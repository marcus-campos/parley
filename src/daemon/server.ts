import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, watch as watchFs, type FSWatcher } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, relative, sep } from "node:path";
import { BIRTH_STAMP_OP, Journal, type JournalEntry } from "../journal/journal";
import { createDecoder, encodeFrame, type Decoder } from "../protocol/codec";
import { DEFAULTS, PROTOCOL_VERSION, err, type Mode } from "../protocol/types";
import { apply, initialState, makeCtx, tick, type BirthIntent } from "../state/machine";
import { pushEvent, type ConvEvent, type Ctx, type Participant, type State } from "../state/types";
import { exportNotes } from "../notes/export";
import { newEndpoint, readEndpoint, removeEndpoint, writeEndpoint, type Endpoint } from "./endpoint";
import type { Address } from "../transport/address";
import { readSpawnConfigIn, type SpawnConfig } from "../cli/spawn-config";
import { bearFront, harnessBin } from "../spawn/birth";
import { isNewbornWorktree, nextFrontIndexIn, removeWorktreeIfClean, type WorktreeRemoval } from "../spawn/worktree";

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
  /**
   * How a worktree is collected. Production never sets this — the default is
   * the real `removeWorktreeIfClean`.
   *
   * It exists because the one window this daemon has to get right is the one
   * *inside* that call: between `git status` answering clean and `git worktree
   * remove` being issued, the daemon keeps serving frames, and one of them can
   * be the front walking back into the directory. Every other collection test
   * asserts after `close()`, which awaits `this.collecting` — so the window is
   * always fully drained before the assertion runs and no test could ever
   * observe a frame landing inside it. This is what lets one hold the window
   * open and send a real `join` through it.
   */
  removeWorktree?: typeof removeWorktreeIfClean;
}

/**
 * A front that said `leave` from a worktree parley made, and what has happened
 * to it since. It outlives the decision to collect: while `git` runs, this is
 * the daemon's only record that a removal is in progress, and a removal with
 * no record is a removal nothing can call off.
 */
interface PendingCollection {
  name: string;
  cwd: string;
  sinceMs: number;
  attempts: number;
  /** A removal is in flight for this one. Do not start a second. */
  collecting: boolean;
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
  /** Fronts that said `leave` from a worktree parley made, waiting to be proven gone. */
  private readonly pendingCollection = new Map<string, PendingCollection>();
  /**
   * The tail of what fronts parley bore have printed, for the panel and for
   * nobody else. Not in `State`: it is not a fact about the conversation, it
   * never arrives as a frame, and a journal replay could not reconstruct it.
   */
  private readonly tail: { n: number; name: string; text: string; at: string }[] = [];
  private tailSeq = 0;
  /** How to stop reading each newborn's pipes. Called on `close()`. */
  private readonly outputReaders: (() => void)[] = [];
  /** Fronts parley started that have not reached the bus yet. */
  private readonly pendingBirth = new Map<string, { atMs: number; mode: "panel" | "terminal" }>();
  /** Removals in flight. Nothing waits on these except `close`. */
  private readonly collecting = new Set<Promise<void>>();
  private readonly removeWorktree: typeof removeWorktreeIfClean;
  private readonly token: string | null;
  private readonly now: () => number;
  /** Read once at boot, re-read whenever `parley/spawn.json` changes underneath us. */
  private spawnConfig: SpawnConfig;
  private spawnConfigWatcher: FSWatcher | null = null;
  private nextFrontIndex: number;

