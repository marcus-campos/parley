import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

export interface WorkspaceMarker {
  /** The .code-workspace file this came from, when it came from one. */
  file: string | null;
  /** Member directories, absolute. Only these belong to the bus. */
  members: string[];
  at: string;
}

export function workspaceMarkerPath(root: string): string {
  return join(root, ".parley", "workspace");
}

export function markAsWorkspace(root: string, marker: WorkspaceMarker): void {
  const path = workspaceMarkerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

export function readWorkspaceMarker(root: string): WorkspaceMarker | null {
  const path = workspaceMarkerPath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkspaceMarker;
    return Array.isArray(parsed?.members) ? parsed : null;
  } catch {
    // A marker from before membership was recorded meant "every repository
    // directly inside". Keep honouring it rather than silently doing nothing.
    return { file: null, members: membersOf(root).map((m) => join(root, m)), at: "" };
  }
}

/**
 * VS Code writes JSON with comments and trailing commas, and people edit these
 * by hand. Being strict here would mean refusing a file the editor accepts.
 */
export function parseWorkspaceFile(text: string): string[] {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    const parsed = JSON.parse(stripped) as { folders?: { path?: string }[] };
    return (parsed.folders ?? [])
      .map((f) => (typeof f?.path === "string" ? f.path : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** `.code-workspace` files sitting in a directory. */
export function workspaceFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".code-workspace"))
      .map((f) => join(dir, f))
      .sort();
  } catch {
    return [];
  }
}

/** Deepest directory containing all of them. */
export function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return "";
  const split = paths.map((p) => resolve(p).split("/"));
  const first = split[0]!;
  let shared = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < shared && i < parts.length && parts[i] === first[i]) i++;
    shared = i;
  }
  return first.slice(0, shared).join("/") || "/";
}

/** Resolve a .code-workspace into the bus root and its members. */
export function readWorkspaceFile(file: string): { root: string; members: string[] } | null {
  if (!existsSync(file)) return null;
  const folders = parseWorkspaceFile(readFileSync(file, "utf8"));
  if (folders.length === 0) return null;
  const base = dirname(resolve(file));
  const members = folders.map((f) => resolve(base, f));
  // A workspace whose folders live above the file still needs one root that
  // every territory path can be relative to.
  const root = members.every((m) => m.startsWith(`${base}/`) || m === base)
    ? base
    : commonAncestor([...members, base]);
  return { root, members };
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
  const here = resolve(cwd);
  let root = findWorkspaceRoot(here);

  // Being *under* a marked directory is not enough: a workspace names its
  // folders, and the directory that holds them usually holds a dozen others
  // that have nothing to do with it. A session in one of those keeps its own
  // repository bus.
  while (root) {
    const marker = readWorkspaceMarker(root);
    const belongs =
      !marker ||
      marker.members.length === 0 ||
      here === root ||
      marker.members.some((m) => here === m || here.startsWith(`${m}/`));
    if (belongs) break;
    const up = dirname(root);
    root = up === root ? null : findWorkspaceRoot(up);
  }
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
