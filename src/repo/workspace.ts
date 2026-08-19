import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
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

/**
 * Resolve symlinks before comparing paths.
 *
 * `/tmp` is a symlink to `/private/tmp` on macOS, home directories are
 * symlinked on plenty of setups, and a harness may hand us either form. Two
 * spellings of the same directory failing to match meant a session inside a
 * workspace silently fell back to its own repository bus — the silent failure
 * class again.
 */
export function realPath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * One spelling of a path, for comparison only.
 *
 * Splitting and prefix-matching on "/" is wrong on Windows, where the
 * separator is a backslash and the filesystem does not care about case — every
 * membership check silently failed there, and the common ancestor of a set of
 * `C:\...` paths came out as "/". Never store this form; it exists to be
 * compared.
 */
export function comparable(path: string): string {
  const unified = realPath(path).replace(/\\/g, "/");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/** Is `child` the same directory as `parent`, or inside it? */
export function isWithin(child: string, parent: string): boolean {
  const c = comparable(child);
  const p = comparable(parent);
  return c === p || c.startsWith(`${p}/`);
}

/** Deepest directory containing all of them. */
export function commonAncestor(paths: string[]): string {
  if (paths.length === 0) return "";
  // Compare on the normalised form, but return a real path — the answer
  // becomes the workspace root, which everything else is relative to.
  const originals = paths.map((p) => realPath(p));
  const split = originals.map((p) => comparable(p).split("/"));
  const first = split[0]!;
  let shared = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < shared && i < parts.length && parts[i] === first[i]) i++;
    shared = i;
  }
  const depth = Math.max(1, shared);
  const template = originals[0]!.replace(/\\/g, "/").split("/");
  const joined = template.slice(0, depth).join("/");
  return joined || originals[0]!;
}

/** Resolve a .code-workspace into the bus root and its members. */
export function readWorkspaceFile(file: string): { root: string; members: string[] } | null {
  if (!existsSync(file)) return null;
  const folders = parseWorkspaceFile(readFileSync(file, "utf8"));
  if (folders.length === 0) return null;
  const base = realPath(dirname(resolve(file)));
  const members = folders.map((f) => realPath(resolve(base, f)));
  // A workspace whose folders live above the file still needs one root that
  // every territory path can be relative to.
  const root = members.every((m) => isWithin(m, base))
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
  let dir = realPath(from);
  for (;;) {
    if (existsSync(workspaceMarkerPath(dir))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function findWorkspaceScope(cwd: string): RepoInfo | null {
  const here = realPath(cwd);
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
      // The root itself counts, but *being under* it does not — that is the
      // whole distinction: the directory holding seven projects usually holds
      // twenty others that are not part of this workspace.
      comparable(here) === comparable(root) ||
      marker.members.some((m) => isWithin(here, m));
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
    cwd: here,
  };
}
