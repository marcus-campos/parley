import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecoder, encodeFrame } from "../../src/protocol/codec";
import type { Response } from "../../src/protocol/types";
import { ParleyDaemon, type DaemonOptions } from "../../src/daemon/server";

export const dirs: string[] = [];
export const daemons: ParleyDaemon[] = [];

export function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "parley-it-"));
  dirs.push(dir);
  return dir;
}

export async function startDaemon(
  gitCommonDir: string,
  journalPath: string,
  opts: Partial<DaemonOptions> = {},
) {
  const daemon = new ParleyDaemon({
    gitCommonDir,
    address: { kind: "unix", address: join(gitCommonDir, "p.sock") },
    journalPath,
    tickIntervalMs: 50,
    ...opts,
  });
  daemons.push(daemon);
  const endpoint = await daemon.listen();
  return { daemon, endpoint };
}

/** A minimal NDJSON client, so the test exercises the wire and not our client. */
export class RawClient {
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

export interface Front {
  send(frame: Record<string, unknown>): Promise<Record<string, unknown>>;
  pushes: unknown[];
}

/**
 * A real daemon on a real socket in a temp directory, driven by the minimal
 * NDJSON client — so the test exercises the wire and not our client.
 *
 * `restart` is what makes durability testable: `{ hard: true }` kills the
 * process rather than stopping it, which is the case the journal exists for.
 *
 * A restarted daemon gets its own fresh socket directory — only the journal
 * path is held constant — because a hard restart cannot gracefully vacate the
 * old socket the way a real `kill -9` vacates the old process's file
 * descriptors. `connect` always dials whichever daemon is current, so the
 * fresh address is invisible to the caller.
 */
export async function withDaemon(
  fn: (
    connect: (name: string) => Promise<Front>,
    restart: (opts?: { hard?: boolean }) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const ownDirs: string[] = [];
  const ownDaemons: ParleyDaemon[] = [];
  const clients: RawClient[] = [];

  const journalDir = tempRepo();
  ownDirs.push(journalDir);
  const journalPath = join(journalDir, "journal.ndjson");

  let current = await bootDaemon();

  async function bootDaemon() {
    const socketDir = tempRepo();
    ownDirs.push(socketDir);
    const started = await startDaemon(socketDir, journalPath);
    ownDaemons.push(started.daemon);
    return started;
  }

  const connect = async (name: string): Promise<Front> => {
    const client = await RawClient.connect(current.endpoint.address);
    clients.push(client);
    await client.send({ op: "join", name, mission: name });
    return client;
  };

  const restart = async (opts: { hard?: boolean } = {}): Promise<void> => {
    if (!opts.hard) await current.daemon.close();
    current = await bootDaemon();
  };

  try {
    await fn(connect, restart);
  } finally {
    for (const c of clients) c.close();
    for (const d of ownDaemons) await d.close().catch(() => { /* already gone */ });
    for (const dir of ownDirs) rmSync(dir, { recursive: true, force: true });
  }
}
