import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecoder, encodeFrame } from "../../src/protocol/codec";
import type { Response } from "../../src/protocol/types";
import { readEndpoint } from "../../src/daemon/endpoint";
import { ParleyDaemon } from "../../src/daemon/server";

const dirs: string[] = [];
const daemons: ParleyDaemon[] = [];

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "parley-it-"));
  dirs.push(dir);
  return dir;
}

async function startDaemon(gitCommonDir: string, journalPath: string) {
  const daemon = new ParleyDaemon({
    gitCommonDir,
    address: { kind: "unix", address: join(gitCommonDir, "p.sock") },
    journalPath,
    tickIntervalMs: 50,
  });
  daemons.push(daemon);
  const endpoint = await daemon.listen();
  return { daemon, endpoint };
}

/** A minimal NDJSON client, so the test exercises the wire and not our client. */
class RawClient {
  private socket!: Socket;
  private readonly decoder = createDecoder();
  private readonly waiting: ((r: Response) => void)[] = [];
  readonly pushes: unknown[] = [];

  static connect(path: string): Promise<RawClient> {
    return new Promise((resolve) => {
      const c = new RawClient();
      c.socket = connect(path, () => resolve(c));
      c.socket.setEncoding("utf8");
      c.socket.on("data", (chunk: string) => {
        for (const line of c.decoder.push(chunk)) {
          if (!line.ok) continue;
          if (line.frame.op === "push") { c.pushes.push(line.frame); continue; }
          c.waiting.shift()?.(line.frame as unknown as Response);
        }
      });
    });
  }

  send(frame: Record<string, unknown>): Promise<Response> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.socket.write(encodeFrame({ v: 1, ...frame }));
    });
  }

  close() { this.socket.destroy(); }
}

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a real daemon over a real socket", () => {
  test("publishes a readable endpoint and answers status", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));
    expect(endpoint.protocol).toBe(1);
    expect(readEndpoint(dir)?.address).toBe(endpoint.address);

    const client = await RawClient.connect(endpoint.address);
    const status = await client.send({ op: "status" });
    expect(status).toMatchObject({ ok: true, mode: "advisory", participants: 0 });
    client.close();
  });

  test("THE test that matters: two clients claiming the same path at once", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));

    const a = await RawClient.connect(endpoint.address);
    const b = await RawClient.connect(endpoint.address);
    await a.send({ op: "join", name: "FINANCEIRO", cwd: "/wt/a" });
    await b.send({ op: "join", name: "TESTE-CAMPO", cwd: "/wt/b" });

    const [ra, rb] = await Promise.all([
      a.send({ op: "claim", paths: ["src/backend/finance/services.py"] }),
      b.send({ op: "claim", paths: ["src/backend/finance/**"] }),
    ]);

    const winners = [ra, rb].filter((r) => r.ok);
    const losers = [ra, rb].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ error: { code: "CONFLICT" } });

    a.close();
    b.close();
  });

  test("a message reaches the other session as an unsolicited push", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));

    const a = await RawClient.connect(endpoint.address);
    const b = await RawClient.connect(endpoint.address);
    await a.send({ op: "join", name: "FIN", cwd: "/wt/a" });
    await b.send({ op: "join", name: "CAMPO", cwd: "/wt/b" });

    await a.send({ op: "say", text: "confiram as heads do alembic" });
    await new Promise((r) => setTimeout(r, 80));

    const text = JSON.stringify(b.pushes);
    expect(text).toContain("confiram as heads do alembic");
    expect(JSON.stringify(a.pushes)).not.toContain("confiram as heads do alembic");

    a.close();
    b.close();
  });

  test("kill -9 costs nothing: the journal rebuilds territory and history", async () => {
    const dir = tempRepo();
    const journal = join(dir, "journal.ndjson");

    const first = await startDaemon(dir, journal);
    const a = await RawClient.connect(first.endpoint.address);
    await a.send({ op: "join", name: "FINANCEIRO", cwd: "/wt/a" });
    await a.send({ op: "claim", paths: ["src/backend/finance/**"], intent: "closing refactor" });
    await a.send({ op: "note", title: "CI runs tsc -b here", body: "solution-style tsconfig" });
    a.close();
    await first.daemon.close();

    // Same journal, brand new process-equivalent.
    const second = await startDaemon(dir, journal);
    const state = second.daemon.snapshot();
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0]!.pattern).toBe("src/backend/finance/**");
    expect(state.claims[0]!.intent).toBe("closing refactor");
    expect(state.notes).toHaveLength(1);
    // Nothing survives a restart connected: presence has to be re-proven.
    expect(Object.values(state.participants).every((p) => !p.connected)).toBe(true);
  });

  test("a torn last line does not stop the daemon from booting", async () => {
    const dir = tempRepo();
    const journal = join(dir, "journal.ndjson");
    const first = await startDaemon(dir, journal);
    const a = await RawClient.connect(first.endpoint.address);
    await a.send({ op: "join", name: "FIN", cwd: "/wt/a" });
    await a.send({ op: "claim", paths: ["src/app.ts"] });
    a.close();
    await first.daemon.close();

    await Bun.write(journal, `${await Bun.file(journal).text()}{"at":"2026-08-18T14:00:00.0`);

    const second = await startDaemon(dir, journal);
    expect(second.daemon.snapshot().claims).toHaveLength(1);
  });

  test("an unknown op is refused without dropping the connection", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));
    const a = await RawClient.connect(endpoint.address);
    expect(await a.send({ op: "teleport" })).toMatchObject({ error: { code: "UNKNOWN_OP" } });
    expect(await a.send({ op: "status" })).toMatchObject({ ok: true });
    a.close();
  });
});

describe("only one daemon may serve a repository", () => {
  test("a second daemon refuses instead of stealing the live socket", async () => {
    const dir = tempRepo();
    const first = await startDaemon(dir, join(dir, "journal.ndjson"));

    const intruder = new ParleyDaemon({
      gitCommonDir: dir,
      address: { kind: "unix", address: first.endpoint.address },
      journalPath: join(dir, "journal.ndjson"),
      tickIntervalMs: 50,
    });

    let refused = false;
    try {
      await intruder.listen();
    } catch (e) {
      refused = (e as Error).name === "DaemonAlreadyRunning";
    }
    expect(refused).toBe(true);

    // The original is untouched and still answering.
    const client = await RawClient.connect(first.endpoint.address);
    expect(await client.send({ op: "status" })).toMatchObject({ ok: true });
    client.close();
    expect(readEndpoint(dir)?.pid).toBe(first.endpoint.pid);
  });

  test("a leftover socket from a dead daemon is cleared, not respected", async () => {
    const dir = tempRepo();
    const first = await startDaemon(dir, join(dir, "journal.ndjson"));
    const address = first.endpoint.address;
    await first.daemon.close();

    // Recreate the stale file the way a kill -9 would leave it.
    await Bun.write(address, "");
    const second = await startDaemon(dir, join(dir, "journal.ndjson"));
    expect(second.endpoint.address).toBe(address);

    const client = await RawClient.connect(address);
    expect(await client.send({ op: "status" })).toMatchObject({ ok: true });
    client.close();
  });
});
