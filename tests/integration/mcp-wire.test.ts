import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParleyDaemon } from "../../src/daemon/server";
import { RawClient } from "./harness";

/**
 * The MCP half of the delivery fix, end to end.
 *
 * `src/mcp/server.ts` joins with `connected: true` — so the daemon marks it
 * `delivery: "live"`, pushes unsolicited frames at it, and advances its read
 * cursor past them — and for a long time registered no `onPush` handler at
 * all: every directed event to an MCP-driven front was generated, marked read
 * and dropped. It now buffers pushes and folds them into the next tool
 * response's footer.
 *
 * Both ends of that had tests and the wire between them had none — the exact
 * shape this whole wave exists to eliminate, and `client.onPush(…)` plus the
 * buffer fold could both be deleted with the suite green. So this drives the
 * real `parley mcp` process over real stdio, against a real daemon on a real
 * socket, and reads the message out of the tool response a harness would show
 * its model.
 */
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

const dirs: string[] = [];
const daemons: ParleyDaemon[] = [];
const kill: (() => void)[] = [];

afterEach(async () => {
  for (const k of kill.splice(0)) k();
  for (const d of daemons.splice(0)) await d.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "parley-mcp-"));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return repo;
}

/** The real `parley mcp`, talking the real protocol over its own stdio. */
function startMcp(repo: string, name: string) {
  const proc = Bun.spawn([process.execPath, MAIN, "mcp"], {
    cwd: repo,
    env: {
      ...process.env,
      PARLEY_NAME: name,
      PARLEY_SESSION: `session-${name}`,
      PARLEY_MISSION: "reading the pool",
      PARLEY_BORN: "person",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  kill.push(() => { try { proc.kill(); } catch { /* already gone */ } });

  const replies: Record<string, unknown>[] = [];
  void (async () => {
    let buffer = "";
    const decode = new TextDecoder();
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buffer += decode.decode(chunk);
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        try { replies.push(JSON.parse(line)); } catch { /* not ours */ }
      }
    }
  })();

  async function request(id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    proc.stdin.flush();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const found = replies.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`parley mcp never answered ${method}`);
  }

  /** What a harness would put in front of its model. */
  async function callTool(id: number, tool: string): Promise<string> {
    const reply = await request(id, "tools/call", { name: tool, arguments: {} });
    const result = reply.result as { content?: { text?: string }[] } | undefined;
    return result?.content?.[0]?.text ?? JSON.stringify(reply);
  }

  return { request, callTool };
}

describe("an MCP-driven front reads what the bus sends it", () => {
  test("a directed event reaches the next tool response, exactly once", async () => {
    const repo = gitRepo();
    const sockDir = mkdtempSync(join(tmpdir(), "parley-sock-"));
    dirs.push(sockDir);
    const daemon = new ParleyDaemon({
      gitCommonDir: join(repo, ".git", "parley"),
      address: { kind: "unix", address: join(sockDir, "p.sock") },
      journalPath: join(sockDir, "journal.ndjson"),
      tickIntervalMs: 100_000,
    });
    daemons.push(daemon);
    await daemon.listen();

    const mcp = startMcp(repo, "POOL-MCP");
    expect((await mcp.request(1, "initialize")).result).toBeDefined();
    // The MCP front joins the bus on its first tool call, not at startup.
    await mcp.callTool(2, "parley_who");

    const core = await RawClient.connect(join(sockDir, "p.sock"));
    await core.send({ op: "join", name: "CORE", cwd: repo, kind: "agent", session: "s-core" });
    const said = await core.send({ op: "say", to: "POOL-MCP", text: "the pool is empty and you hold nothing" });
    expect(said.ok).toBe(true);
    core.close();

    const seen = await mcp.callTool(3, "parley_who");
    // Delivered: the daemon pushed it down a socket this front does read.
    expect(seen).toContain("the pool is empty and you hold nothing");
    // And once. The buffer is a hand-off, not a copy: the daemon advanced this
    // front's cursor when it pushed, precisely because it declared itself
    // live, so the `drain` in the same footer must not return it again. If a
    // later edit drops `connected: true` from the MCP join, the cursor stops
    // moving and every directed event renders twice — this is what says so.
    expect(seen.split("the pool is empty and you hold nothing").length - 1).toBe(1);
  }, 30_000);
});
