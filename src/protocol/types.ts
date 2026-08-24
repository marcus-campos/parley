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
  "brain",
  "plan",
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
   * How long a front parley started has to reach the bus before parley says
   * it never did.
   *
   * A birth reports success as soon as it has a pid, and in terminal mode that
   * pid belongs to the launcher — `osascript` — not to the agent. The window
   * it opens runs the *person's* shell, so the harness resolves from their
   * PATH and their auth, neither of which the daemon has any view of. A
   * window that prints `claude: command not found` is a birth parley believes
   * in and nobody else ever sees.
   *
   * Inside BIRTH_COOLDOWN_MS on purpose: whoever is watching learns why
   * nothing happened before the next attempt is made.
   */
  BIRTH_JOIN_GRACE_MS: 2 * 60_000,
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
  /**
   * How much of a newborn's output the daemon keeps for the panel.
   *
   * §7 of the design says a newborn's output streams into the *panel* — not
   * onto the bus. That distinction is the whole design of this buffer: bus
   * events are journalled and drained into every other front's context, and a
   * harness printing its answer would cost every agent on the repository the
   * tokens to read it. So the lines live in the daemon, bounded, and only a
   * panel ever asks for them.
   *
   * The bound is also what replaces the rate limit the plan asked for. That
   * limit existed to protect the journal, and nothing here reaches the
   * journal; what is left to protect is memory, and a ring does that without
   * dropping the tail — which is the part somebody watching actually wants.
   */
  PANEL_TAIL_LINES: 300,
  /** No single line of a newborn's output may fill a panel by itself. */
  PANEL_TAIL_LINE_CHARS: 240,
  /** Zero connected participants for this long and the daemon exits. */
  IDLE_SHUTDOWN_MS: 30 * 60_000,
  /**
   * Hard budget for the hook query path. Overrun means let go, never block.
   *
   * This is the number the hook actually arms its timer with. It used to be
   * 30, and the one line that reads it multiplied by 40 — so the constant, its
   * comment and the comment at the call site all called 30ms a *hard budget*
   * while the enforced deadline was 1200ms, and anything measured against 30
   * (`addWorktree` at 29-60ms, say) was being judged against a limit forty
   * times stricter than the one that exists. The value the hook enforces is
   * unchanged; only the two places that lied about it are.
   */
  HOOK_BUDGET_MS: 1_200,
} as const;
