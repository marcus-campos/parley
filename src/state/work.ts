import { err, ok } from "../protocol/types";
import { matchesPath, readPathList } from "../repo/paths";
import { actorOf, liveParticipants, pushEvent, type Ctx, type Outcome, type State, type WorkItem } from "./types";

/**
 * Who already owns this path, if anyone.
 *
 * Possession is what routes discovered work — no plan, no parent. It buys the
 * first refusal and nothing more: the item is an offer, and the owner may drop
 * it. Otherwise the front that discovered the work would have acquired
 * authority over the front that holds the file, which is the hierarchy this
 * whole system exists to do without.
 */
export function ownerForPath(state: State, path: string, exceptId: string): string | null {
  const live = new Set(liveParticipants(state).map((p) => p.id));
  const candidates = state.claims.filter(
    (c) => c.orphanedAtMs === null && c.ownerId !== exceptId && live.has(c.ownerId) && matchesPath(c.pattern, path),
  );
  if (candidates.length === 0) return null;
  // Specific beats broad; on a tie the older claim wins. Deterministic, and the
  // loser is never consulted — this is a routing hint, not a permission.
  const best = candidates.reduce((a, b) => {
    const bySegments = b.pattern.split("/").length - a.pattern.split("/").length;
    if (bySegments !== 0) return bySegments > 0 ? b : a;
    const byWildcard = (a.pattern.includes("*") ? 1 : 0) - (b.pattern.includes("*") ? 1 : 0);
    if (byWildcard !== 0) return byWildcard > 0 ? b : a;
    return a.lastTouchMs <= b.lastTouchMs ? a : b;
  });
  return best.ownerId;
}

/**
 * A front publishes what it found. One item per path, because the unit of
 * territory is the path — which is what lets an owner refuse two files and keep
 * ten, and lets the pool receive exactly what was refused.
 */
export function publishWork(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  if (state.shape === "bus") {
    return { state, response: err("UNKNOWN_OP", "there is no pool in shape bus — parley shape pool"), broadcast: [] };
  }

  const title = typeof frame.title === "string" ? frame.title.trim() : "";
  if (!title) return { state, response: err("UNKNOWN_OP", "a work item needs a title"), broadcast: [] };

  const paths = readPathList(frame.paths);
  if (paths.length === 0) return { state, response: err("UNKNOWN_OP", "a work item needs at least one path"), broadcast: [] };

  const evidenceIds = Array.isArray(frame.evidence)
    ? frame.evidence.filter((e): e is string => typeof e === "string")
    : [];
  const kind = frame.kind === "review" ? "review" : "work";
  const origin = frame.origin === "planned" ? "planned" : "discovered";

  const created: WorkItem[] = [];
  for (const path of paths) {
    const ownerId = ownerForPath(state, path, me.id);
    const item: WorkItem = {
      id: ctx.nextId("w"),
      paths: [path],
      title,
      evidenceIds,
      publishedById: me.id,
      publishedByName: me.name,
      kind,
      origin,
      state: ownerId ? "offered" : "open",
      offeredToId: ownerId,
      offeredAtMs: ownerId ? ctx.nowMs : null,
      takenById: null,
      orphanedAtMs: null,
      reviewOf: typeof frame.reviewOf === "string" ? frame.reviewOf : null,
      at: ctx.now,
    };
    state.work.push(item);
    created.push(item);
  }
  me.lastSeenMs = ctx.nowMs;

  const broadcast = [pushEvent(state, ctx, {
    kind: "system", from: null, to: null, priority: "normal",
    text: `${me.name} published ${created.length} item(s): ${title}`,
    about: me.id,
  })];

  return {
    state,
    response: ok({
      items: created.map((i) => ({ id: i.id, path: i.paths[0]!, state: i.state, offeredTo: i.offeredToId })),
    }),
    broadcast,
  };
}

export function listWork(state: State, actorId: string | null, frame: Record<string, unknown>): Outcome {
  let work = state.work;
  const wanted = frame.state;
  if (wanted === "open" || wanted === "offered" || wanted === "taken" || wanted === "done") {
    work = work.filter((w) => w.state === wanted);
  }
  if (frame.mine === true && actorId) {
    work = work.filter((w) => w.offeredToId === actorId || w.takenById === actorId);
  }
  return { state, response: ok({ work }), broadcast: [] };
}

