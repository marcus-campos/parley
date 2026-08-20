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
  "work", "works", "take", "drop", "done",
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
  /** Zero connected participants for this long and the daemon exits. */
  IDLE_SHUTDOWN_MS: 30 * 60_000,
  /** Hard budget for the hook query path. Overrun means let go, never block. */
  HOOK_BUDGET_MS: 30,
} as const;
