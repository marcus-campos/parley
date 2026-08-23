/** The wire contract. Reimplementing parley in another language is implementing this file. */

export const PROTOCOL_VERSION = 1;

export type Mode = "off" | "advisory" | "enforced";
export type Shape = "bus" | "pool" | "plan";
export const SHAPES = ["bus", "pool", "plan"] as const;
export type ParticipantKind = "agent" | "human";
export type Priority = "normal" | "high";
export type GrantScope = "once" | "transfer";
export type RequestState = "pending" | "granted" | "denied" | "granted_by_timeout";

export const OPS = [
  "join", "rename", "leave", "who",
  "say", "drain", "history", "question", "reply", "questions", "question_status", "ack", "nudged",
  "claim", "release",
  "ask", "grant", "deny", "requests",
  "note", "notes", "reverse", "result", "results",
  "mode", "shape", "status",
  "work", "works", "take", "drop", "done", "summon",
] as const;
export type Op = (typeof OPS)[number];

export const ERROR_CODES = [
  "NAME_TAKEN", "CONFLICT", "NOT_OWNER", "NOT_JOINED",
  "UNKNOWN_OP", "PROTOCOL_MISMATCH", "AUTH_REQUIRED", "OBSERVER_ONLY",
  "NOT_TAKEN", "NO_CAPACITY",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Frame {
  v: number;
  op: string;
  [key: string]: unknown;
}

export interface OkResponse {
  ok: true;
  [key: string]: unknown;
}

export interface ErrResponse {
  ok: false;
  error: { code: ErrorCode; message?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export type Response = OkResponse | ErrResponse;

export function ok(fields: Record<string, unknown> = {}): OkResponse {
  return { ok: true, ...fields };
}

export function err(
  code: ErrorCode,
  message?: string,
  extra: Record<string, unknown> = {},
): ErrResponse {
  return { ok: false, error: { code, ...(message ? { message } : {}), ...extra } };
}

/** Defaults from the design spec. Every one of these is configurable. */
export const DEFAULTS = {
  /** Auto-claims die after 15 min without a fresh edit. Explicit claims never do. */
  AUTO_CLAIM_TTL_MS: 15 * 60_000,
  /** Presence lease for the ephemeral-hook path, renewed on every call. */
  LEASE_TTL_MS: 5 * 60_000,
  /** Unanswered permission requests are granted and announced loudly. */
  PERMISSION_TTL_MS: 5 * 60_000,
  /** A dead front's claims are announced, then released after this grace. */
  ORPHAN_GRACE_MS: 60_000,
  /** An offer nobody answered returns to the pool. Matches PERMISSION_TTL_MS on purpose. */
  OFFER_TTL_MS: 5 * 60_000,
  /**
   * How long an open item sits before the pool rings an idle front about it.
   * Longer than LEASE_TTL_MS, which is not incidental: a front with nothing
   * renewing its lease for this long is not idle capacity, it is gone — so in
   * practice the bell only ever reaches a front holding a live connection.
   */
  ORPHAN_POOL_MS: 10 * 60_000,
  /** At most one front is created per window, however large the pool is. */
  BIRTH_COOLDOWN_MS: 5 * 60_000,
  /**
   * How long a newborn front has before it can be invited to go home. It is
   * born because the pool was stale; if another front empties the pool while
   * it is still starting up, it must still get a chance to look before being
   * told there is nothing to look at.
   */
  RETIRE_GRACE_MS: 60_000,
  /**
   * How long a newborn's worktree is left alone after its front said `leave`.
   *
   * `leave` is not proof that a process has exited. The retirement notice
   * itself asks the front to run `parley leave`, and a front that does so can
   * still make another tool call afterwards — its cwd would be gone under it.
   * One LEASE_TTL_MS of silence is what this bus already treats as death
   * everywhere else, so it is what "actually gone" means here too.
   */
  COLLECT_AFTER_LEAVE_MS: 5 * 60_000,
  /**
   * How many times a collection that could not find out is retried before the
   * daemon stops trying and says so.
   *
   * `dirty` is an answer and is never retried — somebody's changes are in
   * there and that is a decision for a person. `unknown` (a `git status` that
   * failed or timed out) and `failed` (git refused the removal) are the
   * opposite: nothing is known and nothing happened, and a stale `index.lock`
   * or a busy network filesystem clears on its own. So they come back to the
   * sweep — bounded, because retrying forever with nobody told is the shape
   * this codebase has already been burned by once.
   */
  COLLECT_MAX_ATTEMPTS: 3,
  /** Zero connected participants for this long and the daemon exits. */
  IDLE_SHUTDOWN_MS: 30 * 60_000,
  /** Hard budget for the hook query path. Overrun means let go, never block. */
  HOOK_BUDGET_MS: 30,
} as const;
