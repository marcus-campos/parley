import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Worktree {
  path: string;
  branch: string;
}

/**
 * Nothing here may run without a bound.
 *
 * Every one of these calls is made by the daemon, which is single-threaded and
 * serves every front on this repository from one event loop. `git` on a real
 * repository is not fast — a warm `git status --porcelain` measures ~13ms on a
 * two-file repository and far more with `node_modules` and a cold cache — and
 * `git` on a repository with a stale `index.lock`, or on a network filesystem,
 * does not finish at all. A daemon wedged behind a hung subprocess is a broken
 * parley that stops the work, which is the one thing it must never do.
 */
const GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", windowsHide: true, timeout: GIT_TIMEOUT_MS,
  }).trim();
}

/** The same call, off the event loop. Never rejects; resolves `null` on failure. */
function gitAsync(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: GIT_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : String(stdout).trim()));
  });
}

/**
 * A newborn front always gets its own directory.
 *
 * Territory settles the logical conflict — two agents in one file. It does
 * nothing about the physical one: the same port, the same `dist/`, the same dev
 * server. A front born inside an occupied worktree inherits all of that, and
 * the bus never finds out.
 *
 * The conversation is not fragmented by this, because the bus is keyed on
 * `git-common-dir`, which is exactly what every worktree of a repository
 * shares.
 *
 * Synchronous, unlike the removal below, because a birth already costs a
 * process spawn and happens at most once per `BIRTH_COOLDOWN_MS`; the timeout
 * is what keeps "at most once per five minutes" from ever becoming "forever".
 */
export function addWorktree(repoRoot: string, name: string): Worktree {
  const dir = join(repoRoot, ".parley", "worktrees", name);
  const branch = `parley/${name}`;
  git(repoRoot, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { path: dir, branch };
}

/**
 * Removed only when it holds nothing. A front's work is never thrown away.
 *
 * Asynchronous on purpose. This is two subprocesses, and it is called from the
 * daemon on the same path every hook frame takes — a path with a 30ms budget
 * per hook. Run synchronously it turned one retiring front into tens of
 * milliseconds of dead air for every other front on the bus, and the cost was
 * cruelly asymmetric: when removal succeeded it went away, and when it failed
 * — a front with uncommitted work, the case most worth being gentle about —
 * the full cost repeated on every tick forever.
 */
export async function removeWorktreeIfClean(repoRoot: string, path: string): Promise<boolean> {
  if (!existsSync(path)) return true;
  const status = await gitAsync(path, ["status", "--porcelain"]);
  // `null` is a git that failed or timed out — not proof the tree is clean.
  if (status === null || status !== "") return false;
  const removed = await gitAsync(repoRoot, ["worktree", "remove", path]);
  // A worktree that will not come off is left where it is. Losing disk is
  // cheaper than losing somebody's changes.
  return removed !== null;
}
