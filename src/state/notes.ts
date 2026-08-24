import { err, ok } from "../protocol/types";
import { matchesPath, normalizeTerritoryPath, readPathList } from "../repo/paths";
import { actorOf, pushEvent, type ConvEvent, type Ctx, type Note, type Outcome, type State } from "./types";

/** Knowledge anchored to a concrete path, newest last. */
export function notesForPath(state: State, path: string): Note[] {
  return state.notes.filter(
    (n) => n.reversedBy === null && n.paths.some((pattern) => matchesPath(pattern, path)),
  );
}

/** Decisions still standing. Few, binding, worth repeating to every front. */
export function activeDecisions(state: State): Note[] {
  return state.notes.filter((n) => n.kind === "decision" && n.reversedBy === null);
}

/**
 * `say` and `note` are separate because they have different useful lifetimes.
 * "CI is red on develop, fixed in branch X" is conversation — it dies resolved.
 * "`npx tsc --noEmit` checks nothing here" is knowledge that is worth something
 * to every future front, including the ones that do not exist yet.
 */
export function note(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const title = typeof frame.title === "string" ? frame.title.trim() : "";
  if (!title) return { state, response: err("UNKNOWN_OP", "a note needs a title"), broadcast: [] };

  const entry: Note = {
    id: ctx.nextId("n"),
    title,
    body: typeof frame.body === "string" ? frame.body : "",
    tags: Array.isArray(frame.tags) ? frame.tags.filter((t): t is string => typeof t === "string") : [],
    paths: readPathList(frame.paths),
    kind: frame.kind === "decision" ? "decision" : "note",
    reversedBy: null,
    authorId: me.id,
    authorName: me.name,
    at: ctx.now,
  };
  state.notes.push(entry);
  me.lastSeenMs = ctx.nowMs;

  // A decision binds every front, so it is announced. A note is not.
  const broadcast = entry.kind === "decision"
    ? [pushEvent(state, ctx, {
        kind: "system", from: null, to: null, priority: "high",
        text: `${me.name} recorded a decision: ${entry.title}. It stands until someone reverses it (parley reverse ${entry.id}).`,
      })]
    : [];

  return { state, response: ok({ id: entry.id, kind: entry.kind }), broadcast };
}

/**
 * A front asking for `semantic` recall cannot be blocked on a prompt it has no
 * way to answer — a model choice and a ~100MB download are the person's call
 * (see `brain` in machine.ts) — so the request is answered from the lexical
 * floor unconditionally. What it earns instead is one notice, and only one:
 * `askedAtMs` is the same once-only bookkeeping the permission and question
 * nudges elsewhere in `src/state/` already use, so a front that keeps asking
 * cannot turn this into noise.
 *
 * The once is bus-wide, not per-front, and deliberately so: it announces that
 * *somebody* wants semantic recall, which is a fact about the bus and needs
 * saying once, not once per front that happens to ask.
 *
 * Shared with `listResults` rather than duplicated there. `notes --query` and
 * `results --query` are the same request against two corpora — the daemon even
 * resolves them through the same ranking — so which of the two a front happens
 * to reach for should not decide whether the person ever hears about the
 * brain.
 */
export function brainNudge(state: State, frame: Record<string, unknown>, ctx: Ctx): ConvEvent[] {
  if (frame.semantic !== true || state.brain.active || state.brain.askedAtMs !== null) return [];
  state.brain.askedAtMs = ctx.nowMs;
  return [pushEvent(state, ctx, {
    kind: "system", from: null, to: null, priority: "high",
    text: "a front asked for semantic recall and the brain is off — `parley brain enable` to pick a model",
  })];
}

export function listNotes(state: State, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  let notes = state.notes;
  if (typeof frame.tag === "string" && frame.tag) {
    notes = notes.filter((n) => n.tags.includes(frame.tag as string));
  }
  if (typeof frame.path === "string" && frame.path) {
    try {
      const target = normalizeTerritoryPath(frame.path);
      notes = notes.filter((n) => n.paths.some((pattern) => matchesPath(pattern, target)));
    } catch { /* an unusable path filters nothing */ }
  }
  if (frame.kind === "decision" || frame.kind === "note") {
    notes = notes.filter((n) => n.kind === frame.kind);
  }
  if (frame.active === true) notes = notes.filter((n) => n.reversedBy === null);

  // The daemon resolves `q` into ranked `ids` before calling `apply` — this
  // module has no clock and no I/O, so it cannot search on its own. A direct
  // `apply` carrying a bare `q` (Task 5's tests call it that way, with no
  // daemon in front) has nothing to rank by, so `q` itself is never read here;
  // the honest degrade is the unranked list, not an attempt to search.

  const broadcast = brainNudge(state, frame, ctx);

  if (Array.isArray(frame.ids)) {
    const byId = new Map(notes.map((n) => [n.id, n]));
    const ranked = (frame.ids as unknown[])
      .map((id) => (typeof id === "string" ? byId.get(id) : undefined))
      .filter((n): n is Note => n !== undefined);
    return { state, response: ok({ notes: ranked, ranked: true }), broadcast };
  }

  return { state, response: ok({ notes }), broadcast };
}

/** Reversing a decision keeps it in the record and stops it binding. */
export function reverse(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const target = state.notes.find((n) => n.id === String(frame.id ?? ""));
  if (!target) return { state, response: err("UNKNOWN_OP", "no note or decision with that id"), broadcast: [] };
  if (target.reversedBy !== null) {
    return { state, response: err("UNKNOWN_OP", "already reversed"), broadcast: [] };
  }

  target.reversedBy = me.id;
  me.lastSeenMs = ctx.nowMs;
  const reason = typeof frame.reason === "string" ? frame.reason : "";

  return {
    state,
    response: ok({ id: target.id, reversed: true }),
    broadcast: [pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "high",
      text: `${me.name} reversed "${target.title}"${reason ? ` — ${reason}` : ""}. It no longer binds.`,
    })],
  };
}
