import type {
  GrantScope, Mode, ParticipantKind, Priority, RequestState, Response,
} from "../protocol/types";

export interface Participant {
  id: string;
  name: string;
  mission: string;
  harness: string;
  kind: ParticipantKind;
  cwd: string;
  joinedAt: string;
  /** Renewed by every call. Presence for the ephemeral-hook path. */
  lastSeenMs: number;
  /** True while a persistent connection is open. Presence for the MCP path. */
  connected: boolean;
  /** Left explicitly, or the lease expired. Kept for name reuse on restart. */
  gone: boolean;
  /**
   * Opaque, stable for the lifetime of one agent session — the harness session
   * id where there is one. This, not the name, is what identity is keyed on.
   */
  session: string | null;
}

export interface Claim {
  pattern: string;
  ownerId: string;
  intent: string;
  since: string;
  /** Taken by first edit rather than declared. Expires; explicit claims do not. */
  auto: boolean;
  lastTouchMs: number;
  /** Set when the owner dies; released after the grace period. */
  orphanedAtMs: number | null;
}

export interface PermissionRequest {
  id: string;
  path: string;
  requesterId: string;
  ownerId: string;
  reason: string;
  state: RequestState;
  createdAt: string;
  expiresAtMs: number;
  scope: GrantScope | null;
  denyReason: string | null;
}

export interface ConvEvent {
  seq: number;
  kind: "say" | "system";
  from: { id: string; name: string; kind: ParticipantKind } | null;
  /** Participant name, or null for broadcast. */
  to: string | null;
  priority: Priority;
  text: string;
  at: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  /**
   * Paths or globs this knowledge is about. A note anchored to a path is
   * delivered to whoever touches that path, which inverts who does the
   * remembering: the agent does not have to think to ask.
   */
  paths: string[];
  /**
   * A `note` is knowledge. A `decision` is binding until reversed — the point
   * is to stop the next front relitigating something already settled.
   */
  kind: "note" | "decision";
  reversedBy: string | null;
  authorId: string | null;
  authorName: string;
  at: string;
}

/** Who last touched a path, kept after the claim is gone. */
export interface Touch {
  path: string;
  byId: string;
  byName: string;
  intent: string;
  at: string;
  atMs: number;
}

/** A command result worth not running again. */
export interface CommandResult {
  key: string;
  status: "pass" | "fail" | "unknown";
  summary: string;
  /** Editing any of these invalidates the result. */
  paths: string[];
  byId: string;
  byName: string;
  at: string;
  atMs: number;
  staleBecause: string | null;
}

export interface State {
  mode: Mode;
  seq: number;
  participants: Record<string, Participant>;
  claims: Claim[];
  requests: Record<string, PermissionRequest>;
  events: ConvEvent[];
  /** Read cursor per participant, so each front drains only what it has not seen. */
  cursors: Record<string, number>;
  notes: Note[];
  /** Bounded log of who last touched each path. */
  touches: Record<string, Touch>;
  results: Record<string, CommandResult>;
}

/**
 * Everything time- and identity-shaped, injected. No `Date.now()` and no
 * `Math.random()` anywhere below this line — that is what makes a two-client
 * race a deterministic unit test instead of a flaky one.
 */
export interface Ctx {
  now: string;
  nowMs: number;
  nextId(prefix: string): string;
}

export interface Outcome {
  state: State;
  response: Response;
  /** Events created by this command, for push to connected peers. */
  broadcast: ConvEvent[];
}

export function emptyState(mode: Mode = "advisory"): State {
  return {
    mode, seq: 0, participants: {}, claims: [], requests: {},
    events: [], cursors: {}, notes: [], touches: {}, results: {},
  };
}

/** Append a conversation or system event and return it. Mutates `state`. */
export function pushEvent(
  state: State,
  ctx: Ctx,
  ev: Omit<ConvEvent, "seq" | "at">,
): ConvEvent {
  const full: ConvEvent = { ...ev, seq: ++state.seq, at: ctx.now };
  state.events.push(full);
  return full;
}

export function liveParticipants(state: State): Participant[] {
  return Object.values(state.participants).filter((p) => !p.gone);
}

export function byName(state: State, name: string): Participant | undefined {
  return liveParticipants(state).find((p) => p.name === name);
}

export function actorOf(state: State, id: string | null): Participant | undefined {
  if (!id) return undefined;
  const p = state.participants[id];
  return p && !p.gone ? p : undefined;
}

export function publicParticipant(p: Participant, state: State, ctx: Ctx) {
  return {
    id: p.id,
    name: p.name,
    mission: p.mission,
    harness: p.harness,
    kind: p.kind,
    connected: p.connected,
    since: p.joinedAt,
    idle_s: Math.max(0, Math.round((ctx.nowMs - p.lastSeenMs) / 1000)),
    claims: state.claims.filter((c) => c.ownerId === p.id).map((c) => c.pattern),
  };
}