  constructor(private readonly opts: DaemonOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.removeWorktree = opts.removeWorktree ?? removeWorktreeIfClean;
    this.journal = new Journal(opts.journalPath);
    this.token = opts.address.kind === "tcp" ? randomBytes(24).toString("hex") : null;
    // Read before `restore()` runs: replaying a journaled `summon` needs the
    // same ceiling a live one would have been checked against (see `restore`
    // below) — a state reconstruction is only lossless if it re-derives what
    // happened, not what would happen under today's hardcoded default.
    this.spawnConfig = readSpawnConfigIn(opts.gitCommonDir);
    // Read from git, not started at 1. The counter is in memory and the branch
    // a collected worktree was on is not deleted by `git worktree remove`, so
    // restarting the count meant the first birth of every daemon lifetime
    // after the first collided with a branch that was already there — a
    // phantom "a front could not be started" and a full BIRTH_COOLDOWN_MS of
    // delay, every time.
    const root = this.repoRootForExport();
    this.nextFrontIndex = root ? nextFrontIndexIn(root) : 1;
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
      const at = Number.isNaN(ms) ? 0 : ms;
      // Not a frame anybody sent — see `BIRTH_STAMP_OP`. `tick` is what stamps
      // the cooldown and `tick` is never journalled, so this is the only way a
      // window parley already spent is still spent after a restart. `apply`
      // does not know this op and must never be handed it.
      if (entry.frame.op === BIRTH_STAMP_OP) {
        state.lastBirthMs = at;
        continue;
      }
      apply(
        state, entry.actorId, entry.frame,
        makeCtx(at, this.counter),
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

    // A daemon-local read, answered before anything else happens to it: the
    // tail of a newborn's output is not a fact about the conversation, so it
    // is neither applied to the state nor written to the journal. Only a panel
    // ever asks.
    if (frame.op === "output") {
      const after = typeof frame.after === "number" ? frame.after : 0;
      this.send(conn, { ok: true, lines: this.tail.filter((l) => l.n > after) });
      return;
    }

    const ctx = makeCtx(this.now(), this.counter);

    // Expire before deciding: a claim held by a front that died two minutes ago
    // must not win a conflict against the front asking right now.
    const expired = tick(this.state, ctx, { maxFronts: this.spawnConfig.maxFronts });
    if (expired.broadcast.length) this.push(expired.broadcast, null);
    this.bearFrontFor(expired.birth, ctx);
    this.retireFronts(expired.retire, ctx);
    this.collectDead(expired.died);

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
      this.scheduleCollection(conn.participantId ? this.state.participants[conn.participantId] : undefined);
      conn.participantId = null;
    }

    // After `apply`, never before. The sweep asks "is anybody still standing
    // in there", and it can only see participants the state already has — so
    // run before the frame is applied, the participant arriving *on this very
    // frame* is invisible to it. A front that says `parley leave` and then
    // makes one tool call longer than `COLLECT_AFTER_LEAVE_MS` — a full test
    // run, a build — had its directory removed by the same hook frame that was
    // supposed to cancel the collection, because the sweep decided first and
    // the cancel landed one statement later. Same for a person opening a
    // session inside `.parley/worktrees/pool-1` to read what a departed
    // newborn did: their first hook frame deleted the checkout they had just
    // opened.
    this.sweepCollections(ctx.nowMs);
    this.sweepBirths(ctx.nowMs);

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
    this.collectDead(result.died);
    this.sweepCollections(ctx.nowMs);
    this.sweepBirths(ctx.nowMs);

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
    // Written before anything is attempted, because `tick` stamps
    // `state.lastBirthMs` when it emits the intent and not when a spawn
    // succeeds — a bare repository that cannot host a worktree has still spent
    // the window, exactly as it does in memory. Without this the cooldown was
    // the one capacity decision a restart silently undid, while the veto one
    // field above it survived by being journalled.
    try {
      this.journal.append({ at: ctx.now, actorId: null, frame: { op: BIRTH_STAMP_OP } });
    } catch (e) {
      process.stderr.write(`parley: journal append failed: ${(e as Error).message}\n`);
    }
    const root = this.repoRootForExport();
    if (!root) return;

    const wanted = this.spawnConfig.mode;
    // Fixed before the call, because the callback that reads the newborn's
    // output has to know whose output it is and `bearFront` has not returned
    // yet when the first line arrives.
    const name = `POOL-${this.nextFrontIndex}`;
    const born = bearFront({
      repoRoot: root,
      config: this.spawnConfig,
      intent: birth,
      index: this.nextFrontIndex++,
      onOutput: (line) => this.recordTail(name, line),
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

    // It has a pid; it has not said anything. In terminal mode that pid is
    // `osascript`'s, and whether the agent itself ever starts depends on a
    // PATH the daemon cannot see. `sweepBirths` is what turns silence into a
    // sentence.
    this.pendingBirth.set(born.name, { atMs: ctx.nowMs, mode: born.mode });
    if (born.stopOutput) this.outputReaders.push(born.stopOutput);

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
   * A worktree is collected only after its front has left *and* gone quiet,
   * and only if it is empty. All three matter, and the first two are not the
   * same thing.
   *
   * *Left*: `leave` is the only thing parley ever hears that means "I am done
   * with this directory" (the SessionEnd hook sends it too, so a session
   * closed from the harness side is covered).
   *
   * *Gone*: `leave` is not proof that the process has exited, and the
   * retirement notice makes that the common case rather than the rare one —
   * it asks the front to run `parley leave`, so the front runs it and then
   * makes one more tool call, with its cwd deleted underneath it. Note which
   * lock cannot help here: "only if clean" is exactly the one that cannot,
   * because a newborn's tree is clean by construction. Collecting on socket
   * close would not help either — `parley leave` from a hook or a shell is its
   * own short-lived process, so its socket closes milliseconds later and
   * proves only that the *command* finished. So leaving schedules; the sweep
   * below decides. Anything that puts a live front back in that directory —
   * one more tool call, and the hook re-joins — cancels it.
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
  private scheduleCollection(p: Participant | undefined): void {
    if (!p || p.born !== "parley" || !p.cwd) return;
    const root = this.repoRootForExport();
    if (!root) return;
    if (!isNewbornWorktree(root, p.cwd)) return;
    // The name is copied rather than looked up later: by the time the removal
    // answers, this is the only thing left that can say whose worktree it was.
    this.pendingCollection.set(p.id, { name: p.name, cwd: p.cwd, sinceMs: this.now(), attempts: 0, collecting: false });
  }

  /**
   * The other end of a life, and the one that was missing.
   *
   * `scheduleCollection` had exactly one call site — the `leave` branch — so
   * §4.4's "removed on death" was in fact removed on *saying goodbye*. A
   * newborn killed by SIGKILL, by a crash, by a closed laptop, or by a harness
   * that never fires `SessionEnd` had its lease expire, was marked `gone`,
   * freed its slot under the ceiling, and kept its full checkout and its
   * branch for ever — and `nextFrontIndexIn` then reserved that index for ever
   * too. Two ends covered, the middle missing, which is the same shape
   * `PARLEY_BORN` had.
   *
   * A front that is merely restarting is safe: it re-joins from the same
   * directory and the sweep cancels on "is anybody in there", which it asks
   * before it looks at any deadline.
   */
  private collectDead(ids: string[]): void {
    for (const id of ids) this.scheduleCollection(this.state.participants[id]);
  }

  /**
   * A birth is not a front until it says so.
   *
   * `bearFront` returns as soon as it has a pid, and reports `mode:
   * "terminal"` the moment `osascript` reports one — the launcher's pid, not
   * the agent's. Since the daemon's environment no longer travels into that
   * window (`terminalCommand`, and deliberately so), the harness resolves from
   * the person's own interactive shell: a PATH or an auth difference yields a
   * window printing `command not found`, and parley counted a front it had
   * successfully started.
   *
   * It costs no capacity — `canBearFront` and `summon` both count live
   * participants, and a front that never joins never becomes one — so this is
   * not a leak. What it was, was silent: `state.lastBirthMs` is stamped at the
   * intent, so the pool waits out a whole BIRTH_COOLDOWN_MS, opens another
   * window that fails the same way, and repeats, with nobody told. Said once
   * per birth, like every other thing this daemon has to report.
   */
  private sweepBirths(nowMs: number): void {
    if (this.pendingBirth.size === 0) return;
    for (const [name, pending] of [...this.pendingBirth]) {
      // Any participant that has ever carried the name, not just a live one:
      // a newborn that joined, worked and left did reach the bus.
      if (Object.values(this.state.participants).some((p) => p.name === name)) {
        this.pendingBirth.delete(name);
        continue;
      }
      if (nowMs - pending.atMs < DEFAULTS.BIRTH_JOIN_GRACE_MS) continue;
      this.pendingBirth.delete(name);
      const hint =
        pending.mode === "terminal"
          ? `the window it opened runs your shell, so \`${harnessBin(this.spawnConfig.harness)}\` has to be on *your* PATH`
          : "its harness did not start";
      this.announce(makeCtx(nowMs, this.counter), `${name} was started and never joined — ${hint}`);
    }
  }

  /**
   * Nobody has been in that directory for as long as this bus takes silence to
   * mean death. Now it can go.
   *
   * A front that came back — reattached to the same participant, or joined as
   * a new one from the same directory — cancels its own collection outright,
   * because the question was never "did it say leave" but "is anybody still in
   * there".
   */
  private sweepCollections(nowMs: number): void {
    if (this.pendingCollection.size === 0) return;
    const root = this.repoRootForExport();
    if (!root) return;
    for (const [id, pending] of [...this.pendingCollection]) {
      const inThere = Object.values(this.state.participants).some(
        (p) => !p.gone && p.cwd && (p.cwd === pending.cwd || p.cwd.startsWith(`${pending.cwd}${sep}`)),
      );
      if (inThere || this.state.participants[id]?.gone === false) {
        // Deleting the entry is also how a removal already in flight is
        // called off: `stillEmpty` below asks this very map, and asks it at
        // the last moment there is still something to call off.
        this.pendingCollection.delete(id);
        continue;
      }
      // Already being removed. Nothing to decide — but the entry stays,
      // because the entry *is* the record that a collection is happening, and
      // the cancel above has nothing to find without it.
      if (pending.collecting) continue;
      if (nowMs - pending.sinceMs < DEFAULTS.COLLECT_AFTER_LEAVE_MS) continue;
      pending.collecting = true;
      // Deliberately not awaited: two `git` subprocesses must never be
      // something the daemon's event loop waits on. Failure is already the
      // safe outcome — the worktree stays where it is. `close()` is the one
      // place that waits, so a daemon shutting down cannot leave a half-done
      // `git worktree remove` behind.
      //
      // The entry used to be deleted right here, one line before the two
      // subprocesses started. From that instant the daemon held no record
      // that a collection was in progress, so `sweepCollections` returned at
      // its first line — `size === 0` — and the re-join that should have
      // cancelled it cancelled nothing. Moving the sweep after `apply()`
      // fixed the frame that arrives *before* the decision; this is the frame
      // that arrives *after* the decision and before `git` has finished, and
      // on a real repository that window is tens of milliseconds wide.
      const collecting = this.removeWorktree(root, pending.cwd, () => this.pendingCollection.get(id) === pending)
        .then((outcome) => this.afterCollection(id, pending, outcome))
        .catch(() => { this.forgetCollection(id, pending); });
      this.collecting.add(collecting);
      void collecting.finally(() => this.collecting.delete(collecting));
    }
  }

  /**
   * Drop the record, but only if it is still the one this removal belongs to.
   *
   * Answers whether it was. A `false` means the sweep deleted it underneath —
   * somebody is back in that directory, or a later `leave` replaced it — and
   * every conclusion this removal reached is about a directory that is no
   * longer nobody's.
   */
  private forgetCollection(id: string, pending: PendingCollection): boolean {
    if (this.pendingCollection.get(id) !== pending) return false;
    this.pendingCollection.delete(id);
    return true;
  }

  /**
   * What became of it, said out loud.
   *
   * `removeWorktreeIfClean` answers with four distinct outcomes and every one
   * of them was thrown away here — `.then(() => {}).catch(() => {})` — so the
   * daemon could not tell "it holds somebody's work" from "git could not be
   * asked". The consequence was a silence in the one case most worth hearing:
   * **a front that leaves holding uncommitted changes has its worktree kept
   * and nobody is told.** It leaves a full checkout on disk, under a name
   * nothing else will ever mention again, with an hour of somebody's work in
   * it. `bearFrontFor` announces both a failed birth and a degrade; this is
   * the same obligation on the other end of the life.
   *
   * The three that are not `removed` divide cleanly:
   *
   *  - `dirty` is an **answer**. Nothing was lost, nothing will change on its
   *    own, and what to do with those changes is a person's decision. Said
   *    once, never retried.
   *  - `unknown` and `failed` are **not answers**. A `git status` that timed
   *    out behind a stale `index.lock`, a removal git refused for a reason
   *    that clears — nothing is known and nothing happened. Those come back to
   *    the sweep, bounded by `COLLECT_MAX_ATTEMPTS`, and are announced only
   *    when the tries run out.
   *
   * Re-arming after a re-join is safe without a check here: the sweep cancels
   * any pending collection whose directory has somebody live in it, and it
   * does that before it looks at any deadline.
   */
  private afterCollection(id: string, pending: PendingCollection, outcome: WorktreeRemoval): void {
    // The entry outlived the removal on purpose, and this is where it stops.
    // If it is no longer ours, the sweep deleted it while `git` was running —
    // which is the sweep saying somebody is standing in that directory again.
    // Then there is nothing to announce and nothing to retry, whatever git
    // answered: `cancelled` is the outcome when the check caught it in time,
    // and the others are a removal that raced past the check and lost anyway.
    if (!this.forgetCollection(id, pending)) return;
    if (outcome === "removed" || outcome === "cancelled") return;
    const root = this.repoRootForExport();
    const where = root ? relative(root, pending.cwd) : pending.cwd;
    const ctx = makeCtx(this.now(), this.counter);

    if (outcome === "dirty") {
      this.announce(ctx, `${pending.name} left uncommitted changes in ${where} — its worktree is kept, nothing was thrown away`);
      return;
    }

    const attempts = pending.attempts + 1;
    if (attempts < DEFAULTS.COLLECT_MAX_ATTEMPTS) {
      this.pendingCollection.set(id, { ...pending, sinceMs: this.now(), attempts, collecting: false });
      return;
    }
    this.announce(ctx, `${pending.name}'s worktree at ${where} could not be collected after ${attempts} tries — it is still on disk`);
  }

  /**
   * A line a newborn printed, kept where a panel can ask for it.
   *
   * §7 of the design: *"a newborn front's output streams into the panel —
   * which is what makes headless spawning legible rather than a black box"*.
   * Into the panel, and the word matters. The plan's sketch pushed each line
   * onto the bus as a `say`, which would journal it and drain it into every
   * other front's context — a harness printing its answer would cost every
   * agent on the repository the tokens to read it, and the pool footer exists
   * precisely because that trade is not worth making.
   */
  private recordTail(name: string, line: string): void {
    const text = line.length > DEFAULTS.PANEL_TAIL_LINE_CHARS
      ? `${line.slice(0, DEFAULTS.PANEL_TAIL_LINE_CHARS)}…`
      : line;
    this.tail.push({ n: ++this.tailSeq, name, text, at: new Date(this.now()).toISOString() });
    while (this.tail.length > DEFAULTS.PANEL_TAIL_LINES) this.tail.shift();
  }

  /** One system event, to everyone. Nothing else in here has a voice. */
  private announce(ctx: Ctx, text: string): void {
    const event = pushEvent(this.state, ctx, {
      kind: "system", from: null, to: null, priority: "high", text,
    });
    this.push([event], null);
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
    // A pipe still being read keeps the event loop open. The newborn itself is
    // detached and unref'd and outlives this.
    for (const stop of this.outputReaders.splice(0)) {
      try { stop(); } catch { /* already gone */ }
    }
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
    // A `git worktree remove` in flight belongs to this daemon; exiting from
    // under it leaves a half-removed worktree and a stale entry in .git. Each
    // one is bounded by GIT_TIMEOUT_MS, and there is at most one per front
    // that has left.
    // Awaited *before* the map is cleared, never after. The map is the
    // cancellation token every removal in flight reads, so clearing it first
    // would make every shutdown cancel the collection it is standing here
    // waiting for.
    await Promise.all([...this.collecting]);
    this.pendingCollection.clear();
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
