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

/**
 * The longest thing that can still be an address rather than a paragraph.
 */
const MAX_WAKE_CHARS = 512;

/**
 * A wake address, or nothing.
 *
 * This is a fact a front reports **about itself** — `wakeAddress()` in
 * `src/cli/identity.ts` builds it from the socket the harness publishes — and
 * parley's only use for it is to hand it back to whoever asked that front a
 * question, rendered into their tool response as *"To wake it now: <address>
 * — use your harness's session-message tool"*. That makes it the one string on
 * this bus that is presented to another agent as something to act on.
 *
 * So it is held to the shape of an address: one line, bounded. Something with
 * newlines in it is not a wake address whatever else it is, and refusing it
 * costs nothing, because no harness publishes one.
 *
 * What it is deliberately **not** gated on is `born`. The plan's Task 6 asked
 * for `wake` to be accepted only from a front parley bore, on the grounds that
 * *"parley never guesses how to wake a session it did not start"* — but
 * `frame.wake` is not parley guessing, it is the front reporting, and §4.6 of
 * the design says the person-opened path is **unchanged**. Gating it on `born`
 * would have silently emptied `wake` for every front a person opened, which is
 * every front the question doorbell exists for: `src/state/questions.ts` reads
 * `target.wake` to tell an asker how to reach a front that has gone quiet, and
 * `src/adapters/hook.ts` prints it. The doorbell would have gone dark and no
 * test would have said so.
 */
function wakeOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (!address || address.length > MAX_WAKE_CHARS || /[\r\n]/.test(address)) return null;
  return address;
}

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
      // Where it is *now*. A session's cwd is not fixed for its lifetime — a
      // person walks from the repository root into `.parley/worktrees/pool-1`
      // to read what a newborn did, and every tool call after that re-joins
      // from there. This branch read `branch`, `wake`, `connected` and
      // `mission` off the frame and dropped `cwd`, so `src/daemon/server.ts`'s
      // sweep — whose whole question is "is anybody still standing in that
      // directory" — was answering it from an address the front had left.
      if (typeof frame.cwd === "string" && frame.cwd) known.cwd = frame.cwd;
      const wake = wakeOf(frame.wake);
      if (wake) known.wake = wake;
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
    // A front that holds the connection open is pushed to; one that connects,
    // speaks and exits reads its inbox on its next call.
    delivery: frame.connected === true ? "live" : frame.harness === "shell" ? "manual" : "hooks",
    wake: wakeOf(frame.wake),
    born: frame.born === "parley" ? "parley" : "person",
    retireNudgedAtMs: null,
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

export function who(state: State, ctx: Ctx, maxFronts = 6): Outcome {
  const live = liveParticipants(state);
  return {
    state,
    response: ok({
      mode: state.mode,
      participants: live.map((p) => publicParticipant(p, state, ctx)),
      // Carried here rather than in `status` because this is the op a panel
      // already asks on every refresh, and a switch a person can throw has to
      // show what it is switching: whether parley may start fronts at all, the
      // ceiling it would stop at, and how much of that ceiling is in use.
      births: {
        allowed: state.birthsAllowed,
        max: maxFronts,
        live: live.filter((p) => p.kind === "agent").length,
      },
    }),
    broadcast: [],
  };
}
