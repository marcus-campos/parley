import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { Journal, type JournalEntry } from "../journal/journal";
import { createDecoder, encodeFrame, type Decoder } from "../protocol/codec";
import { DEFAULTS, PROTOCOL_VERSION, err, type Mode } from "../protocol/types";
import { apply, initialState, makeCtx, tick } from "../state/machine";
import type { ConvEvent, State } from "../state/types";
import { newEndpoint, removeEndpoint, writeEndpoint, type Endpoint } from "./endpoint";
import type { Address } from "../transport/address";

interface Conn {
  socket: Socket;
  decoder: Decoder;
  participantId: string | null;
  authed: boolean;
}

export interface DaemonOptions {
  gitCommonDir: string;
  address: Address;
  journalPath: string;
  mode?: Mode;
  idleShutdownMs?: number;
  tickIntervalMs?: number;
  /** Injected in tests so a whole lifetime runs in milliseconds. */
  now?: () => number;
  onListening?: (endpoint: Endpoint) => void;
}

export class ParleyDaemon {
  private state: State;
  private readonly journal: Journal;
  private readonly counter = { n: 0 };
  private readonly conns = new Set<Conn>();
  private server: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityMs: number;
  private readonly token: string | null;
  private readonly now: () => number;

  constructor(private readonly opts: DaemonOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.journal = new Journal(opts.journalPath);
    this.token = opts.address.kind === "tcp" ? randomBytes(24).toString("hex") : null;
    this.state = this.restore(opts.mode ?? "advisory");
    this.lastActivityMs = this.now();
  }

  /**
   * Rebuild from the journal. The whole point of writing before responding is
   * that this reconstruction is lossless up to the last completed line.
   */
  private restore(mode: Mode): State {
    const state = initialState(mode);
    const { entries, discarded } = this.journal.replay();
    for (const entry of entries) {
      const ms = Date.parse(entry.at);
      apply(state, entry.actorId, entry.frame, makeCtx(Number.isNaN(ms) ? 0 : ms, this.counter));
    }
    // Nothing survives a restart connected; presence has to be re-proven.
    for (const p of Object.values(state.participants)) p.connected = false;
    if (discarded.length > 0) {
      process.stderr.write(
        `parley: discarded ${discarded.length} unreadable journal line(s); starting anyway\n`,
      );
    }
    return state;
  }

  async listen(): Promise<Endpoint> {
    const { address } = this.opts;
    if (address.kind === "unix") {
      mkdirSync(dirname(address.address), { recursive: true });
      // A socket file left by a dead daemon blocks bind(); the endpoint entry is
      // claimed by whoever arrives, so removing it here is the same decision.
      if (existsSync(address.address)) {
        try { unlinkSync(address.address); } catch { /* raced with another spawn */ }
      }
    }

    const server = createServer((socket) => this.accept(socket));
    this.server = server;

    const endpoint = await new Promise<Endpoint>((resolve, reject) => {
      server.once("error", reject);
      const done = () => {
        const info = server.address();
        const port = typeof info === "object" && info ? info.port : address.port;
        resolve(
          newEndpoint({
            pid: process.pid,
            transport: address.kind,
            address: address.kind === "tcp" ? address.address : address.address,
            ...(address.kind === "tcp" ? { port } : {}),
            os: process.platform,
            token: this.token,
            started_at: new Date(this.now()).toISOString(),
          }),
        );
      };
      if (address.kind === "tcp") server.listen(address.port ?? 0, address.address, done);
      else server.listen(address.address, done);
    });

    writeEndpoint(this.opts.gitCommonDir, endpoint);
    this.opts.onListening?.(endpoint);

    const interval = this.opts.tickIntervalMs ?? 5_000;
    this.timer = setInterval(() => this.onTick(), interval);
    if (typeof this.timer.unref === "function") this.timer.unref();

    return endpoint;
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    const conn: Conn = {
      socket,
      decoder: createDecoder(),
      participantId: null,
      // Nothing listens on the network except loopback mode, and loopback
      // without a token would be an open bus for every process on the machine.
      authed: this.token === null,
    };
    this.conns.add(conn);
    this.lastActivityMs = this.now();

    socket.on("data", (chunk: string) => this.onData(conn, chunk));
    socket.on("error", () => this.dropConn(conn));
    socket.on("close", () => this.dropConn(conn));
  }

