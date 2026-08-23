import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

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

/** Where every newborn's directory goes. The one place that decides so. */
function worktreeHome(repoRoot: string): string {
  return join(repoRoot, ".parley", "worktrees");
}

/**
 * Is this a directory parley made for a newborn front?
 *
 * A front's cwd is wherever its process happened to be, not a fact about what
 * parley made — so this is what stands between `collectWorktree` and somebody
 * else's checkout. It reads the layout from `addWorktree`'s own helper rather
 * than restating it, because a guard that spells out a path a second time is
 * a guard that stops matching the day the layout moves.
 *
 * The directory `.parley/worktrees` itself is not one of them: only what is
 * *inside* it is. The previous form admitted it exactly (`cwd !== home && !cwd
 * .startsWith(home + sep)`), which read as if it excluded that directory and
 * did the opposite. Git refused it anyway, so nothing was ever lost — but "git
 * would have refused" is not what this guard is for.
 */
export function isNewbornWorktree(repoRoot: string, cwd: string): boolean {
  if (!cwd) return false;
  return cwd.startsWith(`${worktreeHome(repoRoot)}${sep}`);
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
  const dir = join(worktreeHome(repoRoot), name);
  const branch = `parley/${name}`;
  git(repoRoot, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { path: dir, branch };
}

/**
 * What became of a worktree that was offered up for collection.
 *
 * A boolean could not tell "there was nothing to remove" from "we could not
 * find out", and those are the two ends of the one guarantee this module has:
 * **a git that failed is not proof that a tree is clean**. Mutating that
 * branch — treating a failed or timed-out `git status` as clean — left the
 * whole suite green, because with git's own refusal still in place the
 * *outcome* was identical and only an attempted subprocess differed. Naming
 * the outcomes makes the guarantee assertable from outside, with no fake git
 * anywhere: a path where `git status` genuinely cannot run is a directory
 * outside any repository.
 */
export type WorktreeRemoval =
  /** Gone — or already absent, which is the same thing to a caller. */
  | "removed"
  /** It holds changes. Nobody's work is thrown away. */
  | "dirty"
  /** `git status` failed or timed out. Nothing was attempted, nothing is known. */
  | "unknown"
  /** Clean, and `git worktree remove` refused it anyway. */
  | "failed";

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
export async function removeWorktreeIfClean(repoRoot: string, path: string): Promise<WorktreeRemoval> {
  if (!existsSync(path)) return "removed";
  const status = await gitAsync(path, ["status", "--porcelain"]);
  // `null` is a git that failed or timed out — not proof the tree is clean,
  // and the one thing git's own refusal cannot cover, because you would have
  // to attempt the removal to find out.
  if (status === null) return "unknown";
  if (status !== "") return "dirty";
  const removed = await gitAsync(repoRoot, ["worktree", "remove", path]);
  // A worktree that will not come off is left where it is. Losing disk is
  // cheaper than losing somebody's changes.
  return removed === null ? "failed" : "removed";
}
