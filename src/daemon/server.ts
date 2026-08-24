import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { Journal, type JournalEntry } from "../journal/journal";
import { createDecoder, encodeFrame, type Decoder } from "../protocol/codec";
import { DEFAULTS, PROTOCOL_VERSION, err, type Mode } from "../protocol/types";
import { apply, initialState, makeCtx, tick } from "../state/machine";
import type { ConvEvent, Outcome, State } from "../state/types";
import { indexFromState, type LexicalIndex } from "../brain/lexical";
import { debias, embed, fuse, loadStaticModel, VectorIndex, type StaticModel } from "../brain/embed";
import { calibrate, type Calibration } from "../brain/calibrate";
import { loadVectors, saveVectors } from "../brain/vectors";
import { findModel } from "../brain/registry";
import { modelPath } from "../brain/download";
import { exportNotes } from "../notes/export";
import { newEndpoint, readEndpoint, removeEndpoint, writeEndpoint, type Endpoint } from "./endpoint";
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
  /**
   * Where model files live. Defaults (via `modelPath`, `download.ts`) to the
   * real machine-local models directory so every production caller is
   * unchanged; tests inject a throwaway directory instead, the same
   * discipline `download.ts` already keeps for `ensureModel`.
   */
  modelsDir?: string;
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
  private brain: { model: StaticModel; calibration: Calibration; vectors: VectorIndex } | null = null;
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

  constructor(private readonly opts: DaemonOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.journal = new Journal(opts.journalPath);
    this.token = opts.address.kind === "tcp" ? randomBytes(24).toString("hex") : null;
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
    this.brain = null;
    this.brainLoadNudged = false;
    if (!this.state.brain.active || !this.state.brain.model) return;
    try {
      const model = findModel(this.state.brain.model);
      if (!model) return;
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
      this.brain = { model: staticModel, calibration, vectors };
    } catch (e) {
      process.stderr.write(`parley: brain load failed, falling back to the lexical floor: ${(e as Error).message}\n`);
    }
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

    // Cheap on every request; only ever does anything the first time there is
    // someone connected to tell about a `state.brain.active` this particular
    // daemon process cannot honor (a fresh boot replaying a journal whose
    // model has since gone missing or corrupt — the silent branches the
    // review named). Latches via `brainLoadNudged` once it actually reaches
    // someone.
    this.maybeNudgeBrainLoadFailure();

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
        const vectorHits = this.brain
          ? this.brain.vectors.search(
              this.vectorFor(this.brain.model, this.brain.calibration, frame.q),
              this.brain.vectors.size,
            )
          : [];
        const hits = fuse(lexicalHits, vectorHits, this.index.size + vectorHits.length)
          .filter((h) => (wantsNote ? h.kind !== "result" : h.kind === "result"));
        toApply = { ...frame, ids: hits.slice(0, k).map((h) => h.id), ranked: true };
      } catch (e) {
        // A broken index must never take the query down with it — the honest
        // degrade is the same unranked list a plain notes/results call gets.
        process.stderr.write(`parley: query resolution failed: ${(e as Error).message}\n`);
      }
    }

    const outcome = apply(this.state, conn.participantId, toApply, ctx);

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
    if (frame.op === "leave" && outcome.response.ok) conn.participantId = null;

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
          if (this.brain) {
            this.brain.vectors.add(entry.id, this.vectorFor(this.brain.model, this.brain.calibration, text), entry.kind);
            this.saveBrainVectors();
          }
        }
      } else if (op === "reverse") {
        const id = typeof response.id === "string" ? response.id : null;
        if (id) {
          this.index.remove(id);
          if (this.brain) {
            this.brain.vectors.remove(id);
            this.saveBrainVectors();
          }
        }
      } else if (op === "result") {
        const key = typeof response.key === "string" ? response.key : null;
        const entry = key ? this.state.results[key] : undefined;
        if (entry) {
          const text = [entry.key, entry.summary, entry.paths.join(" ")].join(" ");
          this.index.add(entry.key, "result", text);
          if (this.brain) {
            this.brain.vectors.add(entry.key, this.vectorFor(this.brain.model, this.brain.calibration, text), "result");
            this.saveBrainVectors();
          }
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
   * The bus key is the git common dir, so for a normal checkout the worktree
   * root is its parent. A bare repository has no worktree and gets no file.
   */
  private repoRootForExport(): string | null {
    const common = this.opts.gitCommonDir;
    return basename(common) === ".git" ? dirname(common) : null;
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
