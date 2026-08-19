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

/** Your own territory, with how long since each path was last touched. */
function ownClaims(state: State, ownerId: string, ctx: Ctx) {
  return state.claims
    .filter((c) => c.ownerId === ownerId)
    .map((c) => ({
      pattern: c.pattern,
      auto: c.auto,
      idle_s: Math.max(0, Math.round((ctx.nowMs - c.lastTouchMs) / 1000)),
    }));
}

export function join(state: State, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const name = str(frame.name).trim();
  if (!name) return { state, response: err("NAME_TAKEN", "a name is required"), broadcast: [] };

  // Identity is keyed on the session, never on the name.
  //
  // The hook is an ephemeral process that re-derives a name from the worktree
  // on every single tool call. Keyed on the name, two things went wrong at
  // once: an agent that renamed itself came back as a brand new front on its
  // next tool call, and two sessions in the same worktree derived the same
  // name and were merged into one. Both were visible as names churning in the
  // panel.
  const session = str(frame.session);
  if (session) {
    const known = Object.values(state.participants).find((p) => p.session === session);
    if (known) {
      known.gone = false;
      known.lastSeenMs = ctx.nowMs;
      if (typeof frame.branch === "string" && frame.branch) known.branch = frame.branch;
      if (frame.connected === true) known.connected = true;
      // Coming back renews the territory. A front that paused — thinking, or
      // waiting on the person — must not lose files it is still holding just
      // because a hook did not fire for a few minutes.
      for (const c of state.claims) {
        if (c.ownerId === known.id) c.orphanedAtMs = null;
      }
      // The name it is using now wins over whatever the caller re-derived.
      if (typeof frame.mission === "string" && frame.mission && !known.mission) {
        known.mission = frame.mission;
      }
      return {
        state,
        response: ok({
          id: known.id,
          name: known.name,
          mission: known.mission,
          mode: state.mode,
          reattached: true,
          claims: ownClaims(state, known.id, ctx),
          peers: liveParticipants(state)
            .filter((p) => p.id !== known.id)
            .map((p) => publicParticipant(p, state, ctx)),
          inbox: [],
        }),
        broadcast: [],
      };
    }
  }

  const taken = byName(state, name);
  if (taken) {
    // Fallback for callers with no session id (a plain shell, another tool):
    // same name from the same worktree is the same front coming back.
    //
    // But never hand over an identity that already belongs to a known session.
    // Every session on a branch derives the same name from that branch, so
    // without this a second session walks straight into the first one's
    // participant and starts speaking as it — claims and all.
    const sameWorktree =
      !session &&
      taken.session === null &&
      typeof frame.cwd === "string" && frame.cwd !== "" && frame.cwd === taken.cwd;
    if (sameWorktree) {
      taken.lastSeenMs = ctx.nowMs;
      if (frame.connected === true) taken.connected = true;
      for (const c of state.claims) {
        if (c.ownerId === taken.id) c.orphanedAtMs = null;
      }
      if (typeof frame.mission === "string" && frame.mission) taken.mission = frame.mission;
      return {
        state,
        response: ok({
          id: taken.id,
          name: taken.name,
          mode: state.mode,
          reattached: true,
          claims: ownClaims(state, taken.id, ctx),
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
    branch: str(frame.branch),
    session: session || null,
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
    about: id,
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
      claims: ownClaims(state, id, ctx),
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
    about: me.id,
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
    about: me.id,
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
