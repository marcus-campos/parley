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
