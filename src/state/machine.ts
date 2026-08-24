import { DEFAULTS, PROTOCOL_VERSION, err, ok, type Mode } from "../protocol/types";
import { findModel } from "../brain/registry";
import { drain, history, say } from "./conversation";
import { listResults, recordResult } from "./results";
import { acknowledge, askFront, listQuestions, markNudged, questionStatus, replyToQuestion } from "./questions";
import { listNotes, note, reverse } from "./notes";
import { ask, deny, expirePermissions, grant, listRequests } from "./permissions";
import { join, leave, rename, who } from "./participants";
import { claim, release } from "./territory";
import { dispatchPlan, dropWork, finishWork, idleFronts, listWork, publishWork, shouldRetire, summonCapacity, takeWork } from "./work";
import {
  actorOf, emptyState, liveParticipants, pushEvent,
  type ConvEvent, type Ctx, type Outcome, type State,
} from "./types";

export { emptyState } from "./types";

export function initialState(mode: Mode = "advisory"): State {
  return emptyState(mode);
}

/**
 * One command in, one outcome out. Mutates and returns `state` — "pure" here
 * means no I/O and no ambient clock, not structural immutability. That is the
 * property the tests depend on.
 */
export function apply(
  state: State,
  actorId: string | null,
  frame: Record<string, unknown>,
  ctx: Ctx,
  // Threaded from the daemon's SpawnConfig (Task 1) so `summon` is refused at
  // the same ceiling a repository configured for itself. Defaults to
  // SPAWN_DEFAULTS.maxFronts for every caller that has not wired it through —
  // tests included.
  maxFronts: number = 6,
): Outcome {
  const version = typeof frame.v === "number" ? frame.v : null;
  if (version !== null && version !== PROTOCOL_VERSION) {
    return {
      state,
      response: err(
        "PROTOCOL_MISMATCH",
        `this daemon speaks v${PROTOCOL_VERSION}, the client sent v${version}`,
        { server: PROTOCOL_VERSION, client: version },
      ),
      broadcast: [],
    };
  }

  const me = actorOf(state, actorId);
  if (me) me.lastSeenMs = ctx.nowMs;

  switch (frame.op) {
    case "join": return join(state, frame, ctx);
    case "rename": return rename(state, actorId, frame, ctx);
    case "leave": return leave(state, actorId, ctx);
    case "who": return who(state, ctx, maxFronts);
    case "say": return say(state, actorId, frame, ctx);
    case "drain": return drain(state, actorId, ctx);
    case "history": return history(state, actorId, frame);
    case "claim": return claim(state, actorId, frame, ctx);
    case "release": return release(state, actorId, frame, ctx);
    case "ask": return ask(state, actorId, frame, ctx);
    case "grant": return grant(state, actorId, frame, ctx);
    case "deny": return deny(state, actorId, frame, ctx);
    case "requests": return listRequests(state, frame, ctx, actorId);
    case "note": return note(state, actorId, frame, ctx);
    case "notes": return listNotes(state, frame, ctx);
    case "reverse": return reverse(state, actorId, frame, ctx);
    case "result": return recordResult(state, actorId, frame, ctx);
    case "results": return listResults(state, frame, ctx);
    case "question": return askFront(state, actorId, frame, ctx);
    case "reply": return replyToQuestion(state, actorId, frame, ctx);
    case "questions": return listQuestions(state, actorId, frame, ctx);
    case "ack": return acknowledge(state, actorId, frame, ctx);
    case "nudged": return markNudged(state, actorId, frame, ctx);
    case "question_status": return questionStatus(state, frame, ctx);
    case "mode": return setMode(state, frame, ctx);
    case "shape": return setShape(state, frame, ctx);
    case "status": return status(state, ctx);
    case "work": return publishWork(state, actorId, frame, ctx);
    case "works": return listWork(state, actorId, frame);
    case "take": return takeWork(state, actorId, frame, ctx);
    case "drop": return dropWork(state, actorId, frame, ctx);
    case "done": return finishWork(state, actorId, frame, ctx);
    case "brain": return brain(state, actorId, frame, ctx);
    case "plan": return dispatchPlan(state, actorId, frame, ctx);
    case "summon": return summonCapacity(state, actorId, frame, ctx, maxFronts);
    default:
      return { state, response: err("UNKNOWN_OP", `unknown op: ${String(frame.op)}`), broadcast: [] };
  }
}

