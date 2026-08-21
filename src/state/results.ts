import { err, ok } from "../protocol/types";
import { matchesPath, readPathList } from "../repo/paths";
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
    paths: readPathList(frame.paths).length ? readPathList(frame.paths) : ["**"],
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

  // Same treatment as listNotes: the daemon resolves `q` into ranked `ids`
  // before `apply`, so this stays pure and never searches on its own.
  if (Array.isArray(frame.ids)) {
    const byKey = new Map(results.map((r) => [r.key, r]));
    const ranked = (frame.ids as unknown[])
      .map((id) => (typeof id === "string" ? byKey.get(id) : undefined))
      .filter((r): r is CommandResult => r !== undefined);
    return { state, response: ok({ results: ranked, ranked: true }), broadcast: [] };
  }

  return { state, response: ok({ results }), broadcast: [] };
}
