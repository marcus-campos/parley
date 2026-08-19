import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEndpoint } from "../daemon/endpoint";
import { readRunningPanel } from "./web";
import { pruneRegistry } from "../adapters/registry";
import { locateRepo } from "../repo/locate";
import { detectAddrEnv, stateDir } from "../transport/address";

/**
 * Every bus this machine knows about, and where the conversation actually is.
 *
 * With one repository this question does not exist. With a workspace, a dozen
 * projects and a handful of worktrees it becomes the first question you have:
 * the agents are clearly talking, and the panel you happen to have open is
 * quiet — because it is a different bus. Guessing which one to open is not a
 * reasonable thing to ask of somebody.
 */

export interface BusSummary {
  root: string;
  scope: "repository" | "workspace";
  id: string;
  live: boolean;
  fronts: number;
  says: number;
  lastActivity: string | null;
  panel: string | null;
}

/** Cheap read of a journal: how much was said, and when anything last happened. */
function readJournalSummary(path: string): { says: number; last: string | null } {
  if (!existsSync(path)) return { says: 0, last: null };
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    let says = 0;
    let last: string | null = null;
    for (const line of lines) {
      if (line.includes('"op":"say"') || line.includes('"op":"question"')) says++;
      const at = /"at":"([^"]+)"/.exec(line);
      if (at) last = at[1]!;
    }
    return { says, last };
  } catch {
    return { says: 0, last: null };
  }
}

export function summariseBuses(): BusSummary[] {
  const byId = new Map<string, BusSummary>();

  for (const entry of pruneRegistry()) {
    // Resolve the scope the same way every other command does, rather than
    // guessing from the path. A member of a workspace is on the workspace bus,
    // and several registered roots collapse onto one bus — showing them
    // separately is how you end up opening the wrong panel.
    let scope: { root: string; repoId: string; discoveryDir: string; scope: "repository" | "workspace" };
    try {
      scope = locateRepo(entry.root);
    } catch {
      continue;
    }
    if (byId.has(scope.repoId)) continue;

    const endpoint = readEndpoint(scope.discoveryDir);
    const env = detectAddrEnv(scope.root);
    const { says, last } = readJournalSummary(join(stateDir(scope.repoId, env), "journal.ndjson"));

    let live = false;
    if (endpoint) {
      try { process.kill(endpoint.pid, 0); live = true; } catch { live = false; }
    }

    byId.set(scope.repoId, {
      root: scope.root,
      scope: scope.scope,
      id: scope.repoId,
      live,
      fronts: 0,
      says,
      lastActivity: last,
      panel: readRunningPanel(scope.discoveryDir)?.url ?? null,
    });
  }

  // Busiest first: the one you are looking for is almost always the one with
  // the most recent activity.
  return [...byId.values()].sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}
