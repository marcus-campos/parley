import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { canonicalizeRepoPath, detectEnv, repoId } from "./canonical";
import { findWorkspaceScope } from "./workspace";

export interface RepoInfo {
  /** Where `endpoint.json` lives for this scope. */
  discoveryDir: string;
  /** "repository" or "workspace" — what one bus covers here. */
  scope: "repository" | "workspace";
  /** Working-tree root of the current worktree. */
  root: string;
  /** Shared across every worktree of the repository — this is the bus identity. */
  gitCommonDir: string;
  canonical: string;
  repoId: string;
}

export class NotARepository extends Error {
  constructor(cwd: string) {
    super(`not inside a git repository: ${cwd}`);
    this.name = "NotARepository";
  }
}

/**
 * The bus key is `git rev-parse --git-common-dir`, not the session directory.
 * Every worktree of a repository shares one common dir, so five sessions land
 * on the same bus without configuring anything.
 */
export function locateRepo(cwd: string = process.cwd()): RepoInfo {
  // A marked workspace wins: the bus then covers every repository inside it.
  const workspace = findWorkspaceScope(cwd);
  if (workspace) return workspace;

  let out: string;
  try {
    out = execFileSync("git", ["rev-parse", "--git-common-dir", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new NotARepository(cwd);
  }

  const [rawCommon = "", rawRoot = ""] = out.trim().split("\n");
  const gitCommonDir = isAbsolute(rawCommon) ? rawCommon : resolve(cwd, rawCommon);
  const root = isAbsolute(rawRoot) ? rawRoot : resolve(cwd, rawRoot);
  const canonical = canonicalizeRepoPath(gitCommonDir, detectEnv());

  return {
    root, gitCommonDir, canonical, repoId: repoId(canonical),
    discoveryDir: resolve(gitCommonDir, "parley"),
    scope: "repository",
  };
}
