import { err, ok, type Priority } from "../protocol/types";
import {
  actorOf, byName, pushEvent,
  type ConvEvent, type Ctx, type Outcome, type Participant, type State,
} from "./types";
import { poolFooterFor } from "./work";

export function say(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const text = typeof frame.text === "string" ? frame.text : "";
  if (!text.trim()) return { state, response: ok({ seq: state.seq, ignored: true }), broadcast: [] };

  const to = typeof frame.to === "string" && frame.to.trim() ? frame.to.trim() : null;
  if (to && !byName(state, to)) {
    return { state, response: err("NOT_JOINED", `no live participant named ${to}`), broadcast: [] };
  }

  // A human always speaks with priority, and arrives marked as human. It guides
  // without holding a veto — the agent must not weigh it as one peer opinion
  // among many, and must not wait for it either.
  const priority: Priority =
    me.kind === "human" ? "high" : frame.priority === "high" ? "high" : "normal";

  me.lastSeenMs = ctx.nowMs;
  const event = pushEvent(state, ctx, {
    kind: "say",
    from: { id: me.id, name: me.name, kind: me.kind },
    to,
    priority,
    text,
  });

  // The event travels back with the receipt. `drain` deliberately never returns
  // your own messages — right for an agent, wrong for whoever is typing, who
  // otherwise gets no evidence at all that anything was sent.
  return { state, response: ok({ seq: event.seq, event }), broadcast: [event] };
}

/** Events this participant is entitled to and has not read yet. */
export function pendingFor(state: State, participantId: string): ReturnType<typeof selectEvents> {
  return selectEvents(state, participantId);
}

function selectEvents(state: State, participantId: string) {
  const me = state.participants[participantId];
  if (!me) return [];
  const cursor = state.cursors[participantId] ?? 0;
  return state.events.filter(
    (e) =>
      e.seq > cursor &&
      e.from?.id !== participantId &&
      e.about !== participantId &&
      visibleTo(e, me),
  );
}

/**
 * A directed message is private between two fronts — but not from the person
 * watching. A human is the observer of the whole bus: they are accountable for
 * what happens in this repository, and coordination they cannot see is
 * coordination they cannot correct. This is a local development tool, not a
 * privacy boundary between an agent and its operator.
 */
function visibleTo(event: ConvEvent, me: Participant): boolean {
  if (event.to === null) return true;
  if (event.to === me.name) return true;
  return me.kind === "human";
}

export function drain(state: State, actorId: string | null, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const events = selectEvents(state, me.id);
  state.cursors[me.id] = state.seq;
  me.lastSeenMs = ctx.nowMs;

  // The pool rides here rather than behind a second request: `drain` already
  // sits on the hottest path in the system (the hook's 30ms budget, every MCP
  // tool response), so this is the one call that reaches both without doubling
  // the round trips either channel pays for.
  return { state, response: ok({ events, pool: poolFooterFor(state, me.id) }), broadcast: [] };
}

/**
 * The last N events this participant is entitled to see, WITHOUT moving the read
 * cursor.
 *
 * A joining agent deliberately starts at the current sequence number — nobody
 * wants a fresh session flooded with an hour of backlog it cannot act on. A
 * panel is the opposite case: you open it precisely to see what has been going
 * on. So backlog is a separate request rather than a different kind of join.
 */
export function history(state: State, actorId: string | null, frame: Record<string, unknown>): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const raw = typeof frame.limit === "number" ? frame.limit : 200;
  const limit = Math.max(1, Math.min(1000, Math.floor(raw)));
  const since = typeof frame.since === "number" ? frame.since : 0;

  const events = state.events
    .filter((e) => e.seq > since && e.about !== me.id && (visibleTo(e, me) || e.from?.id === me.id))
    .slice(-limit);

  // `cursor` is where a plain `drain` would resume from, so a caller can hand
  // it back as `since` later — a deliberate re-read of a known window rather
  // than pulling the whole log again.
  return {
    state,
    response: ok({ events, cursor: state.cursors[me.id] ?? 0, seq: state.seq }),
    broadcast: [],
  };
}
