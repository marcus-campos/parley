import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * How this repository is willing to have fronts created for it.
 *
 * Lives beside `panel.json`, inside the git directory, so it is per-repo and
 * never committed. Spawning costs money, so the ceiling is a file somebody had
 * to write, not a default somebody has to discover.
 */
export interface SpawnConfig {
  /**
   * `panel` spawns headless and streams the front into the panel that already
   * exists. `terminal` opens a real system terminal. `terminal` that cannot
   * open degrades to `panel` and says so loudly.
   */
  mode: "panel" | "terminal";
  /** Which harness to spawn. Resolved from the adapter registry when absent. */
  harness?: string;
  maxFronts: number;
}

export const SPAWN_DEFAULTS: SpawnConfig = { mode: "panel", maxFronts: 6 };

const MIN_FRONTS = 1;
const MAX_FRONTS = 32;

function spawnConfigPath(gitCommonDir: string): string {
  return join(gitCommonDir, "parley", "spawn.json");
}

export function readSpawnConfig(gitCommonDir: string): SpawnConfig {
  return readSpawnConfigIn(join(gitCommonDir, "parley"));
}

/**
 * The same file, addressed by the directory it is actually in rather than by
 * the git directory above it.
 *
 * The daemon is handed the discovery directory — `<git-common-dir>/parley` for
 * a repository, `<workspace>/.parley` for a workspace — under a parameter
 * still named `gitCommonDir`. Calling `readSpawnConfig` with it therefore
 * looked for `<git-common-dir>/parley/parley/spawn.json`, a path nothing
 * writes, so every daemon in production silently ran on `SPAWN_DEFAULTS` and
 * `maxFronts` in `spawn.json` was never read by the process that enforces it.
 * `endpoint.json` and `panel.json` both live directly in the discovery
 * directory; so does this.
 */
export function readSpawnConfigIn(discoveryDir: string): SpawnConfig {
  const path = join(discoveryDir, "spawn.json");
  if (!existsSync(path)) return { ...SPAWN_DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SpawnConfig>;
    const mode = raw.mode === "terminal" ? "terminal" : "panel";
    const wanted = typeof raw.maxFronts === "number" && Number.isFinite(raw.maxFronts)
      ? Math.round(raw.maxFronts)
      : SPAWN_DEFAULTS.maxFronts;
    return {
      mode,
      harness: typeof raw.harness === "string" ? raw.harness : undefined,
      maxFronts: Math.min(MAX_FRONTS, Math.max(MIN_FRONTS, wanted)),
    };
  } catch {
    // A config nobody can parse must not stop the daemon booting.
    return { ...SPAWN_DEFAULTS };
  }
}

export function writeSpawnConfig(gitCommonDir: string, config: SpawnConfig): void {
  const path = spawnConfigPath(gitCommonDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    // Remembering the choice is a convenience; failing to is not worth an error.
  }
}
