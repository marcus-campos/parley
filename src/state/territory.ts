import { err, ok } from "../protocol/types";
import { matchesPath, normalizeTerritoryPath, patternsOverlap } from "../repo/paths";
import { notesForPath } from "./notes";
import {
  actorOf, pushEvent,
  type Claim, type ConvEvent, type Ctx, type Note, type Outcome, type State, type Touch,
} from "./types";

/** Keeps the touch log from growing without bound on a long-lived daemon. */
const MAX_TOUCHES = 500;

function recordTouch(state: State, path: string, ownerId: string, intent: string, ctx: Ctx): void {
  state.touches[path] = {
    path, byId: ownerId,
    byName: state.participants[ownerId]?.name ?? "(gone)",
    intent, at: ctx.now, atMs: ctx.nowMs,
  };
  const keys = Object.keys(state.touches);
  if (keys.length > MAX_TOUCHES) {
    const oldest = keys
      .map((k) => state.touches[k]!)
      .sort((a, b) => a.atMs - b.atMs)
      .slice(0, keys.length - MAX_TOUCHES);
    for (const t of oldest) delete state.touches[t.path];
  }
}

/** A live session accumulates forty-plus notes; riding all of them on every claim is a tax on every edit. */
const NOTES_CAP = 5;

/**
 * Decisions bind until reversed, so exempting them from `NOTES_CAP` entirely
 * was the right instinct — an agent that never sees one will relitigate
 * exactly what it was recorded to settle. But "exempt" and "unbounded" are not
 * the same claim: a path that has collected thirty decisions over the life of
 * a repository is the same shape of tax `NOTES_CAP` exists to stop, just paid
 * in the binding half of the corpus instead of the disposable half. This cap
 * is deliberately far more generous than `NOTES_CAP` — decisions are rarer and
 * worth more per line — but it is still a cap, with its own overflow count, so
 * the footer's worst case stays bounded instead of growing with the
 * repository's whole decided history.
 */
const DECISIONS_CAP = 20;

/**
 * What someone else did to this path recently, and what is known about it.
 *
 * Both travel back on the claim, which is the one call the hook already makes
 * before an edit — so the agent learns who rewrote the file four minutes ago,
 * and whatever a previous front wrote down about it, without a second round
 * trip and without having to think to ask.
 *
 * Both halves are capped because `claim` runs on every tool call — the corpus
 * must not. Plain notes are trimmed to the newest few (`NOTES_CAP`); decisions
 * get their own, far more generous cap (`DECISIONS_CAP`) precisely because
 * they bind — but a cap all the same, so 30 decisions and 30 notes on one path
 * cannot add up to an unbounded claim response the way an exemption would.
 * Both overflow counts point at `parley notes --path` for the rest.
 */
function contextFor(state: State, paths: string[], meId: string, ctx: Ctx): {
  recent: Touch[];
  notes: Note[];
  moreNotes: number;
  moreDecisions: number;
} {
  const recent: Touch[] = [];
  const gathered: Note[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const touch = state.touches[path];
    if (touch && touch.byId !== meId && ctx.nowMs - touch.atMs < 60 * 60_000) recent.push(touch);
    for (const note of notesForPath(state, path)) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      gathered.push(note);
    }
  }

  const decisions = gathered
    .filter((n) => n.kind === "decision")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const rest = gathered
    .filter((n) => n.kind !== "decision")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    recent,
    notes: [...decisions.slice(0, DECISIONS_CAP), ...rest.slice(0, NOTES_CAP)],
    moreNotes: Math.max(0, rest.length - NOTES_CAP),
    moreDecisions: Math.max(0, decisions.length - DECISIONS_CAP),
  };
}

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

/**
 * The claim covering a concrete path, if any.
 *
 * Not the same function as `ownerForPath` in `work.ts`, on purpose: this one
 * serves permissions and may lean on the no-overlapping-live-claims invariant
 * `claim` enforces, while that one must stay correct even when a replayed
 * journal has broken it. Different correctness contracts, so not collapsed.
 */
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

  const context = contextFor(state, paths, me.id, ctx);

  const claimed: string[] = [];
  for (const pattern of paths) {
    recordTouch(state, pattern, me.id, intent, ctx);
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
          about: me.id,
        }),
      ]
    : [];

  return {
    state,
    response: ok({
      claimed, auto, recent: context.recent, notes: context.notes,
      more_notes: context.moreNotes, more_decisions: context.moreDecisions,
    }),
    broadcast,
  };
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
        about: me.id,
      }),
    );
    broadcast.push(...resolvePendingOnRelease(state, me.id, released, ctx));
  }

  return { state, response: ok({ released, settled: broadcast.length - 1 }), broadcast };
}
