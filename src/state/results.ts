import { err, ok } from "../protocol/types";
import { matchesPath, normalizeTerritoryPath } from "../repo/paths";
import { actorOf, type CommandResult, type Ctx, type Outcome, type State } from "./types";

/**
 * Command results worth not running again.
 *
 * Front A runs the suite: two minutes of wall clock, plus the tokens to read
 * the output. Ten minutes later front B runs the same suite, on the same tree,
 * and pays both again. The bus already knows who touched what and when, so it
 * can say whether the answer A got still holds.
 *
 * Staleness is computed on read rather than stamped on write: a result is stale
 * the moment anything it depends on is touched, and nothing has to go around
 * invalidating it.
 */
export function staleReason(state: State, result: CommandResult): string | null {
  for (const [path, touch] of Object.entries(state.touches)) {
    if (touch.atMs <= result.atMs) continue;
    if (result.paths.some((pattern) => matchesPath(pattern, path))) {
      return `${touch.byName} touched ${path} after this ran`;
    }
  }
  return null;
}

function readPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const p of value) {
    if (typeof p !== "string" || !p.trim()) continue;
    try { out.push(normalizeTerritoryPath(p)); } catch { /* not a usable path */ }
  }
  return out;
}

export function recordResult(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const key = typeof frame.key === "string" ? frame.key.trim() : "";
  if (!key) return { state, response: err("UNKNOWN_OP", "a result needs a key, e.g. \"bun test\""), broadcast: [] };

  const status =
    frame.status === "pass" ? "pass" : frame.status === "fail" ? "fail" : "unknown";

  const entry: CommandResult = {
    key,
    status,
    summary: typeof frame.summary === "string" ? frame.summary : "",
    // With no paths declared, anything touched anywhere invalidates it. That is
    // the safe default: better to re-run than to trust a stale green.
    paths: readPaths(frame.paths).length ? readPaths(frame.paths) : ["**"],
    byId: me.id,
    byName: me.name,
    at: ctx.now,
    atMs: ctx.nowMs,
    staleBecause: null,
  };
  state.results[key] = entry;
  me.lastSeenMs = ctx.nowMs;

  return { state, response: ok({ key, status }), broadcast: [] };
}

export function listResults(state: State, frame: Record<string, unknown>): Outcome {
  const wanted = typeof frame.key === "string" && frame.key ? frame.key : null;
  const results = Object.values(state.results)
    .filter((r) => !wanted || r.key === wanted)
    .map((r) => ({ ...r, staleBecause: staleReason(state, r) }))
    .filter((r) => frame.fresh !== true || r.staleBecause === null);

  return { state, response: ok({ results }), broadcast: [] };
}
