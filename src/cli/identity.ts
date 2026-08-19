import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface Identity {
  name: string;
  branch: string;
  /** True when derived rather than chosen: the CLI may accept a suggested name. */
  provisional: boolean;
  mission: string;
  harness: string;
}

/**
 * A front that forgets to introduce itself still shows up in `who`, instead of
 * being a ghost editing files. The name comes from the worktree or branch and
 * the agent is told to rename itself.
 */
export function currentBranch(cwd: string): string {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch && branch !== "HEAD" ? branch : "";
  } catch {
    return "";
  }
}

export function deriveName(root: string, cwd: string): string {
  let base = basename(root);
  const branch = currentBranch(cwd);
  if (branch && branch !== "main" && branch !== "master") base = branch;

  const cleaned = base
    .replace(/^worktrees?[-_/]/i, "")
    .replace(/^(feature|feat|fix|chore)[-_/]/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-\d+$/, "")
    .replace(/^-+|-+$/g, "");
  return (cleaned || "SESSION").toUpperCase().slice(0, 32);
}

export function resolveIdentity(root: string, cwd: string, explicitName?: string): Identity {
  const fromEnv = process.env.PARLEY_NAME?.trim();
  const chosen = explicitName?.trim() || fromEnv || "";
  return {
    name: chosen || deriveName(root, cwd),
    branch: currentBranch(cwd),
    provisional: !chosen,
    mission: process.env.PARLEY_MISSION?.trim() ?? "",
    harness: process.env.PARLEY_HARNESS?.trim() ?? detectHarness(),
  };
}

function detectHarness(): string {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return "codex";
  if (process.env.CURSOR_TRACE_ID) return "cursor";
  if (process.env.TERM_PROGRAM === "vscode") return "vscode";
  return "shell";
}
