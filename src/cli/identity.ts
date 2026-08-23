import { execFileSync } from "node:child_process";
import { basename } from "node:path";

export interface Identity {
  name: string;
  branch: string;
  /** True when derived rather than chosen: the CLI may accept a suggested name. */
  provisional: boolean;
  mission: string;
  harness: string;
  /**
   * Who started this session, read from the environment `bearFront` writes.
   *
   * This is the consuming half of `PARLEY_BORN`. Without it the variable was
   * written into every newborn's environment and read by nobody, so every
   * participant arrived on the bus as `person` and `shouldRetire` — whose
   * first line is `p.born !== "parley"` — was false for every front that has
   * ever existed. Both ends were tested; the wire between them was not.
   */
  born: "person" | "parley";
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
    // Set by `bearFront` and inherited by everything the newborn runs, which
    // is exactly the scope wanted: every `parley` call a spawned front makes,
    // through the hook or through its shell, is a call by a parley-born front.
    born: process.env.PARLEY_BORN?.trim() === "parley" ? "parley" : "person",
  };
}

/**
 * The one place a `join` frame is built.
 *
 * There were four of them before, in three files, and `born` was in none —
 * which is how a field the state machine gates a whole feature on could be
 * produced by `bearFront`, consumed by `shouldRetire`, and never once travel
 * between the two. A single producer is what makes "every join carries it" a
 * property of the code rather than of four people remembering.
 *
 * `extra` carries what only the caller knows — `cwd`, `kind`, `session`,
 * `wake`, `connected` — and may override any derived field (the NAME_TAKEN
 * retry re-sends the same frame under the suggested name).
 *
 * Except `born`, which is stamped after the spread. The retry only ever needs
 * `name`, and the entire point of a single producer is that `born` cannot be
 * forgotten on the way to the bus — so it is the one field no caller can
 * overwrite, by accident or otherwise.
 */
export function joinFrame(identity: Identity, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    op: "join",
    name: identity.name,
    mission: identity.mission,
    harness: identity.harness,
    branch: identity.branch,
    ...extra,
    born: identity.born,
  };
}

/** Where this session can be woken, if its harness publishes such an address. */
export function wakeAddress(): string {
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  return socket ? `uds:${socket}` : "";
}

function detectHarness(): string {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return "codex";
  if (process.env.CURSOR_TRACE_ID) return "cursor";
  if (process.env.TERM_PROGRAM === "vscode") return "vscode";
  return "shell";
}
