import { err, ok } from "../protocol/types";
import { actorOf, type Ctx, type Note, type Outcome, type State } from "./types";

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
    authorId: me.id,
    authorName: me.name,
    at: ctx.now,
  };
  state.notes.push(entry);
  me.lastSeenMs = ctx.nowMs;

  return { state, response: ok({ id: entry.id }), broadcast: [] };
}

export function listNotes(state: State, frame: Record<string, unknown>): Outcome {
  const tag = typeof frame.tag === "string" ? frame.tag : null;
  const notes = tag ? state.notes.filter((n) => n.tags.includes(tag)) : state.notes;
  return { state, response: ok({ notes }), broadcast: [] };
}
