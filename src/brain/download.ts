import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectAddrEnv } from "../transport/address";
import type { BrainModel } from "./registry";

/**
 * Models live outside any repository, keyed by model name rather than repo:
 * one download serves every project, exactly like `repos.json` in
 * `src/adapters/registry.ts`. This mirrors the per-OS branching `stateDir`
 * (`src/transport/address.ts:59`) uses for the repo-scoped state directory,
 * with a `models` folder standing in for the repo id — a fact about the
 * machine, not about any one project.
 */
function defaultModelsDir(): string {
  const env = detectAddrEnv(process.cwd());
  if (env.platform === "win32") {
    return join(env.localAppData ?? join(env.home, "AppData", "Local"), "parley", "models");
  }
  if (env.platform === "darwin") {
    return join(env.home, "Library", "Application Support", "parley", "models");
  }
  return join(env.xdgStateHome ?? join(env.home, ".local", "state"), "parley", "models");
}

/**
 * `baseDir` defaults to the real machine-local models directory so every
 * production caller is unchanged. Tests pass a throwaway directory instead,
 * so the suite never writes into a developer's real machine-local state —
 * the same trap a prior review filed against a suite mutating the real
 * adapter registry.
 */
export function modelPath(model: BrainModel, baseDir?: string): string {
  return join(baseDir ?? defaultModelsDir(), model.name, "model.bin");
}

/**
 * Fetch, hash, compare, and refuse to install a corrupted file — the same
 * suspicion `install.sh:75-97` applies to the parley binary, applied here to
 * a model: code-adjacent data that will shape what agents believe about this
 * repository.
 *
 * A broken parley must never stop the work: every failure — network, HTTP,
 * checksum mismatch — is reported as `null` and never thrown. A file that
 * fails verification is written and then deleted rather than left on disk
 * corrupted, and the brain stays off.
 */
export async function ensureModel(
  model: BrainModel,
  fetchFn: typeof fetch = fetch,
  baseDir?: string,
): Promise<string | null> {
  const path = modelPath(model, baseDir);
  try {
    if (existsSync(path)) return path;

    const response = await fetchFn(model.url);
    if (!response.ok) return null;

    const body = new Uint8Array(await response.arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);

    if (digest !== model.sha256) {
      rmSync(path, { force: true });
      return null;
    }
    return path;
  } catch {
    return null;
  }
}
