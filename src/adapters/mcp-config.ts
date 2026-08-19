import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Wiring parley into the harnesses that have no pre-tool gate.
 *
 * They all reach it the same way — as an MCP server over stdio — and differ
 * only in where the configuration lives. Where a format is confirmed, this
 * writes it. Where it is not, it says so and points at the manual snippet,
 * because a config file written on a guess is worse than a paragraph of
 * instructions: it fails silently and the user has no idea why.
 */

export interface McpTarget {
  id: string;
  label: string;
  /**
   * A global config affects every repository on the machine. Running `init`
   * inside one project and silently changing a machine-wide file is exactly the
   * kind of surprise that makes people stop trusting a tool, so the scope is
   * part of what gets shown before anything is written.
   */
  scope: "repository" | "global";
  /** Where the config lives, or null when we only know how to print a snippet. */
  path: string | null;
  detected: boolean;
  /** Confirmed against the real thing, or best-effort. */
  confirmed: boolean;
  note?: string;
}

export const MCP_SERVER_ENTRY = {
  command: "parley",
  args: ["mcp"],
} as const;

export function detectMcpTargets(repoRoot: string, label?: string): McpTarget[] {
  const home = homedir();
  const codex = join(home, ".codex", "config.toml");
  const projectMcp = join(repoRoot, ".mcp.json");

  return [
    {
      id: "project-mcp",
      label: `Project MCP config${label ? ` — ${label}` : ""} (.mcp.json)`,
      scope: "repository",
      path: projectMcp,
      // Always offered: it is the portable, per-repository way in, and the one
      // a colleague who clones the repo inherits.
      detected: true,
      confirmed: true,
      note: "read by Claude Code and by a growing number of MCP clients",
    },
    {
      id: "codex",
      label: "Codex CLI",
      scope: "global",
      path: codex,
      detected: existsSync(dirname(codex)),
      confirmed: true,
      note: "~/.codex/config.toml, [mcp_servers.parley]",
    },
    {
      id: "antigravity",
      label: "Antigravity",
      scope: "global",
      path: null,
      detected: existsSync(join(home, ".antigravity")) || existsSync(join(home, "Library", "Application Support", "Antigravity")),
      confirmed: false,
      note: "MCP config format not confirmed; add the snippet by hand",
    },
    {
      id: "kimi",
      label: "Kimi CLI",
      scope: "global",
      path: null,
      detected: existsSync(join(home, ".kimi")),
      confirmed: false,
      note: "MCP config format not confirmed; add the snippet by hand",
    },
  ];
}

/** What to paste when we cannot write the file ourselves. */
export function manualSnippet(): string {
  return JSON.stringify({ mcpServers: { parley: MCP_SERVER_ENTRY } }, null, 2);
}

export function projectMcpPlan(path: string): { before: string; after: string } {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  let parsed: Record<string, unknown> = {};
  if (before.trim()) {
    try { parsed = JSON.parse(before) as Record<string, unknown>; } catch { parsed = {}; }
  }
  const servers = (parsed.mcpServers as Record<string, unknown>) ?? {};
  const after = `${JSON.stringify({ ...parsed, mcpServers: { ...servers, parley: MCP_SERVER_ENTRY } }, null, 2)}\n`;
  return { before, after };
}

export function writeProjectMcp(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, projectMcpPlan(path).after, "utf8");
}

const CODEX_BLOCK = `[mcp_servers.parley]
command = "parley"
args = ["mcp"]
`;

/**
 * TOML edited as text on purpose. Round-tripping through a parser would
 * reformat and reorder a file the user wrote by hand, and this is their
 * configuration, not ours — we add one block and leave the rest untouched.
 */
export function codexPlan(path: string): { before: string; after: string } {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (before.includes("[mcp_servers.parley]")) {
    const after = before.replace(
      /\[mcp_servers\.parley\][\s\S]*?(?=\n\[|$)/,
      CODEX_BLOCK.trimEnd(),
    );
    return { before, after: after.endsWith("\n") ? after : `${after}\n` };
  }
  const separator = before.trim() ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  return { before, after: `${before}${separator}${CODEX_BLOCK}` };
}

export function writeCodex(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, codexPlan(path).after, "utf8");
}

export const AGENTS_SECTION = `## parley — other agents may be in this repository

Other agent sessions can be working in this same repository right now. parley is
the bus that keeps you from colliding with them. It is available to you as MCP
tools (\`parley_who\`, \`parley_claim\`, \`parley_say\`, \`parley_ask\`,
\`parley_note\`, \`parley_results\`, …).

- **Before any broad change**, call \`parley_who\` to see who is here and what
  they hold, and \`parley_say\` to announce what you are about to do.
- **Before editing files**, call \`parley_claim\` with the paths. The answer
  tells you what other fronts wrote down about those files and who edited them
  recently — read it, it is usually why the obvious change is wrong.
- **Release the moment you are done**, not at the end of the session:
  \`parley_release\`. Holding a path you are not editing blocks everyone else.
- **Before running a long suite**, call \`parley_results\`. If someone already
  ran it and nothing it depends on changed, running it again buys nothing.
- **When you learn something the code does not say about itself**, call
  \`parley_note\` with \`paths\` — it will be handed automatically to whoever
  edits those files next.
- Messages from the other sessions arrive in the footer of every parley tool
  response. A message marked \`(human)\` is a person watching; weigh it, but
  never wait for one.
`;

export function agentsFilePlan(repoRoot: string): { path: string; before: string; after: string; already: boolean } {
  const path = join(repoRoot, "AGENTS.md");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const already = before.includes("## parley — other agents may be in this repository");
  const separator = before.trim() ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  return { path, before, after: already ? before : `${before}${separator}${AGENTS_SECTION}`, already };
}

export function writeAgentsFile(repoRoot: string): void {
  const plan = agentsFilePlan(repoRoot);
  if (plan.already) return;
  writeFileSync(plan.path, plan.after, "utf8");
}

/** Undo what `init` wrote, and only that. */
export function removeProjectMcp(path: string): boolean {
  if (!existsSync(path)) return false;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return false; }
  const servers = (parsed.mcpServers as Record<string, unknown>) ?? {};
  if (!("parley" in servers)) return false;
  delete servers.parley;
  const next = Object.keys(servers).length ? { ...parsed, mcpServers: servers } : (() => {
    const copy = { ...parsed };
    delete copy.mcpServers;
    return copy;
  })();
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return true;
}

export function removeCodex(path: string): boolean {
  if (!existsSync(path)) return false;
  const before = readFileSync(path, "utf8");
  if (!before.includes("[mcp_servers.parley]")) return false;
  const after = before.replace(/\n*\[mcp_servers\.parley\][\s\S]*?(?=\n\[|$)/, "");
  writeFileSync(path, after.endsWith("\n") ? after : `${after}\n`, "utf8");
  return true;
}
