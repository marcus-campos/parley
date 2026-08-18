import { err, ok, type ParticipantKind } from "../protocol/types";
import { resolvePendingOnRelease } from "./territory";
import {
  actorOf, byName, liveParticipants, publicParticipant, pushEvent,
  type Ctx, type Outcome, type Participant, type State,
} from "./types";

function suggestName(state: State, wanted: string): string {
  for (let n = 2; n < 100; n++) {
    const candidate = `${wanted}-${n}`;
    if (!byName(state, candidate)) return candidate;
  }
  return `${wanted}-${state.seq + 1}`;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

export function join(state: State, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const name = str(frame.name).trim();
  if (!name) return { state, response: err("NAME_TAKEN", "a name is required"), broadcast: [] };

  const taken = byName(state, name);
  if (taken) {
    // The CLI path is ephemeral: a hook connects, speaks and exits on every
    // tool call. Same name from the same worktree is the same front coming
    // back, so it re-attaches and renews its lease instead of colliding with
    // itself. A different worktree with the same name is a genuine collision.
    const sameWorktree = typeof frame.cwd === "string" && frame.cwd !== "" && frame.cwd === taken.cwd;
    if (sameWorktree) {
      taken.lastSeenMs = ctx.nowMs;
      if (frame.connected === true) taken.connected = true;
      if (typeof frame.mission === "string" && frame.mission) taken.mission = frame.mission;
      return {
        state,
        response: ok({
          id: taken.id,
          name: taken.name,
          mode: state.mode,
          reattached: true,
          peers: liveParticipants(state)
            .filter((p) => p.id !== taken.id)
            .map((p) => publicParticipant(p, state, ctx)),
          inbox: [],
        }),
        broadcast: [],
      };
    }
    return {
      state,
      response: err("NAME_TAKEN", `${name} is already on the bus`, {
        suggestion: suggestName(state, name),
      }),
      broadcast: [],
    };
  }

  // A front whose session restarted reclaims its own identity, cursor included,
  // so a crash-and-reconnect does not replay the whole conversation at it.
  const previous = Object.values(state.participants).find((p) => p.gone && p.name === name);
  const id = previous?.id ?? ctx.nextId("p");

  const participant: Participant = {
    id,
    name,
    mission: str(frame.mission),
    harness: str(frame.harness, "unknown"),
    kind: (str(frame.kind, "agent") === "human" ? "human" : "agent") as ParticipantKind,
    cwd: str(frame.cwd),
    joinedAt: ctx.now,
    lastSeenMs: ctx.nowMs,
    connected: frame.connected === true,
    gone: false,
  };
  state.participants[id] = participant;

  const event = pushEvent(state, ctx, {
    kind: "system",
    from: null,
    to: null,
    priority: "normal",
    text: `${name} joined${participant.mission ? ` — ${participant.mission}` : ""}`,
  });

  // The cursor is set AFTER the join event, so a fresh front never drains the
  // announcement of its own arrival. A front that had left keeps the cursor it
  // had, and so catches up on everything said while it was away.
  if (state.cursors[id] === undefined) state.cursors[id] = state.seq;

  return {
    state,
    response: ok({
      id,
      name,
      mode: state.mode,
      peers: liveParticipants(state)
        .filter((p) => p.id !== id)
        .map((p) => publicParticipant(p, state, ctx)),
      inbox: [],
    }),
    broadcast: [event],
  };
}

export function rename(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const wanted = str(frame.name).trim();
  if (wanted && wanted !== me.name) {
    const taken = byName(state, wanted);
    if (taken) {
      return {
        state,
        response: err("NAME_TAKEN", `${wanted} is already on the bus`, {
          suggestion: suggestName(state, wanted),
        }),
        broadcast: [],
      };
    }
  }

  const before = me.name;
  if (wanted) me.name = wanted;
  if (typeof frame.mission === "string") me.mission = frame.mission;
  me.lastSeenMs = ctx.nowMs;

  const event = pushEvent(state, ctx, {
    kind: "system",
    from: null,
    to: null,
    priority: "normal",
    text:
      before === me.name
        ? `${me.name} is now on: ${me.mission}`
        : `${before} is now ${me.name}${me.mission ? ` — ${me.mission}` : ""}`,
  });

  return { state, response: ok({ id: me.id, name: me.name, mission: me.mission }), broadcast: [event] };
}

export function leave(state: State, actorId: string | null, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const released = state.claims.filter((c) => c.ownerId === me.id).map((c) => c.pattern);
  state.claims = state.claims.filter((c) => c.ownerId !== me.id);
  me.gone = true;
  me.connected = false;

  const event = pushEvent(state, ctx, {
    kind: "system",
    from: null,
    to: null,
    priority: "normal",
    text: `${me.name} left${released.length ? `, releasing ${released.length} claim(s)` : ""}`,
  });

  // Leaving is releasing, so anyone waiting on those paths is served too.
  const settled = released.length ? resolvePendingOnRelease(state, me.id, released, ctx) : [];

  return { state, response: ok({ released }), broadcast: [event, ...settled] };
}

export function who(state: State, ctx: Ctx): Outcome {
  return {
    state,
    response: ok({
      mode: state.mode,
      participants: liveParticipants(state).map((p) => publicParticipant(p, state, ctx)),
    }),
    broadcast: [],
  };
}
