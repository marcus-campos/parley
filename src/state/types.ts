import type {
  GrantScope, Mode, ParticipantKind, Priority, RequestState, Response, Shape,
} from "../protocol/types";

export interface Participant {
  id: string;
  name: string;
  mission: string;
  harness: string;
  kind: ParticipantKind;
  cwd: string;
  /** Branch and worktree, because on a shared branch the name is not enough. */
  branch: string;
  joinedAt: string;
  /** Renewed by every call. Presence for the ephemeral-hook path. */
  lastSeenMs: number;
  /** True while a persistent connection is open. Presence for the MCP path. */
  connected: boolean;
  /** Left explicitly, or the lease expired. Kept for name reuse on restart. */
  gone: boolean;
  /**
   * How fast a message reaches this front, which is not the same for all of
   * them and is the thing an agent actually needs to know before deciding
   * whether to wait for an answer.
   */
  delivery: "live" | "hooks" | "manual";
  /**
   * How this session can be woken from outside, when its harness offers such a
   * thing. parley never writes here itself — the format belongs to the harness
   * and guessing it would mean sending malformed bytes into somebody's live
   * session. It is recorded so that whoever needs to wake this front can be
   * told exactly how, using the tool their own harness already gives them.
   */
  wake: string | null;
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
  /** Each side gets one hard nudge, so nobody can be pushed round in circles. */
  ownerNudgedAtMs: number | null;
  requesterNudgedAtMs: number | null;
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
  /**
   * The participant a system event is *about*. They already know what they did,
   * so it is never delivered back to them. Matching on the name inside the text
   * would break the moment someone renames themselves.
   */
  about?: string | null;
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

/**
 * A question one front put to another and is waiting on.
 *
 * Separate from a `say` because it has a state: somebody owes an answer. That
 * is what lets the recipient's harness refuse to go idle while the question is
 * open, and what lets the asker block until it arrives.
 */
export interface Question {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  text: string;
  at: string;
  atMs: number;
  expiresAtMs: number;
  answer: string | null;
  answeredAtMs: number | null;
  /** Set when the asker has read the answer, and when it said so. */
  answerSeenAtMs: number | null;
  acknowledgedAtMs: number | null;
  /** Set once it has been pushed hard at the recipient, so it only does so once. */
  deliveredAtMs: number | null;
  /**
   * Set when the asker says it rang the recipient's doorbell.
   *
   * No external process can wake a Claude Code session — there is no API,
   * socket or pipe for it, only the harness's own session-to-session tool,
   * which only another session can call. So parley cannot do the waking; what
   * it can do is refuse to let the asker forget, and stop nagging once it has
   * been done.
   */
  nudgedAtMs: number | null;
}

export interface WorkItem {
  id: string;
  /** One concrete path or glob. One item per path — the unit of territory. */
  paths: string[];
  title: string;
  /** Ids of Note and CommandResult. Reference, never a copy: this is the token saving. */
  evidenceIds: string[];
  publishedById: string;
  publishedByName: string;
  /** `work` is something to do. `review` is somebody else's work to check. */
  kind: "work" | "review";
  /**
   * What decides whether it can be refused. A discovered item is an offer; a
   * planned item is a dispatch.
   */
  origin: "discovered" | "planned";
  state: "open" | "offered" | "taken" | "done";
  offeredToId: string | null;
  offeredAtMs: number | null;
  takenById: string | null;
  /** Set when the holder dies; returned to the pool after the grace period. */
  orphanedAtMs: number | null;
  /** For `kind: "review"`, the item whose work is being checked. */
  reviewOf: string | null;
  at: string;
  /**
   * Set once the pool has rung an idle front about this item, so nobody is
   * pushed round in circles. Same discipline as the question and permission
   * nudges.
   */
  nudgedAtMs: number | null;
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
  /**
   * Where work comes from. Orthogonal to `mode`, which is how strict territory
   * is. Repo-scoped for the same reason: a front in `bus` inside a `plan`
   * would ignore dispatch, and the plan would be theatre.
   */
  shape: Shape;
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
  questions: Record<string, Question>;
  work: WorkItem[];
  /**
   * The optional layer above the lexical floor. `active`/`model` are the
   * person's decision (`parley brain enable`, human-only — see machine.ts);
   * `askedAtMs` is parley's own nudge-once bookkeeping for the panel notice
   * raised the first time a front wants semantic recall while it is off.
   */
  brain: { active: boolean; model: string | null; askedAtMs: number | null };
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
    mode, shape: "bus", seq: 0, participants: {}, claims: [], requests: {},
    events: [], cursors: {}, notes: [], touches: {}, results: {}, questions: {},
    work: [],
    brain: { active: false, model: null, askedAtMs: null },
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

/** Seconds since this front last did anything. */
function idleSeconds(p: Participant, ctx: Ctx): number {
  return Math.max(0, Math.round((ctx.nowMs - p.lastSeenMs) / 1000));
}

export function publicParticipant(p: Participant, state: State, ctx: Ctx) {
  return {
    id: p.id,
    name: p.name,
    mission: p.mission,
    harness: p.harness,
    kind: p.kind,
    branch: p.branch,
    // A participant restored from a journal written by an older daemon has no
    // delivery recorded. Reporting `undefined` for the field the skill tells
    // the agent to decide on is worse than assuming the common case.
    delivery: p.delivery ?? (p.connected ? "live" : "hooks"),
    wake: p.wake ?? null,
    /**
     * Plain-language version of the same thing. "live" holds an open
     * connection and is pushed to immediately; "hooks" is an ephemeral CLI
     * front that reads its inbox on its next tool call — seconds while it is
     * working, and not until its person prompts it again once it has stopped.
     */
    reach:
      (p.delivery ?? (p.connected ? "live" : "hooks")) === "live"
        ? "immediately — holds an open connection"
        : (p.delivery ?? "hooks") === "hooks"
          ? idleSeconds(p, ctx) > 120
            ? "on its next tool call; it has been idle a while, so possibly not soon"
            : "on its next tool call, usually within seconds"
          : "only when someone runs parley there",
    // The last segment of the path is what a person recognises a worktree by.
    worktree: p.cwd ? p.cwd.replace(/\\/g, "/").split("/").filter(Boolean).slice(-1)[0] ?? "" : "",
    // Enough of the id to tell two fronts apart at a glance, and stable.
    tag: p.id.replace(/^p_/, ""),
    connected: p.connected,
    since: p.joinedAt,
    idle_s: Math.max(0, Math.round((ctx.nowMs - p.lastSeenMs) / 1000)),
    claims: state.claims.filter((c) => c.ownerId === p.id).map((c) => c.pattern),
  };
}
