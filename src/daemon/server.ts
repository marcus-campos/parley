import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, watch as watchFs, type FSWatcher } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, relative, sep } from "node:path";
import { BIRTH_STAMP_OP, Journal, type JournalEntry } from "../journal/journal";
import { createDecoder, encodeFrame, type Decoder } from "../protocol/codec";
import { DEFAULTS, PROTOCOL_VERSION, err, type Mode } from "../protocol/types";
import { apply, initialState, makeCtx, tick, type BirthIntent } from "../state/machine";
import { pushEvent, type ConvEvent, type Ctx, type Outcome, type Participant, type State } from "../state/types";
import { indexFromState, type Hit, type LexicalIndex } from "../brain/lexical";
import { debias, embed, fuse, loadStaticModel, VectorIndex, type StaticModel } from "../brain/embed";
import { calibrate, type Calibration } from "../brain/calibrate";
import { loadVectors, saveVectors } from "../brain/vectors";
import { findModel, isEncoder, type EncoderBrainModel } from "../brain/registry";
import { modelPath } from "../brain/download";
import { startEncoder, type EncoderHandle } from "../brain/encoder";
import { exportNotes } from "../notes/export";
import { newEndpoint, readEndpoint, removeEndpoint, writeEndpoint, type Endpoint } from "./endpoint";
import type { Address } from "../transport/address";
import { readSpawnConfigIn, type SpawnConfig } from "../cli/spawn-config";
import { bearFront, harnessBin } from "../spawn/birth";
import { isNewbornWorktree, nextFrontIndexIn, removeWorktreeIfClean, type WorktreeRemoval } from "../spawn/worktree";

/** How many skipped journal entries are named before the rest become a count. */
const MAX_NAMED_FAILURES = 3;

/**
 * How many texts the encoder backfill hands over per round trip.
 *
 * Small on purpose. The sidecar embeds one text at a time whatever it is given,
 * so a large chunk buys no throughput — it only delays the moment those
 * vectors reach the index and get persisted. Sixteen keeps a first activation
 * making visible progress while a person watches it.
 */
const ENCODER_DRAIN_CHUNK = 16;

interface Conn {
  socket: Socket;
  decoder: Decoder;
  participantId: string | null;
  authed: boolean;
  /**
   * Frames from one connection apply in the order they arrived, even when one
   * of them has to wait for an encoder. Without this, a query that pauses for a
   * forward pass could be overtaken by the write that came after it, and a
   * caller would see its own two commands land backwards.
   */
  chain: Promise<void>;
}

/**
 * The two ways a brain can exist, and the reason they cannot share one shape.
 *
 * A static model is a table this process owns: embedding is a synchronous
 * function call, so a note is searchable the instant it is written and a query
 * is ranked inside the same tick that received it.
 *
 * An encoder is a separate process holding a transformer. Every embedding is a
 * message and an await. Both end at the same `VectorIndex` and the same fusion
 * with the lexical floor — the difference is entirely in when the vector shows
 * up, which is why the union is here rather than behind one `embed()` that
 * pretends the two are alike.
 */
type BrainRuntime =
  | { kind: "static"; model: StaticModel; calibration: Calibration; vectors: VectorIndex }
  | { kind: "encoder"; model: EncoderBrainModel; encoder: EncoderHandle; vectors: VectorIndex };

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
   * Where model files live. Defaults (via `modelPath`, `download.ts`) to the
   * real machine-local models directory so every production caller is
   * unchanged; tests inject a throwaway directory instead, the same
   * discipline `download.ts` already keeps for `ensureModel`.
   */
  modelsDir?: string;
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

/**
 * What a thrown value says about itself, without trusting it to be an Error.
 *
 * `restore` catches whatever a reducer threw, and `(e as Error).message` is a
 * cast rather than a check — the same shape as the `frame.tasks as PlanTask[]`
 * this branch removed. `throw null` would make the REPORTER throw inside its
 * own catch and take the boot down anyway, which is exactly the failure that
 * catch exists to end, and the same one the `?.` on `entry.frame.op` fixes one
 * expression earlier.
 *
 * Nothing here calls `toString` on the value. A reporting line for a poisoned
 * journal is not the place to run code the journal supplied.
 *
 * Not reachable today: every `throw` under `src/` raises an `Error` (or
 * `NotARepository`, which extends one) and the engine's own throws are Errors
 * too. So this pins the shape against deletion and can never go red for a live
 * bug — the same trade the `livePlanItems` breadth test makes.
 */
