import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { ParleyClient } from "../client/client";
import type { RepoInfo } from "../repo/locate";
import { PAGE } from "./web-page";
import { readPanelConfig, sanitiseName, writePanelConfig } from "./panel-config";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * `parley watch --web` — the same panel in a browser, for following along on a
 * second screen while the terminal stays free.
 *
 * The page opens in watching posture: no message box, and no grant or deny
 * anywhere on it, ever — the fronts settle permission among themselves, and a
 * stalled request must not turn into a request for a person's attention.
 * Pressing `s` opens a composer, because a human does have a voice; it just is
 * not the thing the interface puts in front of you.
 *
 * Binds to 127.0.0.1 only and requires a token that is printed with the URL.
 * Localhost is not a security boundary on a shared machine: without the token,
 * any process — or any page you have open — could read the bus and speak on it.
 */

export interface Snapshot {
  mode: string;
  repo: string;
  you: string;
  fronts: unknown[];
  requests: unknown[];
  notes: unknown[];
  feed: unknown[];
}

/**
 * Where a detached panel records itself, so a second `--detach` finds the one
 * already running instead of starting a second copy on another port.
 */
interface RunningPanel { pid: number; url: string; port: number }

function panelStatePath(gitCommonDir: string): string {
  return join(gitCommonDir, "parley", "panel-web.json");
}

export function readRunningPanel(gitCommonDir: string): RunningPanel | null {
  const path = panelStatePath(gitCommonDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RunningPanel;
    // A recorded pid that no longer exists is a leftover, not a running panel.
    process.kill(parsed.pid, 0);
    return parsed;
  } catch {
    return null;
  }
}

function writeRunningPanel(gitCommonDir: string, panel: RunningPanel): void {
  const path = panelStatePath(gitCommonDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(panel, null, 2)}\n`, "utf8");
}

export function clearRunningPanel(gitCommonDir: string): void {
  try { rmSync(panelStatePath(gitCommonDir), { force: true }); } catch { /* nothing there */ }
}

export async function runWebPanel(
  repo: RepoInfo,
  name: string,
  port: number,
  openBrowser: boolean,
): Promise<void> {
  const client = await ParleyClient.connect({ gitCommonDir: repo.gitCommonDir });
  const joined = await client.request({
    op: "join", name, mission: "watching (web)", harness: "panel",
    cwd: repo.root, kind: "human", connected: true,
  });
  if (!joined.ok) {
    client.close();
    process.stderr.write(`parley: could not join as ${name}: ${joined.error.code}\n`);
    process.exit(1);
  }
  const me = joined as unknown as { name: string; mode: string };
  let myName = me.name;

  const token = randomBytes(16).toString("hex");
  const feed: unknown[] = [];
  let seeded = false;
  const subscribers = new Set<(chunk: string) => void>();

  client.onPush((events) => {
    for (const e of events) feed.push(e);
    while (feed.length > 500) feed.shift();
    void broadcast();
  });

  async function snapshot(): Promise<Snapshot> {
    // Seed from the backlog once, before the first snapshot goes out.
    if (!seeded) {
      seeded = true;
      const past = await client.request({ op: "history", limit: 200 });
      if (past.ok) {
        for (const e of (past as unknown as { events: unknown[] }).events) feed.push(e);
      }
    }
    const [whoR, reqR, notesR, drainR] = await Promise.all([
      client.request({ op: "who" }),
      client.request({ op: "requests" }),
      client.request({ op: "notes" }),
      client.request({ op: "drain" }),
    ]);
    if (drainR.ok) {
      for (const e of (drainR as unknown as { events: unknown[] }).events) feed.push(e);
      while (feed.length > 500) feed.shift();
    }
    const who = whoR.ok ? (whoR as unknown as { mode: string; participants: { name: string }[] }) : null;
    return {
      mode: who?.mode ?? me.mode,
      repo: repo.root,
      you: myName,
      fronts: (who?.participants ?? []).filter((p) => p.name !== myName),
      requests: reqR.ok ? (reqR as unknown as { requests: unknown[] }).requests : [],
      notes: notesR.ok ? (notesR as unknown as { notes: unknown[] }).notes : [],
      feed: feed.slice(-200),
    };
  }

  async function broadcast(): Promise<void> {
    if (subscribers.size === 0) return;
    const payload = `data: ${JSON.stringify(await snapshot())}\n\n`;
    for (const send of subscribers) {
      try { send(payload); } catch { subscribers.delete(send); }
    }
  }

  const authorised = (url: URL, req: Request): boolean =>
    url.searchParams.get("t") === token || req.headers.get("x-parley-token") === token;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" ) {
        if (!authorised(url, req)) return new Response("parley: missing or wrong token", { status: 401 });
        return new Response(PAGE.replace("__TOKEN__", token), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (!authorised(url, req)) return json({ ok: false, error: "unauthorised" }, 401);

      if (url.pathname === "/events") {
        let send!: (chunk: string) => void;
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
            subscribers.add(send);
            void snapshot().then((s) => send(`data: ${JSON.stringify(s)}\n\n`));
          },
          cancel() { subscribers.delete(send); },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      // The only write this server accepts. No grant, no deny, no mode: those
      // are not a human's to make, so there is no route to make them through.
      if (req.method === "POST" && url.pathname === "/say") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const r = await client.request({ op: "say", text: String(body.text ?? ""), to: body.to ?? null });
        if (r.ok) {
          const sent = (r as unknown as { event?: unknown }).event;
          if (sent) feed.push(sent);
        }
        await broadcast();
        return json(r);
      }

      // Your own display name, set from the page instead of from a flag.
      if (req.method === "POST" && url.pathname === "/rename") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const wanted = sanitiseName(String(body.name ?? ""));
        if (!wanted) return json({ ok: false, error: "that name has nothing usable in it" }, 400);
        const r = await client.request({ op: "rename", name: wanted });
        if (r.ok) {
          myName = (r as unknown as { name: string }).name;
          writePanelConfig(repo.gitCommonDir, { ...readPanelConfig(repo.gitCommonDir), name: myName });
        }
        await broadcast();
        return json(r);
      }

      return new Response("not found", { status: 404 });
    },
  });

  const address = `http://127.0.0.1:${server.port}/?t=${token}`;
  writeRunningPanel(repo.gitCommonDir, { pid: process.pid, url: address, port: Number(server.port) });
  process.stdout.write(`parley: web panel on ${address}\n`);
  process.stdout.write(`parley: bound to 127.0.0.1 only; the token is required. Ctrl+C to stop.\n`);
  process.stdout.write(`parley: the page opens in watching mode; press s there to say something.\n`);

  if (openBrowser) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", address] : [address];
    try { spawn(opener, args, { stdio: "ignore", detached: true }).unref(); } catch { /* headless box */ }
  }

  const ticker = setInterval(() => void broadcast(), 1500);

  const shutdown = () => {
    clearInterval(ticker);
    void client.request({ op: "leave" }).finally(() => {
      client.close();
      server.stop(true);
      clearRunningPanel(repo.gitCommonDir);
      process.stdout.write("\nparley: web panel closed\n");
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => { /* serve until signalled */ });
}
