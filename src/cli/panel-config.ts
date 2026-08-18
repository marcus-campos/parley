import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What the person watching chose to be called, remembered per repository.
 *
 * Lives beside the endpoint, inside the git directory, so it is per-repo and
 * never committed. A name you had to re-type on every launch would just become
 * a flag with extra steps.
 */
export interface PanelConfig {
  name?: string;
}

function panelConfigPath(gitCommonDir: string): string {
  return join(gitCommonDir, "parley", "panel.json");
}

export function readPanelConfig(gitCommonDir: string): PanelConfig {
  const path = panelConfigPath(gitCommonDir);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PanelConfig;
  } catch {
    return {};
  }
}

export function writePanelConfig(gitCommonDir: string, config: PanelConfig): void {
  const path = panelConfigPath(gitCommonDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    // Remembering the name is a convenience; failing to is not worth an error.
  }
}

/** Names are used as addresses on the bus, so they cannot carry spaces. */
export function sanitiseName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 32);
}
