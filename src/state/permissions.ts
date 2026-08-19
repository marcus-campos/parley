import { DEFAULTS, err, ok, type GrantScope } from "../protocol/types";
import { normalizeTerritoryPath } from "../repo/paths";
import { ownerOfPath } from "./territory";
import {
  actorOf, pushEvent, type Ctx, type Outcome, type PermissionRequest, type State,
} from "./types";

export function ask(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  if (state.mode === "off") {
    return { state, response: ok({ mode: "off", state: "granted", reason: "territory disabled" }), broadcast: [] };
  }

  let path: string;
  try {
    path = normalizeTerritoryPath(String(frame.path ?? ""));
  } catch (e) {
    return { state, response: err("NOT_OWNER", (e as Error).message), broadcast: [] };
  }

  me.lastSeenMs = ctx.nowMs;
  const held = ownerOfPath(state, path);
  if (!held || held.ownerId === me.id) {
    // Nothing to ask: the path is free, or already yours.
    return { state, response: ok({ state: "granted", reason: held ? "already yours" : "unclaimed" }), broadcast: [] };
  }

  const ttlMs = typeof frame.ttl_s === "number" && frame.ttl_s > 0 ? frame.ttl_s * 1000 : DEFAULTS.PERMISSION_TTL_MS;
  const request: PermissionRequest = {
    id: ctx.nextId("r"),
    path,
    requesterId: me.id,
    ownerId: held.ownerId,
    reason: typeof frame.reason === "string" ? frame.reason : "",
    state: "pending",
    createdAt: ctx.now,
    expiresAtMs: ctx.nowMs + ttlMs,
    scope: null,
    denyReason: null,
    ownerNudgedAtMs: null,
    requesterNudgedAtMs: null,
  };
  state.requests[request.id] = request;

  const owner = state.participants[request.ownerId];
  const event = pushEvent(state, ctx, {
    kind: "system",
    from: null,
    to: owner?.name ?? null,
    priority: "high",
    text: `${me.name} asks for ${path} — ${request.reason || "no reason given"} (request ${request.id}, ${Math.round(ttlMs / 1000)}s to answer)`,
  });

  return {
    state,
    response: ok({
      request: request.id,
      state: "pending",
      owner: owner?.name ?? "(gone)",
      expires_at: new Date(request.expiresAtMs).toISOString(),
    }),
    broadcast: [event],
  };
}

