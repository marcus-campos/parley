import { err, ok } from "../protocol/types";
import { matchesPath, normalizeTerritoryPath, patternsOverlap } from "../repo/paths";
import { actorOf, pushEvent, type Claim, type ConvEvent, type Ctx, type Outcome, type State } from "./types";

export interface ConflictReport {
  path: string;
  owner: { id: string; name: string; mission: string };
  since: string;
  auto: boolean;
}

function readPaths(frame: Record<string, unknown>): string[] {
  const raw = Array.isArray(frame.paths) ? frame.paths : frame.path !== undefined ? [frame.path] : [];
  const out: string[] = [];
  for (const p of raw) if (typeof p === "string" && p.trim()) out.push(normalizeTerritoryPath(p));
  return out;
}

/** Claims held by someone other than `ownerId` that overlap `pattern`. */
export function conflictsFor(state: State, pattern: string, ownerId: string): Claim[] {
  return state.claims.filter((c) => c.ownerId !== ownerId && patternsOverlap(c.pattern, pattern));
}

/** The claim covering a concrete path, if any. */
export function ownerOfPath(state: State, path: string): Claim | undefined {
  return state.claims.find((c) => matchesPath(c.pattern, path));
}

function report(state: State, pattern: string, claim: Claim): ConflictReport {
  const owner = state.participants[claim.ownerId];
  return {
    path: pattern,
    owner: {
      id: claim.ownerId,
      name: owner?.name ?? "(gone)",
      mission: owner?.mission ?? "",
    },
    since: claim.since,
    auto: claim.auto,
  };
}

export function claim(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  if (state.mode === "off") {
    return { state, response: ok({ mode: "off", claimed: [], ignored: true }), broadcast: [] };
  }

  let paths: string[];
  try {
    paths = readPaths(frame);
  } catch (e) {
    return { state, response: err("CONFLICT", (e as Error).message), broadcast: [] };
  }
  if (paths.length === 0) return { state, response: ok({ claimed: [] }), broadcast: [] };

  const auto = frame.auto === true;
  const intent = typeof frame.intent === "string" ? frame.intent : auto ? "first edit" : "";
  me.lastSeenMs = ctx.nowMs;

  // Resolved by arrival order at the daemon: the whole batch is checked before
  // anything is taken, so a partially-granted claim can never exist.
  const conflicts: ConflictReport[] = [];
  for (const pattern of paths) {
    for (const c of conflictsFor(state, pattern, me.id)) conflicts.push(report(state, pattern, c));
  }
  if (conflicts.length > 0) {
    return { state, response: { ...err("CONFLICT"), conflicts }, broadcast: [] };
  }

  const claimed: string[] = [];
  for (const pattern of paths) {
    const mine = state.claims.find((c) => c.ownerId === me.id && c.pattern === pattern);
    if (mine) {
      mine.lastTouchMs = ctx.nowMs;
      mine.orphanedAtMs = null;
      // An explicit claim over an auto-claim promotes it: it stops expiring.
      if (!auto) {
        mine.auto = false;
        if (intent) mine.intent = intent;
      }
      continue;
    }
    state.claims.push({
      pattern,
      ownerId: me.id,
      intent,
      since: ctx.now,
      auto,
      lastTouchMs: ctx.nowMs,
      orphanedAtMs: null,
    });
    claimed.push(pattern);
  }

  const broadcast = claimed.length
    ? [
        pushEvent(state, ctx, {
          kind: "system",
          from: null,
          to: null,
          priority: "normal",
          text: `${me.name} claimed ${claimed.join(", ")}${intent ? ` — ${intent}` : ""}`,
        }),
      ]
    : [];

  return { state, response: ok({ claimed, auto }), broadcast };
}

/**
 * Letting go of a path IS the answer to whoever was waiting for it.
 *
 * Requiring the owner to release and then also answer a request would be asking
 * twice for one decision, and the second half is exactly the half an agent
 * forgets — leaving somebody blocked on a file that is already free.
 */
export function resolvePendingOnRelease(
  state: State,
  ownerId: string,
  releasedPatterns: string[],
  ctx: Ctx,
): ConvEvent[] {
  const events: ConvEvent[] = [];
  for (const request of Object.values(state.requests)) {
    if (request.state !== "pending" || request.ownerId !== ownerId) continue;
    if (!releasedPatterns.some((pattern) => matchesPath(pattern, request.path))) continue;
    // Nobody else may slip in between the release and the waiting front, so the
    // requester is handed the claim rather than merely told to go and take it.
    if (conflictsFor(state, request.path, request.requesterId).length === 0) {
      state.claims.push({
        pattern: request.path,
        ownerId: request.requesterId,
        intent: request.reason,
        since: ctx.now,
        auto: false,
        lastTouchMs: ctx.nowMs,
        orphanedAtMs: null,
      });
    }
    request.state = "granted";
    request.scope = "once";

    const owner = state.participants[ownerId];
    const requester = state.participants[request.requesterId];
    events.push(
      pushEvent(state, ctx, {
        kind: "system",
        from: null,
        to: null,
        priority: "high",
        text: `${owner?.name ?? "the owner"} released ${request.path}; ${requester?.name ?? "the requester"} was waiting for it and now has it`,
      }),
    );
  }
  return events;
}

export function release(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  let paths: string[];
  try {
    paths = readPaths(frame);
  } catch (e) {
    return { state, response: err("NOT_OWNER", (e as Error).message), broadcast: [] };
  }
  me.lastSeenMs = ctx.nowMs;

  const all = frame.all === true || paths.length === 0;
  const target = all
    ? state.claims.filter((c) => c.ownerId === me.id)
    : state.claims.filter((c) => c.ownerId === me.id && paths.includes(c.pattern));

  const foreign = all ? [] : paths.filter((p) => state.claims.some((c) => c.pattern === p && c.ownerId !== me.id));
  if (foreign.length > 0) {
    return { state, response: err("NOT_OWNER", `not yours: ${foreign.join(", ")}`), broadcast: [] };
  }

  const released = target.map((c) => c.pattern);
  state.claims = state.claims.filter((c) => !target.includes(c));

  const broadcast: ConvEvent[] = [];
  if (released.length) {
    broadcast.push(
      pushEvent(state, ctx, {
        kind: "system",
        from: null,
        to: null,
        priority: "normal",
        text: `${me.name} released ${released.join(", ")}`,
      }),
    );
    broadcast.push(...resolvePendingOnRelease(state, me.id, released, ctx));
  }

  return { state, response: ok({ released, settled: broadcast.length - 1 }), broadcast };
}
