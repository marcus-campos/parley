import { err, ok, type Priority } from "../protocol/types";
import { actorOf, byName, pushEvent, type Ctx, type Outcome, type State } from "./types";

export function say(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const text = typeof frame.text === "string" ? frame.text : "";
  if (!text.trim()) return { state, response: ok({ seq: state.seq, ignored: true }), broadcast: [] };

  const to = typeof frame.to === "string" && frame.to.trim() ? frame.to.trim() : null;
  if (to && !byName(state, to)) {
    return { state, response: err("NOT_JOINED", `no live participant named ${to}`), broadcast: [] };
  }

  // A human always speaks with priority. The agent must not weigh it as peer
  // opinion — it guides without holding a veto.
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

  return { state, response: ok({ seq: event.seq }), broadcast: [event] };
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
      (e.to === null || e.to === me.name),
  );
}

export function drain(state: State, actorId: string | null, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const events = selectEvents(state, me.id);
  state.cursors[me.id] = state.seq;
  me.lastSeenMs = ctx.nowMs;

  return { state, response: ok({ events }), broadcast: [] };
}
