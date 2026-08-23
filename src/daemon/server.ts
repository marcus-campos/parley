import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, watch as watchFs, type FSWatcher } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { Journal, type JournalEntry } from "../journal/journal";
import { createDecoder, encodeFrame, type Decoder } from "../protocol/codec";
import { DEFAULTS, PROTOCOL_VERSION, err, type Mode } from "../protocol/types";
import { apply, initialState, makeCtx, tick, type BirthIntent } from "../state/machine";
import { pushEvent, type ConvEvent, type Ctx, type Participant, type State } from "../state/types";
import { exportNotes } from "../notes/export";
import { newEndpoint, readEndpoint, removeEndpoint, writeEndpoint, type Endpoint } from "./endpoint";
import type { Address } from "../transport/address";
import { readSpawnConfigIn, type SpawnConfig } from "../cli/spawn-config";
import { bearFront } from "../spawn/birth";
import { isNewbornWorktree, removeWorktreeIfClean } from "../spawn/worktree";

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

export class DaemonAlreadyRunning extends Error {
  constructor(address: string) {
    super(`another parley daemon is already serving ${address}`);
    this.name = "DaemonAlreadyRunning";
  }
}

export class ParleyDaemon {
  /**
   * Does something answer on this socket? Distinguishes live from leftover.
   *
   * This probe is not an optimisation, it is the only defence on Unix: binding
   * a server to a unix socket path that is already being served **succeeds**
   * here, silently displacing the daemon that was there. bind() never
   * complains, so asking first is the whole mechanism.
   *
   * The timeout is generous because it is almost never reached: a leftover
   * socket refuses immediately (ECONNREFUSED) and a live one accepts
   * immediately. It only bites when a connection hangs — and a first connect on
   * a cold Windows runner can take far longer than a local connect ever
   * suggests. Timing this too tightly reads "slow" as "dead", and the cost of
   * that mistake is two daemons on one repository.
   */
  static isServed(path: string, timeoutMs = 2_000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect(path);
      const settle = (alive: boolean) => {
        socket.destroy();
        clearTimeout(timer);
        resolve(alive);
      };
      const timer = setTimeout(() => settle(false), timeoutMs);
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
    });
  }

  private state: State;
  private readonly journal: Journal;
  private readonly counter = { n: 0 };
  private readonly conns = new Set<Conn>();
  private server: Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityMs: number;
  private readonly token: string | null;
  private readonly now: () => number;
  /** Read once at boot, re-read whenever `parley/spawn.json` changes underneath us. */
  private spawnConfig: SpawnConfig;
  private spawnConfigWatcher: FSWatcher | null = null;
  private nextFrontIndex = 1;

  constructor(private readonly opts: DaemonOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.journal = new Journal(opts.journalPath);
    this.token = opts.address.kind === "tcp" ? randomBytes(24).toString("hex") : null;
    // Read before `restore()` runs: replaying a journaled `summon` needs the
    // same ceiling a live one would have been checked against (see `restore`
    // below) — a state reconstruction is only lossless if it re-derives what
    // happened, not what would happen under today's hardcoded default.
    this.spawnConfig = readSpawnConfigIn(opts.gitCommonDir);
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
      apply(
        state, entry.actorId, entry.frame,
        makeCtx(Number.isNaN(ms) ? 0 : ms, this.counter),
        this.spawnConfig.maxFronts,
      );
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
      // A socket file left by a dead daemon blocks bind() and has to go. But
      // deleting one that is still being served would steal the bus from a live
      // daemon, and two daemons on one repository means two states, one of them
      // invisible — and the zombie removes the live endpoint.json when it later
      // times out. So ask first, and only clear what does not answer.
      if (existsSync(address.address)) {
        if (await ParleyDaemon.isServed(address.address)) {
          throw new DaemonAlreadyRunning(address.address);
        }
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
    }).catch((e: NodeJS.ErrnoException) => {
      // Belt and braces. The probe above needs a socket you can stat, which a
      // Windows named pipe is not — and there bind() does refuse, so this is
      // the check that covers pipes and any platform where a rebind is an
      // error rather than a silent takeover.
      if (e?.code === "EADDRINUSE") throw new DaemonAlreadyRunning(address.address);
      throw e;
    });

    writeEndpoint(this.opts.gitCommonDir, endpoint);
    this.opts.onListening?.(endpoint);

    const interval = this.opts.tickIntervalMs ?? 5_000;
    this.timer = setInterval(() => this.onTick(), interval);
    if (typeof this.timer.unref === "function") this.timer.unref();

    this.watchSpawnConfig();

    return endpoint;
  }

  /**
   * A daemon is meant to run all day; a person editing `spawn.json` to change
   * `mode` or `maxFronts` should not have to know a restart is required for it
   * to take effect. `readSpawnConfig` already degrades a missing or unreadable
   * file to `SPAWN_DEFAULTS`, so a delete/replace/split write mid-edit costs
   * at most one cycle before it self-corrects. Losing the watcher itself is a
   * convenience lost, never a reason to stop: the config already read at boot
   * keeps working exactly as it was.
   */
  private watchSpawnConfig(): void {
    try {
      const dir = this.opts.gitCommonDir;
      mkdirSync(dir, { recursive: true });
      const watcher = watchFs(dir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== "spawn.json") return;
        this.spawnConfig = readSpawnConfigIn(this.opts.gitCommonDir);
      });
      if (typeof watcher.unref === "function") watcher.unref();
      this.spawnConfigWatcher = watcher;
    } catch {
      // Watching is a convenience; the config already read at boot is enough.
    }
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
    const expired = tick(this.state, ctx, { maxFronts: this.spawnConfig.maxFronts });
    if (expired.broadcast.length) this.push(expired.broadcast, null);
    this.bearFrontFor(expired.birth, ctx);
    this.retireFronts(expired.retire, ctx);

    // Journal BEFORE responding. This ordering is the entire crash story.
    const entry: JournalEntry = { at: ctx.now, actorId: conn.participantId, frame };
    try {
      this.journal.append(entry);
    } catch (e) {
      process.stderr.write(`parley: journal append failed: ${(e as Error).message}\n`);
    }

    // `summon`'s ceiling check reads this fifth argument (see its doc comment
    // in src/state/machine.ts) — without it, `summon` was refused/granted
    // against the hardcoded default of 6, never against what this repository
    // actually configured in `spawn.json`.
    const outcome = apply(this.state, conn.participantId, frame, ctx, this.spawnConfig.maxFronts);

    if (frame.op === "join" && outcome.response.ok) {
      conn.participantId = (outcome.response as unknown as { id: string }).id;
      const p = this.state.participants[conn.participantId];
      if (p) p.connected = true;
    }
    if (frame.op === "leave" && outcome.response.ok) {
      this.collectWorktree(conn.participantId ? this.state.participants[conn.participantId] : undefined);
      conn.participantId = null;
    }

    this.send(conn, outcome.response);
    if (outcome.broadcast.length) this.push(outcome.broadcast, conn);

    // A note that only exists inside the daemon is a note nobody will find.
    // Writing the file on every note keeps `.parley/notes.md` current without
    // anyone having to remember an export step. Committing it stays a decision
    // a person or an agent makes on purpose — parley never commits.
    if (frame.op === "note" && outcome.response.ok) this.exportNotes();
  }

  private onTick(): void {
    const ctx = makeCtx(this.now(), this.counter);
    const result = tick(this.state, ctx, { maxFronts: this.spawnConfig.maxFronts });
    if (result.broadcast.length) this.push(result.broadcast, null);
    this.bearFrontFor(result.birth, ctx);
    this.retireFronts(result.retire, ctx);

    const idleFor = this.now() - this.lastActivityMs;
    const limit = this.opts.idleShutdownMs ?? DEFAULTS.IDLE_SHUTDOWN_MS;
    if (this.conns.size === 0 && idleFor > limit) void this.close();
  }

  /**
   * Where a birth intent (Task 2) becomes a process (Task 4). `tick` never
   * spawns — `src/state/` stays pure — so this is the only place that turns
   * "capacity is missing" into an actual front. A repository with no worktree
   * root (a bare repo) has nowhere to put one, so it is skipped exactly like
   * `exportNotes` skips writing `.parley/notes.md` for the same reason.
   */
  private bearFrontFor(birth: BirthIntent | null, ctx: Ctx): void {
    if (!birth) return;
    const root = this.repoRootForExport();
    if (!root) return;

    const wanted = this.spawnConfig.mode;
    const born = bearFront({
      repoRoot: root,
      config: this.spawnConfig,
      intent: birth,
      index: this.nextFrontIndex++,
    });

    if (!born) {
      // A birth that fails leaves the pool exactly as open as it was; the
      // cooldown in `tick` passes and the next tick asks again. Announcing it
      // is the only thing that would otherwise be lost — the retry needs no
      // help from us.
      const event = pushEvent(this.state, ctx, {
        kind: "system", from: null, to: null, priority: "high",
        text: "a front could not be started — the pool is still open",
      });
      this.push([event], null);
      return;
    }

    if (born.mode !== wanted) {
      // Same discipline as `enforced` degrading to `advisory` (`setMode`) or a
      // shape change (`setShape`): a silent degrade is a config that quietly
      // stops doing what somebody asked for. Without this, `terminal` in
      // `spawn.json` would spawn into `panel` forever and nobody would learn
      // why.
      const event = pushEvent(this.state, ctx, {
        kind: "system", from: null, to: null, priority: "high",
        text: `${born.name} could not open a terminal — degraded to panel mode`,
      });
      this.push([event], null);
    }
  }

  /**
   * An invitation, and nothing else.
   *
   * §4.5 of the design says a newborn with no taken item and an empty pool
   * "says goodbye by itself", and `src/spawn/birth.ts`'s opening prompt
   * already tells it to. The action belongs to the front. parley's part is to
   * say so once, on the bus, exactly like any other system event — the front
   * reads it on its own next tool call and runs `parley leave`.
   *
   * Nothing here touches the filesystem. It used to remove the front's
   * worktree in this same loop iteration, on the tick that *first* named it —
   * which is to say while the agent was still running inside that directory,
   * and a newborn's worktree is clean by construction. One `parley who` was
   * enough to delete a live front's working directory. Collection now happens
   * in `collectWorktree`, on the front's own `leave`, which is the only
   * evidence parley ever gets that it has actually gone.
   */
  private retireFronts(ids: string[], ctx: Ctx): void {
    if (ids.length === 0) return;
    for (const id of ids) {
      const p = this.state.participants[id];
      if (!p) continue;
      const event = pushEvent(this.state, ctx, {
        kind: "system", from: null, to: p.name, priority: "high",
        text: `${p.name}: the pool is empty and you hold nothing — parley is retiring you. Say so and run \`parley leave\`; your worktree is collected once you have gone.`,
      });
      this.push([event], null);
    }
  }

  /**
   * The worktree comes back only after the front has left, and only if it is
   * empty. Both halves matter.
   *
   * *After*: a front that has been named for retirement has not gone anywhere
   * — it has been asked to. Until it says `leave` it is still running, still
   * has that directory as its cwd, and may still be about to write a file
   * into it. `leave` is the only thing parley ever hears that means "the
   * process is done with this directory" (the SessionEnd hook sends it too,
   * so a session closed from the harness side is covered).
   *
   * *Empty*: `removeWorktreeIfClean` refuses anything with changes in it.
   *
   * And only ever under `.parley/worktrees/`. `p.cwd` is whatever directory
   * the front's process happened to be in; a parley-born front is spawned in
   * its worktree, but nothing stops a later call arriving from somewhere else
   * entirely. `git worktree remove` would refuse a path it does not manage,
   * but "git would have refused" is not the guarantee to rely on when the
   * failure mode is deleting somebody's checkout.
   */
  private collectWorktree(p: Participant | undefined): void {
    if (!p || p.born !== "parley" || !p.cwd) return;
    const root = this.repoRootForExport();
    if (!root) return;
    if (!isNewbornWorktree(root, p.cwd)) return;
    // Deliberately not awaited: two `git` subprocesses must never be something
    // the daemon's event loop waits on. Failure is already the safe outcome —
    // the worktree stays where it is.
    void removeWorktreeIfClean(root, p.cwd).catch(() => { /* disk is cheap */ });
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
      // Moving the cursor is a claim that these events have been delivered,
      // and only a front that reads unsolicited frames can honour it. A hook
      // or CLI front holds this socket for the length of one command and
      // drops every `push` on the floor (`src/client/client.ts` — no handler,
      // no delivery); advancing its cursor marked those events read and
      // `drain` never returned them again. That is why a retirement notice
      // generated by the pre-command tick on the retiring front's *own*
      // connection was emitted down the one channel it cannot read, and then
      // erased from the one it can.
      if (me.delivery !== "live") continue;
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
    this.spawnConfigWatcher?.close();
    this.spawnConfigWatcher = null;
    for (const conn of [...this.conns]) {
      try { conn.socket.destroy(); } catch { /* already gone */ }
    }
    this.conns.clear();
    // Only clean up the endpoint if it is still ours. A daemon that lost the
    // race must not delete the live one's discovery file on its way out.
    // `gitCommonDir` here is already the discovery directory the spawner
    // resolved, repository or workspace.
    const published = readEndpoint(this.opts.gitCommonDir);
    if (!published || published.pid === process.pid) removeEndpoint(this.opts.gitCommonDir);
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    if (
      this.opts.address.kind === "unix" &&
      existsSync(this.opts.address.address) &&
      (!published || published.pid === process.pid)
    ) {
      try { unlinkSync(this.opts.address.address); } catch { /* best effort */ }
    }
    this.server = null;
  }

  /**
   * The working tree everything on disk hangs off: `.parley/notes.md`, and
   * `.parley/worktrees/` for a newborn front.
   *
   * `opts.gitCommonDir` is not the git common dir despite its name — the
   * spawner passes the *discovery* directory, which is
   * `<git-common-dir>/parley` for a repository and `<workspace>/.parley` for a
   * workspace (`src/cli/main.ts`, the `__daemon` branch). Matching `.git`
   * against it therefore never matched, so in production this returned `null`
   * for every repository that has ever run parley — which silently disabled
   * both the notes export and, on this branch, the entire birth path:
   * `bearFrontFor` returns before it spawns anything when there is no root.
   * A bare repository still has no worktree and still gets no file.
   */
  private repoRootForExport(): string | null {
    const discovery = this.opts.gitCommonDir;
    const parent = dirname(discovery);
    // <repo>/.git/parley  ->  <repo>. A linked worktree resolves to the main
    // repository's .git, which is where .parley/worktrees/ belongs anyway.
    if (basename(discovery) === "parley" && basename(parent) === ".git") return dirname(parent);
    // <workspace>/.parley  ->  <workspace>.
    if (basename(discovery) === ".parley") return parent;
    // Handed the git directory itself: what this function used to expect, and
    // what tests that construct a daemon by hand still pass.
    if (basename(discovery) === ".git") return parent;
    return null;
  }

  private exportNotes(): void {
    const root = this.repoRootForExport();
    if (!root) return;
    try {
      exportNotes(this.state.notes, root);
    } catch (e) {
      process.stderr.write(`parley: could not write .parley/notes.md: ${(e as Error).message}\n`);
    }
  }

  /** Test seam. */
  snapshot(): State {
    return this.state;
  }
}

export function journalPathFor(stateDirectory: string): string {
  return join(stateDirectory, "journal.ndjson");
}