  private dropConn(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    const p = conn.participantId ? this.state.participants[conn.participantId] : undefined;
    if (p) {
      p.connected = false;
      // Fall back to the lease: a dropped connection is not proof of death for
      // a front that also renews through the CLI.
      p.lastSeenMs = this.now();
    }
    this.lastActivityMs = this.now();
  }

  private onData(conn: Conn, chunk: string): void {
    for (const line of conn.decoder.push(chunk)) {
      if (!line.ok) {
        this.send(conn, err("UNKNOWN_OP", line.error));
        continue;
      }
      this.handle(conn, line.frame);
    }
  }

  private handle(conn: Conn, frame: Record<string, unknown>): void {
    this.lastActivityMs = this.now();

    if (!conn.authed) {
      if (frame.op === "auth" && frame.token === this.token) {
        conn.authed = true;
        this.send(conn, { ok: true, protocol: PROTOCOL_VERSION });
        return;
      }
      this.send(conn, err("AUTH_REQUIRED", "send {op:'auth',token} first"));
      return;
    }

    const ctx = makeCtx(this.now(), this.counter);

    // Expire before deciding: a claim held by a front that died two minutes ago
    // must not win a conflict against the front asking right now.
    const expired = tick(this.state, ctx, {});
    if (expired.broadcast.length) this.push(expired.broadcast, null);

    // Journal BEFORE responding. This ordering is the entire crash story.
    const entry: JournalEntry = { at: ctx.now, actorId: conn.participantId, frame };
    try {
      this.journal.append(entry);
    } catch (e) {
      process.stderr.write(`parley: journal append failed: ${(e as Error).message}\n`);
    }

    const outcome = apply(this.state, conn.participantId, frame, ctx);

    if (frame.op === "join" && outcome.response.ok) {
      conn.participantId = (outcome.response as unknown as { id: string }).id;
      const p = this.state.participants[conn.participantId];
      if (p) p.connected = true;
    }
    if (frame.op === "leave" && outcome.response.ok) conn.participantId = null;

    this.send(conn, outcome.response);
    if (outcome.broadcast.length) this.push(outcome.broadcast, conn);
  }

  private onTick(): void {
    const ctx = makeCtx(this.now(), this.counter);
    const result = tick(this.state, ctx, {});
    if (result.broadcast.length) this.push(result.broadcast, null);

    const idleFor = this.now() - this.lastActivityMs;
    const limit = this.opts.idleShutdownMs ?? DEFAULTS.IDLE_SHUTDOWN_MS;
    if (this.conns.size === 0 && idleFor > limit) void this.close();
  }

  /** Unsolicited frames on the same connection: inbox and territory events. */
  private push(events: ConvEvent[], from: Conn | null): void {
    for (const conn of this.conns) {
      if (conn === from || !conn.authed || !conn.participantId) continue;
      const me = this.state.participants[conn.participantId];
      if (!me) continue;
      const mine = events.filter(
        (e) => e.from?.id !== conn.participantId && (e.to === null || e.to === me.name),
      );
      if (mine.length === 0) continue;
      this.send(conn, { v: PROTOCOL_VERSION, op: "push", events: mine });
      const cursor = this.state.cursors[conn.participantId] ?? 0;
      const top = mine[mine.length - 1]!.seq;
      if (top > cursor) this.state.cursors[conn.participantId] = top;
    }
  }

  private send(conn: Conn, payload: unknown): void {
    if (conn.socket.destroyed) return;
    try {
      conn.socket.write(encodeFrame(payload));
    } catch {
      this.dropConn(conn);
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const conn of [...this.conns]) {
      try { conn.socket.destroy(); } catch { /* already gone */ }
    }
    this.conns.clear();
    removeEndpoint(this.opts.gitCommonDir);
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    if (this.opts.address.kind === "unix" && existsSync(this.opts.address.address)) {
      try { unlinkSync(this.opts.address.address); } catch { /* best effort */ }
    }
    this.server = null;
  }

  /** Test seam. */
  snapshot(): State {
    return this.state;
  }
}

export function journalPathFor(stateDirectory: string): string {
  return join(stateDirectory, "journal.ndjson");
}