export function thrownMessage(e: unknown): string {
  if (e instanceof Error && typeof e.message === "string") return e.message;
  if (typeof e === "string") return e;
  return `a value that is not a readable Error (${e === null ? "null" : typeof e})`;
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
  /** Fronts parley started that have not reached the bus yet, and what each one already cost on disk. */
  private readonly pendingBirth =
    new Map<string, { atMs: number; mode: "panel" | "terminal"; worktree: string }>();
  /** Removals in flight. Nothing waits on these except `close`. */
  private readonly collecting = new Set<Promise<void>>();
  private readonly removeWorktree: typeof removeWorktreeIfClean;
  private readonly token: string | null;
  private readonly now: () => number;
  /**
   * Held here, not in `state`: an index is derived and a search is not a pure
   * function of `(state, frame, ctx)`. The daemon is long-lived and resolves
   * `q` into ids before `apply` ever sees the frame, so `src/state/` only
   * ever sees data.
   */
  private readonly index: LexicalIndex;
  /**
   * The optional layer above the lexical floor. `null` whenever the brain is
   * off, or its model is missing, corrupt, or not in the registry — every
   * one of those degrades silently to the floor rather than erroring, so
   * this field being `null` is never itself a failure state.
   */
  private brain: BrainRuntime | null = null;
  /**
   * Texts waiting for the encoder, and the pump draining them.
   *
   * A static model embeds in microseconds, so a note becomes searchable inside
   * the same tick that wrote it. An encoder takes tens of milliseconds and a
   * forward pass cannot be made to happen inside a synchronous reducer, so the
   * work is queued here and applied when it lands.
   *
   * That delay is deliberate and it is the deal this feature makes: for a short
   * window a brand new note is findable lexically but not semantically. The
   * alternative — holding the write until the vector exists — would put a
   * model's latency on the path of somebody saving a note, which is the one
   * place parley has never been willing to spend time.
   */
  private encoderQueue: { id: string; kind: Hit["kind"]; text: string }[] = [];
  private encoderPump: Promise<void> | null = null;
  /**
   * Whether the bus has already been told, for the *current* activation
   * attempt, that this daemon cannot actually load what `state.brain`
   * records as active. Reset at the top of every `loadBrain()` call — enable,
   * disable, or a fresh boot — so a new attempt always earns its own
   * one-time notice rather than inheriting silence from the last one. Never
   * persisted: it is a fact about this process's ability to load a file
   * right now, not a change to the bus's shared state.
   */
  private brainLoadNudged = false;
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
    // Not persisted on purpose: a restart already rebuilds `state` from the
    // journal, and the index is a read-side structure with nothing of its own
    // to lose — rebuilding it here is the same story as restoring state.
    this.index = indexFromState(this.state);
    this.loadBrain();
    this.lastActivityMs = this.now();
  }

  /**
   * Reflects `state.brain` into a loaded model plus its vector index, or
   * clears both. Called on boot (replaying whatever the journal already
   * decided) and again every time a `brain` frame is accepted, so enabling
   * takes effect immediately rather than after a restart.
   *
   * Vectors persist beside the journal (`vectors.ts`) so a restart does not
   * re-embed the whole corpus; when nothing is on disk yet — first
   * activation — every note and result already in `state` is embedded once,
   * right here, so there is no window where old knowledge is invisible to
   * semantic recall.
   *
   * Every failure mode — unknown registry name, missing file, corrupt JSON,
   * a disk error while backfilling — degrades to `this.brain = null`, never
   * a throw. A broken model must never stop the daemon, only turn off the
   * extra signal it was offering.
   */
  private loadBrain(): void {
    // Whatever was running belongs to the model that was active a moment ago.
    // Enabling a different one, or disabling, has to take that process with it
    // — otherwise switching models leaks a resident transformer per switch.
    if (this.brain?.kind === "encoder") this.brain.encoder.close();
    this.encoderQueue = [];
    this.brain = null;
    this.brainLoadNudged = false;
    if (!this.state.brain.active || !this.state.brain.model) return;
    try {
      const model = findModel(this.state.brain.model);
      if (!model) return;
      if (isEncoder(model)) {
        this.loadEncoderBrain(model);
        return;
      }
      const staticModel = loadStaticModel(modelPath(model, this.opts.modelsDir));
      if (!staticModel) return;

      // No calibration, no brain. A model that cannot say what unrelated text
      // scores like on its own table has not earned the right to say what
      // related text scores like, and inventing a boundary for it would be
      // the exact mistake the two previous floors made. Degrading here is the
      // same honest degrade as a missing file: `reconcileBrainAnnouncement`
      // and `maybeNudgeBrainLoadFailure` already tell the bus about it.
      const calibration = calibrate(staticModel);
      if (!calibration) {
        process.stderr.write(
          `parley: ${model.name} could not be calibrated (its vocabulary is too small to measure a ` +
            `relevance floor against) — the lexical floor is answering instead\n`,
        );
        return;
      }

      const dir = dirname(this.opts.journalPath);
      let vectors = loadVectors(dir, staticModel.dims, calibration.floor);
      if (!vectors) {
        vectors = new VectorIndex(staticModel.dims, calibration.floor);
        for (const note of this.state.notes) {
          if (note.reversedBy !== null) continue;
          vectors.add(
            note.id,
            this.vectorFor(staticModel, calibration, [note.title, note.body, note.tags.join(" "), note.paths.join(" ")].join(" ")),
            note.kind,
          );
        }
        for (const result of Object.values(this.state.results)) {
          vectors.add(
            result.key,
            this.vectorFor(staticModel, calibration, [result.key, result.summary, result.paths.join(" ")].join(" ")),
            "result",
          );
        }
        saveVectors(dir, vectors);
      }
      this.brain = { kind: "static", model: staticModel, calibration, vectors };
    } catch (e) {
      process.stderr.write(`parley: brain load failed, falling back to the lexical floor: ${(e as Error).message}\n`);
    }
  }

  /**
   * The encoder half of `loadBrain`.
   *
   * Nothing here blocks. `startEncoder` returns as soon as the process is
   * spawned — the model is still loading, and will be for several seconds —
   * and the backfill that follows runs in the background. Until both finish,
   * `this.brain.vectors` is simply smaller than the corpus and the lexical
   * floor answers everything the vectors cannot, which is what it does when
   * the brain is off entirely.
   *
   * A sidecar that never becomes ready is not an error state to recover from:
   * `EncoderHandle` answers `null` forever after, every caller here treats
   * `null` as "no semantic signal", and the daemon keeps working.
   */
  private loadEncoderBrain(model: EncoderBrainModel): void {
    const encoder = startEncoder(this.opts.modelsDir, model);
    if (!encoder) {
      process.stderr.write(
        `parley: ${model.name} is enabled but its runtime is not installed — run "parley brain enable ` +
          `${model.name}" in a shell to install it; the lexical floor is answering meanwhile\n`,
      );
      return;
    }

    const dir = dirname(this.opts.journalPath);
    const vectors = loadVectors(dir, model.dims, model.spec.floor) ?? new VectorIndex(model.dims, model.spec.floor);
    this.brain = { kind: "encoder", model, encoder, vectors };

    // Anything already in state that the persisted index does not have. On a
    // first activation that is the whole corpus; on a restart it is usually
    // nothing, because the vectors outlive the process.
    for (const note of this.state.notes) {
      if (note.reversedBy !== null || vectors.has(note.id)) continue;
      this.encoderQueue.push({
        id: note.id,
        kind: note.kind,
        text: [note.title, note.body, note.tags.join(" "), note.paths.join(" ")].join(" "),
      });
    }
    for (const result of Object.values(this.state.results)) {
      if (vectors.has(result.key)) continue;
      this.encoderQueue.push({
        id: result.key,
        kind: "result",
        text: [result.key, result.summary, result.paths.join(" ")].join(" "),
      });
    }
    this.drainEncoderQueue();
  }

  /**
   * Embeds queued texts one at a time, forever, while there is anything queued.
   *
   * Single-flight by construction: `encoderPump` is the one in-flight drain and
   * every caller either joins it or starts it. Sequential rather than batched
   * because the sidecar serialises anyway (one onnxruntime session), and
   * because a batch would pad short texts and quietly cost accuracy — the same
   * pooling trap that showed up while choosing these models.
   */
  private drainEncoderQueue(): void {
    if (this.encoderPump) return;
    this.encoderPump = (async () => {
      try {
        while (this.encoderQueue.length > 0) {
          const brain = this.brain;
          // Disabled, or switched models, while this was running. The queue is
          // already cleared by `loadBrain`; stopping here is what makes sure
          // nothing lands in an index that belongs to a different model.
          if (brain?.kind !== "encoder") return;

          const batch = this.encoderQueue.splice(0, ENCODER_DRAIN_CHUNK);
          const vectors = await brain.encoder.encode("passage", batch.map((e) => e.text));
          if (!vectors) return; // The sidecar is gone. The floor has the query.
          if (this.brain !== brain) return; // Swapped underneath the await.

          for (let i = 0; i < batch.length; i++) {
            const entry = batch[i]!;
            brain.vectors.add(entry.id, Float32Array.from(vectors[i]!), entry.kind);
          }
          this.saveBrainVectors();
        }
      } catch (e) {
        process.stderr.write(`parley: encoder backfill stopped: ${(e as Error).message}\n`);
      } finally {
        this.encoderPump = null;
        // Something arrived while the last chunk was in flight.
        if (this.encoderQueue.length > 0 && this.brain?.kind === "encoder") this.drainEncoderQueue();
      }
    })();
  }

  /**
   * The query side of the same seam.
   *
   * `null` means "no semantic signal for this query" and is a normal answer,
   * not a failure: brain off, sidecar not ready yet, sidecar dead. Every one of
   * those leaves the lexical ranking exactly as it would have been.
   */
  private async queryVector(text: string): Promise<Float32Array | null> {
    const brain = this.brain;
    if (!brain) return null;
    if (brain.kind === "static") return this.vectorFor(brain.model, brain.calibration, text);
    const vectors = await brain.encoder.encode("query", [text]);
    if (!vectors?.[0] || this.brain !== brain) return null;
    return Float32Array.from(vectors[0]);
  }

  /**
   * The one place text becomes a comparable vector: pool it, then take the
   * table's own centre of mass back out (`debias`, embed.ts). Everything
   * stored in the index and everything searched against it goes through here,
   * so a document and a query are never compared in two different spaces.
   */
  private vectorFor(model: StaticModel, calibration: Calibration, text: string): Float32Array {
    return debias(embed(model, text), calibration.mean);
  }

  /**
   * One document, into the vector half of the index.
   *
   * Static: done here and now, and persisted, because it costs microseconds.
   * Encoder: queued, because it costs a forward pass and this is called from
   * inside the write path — the note is already journaled and already answers
   * lexically, and making somebody wait on a transformer to finish saving it
   * would be the wrong trade.
   */
  private embedIntoIndex(id: string, kind: Hit["kind"], text: string): void {
    const brain = this.brain;
    if (!brain) return;
    if (brain.kind === "static") {
      brain.vectors.add(id, this.vectorFor(brain.model, brain.calibration, text), kind);
      this.saveBrainVectors();
      return;
    }
    this.encoderQueue.push({ id, kind, text });
    this.drainEncoderQueue();
  }

  /** Persists the vector index beside the journal; a failure here never surfaces as a write failure. */
  private saveBrainVectors(): void {
    if (!this.brain) return;
    try {
      saveVectors(dirname(this.opts.journalPath), this.brain.vectors);
    } catch (e) {
      process.stderr.write(`parley: could not persist vectors: ${(e as Error).message}\n`);
    }
  }

  /**
   * Corrects an already-computed `brain` outcome — response and broadcast —
   * before either one is sent, so what the caller and the bus are told
   * matches what `loadBrain` (called just before this, in `handle`) actually
   * managed. `state.brain.active` is the person's decision and stands
   * regardless; this only ever downgrades the *announcement* of it, never
   * the decision itself.
   *
   * Nothing to correct when the two already agree: truly on (`active` and
   * loaded), or truly off (`!active`, and `loadBrain` already cleared
   * `this.brain` for that same reason). Only the mismatch — recorded active,
   * not actually loaded — needs a correction.
   */
  private reconcileBrainAnnouncement(outcome: Outcome): void {
    if (!this.state.brain.active || this.brain) return;
    const response = outcome.response as unknown as Record<string, unknown>;
    response.loaded = false;
    response.note = `${this.state.brain.model} could not be loaded by this daemon — the lexical floor is answering instead`;
    for (const event of outcome.broadcast) {
      event.text = `${this.state.brain.model} was recorded as enabled, but this daemon could not load it — ` +
        `the lexical floor is answering for every front on this bus until that changes`;
    }
    // Only actually correcting the bus-wide broadcast counts as having told
    // anyone besides the direct caller; an empty broadcast (the state did
    // not change — e.g. re-enabling an already-active model that has since
    // stopped loading) leaves the ambient nudge armed to catch it instead.
    if (outcome.broadcast.length > 0) this.brainLoadNudged = true;
  }

  /**
   * The other half of the same finding: a mismatch discovered with no live
   * `brain` frame to correct — a fresh boot replaying a journal whose model
   * file has since gone missing or corrupt, or a disk error during a later
   * backfill. Checked cheaply on every request; the moment there is at least
   * one other connected, joined front to tell, it is told once and latches
   * (`brainLoadNudged`) until the next `loadBrain()` attempt.
   */
  private maybeNudgeBrainLoadFailure(): void {
    if (this.brainLoadNudged || !this.state.brain.active || this.brain) return;
    const sent = this.notifyAllConnected(
      `brain is recorded as enabled (${this.state.brain.model}), but this daemon could not load it — ` +
        `the lexical floor is answering until that changes`,
    );
    if (sent) this.brainLoadNudged = true;
  }

  /**
   * A daemon-local admin notice, not a bus event: it is never added to
   * `state.events` and never touches `state.seq` or `state.cursors`, since it
   * is a fact about *this* process's ability to load a file, not a change to
   * the replayable, journaled conversation every front shares. A different
   * daemon (after the file reappears, or a fresh restart) may succeed where
   * this one didn't, and history should not remember this as a bus event.
   */
  private notifyAllConnected(text: string): boolean {
    let sent = false;
    const event = {
      seq: this.state.seq, at: new Date(this.now()).toISOString(),
      kind: "system" as const, from: null, to: null, priority: "high" as const, text,
    };
    for (const conn of this.conns) {
      if (!conn.authed || !conn.participantId) continue;
      this.send(conn, { v: PROTOCOL_VERSION, op: "push", events: [event] });
      sent = true;
    }
    return sent;
  }

  /**
   * Rebuild from the journal. The whole point of writing before responding is
   * that this reconstruction is lossless up to the last completed line.
   *
   * An entry that THROWS is skipped and reported, not allowed to abort the
   * boot. `Journal.replay` already decided this question one layer down for a
   * line that will not parse — "a bus that will not boot because of one torn
   * line is worse than a bus missing its final event" — and an entry that
   * parses and then throws is the same damage one layer up. It is strictly
   * worse, in fact: the journal is written BEFORE the frame is applied, so a
   * frame that throws is on disk before anyone learns it is poison, and
   * without this a single such frame makes the repository undispatchable
   * forever. Restarting replays it. "A broken parley must never stop the work"
   * is the rule that outranks everything here, and not booting at all is the
   * most literal way there is to violate it.
   *
   * Three alternatives were weighed and rejected. Refusing to boot with a
   * repair message is the current behaviour with better prose, and the repair
   * is hand-editing the journal. Aborting the replay at the first failure
   * silently drops every event after it, which costs territory and history
   * that were never in question. Snapshotting the state before each entry so a
   * failure could be rolled back is O(state) per entry on the one structure
   * that grows without bound.
   *
   * So the cost is named instead of paid: `apply` mutates in place, so an
   * entry that throws part-way leaves what it had already written. Every
   * reducer that reads a frame is expected to validate at its boundary rather
   * than rely on this — `dispatchPlan` and `readPathList` both do, and the
   * plan hazard that motivated this refuses before it mutates anything.
   */
  private restore(mode: Mode): State {
    const state = initialState(mode);
    const { entries, discarded } = this.journal.replay();
    const failed: string[] = [];
    let orphaned = 0;
    entries.forEach((entry, index) => {
      const ms = Date.parse(entry.at);
      const at = Number.isNaN(ms) ? 0 : ms;
      try {
        // Não é um frame que alguém enviou — ver `BIRTH_STAMP_OP`. `tick` é o
        // que carimba o cooldown e `tick` nunca vai para o journal, então esta
        // é a única forma de uma janela que o parley já gastou continuar gasta
        // depois de um restart. `apply` não conhece esta op e nunca deve recebê-la.
        if (entry.frame.op === BIRTH_STAMP_OP) {
          state.lastBirthMs = at;
          return;
        }
        const outcome = apply(state, entry.actorId, entry.frame, makeCtx(at, this.counter), this.spawnConfig.maxFronts);
        // The blast radius of a skip, measured rather than assumed. A frame is
        // journaled under the participant id its connection was bound to, and
        // `handleFrame` only ever sets that binding from a join the reducer
        // ACCEPTED — so an entry whose actor is unknown on replay is one whose
        // join went with a skipped entry. That is the same loss one
        // indirection away, and it applies nothing at all, which is how
        // `skipped 1 journal entry` can mean a whole session.
        //
        // Counted only when something was actually lost — a discarded line or
        // an already-skipped entry. A refused entry is otherwise ordinary:
        // every frame is journaled, including the ones the reducer refused the
        // first time, so refusals on replay are the normal shape of a healthy
        // journal. `NOT_JOINED` under a real actor is reachable on a healthy
        // one too — two connections may share a session and so share an id,
        // and one of them leaving marks that participant gone — which is why
        // this is not simply counted always.
        //
        // A DISCARDED line is loss for the same reason a skipped entry is, and
        // that half is not defensive: a torn last line is exactly what
        // `kill -9` writes, and if the torn one was a join, the whole session
        // after it is orphaned with nothing skipped at all.
        if ((discarded.length > 0 || failed.length > 0) && entry.actorId !== null
          && !outcome.response.ok && outcome.response.error.code === "NOT_JOINED") orphaned += 1;
      } catch (e) {
        // Read through `?.`, because the reason an entry throws may be that
        // its frame is not an object at all — a reporting line that reads it
        // the direct way throws inside the handler and takes the boot down
        // anyway, which is the whole defect this exists to end. `thrownMessage`
        // is the same care one expression later, for the same reason.
        const op = String((entry.frame as Record<string, unknown> | null)?.op ?? "?");
        failed.push(`entry ${index + 1} (op ${op}, at ${entry.at}): ${thrownMessage(e)}`);
      }
    });
    // Nothing survives a restart connected; presence has to be re-proven.
    for (const p of Object.values(state.participants)) p.connected = false;
    if (discarded.length > 0) {
      process.stderr.write(
        `parley: discarded ${discarded.length} unreadable journal line(s); starting anyway\n`,
      );
    }
    if (failed.length > 0) {
      // Named, not counted: the operator repairing this needs to know which
      // op poisoned the log, and the journal is never rewritten from here —
      // that would destroy the evidence while it is still the only copy.
      // The count is entries, not damage, and saying only the count tells an
      // operator that one entry was lost when a whole session may have gone
      // with it. Both lines below exist to stop that: the first because a
      // dependent loss is not always a participant (a skipped `claim` makes a
      // later `release` refuse too), the second because the participant case
      // is the one that can actually be measured here.
      process.stderr.write(
        `parley: skipped ${failed.length} journal entry(ies) that could not be replayed; starting anyway\n` +
          failed.slice(0, MAX_NAMED_FAILURES).map((f) => `  ${f}\n`).join("") +
          (failed.length > MAX_NAMED_FAILURES ? `  ...and ${failed.length - MAX_NAMED_FAILURES} more\n` : "") +
          "  whatever depended on a skipped entry is refused on replay and writes nothing," +
          " so this counts entries, not the state they would have written\n",
      );
    }
    // Reported on its own, because the loss it measures belongs to a discarded
    // line just as much as to a skipped entry, and the operator reading either
    // count needs the same correction: a lost `join` costs everything its
    // session did, and none of it appears in the number above.
    if (orphaned > 0) {
      process.stderr.write(
        `parley: ${orphaned} journal entry(ies) named a participant that no surviving entry joined` +
          " — a lost join takes its whole session with it\n",
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
      chain: Promise.resolve(),
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

  /**
   * Every frame is appended to this connection's chain rather than run on the
   * spot.
   *
   * With a static brain — or none — each link settles in a microtask and this
   * is the same behaviour as calling `handle` directly. With an encoder, one
   * frame can genuinely wait on another process, and the chain is what keeps a
   * caller's own frames in the order it sent them.
   *
   * A rejected link must not poison the chain: one frame failing is a failure
   * of that frame, and the connection has to stay usable for the next one.
   */
  private onData(conn: Conn, chunk: string): void {
    for (const line of conn.decoder.push(chunk)) {
      if (!line.ok) {
        this.send(conn, err("UNKNOWN_OP", line.error));
        continue;
      }
      const frame = line.frame;
      conn.chain = conn.chain.then(
        () => this.handle(conn, frame),
        () => this.handle(conn, frame),
      ).catch((e: unknown) => {
        process.stderr.write(`parley: frame handling failed: ${(e as Error).message}\n`);
      });
    }
  }

  private async handle(conn: Conn, frame: Record<string, unknown>): Promise<void> {
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

    // Cheap on every request; only ever does anything the first time there is
    // someone connected to tell about a `state.brain.active` this particular
    // daemon process cannot honor (a fresh boot replaying a journal whose
    // model has since gone missing or corrupt — the silent branches the
    // review named). Latches via `brainLoadNudged` once it actually reaches
    // someone.
    this.maybeNudgeBrainLoadFailure();

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

    // The journal keeps exactly the frame that came over the wire; ranking
    // only touches the copy handed to `apply`, so a replay never has to agree
    // with what the index looked like at write time.
    let toApply = frame;
    if ((frame.op === "notes" || frame.op === "results") && typeof frame.q === "string" && frame.q.trim()) {
      try {
        const k = typeof frame.k === "number" ? Math.max(1, Math.min(20, frame.k)) : 5;
        // `search` ranks across every kind in one corpus-wide score, and its
        // distinctiveness threshold is a property of the whole corpus — a
        // term's document frequency does not mean anything as "half of just
        // the notes". So `k` cannot be handed to `search` directly: the top-k
        // across all kinds can be entirely the other op's kind, which would
        // starve this op of a real match it actually has. Asking for up to
        // the whole index back costs almost nothing extra, because `search`
        // already scores and sorts every candidate before slicing — the
        // kind filter below only changes where the slice happens.
        const wantsNote = frame.op === "notes";
        const lexicalHits = this.index.search(frame.q, this.index.size);
        // Strictly additive: when the brain is off, missing, or corrupt,
        // `vectorHits` is empty and `fuse` degrades to exactly the lexical
        // ranking — the same floor this daemon has always answered from.
        const queryVector = await this.queryVector(frame.q);
        const vectorHits =
          this.brain && queryVector ? this.brain.vectors.search(queryVector, this.brain.vectors.size) : [];
        const hits = fuse(lexicalHits, vectorHits, this.index.size + vectorHits.length)
          .filter((h) => (wantsNote ? h.kind !== "result" : h.kind === "result"));
        toApply = { ...frame, ids: hits.slice(0, k).map((h) => h.id), ranked: true };
      } catch (e) {
        // A broken index must never take the query down with it — the honest
        // degrade is the same unranked list a plain notes/results call gets.
        process.stderr.write(`parley: query resolution failed: ${(e as Error).message}\n`);
      }
    }

    // `summon`'s ceiling check reads this fifth argument (see its doc comment
    // in src/state/machine.ts) — without it, `summon` was refused/granted
    // against the hardcoded default of 6, never against what this repository
    // actually configured in `spawn.json`.
    const outcome = apply(this.state, conn.participantId, toApply, ctx, this.spawnConfig.maxFronts);

    // A person just changed `state.brain` — enabled, disabled, or switched
    // models. Reloading here, rather than waiting for a restart, is what
    // makes that decision take effect immediately: enabling backfills every
    // note already in state (see `loadBrain`), and disabling drops the
    // vector index from memory right away. Done *before* the response and
    // broadcast below are sent — never after — so both can be corrected by
    // `reconcileBrainAnnouncement` if what actually loaded does not match
    // what was just recorded, instead of the bus being told a success that
    // this same function already knows, one line later, was not real.
    if (frame.op === "brain" && outcome.response.ok) {
      this.loadBrain();
      this.reconcileBrainAnnouncement(outcome);
    }
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

    // Only these three ops can change what search should see; rebuilding the
    // whole index on every write would make every write's cost grow with the
    // corpus, on a daemon meant to run a whole working day. A rejected frame
    // never reaches here, so the index can never diverge from what was
    // actually accepted.
    if (outcome.response.ok) this.maintainIndex(String(frame.op), outcome.response as Record<string, unknown>);
  }

  /**
   * `note` adds one document; `reverse` removes one — a reversed note no
   * longer binds and `indexFromState` skips it on a fresh rebuild, so a live
   * daemon has to enforce the same rule itself instead of waiting for a
   * restart; `result` adds or replaces one keyed by its `key`. Nothing else
   * touches the corpus.
   *
   * The vector twin rides along on the same three ops, whenever the brain is
   * actually loaded — embedding is cheap (microseconds, no forward pass), and
   * keeping it here rather than a second pass over `state` later is what
   * lets a restart skip re-embedding entirely (`vectors.ts`).
   */
  private maintainIndex(op: string, response: Record<string, unknown>): void {
    try {
      if (op === "note") {
        const id = typeof response.id === "string" ? response.id : null;
        const entry = id ? this.state.notes.find((n) => n.id === id) : undefined;
        if (entry) {
          const text = [entry.title, entry.body, entry.tags.join(" "), entry.paths.join(" ")].join(" ");
          this.index.add(entry.id, entry.kind, text);
          this.embedIntoIndex(entry.id, entry.kind, text);
        }
      } else if (op === "reverse") {
        const id = typeof response.id === "string" ? response.id : null;
        if (id) {
          this.index.remove(id);
          if (this.brain) {
            this.brain.vectors.remove(id);
            // A note reversed while its vector was still queued must not be
            // embedded afterwards — the drain would put back exactly what this
            // line just removed, and the note would answer queries again.
            this.encoderQueue = this.encoderQueue.filter((e) => e.id !== id);
            this.saveBrainVectors();
          }
        }
      } else if (op === "result") {
        const key = typeof response.key === "string" ? response.key : null;
        const entry = key ? this.state.results[key] : undefined;
        if (entry) {
          const text = [entry.key, entry.summary, entry.paths.join(" ")].join(" ");
          this.index.add(entry.key, "result", text);
          this.embedIntoIndex(entry.key, "result", text);
        }
      }
    } catch (e) {
      // The write already succeeded and is already journaled; a failure here
      // must never surface as if the command itself had failed.
      process.stderr.write(`parley: index update failed: ${(e as Error).message}\n`);
    }
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
    this.pendingBirth.set(born.name, { atMs: ctx.nowMs, mode: born.mode, worktree: born.worktree });
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
  /**
   * What a birth that never arrived left behind.
   *
   * `bearFront` creates the worktree *before* it spawns, so a terminal that
   * opens and prints `claude: command not found` has already produced
   * `.parley/worktrees/pool-N` and a `parley/pool-N` branch. That front never
   * joins and never leaves, so nothing ever asked for it to be collected — and
   * `nextFrontIndexIn` reads the surviving branch and skips that index for
   * ever after. `sweepBirths` announced the silence and collected nothing, so
   * a repository whose PATH is wrong accumulated one full checkout per
   * BIRTH_COOLDOWN_MS, permanently.
   *
   * Handed to the same queue a departed front's worktree goes into, so it
   * inherits every lock already there: only under `.parley/worktrees/`, only
   * with nobody standing in it, only if it is clean, retried and then said out
   * loud. A newborn that joins late — after BIRTH_JOIN_GRACE_MS — cancels its
   * own collection by being in there, exactly like a front that came back.
   */
  private collectAbandonedBirth(name: string, cwd: string): void {
    const root = this.repoRootForExport();
    if (!root || !cwd || !isNewbornWorktree(root, cwd)) return;
    // Keyed by the birth, not by a participant: there is no participant. The
    // prefix is what keeps it from ever colliding with one.
    this.pendingCollection.set(`birth:${name}`, {
      name, cwd, sinceMs: this.now(), attempts: 0, collecting: false,
    });
  }

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
      // a newborn that joined, worked and left did reach the bus. But it has
      // to have joined *after* this birth — names are reused, indices restart
      // when the branches behind them are collected, and a `gone` POOL-1
      // replayed out of the journal is not evidence that today's POOL-1
      // arrived. Matching on the name alone lost the announcement entirely
      // after any restart that reset the index.
      if (Object.values(this.state.participants).some(
        (p) => p.name === name && !(Date.parse(p.joinedAt) < pending.atMs),
      )) {
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
      this.collectAbandonedBirth(name, pending.worktree);
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
    // The sidecar is a child process holding a model in memory. Nothing else
    // will reap it: it reads this daemon's pipe, and a daemon that exits
    // without saying so leaves a resident transformer behind.
    if (this.brain?.kind === "encoder") this.brain.encoder.close();
    this.encoderQueue = [];
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