function findItem(state: State, frame: Record<string, unknown>) {
  return state.work.find((w) => w.id === String(frame.id ?? ""));
}

/** Notes and results named by an item, resolved once so the taker never rediscovers. */
function evidenceFor(state: State, item: { evidenceIds: string[] }) {
  return {
    notes: state.notes.filter((n) => item.evidenceIds.includes(n.id)),
    results: Object.values(state.results).filter((r) => item.evidenceIds.includes(r.key)),
  };
}

/**
 * Resolving the evidence here, on take, is why the front that picks the item
 * up does not repay the discovery. An item whose evidence does not travel is
 * a chat message that moved house.
 */
export function takeWork(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  const item = findItem(state, frame);
  if (!item) return { state, response: err("UNKNOWN_OP", "no work item with that id"), broadcast: [] };
  if (item.state === "taken" || item.state === "done") {
    return { state, response: err("CONFLICT", `already ${item.state}`), broadcast: [] };
  }
  // A right of first refusal, not a notification: while the offer stands,
  // only the offeree may take it. Letting anyone else grab it would hand them
  // work whose file they may not even be able to edit under an enforced
  // claim, and would leave Task 5's offer expiry with nothing to expire.
  if (item.state === "offered" && item.offeredToId !== me.id) {
    const holder = state.participants[item.offeredToId ?? ""];
    return {
      state,
      response: {
        ...err("CONFLICT", "offered elsewhere — it is not open yet"),
        offeredTo: { id: item.offeredToId, name: holder?.name ?? "(gone)", mission: holder?.mission ?? "" },
      },
      broadcast: [],
    };
  }

  item.state = "taken";
  item.takenById = me.id;
  item.offeredToId = null;
  item.offeredAtMs = null;
  item.orphanedAtMs = null;
  me.lastSeenMs = ctx.nowMs;

  return {
    state,
    response: ok({ id: item.id, title: item.title, paths: item.paths, evidence: evidenceFor(state, item) }),
    broadcast: [pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "normal",
      text: `${me.name} took ${item.paths[0]} — ${item.title}`,
      about: me.id,
    })],
  };
}

/**
 * Possession bought the owner the first refusal, not obedience. If the owner
 * could not refuse, the front that discovered the work would have acquired
 * authority over the front that holds the file — the exact hierarchy this
 * system exists to do without.
 */
export function dropWork(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  const item = findItem(state, frame);
  if (!item) return { state, response: err("UNKNOWN_OP", "no work item with that id"), broadcast: [] };
  // Dispatch is not an offer. A planned item stays where the plan put it.
  if (item.origin === "planned") {
    return { state, response: err("NOT_OWNER", "a planned item is dispatched, not offered — it cannot be dropped"), broadcast: [] };
  }
  if (item.offeredToId !== me.id && item.takenById !== me.id) {
    return { state, response: err("NOT_TAKEN", "not offered to you and not taken by you"), broadcast: [] };
  }

  item.state = "open";
  item.offeredToId = null;
  item.offeredAtMs = null;
  item.takenById = null;
  me.lastSeenMs = ctx.nowMs;
  const reason = typeof frame.reason === "string" ? frame.reason : "";

  return {
    state,
    response: ok({ id: item.id, state: item.state }),
    broadcast: [pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "normal",
      text: `${me.name} passed on ${item.paths[0]}${reason ? ` — ${reason}` : ""}; it is in the pool`,
      about: me.id,
    })],
  };
}

export function finishWork(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  const item = findItem(state, frame);
  if (!item) return { state, response: err("UNKNOWN_OP", "no work item with that id"), broadcast: [] };
  if (item.takenById !== me.id) {
    return { state, response: err("NOT_TAKEN", "you are not holding this item"), broadcast: [] };
  }

  item.state = "done";
  me.lastSeenMs = ctx.nowMs;
  const summary = typeof frame.summary === "string" ? frame.summary : "";

  return {
    state,
    response: ok({ id: item.id, state: item.state }),
    broadcast: [pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "normal",
      text: `${me.name} finished ${item.paths[0]}${summary ? ` — ${summary}` : ""}`,
      about: me.id,
    })],
  };
}
