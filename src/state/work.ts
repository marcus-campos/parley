import { err, ok } from "../protocol/types";
import { matchesPath, readPathList } from "../repo/paths";
import { staleReason } from "./results";
import {
  actorOf, liveParticipants, pushEvent, type Ctx, type Outcome, type Participant, type State, type WorkItem,
} from "./types";

/**
 * Who already owns this path, if anyone.
 *
 * Possession is what routes discovered work — no plan, no parent. It buys the
 * first refusal and nothing more: the item is an offer, and the owner may drop
 * it. Otherwise the front that discovered the work would have acquired
 * authority over the front that holds the file, which is the hierarchy this
 * whole system exists to do without.
 *
 * Not the same function as `ownerOfPath` in `territory.ts`, on purpose: that one
 * serves permissions and may lean on the no-overlapping-live-claims invariant
 * `claim` enforces, while this one must still answer correctly when a replayed
 * journal has broken it. Different correctness contracts, so not collapsed.
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
      nudgedAtMs: null,
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

/**
 * Notes and results named by an item, resolved once so the taker never
 * rediscovers. A note carries its own truth (`reversedBy` travels with it
 * verbatim), but a `CommandResult` does not: staleness is a read-time
 * function of `(state, result)`, never stamped on the stored object, which
 * always claims `staleBecause: null`. Handing the raw record over would let
 * the taker trust a green result that an intervening touch already
 * invalidated — so it is recomputed here, the same way `listResults` does.
 */
