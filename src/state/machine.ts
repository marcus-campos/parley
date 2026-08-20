import { DEFAULTS, PROTOCOL_VERSION, err, ok, type Mode } from "../protocol/types";
import { drain, history, say } from "./conversation";
import { listResults, recordResult } from "./results";
import { acknowledge, askFront, listQuestions, markNudged, questionStatus, replyToQuestion } from "./questions";
import { listNotes, note, reverse } from "./notes";
import { ask, deny, expirePermissions, grant, listRequests } from "./permissions";
import { join, leave, rename, who } from "./participants";
import { claim, release } from "./territory";
import { listWork, publishWork } from "./work";
import {
  actorOf, emptyState, liveParticipants, pushEvent,
  type ConvEvent, type Ctx, type Outcome, type State,
} from "./types";

export { emptyState } from "./types";

/**
 * What a human is refused. A human has a voice — `say` reaches every front at
 * high priority — but does not settle permission. Territory disputes are for
 * the agents to resolve among themselves; a human is never the tiebreaker, so
 * a stalled request cannot become a request for a person's attention.
 */
const AGENTS_ONLY_OPS = new Set(["grant", "deny"]);

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

  // Enforced here rather than in the panel on purpose: otherwise the rule would
  // only hold for as long as every interface behaved.
  if (me?.kind === "human" && AGENTS_ONLY_OPS.has(String(frame.op))) {
    return {
      state,
      response: err(
        "OBSERVER_ONLY",
        `a human has a voice, not a vote: ${String(frame.op)} is for the fronts to settle among themselves`,
      ),
      broadcast: [],
    };
  }

  switch (frame.op) {
    case "join": return join(state, frame, ctx);
    case "rename": return rename(state, actorId, frame, ctx);
    case "leave": return leave(state, actorId, ctx);
    case "who": return who(state, ctx);
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
    case "notes": return listNotes(state, frame);
    case "reverse": return reverse(state, actorId, frame, ctx);
    case "result": return recordResult(state, actorId, frame, ctx);
    case "results": return listResults(state, frame);
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

function status(state: State, ctx: Ctx): Outcome {
  return {
    state,
    response: ok({
      protocol: PROTOCOL_VERSION,
      mode: state.mode,
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
}

/**
 * Every time-driven rule in one place, driven by an injected clock. Nothing
 * below expires on its own — the daemon calls `tick` on a timer and before
 * each command, so a bus that no one touches never invents events.
 */
export function tick(state: State, ctx: Ctx, opts: TickOptions = {}): { state: State; broadcast: ConvEvent[] } {
  const autoTtl = opts.autoClaimTtlMs ?? DEFAULTS.AUTO_CLAIM_TTL_MS;
  const leaseTtl = opts.leaseTtlMs ?? DEFAULTS.LEASE_TTL_MS;
  const grace = opts.orphanGraceMs ?? DEFAULTS.ORPHAN_GRACE_MS;
  const broadcast: ConvEvent[] = [];

  // 1. A front that stopped renewing its lease is gone. A live connection is
  //    proof on its own, so only lease-only participants can expire this way.
  for (const p of liveParticipants(state)) {
    if (p.connected || ctx.nowMs - p.lastSeenMs <= leaseTtl) continue;
    p.gone = true;
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

  return { state, broadcast };
}

/** Deterministic Ctx factory for the daemon. Tests build their own. */
export function makeCtx(nowMs: number, counter: { n: number }): Ctx {
  return {
    now: new Date(nowMs).toISOString(),
    nowMs,
    nextId: (prefix: string) => `${prefix}_${(++counter.n).toString(36).padStart(4, "0")}`,
  };
}
