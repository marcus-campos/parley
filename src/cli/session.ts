import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The session identity of an ephemeral CLI call.
 *
 * The hook knows which harness session it belongs to; a `parley say` the agent
 * runs through its shell knows nothing. Without an identity those calls fell
 * back to matching on name and working directory — and since every session on
 * a branch derives the same name from that branch, one session would re-attach
 * to another's participant and start speaking as it.
 *
 * So the hook writes down what it knows, keyed by worktree, and the CLI reads
 * it. Two harness sessions in the *same* worktree are still ambiguous from a
 * bare shell — nothing in the environment distinguishes them — which is why
 * `join` refuses to hand an identity that already has a session to a caller
 * that has none, instead of guessing.
 */

export interface SessionMarker {
  session: string;
  name: string;
  at: string;
}

function markerPath(gitCommonDir: string, cwd: string): string {
  const key = createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, 12);
  return join(gitCommonDir, "parley", "sessions", `${key}.json`);
}

export function rememberSession(gitCommonDir: string, cwd: string, marker: SessionMarker): void {
  const path = markerPath(gitCommonDir, cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  } catch {
    // Losing the marker costs identity precision, never the call itself.
  }
}

export function recallSession(gitCommonDir: string, cwd: string): SessionMarker | null {
  const path = markerPath(gitCommonDir, cwd);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SessionMarker;
    return typeof parsed?.session === "string" && parsed.session ? parsed : null;
  } catch {
    return null;
  }
}

/** Explicit env wins, then what the hook wrote down for this worktree. */
export function sessionFor(gitCommonDir: string, cwd: string): string {
  const fromEnv = process.env.PARLEY_SESSION?.trim();
  if (fromEnv) return fromEnv;
  return recallSession(gitCommonDir, cwd)?.session ?? "";
}
