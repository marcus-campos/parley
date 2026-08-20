import { err, ok } from "../protocol/types";
import { matchesPath, normalizeTerritoryPath, readPathList } from "../repo/paths";
import { actorOf, pushEvent, type Ctx, type Note, type Outcome, type State } from "./types";

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

export function listNotes(state: State, frame: Record<string, unknown>): Outcome {
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
  return { state, response: ok({ notes }), broadcast: [] };
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
