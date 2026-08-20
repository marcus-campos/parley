import { err, ok } from "../protocol/types";
import { readPathList } from "../repo/paths";
import { actorOf, pushEvent, type Ctx, type Outcome, type State, type WorkItem } from "./types";

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
    const item: WorkItem = {
      id: ctx.nextId("w"),
      paths: [path],
      title,
      evidenceIds,
      publishedById: me.id,
      publishedByName: me.name,
      kind,
      origin,
      state: "open",
      offeredToId: null,
      offeredAtMs: null,
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
      items: created.map((i) => ({ id: i.id, path: i.paths[0]!, state: i.state, offeredTo: null })),
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