function settle(
  state: State,
  request: PermissionRequest,
  ctx: Ctx,
  outcome: "granted" | "denied" | "granted_by_timeout",
  scope: GrantScope | null,
): void {
  request.state = outcome;
  request.scope = scope;
  if (outcome === "denied") return;

  const held = state.claims.find((c) => c.pattern === request.path || ownerOfPath(state, request.path)?.pattern === c.pattern);
  if (scope === "transfer" && held) {
    held.ownerId = request.requesterId;
    held.since = ctx.now;
    held.auto = false;
    held.lastTouchMs = ctx.nowMs;
    held.orphanedAtMs = null;
  } else {
    // `once`: carve the single path out of the owner's territory and hand it over.
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
}

export function grant(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const request = state.requests[String(frame.request ?? "")];
  if (!request) return { state, response: err("NOT_OWNER", "unknown request"), broadcast: [] };
  if (request.ownerId !== me.id) {
    return { state, response: err("NOT_OWNER", "you do not own this path"), broadcast: [] };
  }
  if (request.state !== "pending") {
    return { state, response: err("NOT_OWNER", `request already ${request.state}`), broadcast: [] };
  }

  const scope: GrantScope = frame.scope === "transfer" ? "transfer" : "once";
  settle(state, request, ctx, "granted", scope);
  me.lastSeenMs = ctx.nowMs;

  const requester = state.participants[request.requesterId];
  const event = pushEvent(state, ctx, {
    kind: "system",
    from: null,
    to: null,
    priority: "high",
    text: `${me.name} granted ${request.path} to ${requester?.name ?? "(gone)"} (${scope})`,
  });

  return { state, response: ok({ request: request.id, state: "granted", scope }), broadcast: [event] };
}

export function deny(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const request = state.requests[String(frame.request ?? "")];
  if (!request) return { state, response: err("NOT_OWNER", "unknown request"), broadcast: [] };
  if (request.ownerId !== me.id) {
    return { state, response: err("NOT_OWNER", "you do not own this path"), broadcast: [] };
  }
  if (request.state !== "pending") {
    return { state, response: err("NOT_OWNER", `request already ${request.state}`), broadcast: [] };
  }

  request.denyReason = typeof frame.reason === "string" ? frame.reason : "";
  settle(state, request, ctx, "denied", null);
  me.lastSeenMs = ctx.nowMs;

  const requester = state.participants[request.requesterId];
  const event = pushEvent(state, ctx, {
    kind: "system",
    from: null,
    to: requester?.name ?? null,
    priority: "high",
    text: `${me.name} denied ${request.path}${request.denyReason ? ` — ${request.denyReason}` : ""}`,
  });

  return { state, response: ok({ request: request.id, state: "denied" }), broadcast: [event] };
}

/**
 * Expiry is a grant, and it is announced by name. An idle agent is the most
 * expensive waste in the system; naming who failed to answer is what stops the
 * timeout from quietly becoming the normal path.
 */
export function expirePermissions(state: State, ctx: Ctx) {
  const broadcast = [];
  for (const request of Object.values(state.requests)) {
    if (request.state !== "pending" || ctx.nowMs < request.expiresAtMs) continue;
    settle(state, request, ctx, "granted_by_timeout", "once");
    const owner = state.participants[request.ownerId];
    const requester = state.participants[request.requesterId];
    const waited = Math.round((request.expiresAtMs - new Date(request.createdAt).getTime()) / 60000);
    broadcast.push(
      pushEvent(state, ctx, {
        kind: "system",
        from: null,
        to: null,
        priority: "high",
        text: `${requester?.name ?? "someone"} took ${request.path} by timeout; ${owner?.name ?? "the owner"} did not answer in ${waited} min.`,
      }),
    );
  }
  return broadcast;
}

/**
 * Pending permission requests. An `ask` is pushed only to the owner, so an
 * observer — the panel, or a human joining mid-flight — has no way to learn
 * about one from the event stream alone. This is that way.
 */
export function listRequests(state: State, frame: Record<string, unknown>, ctx: Ctx, actorId?: string | null): Outcome {
  const all = frame.all === true;
  const requests = Object.values(state.requests)
    .filter((r) => all || r.state === "pending")
    .map((r) => ({
      id: r.id,
      path: r.path,
      requester: state.participants[r.requesterId]?.name ?? "(gone)",
      owner: state.participants[r.ownerId]?.name ?? "(gone)",
      reason: r.reason,
      state: r.state,
      created_at: r.createdAt,
      expires_at: new Date(r.expiresAtMs).toISOString(),
      seconds_left: Math.max(0, Math.round((r.expiresAtMs - ctx.nowMs) / 1000)),
    }));
  // What this particular front still has to do about permission. Both sides
  // are nudged exactly once, which is what makes it safe for a harness to
  // refuse to go idle on the strength of it.
  const me = actorId ? state.participants[actorId] : undefined;
  const owed = me
    ? Object.values(state.requests).filter(
        (r) => r.state === "pending" && r.ownerId === me.id && r.ownerNudgedAtMs === null,
      )
    : [];
  const settled = me
    ? Object.values(state.requests).filter(
        (r) => r.state !== "pending" && r.requesterId === me.id && r.requesterNudgedAtMs === null,
      )
    : [];
  const waiting = me
    ? Object.values(state.requests).filter((r) => r.state === "pending" && r.requesterId === me.id)
    : [];

  if (frame.deliver === true) {
    for (const r of owed) r.ownerNudgedAtMs = ctx.nowMs;
    for (const r of settled) r.requesterNudgedAtMs = ctx.nowMs;
  }

  const brief = (r: (typeof owed)[number]) => ({
    id: r.id, path: r.path, reason: r.reason, state: r.state,
    requester: state.participants[r.requesterId]?.name ?? "(gone)",
    owner: state.participants[r.ownerId]?.name ?? "(gone)",
    seconds_left: Math.max(0, Math.round((r.expiresAtMs - ctx.nowMs) / 1000)),
    deny_reason: r.denyReason,
  });

  return {
    state,
    response: ok({
      requests,
      needs_my_decision: owed.map(brief),
      settled_for_me: settled.map(brief),
      i_am_waiting_on: waiting.map(brief),
    }),
    broadcast: [],
  };
}