function setMode(state: State, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const wanted = frame.mode;
  if (wanted === undefined) return { state, response: ok({ mode: state.mode }), broadcast: [] };
  if (wanted !== "off" && wanted !== "advisory" && wanted !== "enforced") {
    return { state, response: err("UNKNOWN_OP", `mode must be off, advisory or enforced`), broadcast: [] };
  }
  const before = state.mode;
  state.mode = wanted;
  if (before === wanted) return { state, response: ok({ mode: state.mode }), broadcast: [] };

  // The mode belongs to the repository, never to a session: if each session
  // picked, one in `advisory` would drive over the others and `enforced` would
  // be theatre.
  const event = pushEvent(state, ctx, {
    kind: "system", from: null, to: null, priority: "high",
    text: `mode changed: ${before} -> ${wanted} (applies to every front on this bus)`,
  });
  return { state, response: ok({ mode: state.mode, previous: before }), broadcast: [event] };
}

function setShape(state: State, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const wanted = frame.shape;
  if (wanted === undefined) return { state, response: ok({ shape: state.shape }), broadcast: [] };
  if (wanted !== "bus" && wanted !== "pool" && wanted !== "plan") {
    return { state, response: err("UNKNOWN_OP", "shape must be bus, pool or plan"), broadcast: [] };
  }
  const before = state.shape;
  state.shape = wanted;
  if (before === wanted) return { state, response: ok({ shape: state.shape }), broadcast: [] };

  return {
    state,
    response: ok({ shape: state.shape }),
    broadcast: [pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "high",
      text: `shape is now ${wanted} (was ${before}) — it belongs to the repository, not to a session`,
    })],
  };
}

/**
 * Status is a fact anyone on the bus can already infer is missing from a
 * `notes` response — refusing to just say it would only hide the reason a
 * front is stuck on the floor. Turning the brain on or off is a different
 * matter: a download this size and a model choice spend somebody's disk and
 * somebody's money, on somebody's machine, and an agent cannot answer the
 * interactive prompt that decision deserves on that person's behalf.
 *
 * This is the one op in the file gated on `kind` at all, and it runs the
 * opposite way from what a reader used to `grant`/`deny` might expect: it
 * blocks an agent and lets only a human through. Every other op, including
 * `grant` and `deny`, is open to a human the same as to an agent — ownership
 * decides who may answer, not kind. Spending someone's disk and someone's
 * money is the one decision that is never a front's to make, so the check
 * has to live here, on the opposite kind, rather than anywhere ownership-based.
 */
function brain(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const acting = frame.enable !== undefined || frame.disable !== undefined;
  if (!acting) {
    // `may_enable` lets a caller (the CLI) find out whether it is even worth
    // attempting a download before spending one byte on it — the daemon
    // already knows `me.kind` for free. This is a courtesy for callers that
    // choose to probe first; it is not the gate. A client that skips the
    // probe and sends `enable` directly is still refused below, by `me.kind
    // !== "human"`, exactly as before.
    const me = actorOf(state, actorId);
    return {
      state,
      response: ok({ active: state.brain.active, model: state.brain.model, may_enable: me?.kind === "human" }),
      broadcast: [],
    };
  }

  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  if (me.kind !== "human") {
    return {
      state,
      response: err(
        "OBSERVER_ONLY",
        "brain enable/disable is the person's call, not a front's — it is somebody's disk and somebody's money",
      ),
      broadcast: [],
    };
  }

  const before = { active: state.brain.active, model: state.brain.model };

  if (frame.disable === true) {
    state.brain.active = false;
    state.brain.model = null;
    // A fresh "off" period earns its own one-time panel nudge, same as the
    // period that started at first boot.
    state.brain.askedAtMs = null;
    return { state, response: ok({ active: false, model: null }), broadcast: brainChangeBroadcast(state, ctx, before) };
  }

  const name = String(frame.enable ?? "");
  const model = findModel(name);
  if (!model) {
    return { state, response: err("UNKNOWN_OP", `no such model in the registry: ${name}`), broadcast: [] };
  }
  state.brain.active = true;
  state.brain.model = model.name;
  state.brain.askedAtMs = null;
  return { state, response: ok({ active: true, model: model.name }), broadcast: brainChangeBroadcast(state, ctx, before) };
}

