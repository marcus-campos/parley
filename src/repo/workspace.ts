import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalizeRepoPath, detectEnv, repoId } from "./canonical";
import type { RepoInfo } from "./locate";

/**
 * A multi-root workspace as one bus.
 *
 * One repository per bus is right until someone opens a VS Code multi-root
 * workspace: a single session then edits several repositories, joins whichever
 * bus its cwd happens to sit in, and two sessions working across the same set
 * of projects never see each other.
 *
 * Marking the directory that holds them makes it the bus instead. Territory
 * then reads `yzilab-front/src/app.ts`, which is both unambiguous and how a
 * person would say it.
 *
 * It is opt-in and never inferred. Guessing would put the same session on a
 * different bus depending on where it was started from, and territory that
 * silently splits in two is worse than no territory at all.
 */

export function workspaceMarkerPath(root: string): string {
  return join(root, ".parley", "workspace");
}

export function markAsWorkspace(root: string): void {
  const path = workspaceMarkerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${new Date().toISOString()}\n`, "utf8");
}

/** Git repositories directly inside a directory. */
export function membersOf(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, e.name, ".git")))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Nearest marked workspace at or above `from`. */
export function findWorkspaceRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(workspaceMarkerPath(dir))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function findWorkspaceScope(cwd: string): RepoInfo | null {
  const root = findWorkspaceRoot(cwd);
  if (!root) return null;
  const canonical = canonicalizeRepoPath(root, detectEnv());
  return {
    root,
    // No single git dir covers a workspace; the bus key is the directory.
    gitCommonDir: root,
    canonical,
    repoId: repoId(canonical),
    discoveryDir: join(root, ".parley"),
    scope: "workspace",
  };
}
