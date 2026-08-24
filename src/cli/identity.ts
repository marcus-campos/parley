import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
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

/**
 * Who the person is, as distinct from what a front is.
 *
 * A front's name comes from its branch or worktree, because that is what
 * distinguishes one front from another. A person is not distinguished that
 * way — they are the same person in every repository and on every branch, and
 * they are watching several fronts at once. Deriving their name the same way
 * puts them in the fronts' namespace, where the branch name is already taken by
 * the front working on it.
 *
 * `--as` still wins, for somebody who wants to be called something else.
 */
export function personIdentity(preferred?: string): Identity {
  // Not the machine's account name. It leaks who owns the laptop onto a bus
  // other people read, and it is usually meaningless anyway — `ubuntu`,
  // `admin`, `runner`. A person who wants to be called something says so with
  // `--as`; until then they are simply the person, which is the only thing the
  // bus needs to know about them.
  const name = (preferred?.trim() || "person")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 32);
  return {
    name: name || "PERSON",
    mission: "",
    harness: "cli",
    branch: "",
    born: "person",
    // Never provisional: the name is the person's, not one derived from a
    // branch that a front is expected to rename itself away from.
    provisional: false,
  };
}

/**
 * A session key scoped to the person, not to a directory.
 *
 * The front path falls back to a session recalled from the working directory,
 * which is exactly what made a person's shell reattach to the agent working
 * there. This one is stable across repositories and branches, so a person's
 * commands are one participant wherever they run them, and never a front's.
 */
export function personSession(): string {
  // Stable per machine account, and never sent: this is a key the daemon uses
  // to recognise the same shell coming back, not a name anybody reads.
  return `person:${userInfo().username || "unknown"}`;
}