/**
 * `setMode` and `setShape` announce a changed bus-wide setting once, and
 * only when it actually changed — this is the same shape, deferred at Task 5
 * because nothing conditioned behaviour on `brain.active` yet. This task is
 * what changes that, so other fronts need to learn the brain came on (or
 * off) without polling `brain` for it.
 */
function brainChangeBroadcast(
  state: State, ctx: Ctx, before: { active: boolean; model: string | null },
): ConvEvent[] {
  const after = state.brain;
  if (before.active === after.active && before.model === after.model) return [];
  const text = after.active
    ? `brain enabled: ${after.model} (semantic recall now backs every front on this bus)`
    : `brain disabled (was ${before.model}) — back to the lexical floor for every front on this bus`;
  return [pushEvent(state, ctx, { kind: "system", from: null, to: null, priority: "high", text })];
}

function status(state: State, ctx: Ctx): Outcome {
  return {
    state,
    response: ok({
      protocol: PROTOCOL_VERSION,
      mode: state.mode,
      shape: state.shape,
      seq: state.seq,
      participants: liveParticipants(state).length,
      claims: state.claims.length,
      pending_requests: Object.values(state.requests).filter((r) => r.state === "pending").length,
      notes: state.notes.length,
    }),
    broadcast: [],
  };
}

export interface TickOptions {
  autoClaimTtlMs?: number;
  leaseTtlMs?: number;
  orphanGraceMs?: number;
  offerTtlMs?: number;
  orphanPoolMs?: number;
  /** Ceiling on live agent fronts. Same number `summon` is refused against. */
  maxFronts?: number;
  /** At most one birth intent per window, regardless of pool size. */
  birthCooldownMs?: number;
  /** How long a newborn is left alone before it can be invited to go home. */
  retireGraceMs?: number;
}

/**
 * What `tick` asks the daemon to do, never does itself. The state machine
 * decides that capacity is missing; spawning a process is a clock, a PID and
 * an exit code all at once, so it belongs on the other side of this line.
 */
export interface BirthIntent {
  reason: string;
  forItemIds: string[];
}

/**
 * Every time-driven rule in one place, driven by an injected clock. Nothing
 * below expires on its own — the daemon calls `tick` on a timer and before
 * each command, so a bus that no one touches never invents events.
 */
