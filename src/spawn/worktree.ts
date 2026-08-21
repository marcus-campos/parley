import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Worktree {
  path: string;
  branch: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
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
 */
export function addWorktree(repoRoot: string, name: string): Worktree {
  const dir = join(repoRoot, ".parley", "worktrees", name);
  const branch = `parley/${name}`;
  git(repoRoot, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { path: dir, branch };
}

/** Removed only when it holds nothing. A front's work is never thrown away. */
export function removeWorktreeIfClean(repoRoot: string, path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    if (git(path, ["status", "--porcelain"]) !== "") return false;
    git(repoRoot, ["worktree", "remove", path]);
    return true;
  } catch {
    // A worktree that will not come off is left where it is. Losing disk is
    // cheaper than losing somebody's changes.
    return false;
  }
}
