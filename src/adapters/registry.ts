import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Every repository where parley was set up.
 *
 * Without this, `parley update` could only refresh the hooks and skill of the
 * repository you happened to be standing in — so keeping five projects current
 * meant running it five times, and forgetting one meant an agent quietly
 * reading last month's instructions.
 */

export interface RegisteredRepo {
  gitCommonDir: string;
  root: string;
  /** Where this scope's parley files live. Older entries do not have it. */
  discoveryDir?: string;
  at: string;
}

function registryPath(): string {
  // Alongside the runtime state, never inside a repository: this is a fact
  // about the machine, not about any one project.
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "parley", "repos.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "parley", "repos.json");
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "parley", "repos.json");
}

export function readRegistry(): RegisteredRepo[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RegisteredRepo[];
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r?.gitCommonDir === "string") : [];
  } catch {
    return [];
  }
}

function write(repos: RegisteredRepo[]): void {
  const path = registryPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(repos, null, 2)}\n`, "utf8");
  } catch {
    // The registry is a convenience; failing to keep it never fails a command.
  }
}

export function registerRepo(gitCommonDir: string, root: string, discoveryDir?: string): void {
  const repos = readRegistry().filter((r) => r.gitCommonDir !== gitCommonDir);
  repos.push({ gitCommonDir, root, discoveryDir, at: new Date().toISOString() });
  write(repos);
}

export function forgetRepo(gitCommonDir: string): void {
  write(readRegistry().filter((r) => r.gitCommonDir !== gitCommonDir));
}

/** Drop entries whose repository has been deleted or moved. */
export function pruneRegistry(): RegisteredRepo[] {
  const alive = readRegistry().filter((r) => existsSync(r.gitCommonDir) && existsSync(r.root));
  if (alive.length !== readRegistry().length) write(alive);
  return alive;
}