export function tick(
  state: State,
  ctx: Ctx,
  opts: TickOptions = {},
): { state: State; broadcast: ConvEvent[]; birth: BirthIntent | null; retire: string[]; died: string[] } {
  const autoTtl = opts.autoClaimTtlMs ?? DEFAULTS.AUTO_CLAIM_TTL_MS;
  const leaseTtl = opts.leaseTtlMs ?? DEFAULTS.LEASE_TTL_MS;
  const grace = opts.orphanGraceMs ?? DEFAULTS.ORPHAN_GRACE_MS;
  const broadcast: ConvEvent[] = [];
  /**
   * Who this tick just declared dead. §4.4 promises a newborn's worktree is
   * removed on death, and the only thing that ever asked for one was `leave` —
   * so a front killed by SIGKILL, by a crash, by a closed laptop, or by a
   * harness that never fires `SessionEnd` was marked `gone` (freeing the
   * ceiling, correctly) and kept its checkout and its branch for ever.
   *
   * Reported rather than acted on, for the same reason `birth` and `retire`
   * are: what is on disk is the daemon's business and never this file's.
   */
  const died: string[] = [];

  // 1. A front that stopped renewing its lease is gone. A live connection is
  //    proof on its own, so only lease-only participants can expire this way.
  for (const p of liveParticipants(state)) {
    if (p.connected || ctx.nowMs - p.lastSeenMs <= leaseTtl) continue;
    p.gone = true;
    died.push(p.id);
    const held = state.claims.filter((c) => c.ownerId === p.id);
    for (const c of held) c.orphanedAtMs = ctx.nowMs;
    broadcast.push(
      pushEvent(state, ctx, {
        kind: "system", from: null, to: null, priority: "high",
        text: held.length
          ? `${p.name} dropped holding ${held.length} claim(s): ${held.map((c) => c.pattern).join(", ")} — released in ${Math.round(grace / 1000)}s`
          : `${p.name} dropped`,
      }),
    );
  }

  // 2. Auto-claims decay. Without this, a front that swept the repository would
  //    end up owning half of it. Explicit claims never expire by inactivity.
  const staleAuto = state.claims.filter(
    (c) => c.auto && c.orphanedAtMs === null && ctx.nowMs - c.lastTouchMs > autoTtl,
  );
  if (staleAuto.length) {
    state.claims = state.claims.filter((c) => !staleAuto.includes(c));
    for (const c of staleAuto) {
      const owner = state.participants[c.ownerId];
      broadcast.push(
        pushEvent(state, ctx, {
          kind: "system", from: null, to: null, priority: "normal",
          text: `auto-claim on ${c.pattern} expired (${owner?.name ?? "gone"} stopped editing it)`,
        }),
      );
    }
  }

  // 3. Orphans are released after the grace period.
  const expiredOrphans = state.claims.filter(
    (c) => c.orphanedAtMs !== null && ctx.nowMs - c.orphanedAtMs > grace,
  );
  if (expiredOrphans.length) {
    state.claims = state.claims.filter((c) => !expiredOrphans.includes(c));
    broadcast.push(
      pushEvent(state, ctx, {
        kind: "system", from: null, to: null, priority: "normal",
        text: `released orphaned claim(s): ${expiredOrphans.map((c) => c.pattern).join(", ")}`,
      }),
    );
  }

  // 4. Unanswered permission requests are granted, loudly.
  broadcast.push(...expirePermissions(state, ctx));

  // 5. Rule 1 above already marks dead participants and stamps their claims;
  //    this stamps their work the same way, so a front that is merely
  //    restarting gets its item back instead of having to fight for it.
  const offerTtl = opts.offerTtlMs ?? DEFAULTS.OFFER_TTL_MS;

  for (const item of state.work) {
    if (item.state === "done") continue;

    if (item.state === "taken" && item.takenById) {
      const holder = state.participants[item.takenById];
      if (holder?.gone) {
        if (item.orphanedAtMs === null) item.orphanedAtMs = ctx.nowMs;
      } else {
        item.orphanedAtMs = null;
      }
      if (item.orphanedAtMs !== null && ctx.nowMs - item.orphanedAtMs > grace) {
        const name = holder?.name ?? "a front";
        item.state = "open";
        item.takenById = null;
        item.orphanedAtMs = null;
        // Same reset as a voluntary drop: back in the pool is a new episode.
        item.nudgedAtMs = null;
        broadcast.push(pushEvent(state, ctx, {
          kind: "system", from: null, to: null, priority: "normal",
          text: `${name} dropped holding ${item.paths[0]} — back in the pool`,
        }));
      }
      continue;
    }

    // An offer is exclusive — only the offeree may take it — for exactly this
    // long. Without an expiry, one unresponsive front could hold a file's
    // worth of work away from everybody forever.
    if (item.state === "offered" && item.offeredAtMs !== null && ctx.nowMs - item.offeredAtMs > offerTtl) {
      const owner = state.participants[item.offeredToId ?? ""];
      item.state = "open";
      item.offeredToId = null;
      item.offeredAtMs = null;
      // An offered item cannot have been nudged (rule 6 only stamps `open`
      // items) — reset anyway, so no path back to `open` is left to wonder
      // whether leaving it out was deliberate.
      item.nudgedAtMs = null;
      broadcast.push(pushEvent(state, ctx, {
        kind: "system", from: null, to: null, priority: "normal",
        text: `${owner?.name ?? "the owner"} did not answer on ${item.paths[0]} — it is in the pool`,
      }));
    }
  }

  // 6. A pool left open beside spare capacity is the failure this whole shape
  //    exists to prevent: nobody blocked, nothing broken, and an idle front
  //    that never learns there is something to pick up. Rung once per item —
  //    same discipline as the question and permission nudges — so a front
  //    that reads nothing is never pushed round in circles.
  const orphanPool = opts.orphanPoolMs ?? DEFAULTS.ORPHAN_POOL_MS;
  const stale = state.work.filter(
    (w) => w.state === "open" && ctx.nowMs - Date.parse(w.at) > orphanPool,
  );
  let birth: BirthIntent | null = null;
  if (stale.length > 0) {
    const idle = idleFronts(state);
    if (idle.length > 0) {
      // Recycle before creating. A front idle beside an orphan pool is the
      // larger waste, and reviving it costs nothing: no worktree, no
      // dependency install, no cold context. Creating is the fallback, never
      // the first move.
      //
      // `nudgedAtMs` governs *this* branch and only this one. It used to be
      // part of the `stale` filter above, which meant one ring disqualified an
      // item from ever asking for a front again: the idle front that was rung
      // could ignore it and go home, and no later tick would ever ask for
      // capacity for that item — `birth` stayed null at +400s, at +5000s and
      // at +50000s. And since recycling runs before creating by design, the
      // bell is the common path, so that permanently disarmed the birth path
      // for the majority of items. Ring once per item; ask for capacity
      // whenever there is nobody left to ring.
      const unrung = stale.filter((w) => w.nudgedAtMs === null);
      if (unrung.length > 0) {
        const target = idle[0]!;
        for (const w of unrung) w.nudgedAtMs = ctx.nowMs;
        broadcast.push(pushEvent(state, ctx, {
          // Addressed to the front it is about, same as ask/grant/deny — every
          // other front already gets the pool count from poolFooterFor on its
          // own next call, so broadcasting this too would only be noise for them.
          kind: "system", from: null, to: target.name, priority: "high",
          text: `${target.name} is idle and the pool has ${stale.length} open item(s) — parley works --state open, then parley take <id>`,
        }));
      }
    } else if (canBearFront(state, ctx, opts)) {
      // Stamped when the intent is emitted, not when a spawn succeeds. A
      // spawn that fails therefore costs one cooldown window and then asks
      // again — self-healing, and it cannot spin the way stamping on success
      // would if a permanently failing spawn were retried on every tick.
      state.lastBirthMs = ctx.nowMs;
      birth = {
        reason: `${stale.length} open item(s) and no idle front`,
        forItemIds: stale.map((w) => w.id),
      };
      broadcast.push(pushEvent(state, ctx, {
        kind: "system", from: null, to: null, priority: "high",
        text: `the pool has ${stale.length} open item(s) and nobody is idle — providing a front`,
      }));
    }
  }

  // 7. A newborn parley bore, idle, beside a pool that has gone empty, is not
  //    spare capacity waiting for work — it is money being spent on nobody
  //    working. A front a person opened never qualifies; `shouldRetire` is the
  //    line that keeps it that way.
  //
  //    Invited once, not once per tick. The discipline is stated ten lines
  //    above for the doorbell and it applies here for the same reason and one
  //    more: an invitation the front has already read, re-sent every five
  //    seconds and before every command it makes, is not a stronger
  //    invitation. `retireNudgedAtMs` clears the moment the front stops
  //    qualifying, so a pool that refills and empties again rings a second
  //    time — one ring per episode, not one per lifetime.
  const retireGrace = opts.retireGraceMs ?? DEFAULTS.RETIRE_GRACE_MS;
  const retire: string[] = [];
  for (const p of liveParticipants(state)) {
    if (!shouldRetire(state, p, ctx, retireGrace)) {
      p.retireNudgedAtMs = null;
      continue;
    }
    if (p.retireNudgedAtMs !== null) continue;
    p.retireNudgedAtMs = ctx.nowMs;
    retire.push(p.id);
  }

  return { state, broadcast, birth, retire, died };
}