function evidenceFor(state: State, item: { evidenceIds: string[] }) {
  return {
    notes: state.notes.filter((n) => item.evidenceIds.includes(n.id)),
    results: Object.values(state.results)
      .filter((r) => item.evidenceIds.includes(r.key))
      .map((r) => ({ ...r, staleBecause: staleReason(state, r) })),
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
  // done is terminal, same as takeWork and tick already treat it — a finisher
  // still holds takenById, so without this an already-delivered item could be
  // dropped and redone by someone else.
  if (item.state === "done") {
    return { state, response: err("NOT_TAKEN", "already done"), broadcast: [] };
  }
  if (item.offeredToId !== me.id && item.takenById !== me.id) {
    return { state, response: err("NOT_TAKEN", "not offered to you and not taken by you"), broadcast: [] };
  }

  item.state = "open";
  item.offeredToId = null;
  item.offeredAtMs = null;
  item.takenById = null;
  // A front handing work back is a new stale episode, not a continuation of
  // whichever one earned the last nudge — drop is supposed to be free, and it
  // would quietly stop being free if the pool remembered past the hand-back.
  item.nudgedAtMs = null;
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

/**
 * Is this front spare capacity right now?
 *
 * One definition, because there were two and they disagreed: `idleFronts`
 * treated a non-auto, non-orphaned claim as busy, and `shouldRetire` ignored
 * claims entirely — so a parley-born front that had claimed `src/api/**` with
 * a declared intent, provably mid-edit, was simultaneously "busy, do not ring
 * it" and "idle, retire it". Whichever of the two is right, they cannot both
 * be, and a front cannot be too busy to be offered work and idle enough to be
 * sent home in the same tick.
 *
 * A human watching the panel is filtered out: they are not a front to
 * dispatch to, and counting them as idle capacity would ring the bell at
 * someone who was never going to pick the item up.
 *
 * An auto-claim does not count as busy either: it is the footprint of an
 * edit, not a declaration of what a front is doing — a session that swept
 * the repository would otherwise look permanently occupied.
 */
function isIdleFront(state: State, p: Participant): boolean {
  if (p.kind !== "agent") return false;
  if (state.claims.some((c) => c.ownerId === p.id && !c.auto && c.orphanedAtMs === null)) return false;
  if (state.work.some((w) => w.state === "taken" && w.takenById === p.id)) return false;
  return true;
}

/**
 * A front parley created, idle, with an empty pool, has no reason to exist —
 * and every minute it stays is money. A front a person opened is never
 * retired, however idle it is: their session is theirs.
 *
 * `graceMs` is what stops a newborn being named on its very first tool call.
 * It is spawned because the pool was stale; between the intent and its first
 * `parley works` another front may well have emptied the pool, and without a
 * grace period the answer to "you were born ten seconds ago" would be "go
 * home" before it had any chance to read what it was born for.
 */
export function shouldRetire(state: State, p: Participant, ctx: Ctx, graceMs: number): boolean {
  if (p.born !== "parley" || p.gone) return false;
  if (!isIdleFront(state, p)) return false;
  const joinedMs = Date.parse(p.joinedAt);
  // A timestamp that will not parse is read as "just arrived", never as
  // "arrived long ago". Unreachable today — `joinedAt` is written by the
  // daemon's own clock — but the two directions are not equally wrong: one
  // costs a front one more grace period, the other retires it on sight.
  if (Number.isNaN(joinedMs) || ctx.nowMs - joinedMs < graceMs) return false;
  if (state.work.some((w) => w.state === "open" || w.state === "offered")) return false;
  return true;
}

/**
 * Alive fronts that are spare capacity — what the doorbell may address.
 *
 * In practice this only ever names a front holding a live connection.
 * `ORPHAN_POOL_MS` is longer than `LEASE_TTL_MS` on purpose: a front that has
 * gone this long without renewing its lease is not idle capacity waiting to
 * be pinged, it is a session waiting for a person to type — the same "on its
 * next tool call, possibly not soon" front `tick`'s rule 1 already declares
 * gone before the doorbell would get the chance to ring for it.
 */
export function idleFronts(state: State): Participant[] {
  return liveParticipants(state).filter((p) => isIdleFront(state, p));
}

const MAX_NAMED_OFFERS = 3;

/**
 * What this front needs to know about the pool, in the fewest lines that can
 * carry it.
 *
 * Named offers, then a count. Dumping the pool into every tool call would cost
 * more tokens than the pool saves — the whole point of ranking anything is that
 * the footer carries the top of it, never the corpus.
 */
export function poolFooterFor(state: State, participantId: string): string {
  if (state.shape === "bus") return "";

  const mine = state.work.filter((w) => w.state === "offered" && w.offeredToId === participantId);
  const open = state.work.filter((w) => w.state === "open");
  if (mine.length === 0 && open.length === 0) return "";

  const lines: string[] = [];
  for (const item of mine.slice(0, MAX_NAMED_OFFERS)) {
    lines.push(`  ${item.paths[0]} — ${item.title} (parley take ${item.id}, or parley drop ${item.id})`);
  }
  if (mine.length > MAX_NAMED_OFFERS) {
    lines.push(`  ${mine.length - MAX_NAMED_OFFERS} more offered to you — parley works --mine`);
  }
  if (open.length > 0) {
    lines.push(`  ${open.length} open in the pool, owned by nobody — parley works --state open`);
  }
  return `parley pool:\n${lines.join("\n")}`;
}

/**
 * A front asking outright for a hand, distinct from the tick-driven birth
 * intent: this one is spoken, not inferred from a stale pool. Same ceiling,
 * same cooldown stamp — a summon that lands under the ceiling still costs a
 * window, so a person spamming the command cannot bypass the rule that
 * governs the automatic path.
 */
export function summonCapacity(
  state: State,
  actorId: string | null,
  frame: Record<string, unknown>,
  ctx: Ctx,
  maxFronts: number,
): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const live = liveParticipants(state).filter((p) => p.kind === "agent").length;

  // The human's voice on spending (§4.7). `allow` present is a different frame
  // from `summon` without it — one settles whether parley may spend at all,
  // the other asks it to spend now — and only one of them is a person's.
  //
  // This carries its own `kind` check rather than joining a general observer
  // guard, because there is no general guard left to join: `feat/human-vote`
  // deleted the one that refused `grant`/`deny`, on the argument that
  // ownership decides who may answer, not kind. Spending somebody's money is
  // the one decision that runs the other way — it blocks an agent and lets
  // only a person through, which is the shape `brain` uses on that branch for
  // exactly the same reason.
  if (frame.allow !== undefined) {
    if (me.kind !== "human") {
      return {
        state,
        response: err(
          "OBSERVER_ONLY",
          "whether parley may start more fronts is the person's call, not a front's — it is somebody's money",
        ),
        broadcast: [],
      };
    }
    const allowed = frame.allow !== false;
    const changed = state.birthsAllowed !== allowed;
    state.birthsAllowed = allowed;
    return {
      state,
      response: ok({ birthsAllowed: allowed, maxFronts, live }),
      // Said once, on the change. Re-affirming a veto that is already in place
      // is not a louder veto.
      broadcast: changed
        ? [pushEvent(state, ctx, {
            kind: "system", from: null, to: null, priority: "high",
            text: allowed
              ? `${me.name} allowed parley to start fronts again`
              : `${me.name} stopped parley starting any more fronts — the pool stays open and the fronts already here keep working`,
            about: me.id,
          })]
        : [],
    };
  }

  // A front asking for a hand cannot spend past a person who said no. The
  // automatic path is refused in `canBearFront`; this is the same refusal on
  // the path somebody asks for by name, and it has to be here too, or the
  // veto would only hold for as long as nobody asked.
  if (!state.birthsAllowed) {
    return { state, response: err("NO_CAPACITY", "a person has stopped parley starting fronts"), broadcast: [] };
  }
  if (live >= maxFronts) {
    return { state, response: err("NO_CAPACITY", `already at ${maxFronts} front(s)`), broadcast: [] };
  }
  state.lastBirthMs = ctx.nowMs;
  const reason = typeof frame.reason === "string" && frame.reason ? frame.reason : "asked for";
  return {
    state,
    response: ok({ summoned: true, reason }),
    broadcast: [pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "high",
      text: `${me.name} asked for a front — ${reason}`,
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