/**
 * Whether `tick` may hand the daemon a birth intent: under the ceiling, and
 * outside the cooldown window. The daemon still decides whether the spawn
 * actually happens — this only decides whether the state machine is allowed
 * to ask.
 */
function canBearFront(state: State, ctx: Ctx, opts: TickOptions): boolean {
  // A person said no. Not a ceiling and not a cooldown — those bound how fast
  // parley may spend; this settles whether it may at all. Checked first
  // because it is the only one of the three that is somebody's decision rather
  // than a number.
  if (!state.birthsAllowed) return false;
  const ceiling = opts.maxFronts ?? 6;
  if (liveParticipants(state).filter((p) => p.kind === "agent").length >= ceiling) return false;
  const cooldown = opts.birthCooldownMs ?? DEFAULTS.BIRTH_COOLDOWN_MS;
  if (state.lastBirthMs !== null && ctx.nowMs - state.lastBirthMs < cooldown) return false;
  return true;
}

/** Deterministic Ctx factory for the daemon. Tests build their own. */
export function makeCtx(nowMs: number, counter: { n: number }): Ctx {
  return {
    now: new Date(nowMs).toISOString(),
    nowMs,
    nextId: (prefix: string) => `${prefix}_${(++counter.n).toString(36).padStart(4, "0")}`,
  };
}
