import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { RepoInfo } from "../repo/locate";
import { VERSION } from "../version";

/**
 * `parley init` touches the user's configuration files, so it never writes
 * blind: it detects, shows the diff, asks, and only then writes. `uninit`
 * removes exactly what it wrote and nothing else.
 */

const MARKER = "parley hook ";

/**
 * The per-repository opt-in, kept in the git common dir so **every worktree
 * shares it**.
 *
 * `.claude/settings.json` lives in the working tree, and `.claude/` is usually
 * gitignored — so hooks installed in the main checkout simply do not exist in
 * the other worktrees, and sessions opened there never join. Installing the
 * hooks globally fixes that, but then they would fire in every repository on
 * the machine. This marker is what makes global hooks safe: they run
 * everywhere, and do nothing where parley was never set up.
 */
export function enabledMarkerPath(discoveryDir: string): string {
  return join(discoveryDir, "enabled");
}

export function isEnabledForRepo(gitCommonDir: string): boolean {
  return existsSync(enabledMarkerPath(gitCommonDir));
}

export function enableForRepo(gitCommonDir: string): void {
  const path = enabledMarkerPath(gitCommonDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `enabled ${new Date().toISOString()}\n`, "utf8");
}

export function disableForRepo(gitCommonDir: string): void {
  try { rmSync(enabledMarkerPath(gitCommonDir), { force: true }); } catch { /* nothing there */ }
}

/** Hooks in ~/.claude/settings.json apply to every project you open. */
export function globalSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export function installGlobalHooks(): { path: string; before: string; after: string } {
  const path = globalSettingsPath();
  const settings = readSettings(path);
  const before = JSON.stringify(settings, null, 2);
  const { merged } = mergeHooks((settings.hooks as HookMap) ?? {});
  return { path, before, after: `${JSON.stringify({ ...settings, hooks: merged }, null, 2)}\n` };
}

export function writeGlobalHooks(): void {
  const plan = installGlobalHooks();
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, plan.after, "utf8");
}

export function removeGlobalHooks(): boolean {
  const path = globalSettingsPath();
  if (!existsSync(path)) return false;
  const settings = readSettings(path);
  const { merged, removed } = stripHooks((settings.hooks as HookMap) ?? {});
  if (removed.length === 0) return false;
  writeFileSync(path, `${JSON.stringify({ ...settings, hooks: merged }, null, 2)}\n`, "utf8");
  return true;
}

interface HookCommand { type: "command"; command: string; timeout?: number }
interface HookMatcher { matcher?: string; hooks: HookCommand[] }
type HookMap = Record<string, HookMatcher[]>;

const PARLEY_HOOKS: HookMap = {
  SessionStart: [{ hooks: [{ type: "command", command: "parley hook SessionStart", timeout: 5 }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "parley hook UserPromptSubmit", timeout: 5 }] }],
  PreToolUse: [
    {
      // Bash is in here for a reason that is not obvious: it is the tool the
      // agent runs `parley` through. Firing the hook just before a Bash call
      // refreshes the record of which harness session owns this worktree
      // microseconds before the CLI call reads it — which is what lets two
      // sessions in the *same* worktree be told apart at all. Territory is
      // still only settled for the editing tools.
      matcher: "Edit|Write|NotebookEdit|MultiEdit|Bash",
      hooks: [{ type: "command", command: "parley hook PreToolUse", timeout: 5 }],
    },
  ],
  // Stop is what stops a front going idle while another is blocked on it.
  Stop: [{ hooks: [{ type: "command", command: "parley hook Stop", timeout: 8 }] }],
  SessionEnd: [{ hooks: [{ type: "command", command: "parley hook SessionEnd", timeout: 5 }] }],
};

const SKILL_BODY = `---
name: parley
description: Use when other agent sessions may be working in this same repository - coordinating file territory, asking permission for a file someone else holds, broadcasting intent, or recording durable knowledge for future sessions. Triggers on merge conflicts with another agent, "who is working on", "is anyone editing", or before a broad refactor.
---

# parley

Other agent sessions can be running in this repository right now, in other
worktrees. parley is the bus that keeps you from colliding with them.

## Say who you are, out loud

Two things, early, and they are not optional:

\`\`\`
parley rename --as SHORTNAME --mission "what you are here to do"
parley whoami
\`\`\`

The name you joined with was derived from the branch, and **every session on
that branch derives the same one** — so it tells nobody anything.

Then **tell the person which name you are using**, in your own reply, in one
line: *"I'm on parley as TAXAS."* They are watching several sessions at once and
the panel shows names, not windows — without you saying it, they cannot tell
which of their windows you are. Say it again if you rename.

## See who is here first

\`\`\`
parley who
\`\`\`

Names, missions, how long they have been idle, and which paths each one holds.
Run it before any broad change.

## Announce intent, do not just start

\`\`\`
parley say "refactoring the alembic heads, do not create migrations for the next hour"
parley say --to FINANCEIRO "your closing job and my route job both touch services.py"
\`\`\`

A message from a participant marked \`(human)\` is a person watching this bus.
Weigh it above a peer's opinion — but **never wait for one, and never ask one to
decide**. A human may be watching and say nothing at all; that is the normal
case, not a signal. Territory and permission are settled between the fronts.

## Territory

Editing a free file claims it automatically. You only need these when you want
to reserve ahead, or hand something back:

\`\`\`
parley claim 'src/backend/finance/**' --intent "closing refactor"
parley release 'src/backend/finance/**'
\`\`\`

**Release the moment you are done.** Not at the end of the session — the moment
you stop needing the path:

\`\`\`
parley release 'src/backend/finance/**'
parley release --all
\`\`\`

Holding a path you are no longer editing blocks every other front on a file
nobody is touching. If someone is waiting on it, releasing hands it straight to
them — you do not answer the request separately. Letting go IS the answer.

**Renewal is automatic while you work**, because every tool call renews your
lease. If you are going to pause for a long time and still need a path, touch it
or re-claim it. A claim you took by editing expires after 15 idle minutes; one
you asked for explicitly is yours until you release it or leave.

## Asking another front, and getting an answer

\`say\` puts a message in someone's inbox, which an idle session will not read
until its person prompts it again. When you actually need an answer, ask:

\`\`\`
parley question --to BUSSOLA "voce esta segurando finance/services.py? preciso de 3 linhas nele"
parley questions          # what you owe an answer to, and what you are waiting on
parley reply q_0003 "nao encosto nele, pode ir"
\`\`\`

A question is different from a message: someone owes an answer. The other
front's session **will not go idle while your question is open** — it is
interrupted and told to answer. So ask instead of guessing, and **answer
promptly when asked**: whoever asked is blocked on you. If you cannot answer,
say that — it unblocks them just as well.

## When a file belongs to someone else

You only need this when somebody actually holds it; asking for a free file is
granted instantly and costs nothing. Do not edit around it and do not wait
silently:

\`\`\`
parley ask src/backend/finance/services.py --reason "adding one column"
\`\`\`

The owner is pushed the request. If nobody answers within five minutes it is
granted to you and announced to everyone, naming who stayed silent. Waiting
longer than that is not politeness, it is waste.

Ask the **owner**, never a human. A human cannot grant or deny — the protocol
refuses it — precisely so that a stalled request never becomes a request for a
person's attention.

## Anchor knowledge to the files it is about

\`--paths\` is what makes a note find its reader. A note anchored to a path is
handed to whoever edits that path, automatically, before they touch it — so you
are not writing for someone who has to remember to look:

\`\`\`
parley note --title "this serializer is used by the mobile app too" \\
  --body "renaming fields here breaks the collection screen" \\
  --paths src/backend/app/accounts/schemas.py
\`\`\`

**Write one whenever you learn something the file does not say about itself** —
a hidden coupling, a trap, why the obvious change is wrong. It costs you one
call and saves the next front the whole investigation you just did.

## Decisions, when the question should stay answered

\`\`\`
parley decide --title "no Pydantic v2 yet" \\
  --body "the mobile serializers depend on v1 coercion"
parley reverse n_0007 --reason "v2 shipped the compat layer"
\`\`\`

A decision is announced to everyone and **binds until reversed**. Use it so the
next front does not relitigate what is already settled. If you disagree with a
standing decision, reverse it on purpose and say why — do not quietly ignore it.

## Do not re-run what someone just ran

\`\`\`
parley results                       # what is known, and whether it still holds
parley result "bun test" --status pass \\
  --summary "145 pass, 0 fail" --paths 'src/**,tests/**'
\`\`\`

Before running a long suite, check \`parley results\`. If another front ran it
and nothing it depends on has been touched since, the answer is still good —
running it again costs minutes and buys nothing. After you run one, record it.

## Knowledge worth keeping

\`say\` is conversation and dies resolved. \`note\` is knowledge every future
session needs, including sessions that do not exist yet:

\`\`\`
parley note --title "CI here runs tsc -b, not tsc --noEmit" \\
  --body "the root tsconfig is solution-style, so --noEmit checks nothing" \\
  --tags ci,typescript
parley notes
\`\`\`

\`.parley/notes.md\` is written for you every time a note is added, and it is
versioned in git — so a note reaches a colleague, another machine, and every
future session. Commit it when it makes sense; parley never commits for you.
\`parley notes --import\` reads that file back onto the bus, which is what a
fresh clone needs.

## If you lose your context

Your inbox is incremental: \`parley drain\` only ever gives you what you have not
seen, so calling it costs nothing when nothing happened. If your context window
dropped what you already read and you need it back:

\`\`\`
parley history --limit 100
parley notes
parley who
\`\`\`

\`history\` does not move your read cursor, so it never costs you a message.

## If parley is not running

Every command spawns the daemon if needed. If it still fails, keep working —
a broken parley must never stop the work. It degrades to advisory and says so.
`;

/**
 * The skill carries the version that wrote it.
 *
 * Without a stamp, "is my skill up to date?" can only be answered by comparing
 * file contents against the binary — which tells you *that* it differs and
 * never *what you have*. The stamp lets a person open the file and see, and
 * lets `doctor` say "skill 0.3.0, current 0.4.2" instead of just "outdated".
 */
export const SKILL_STAMP = /<!-- parley skill v([0-9][^ ]*) -->/;

const SKILL = `${SKILL_BODY}\n<!-- parley skill v${VERSION} -->\n`;

/** Which version wrote the skill on disk, if it says. */
export function skillVersionAt(path: string): string | null {
  if (!existsSync(path)) return null;
  const found = SKILL_STAMP.exec(readFileSync(path, "utf8"));
  return found ? found[1]! : null;
}

function hookOutput(json: boolean, human: string, payload: unknown): void {
  if (json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else process.stdout.write(`${human}\n`);
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isParleyMatcher(m: HookMatcher): boolean {
  return m.hooks?.some((h) => typeof h.command === "string" && h.command.startsWith(MARKER)) ?? false;
}

function mergeHooks(existing: HookMap): { merged: HookMap; added: string[] } {
  const merged: HookMap = { ...existing };
  const added: string[] = [];
  for (const [event, matchers] of Object.entries(PARLEY_HOOKS)) {
    const current = (merged[event] ?? []).filter((m) => !isParleyMatcher(m));
    const before = (merged[event] ?? []).length;
    merged[event] = [...current, ...matchers];
    if (merged[event]!.length !== before || before === 0) added.push(event);
  }
  return { merged, added };
}

function stripHooks(existing: HookMap): { merged: HookMap; removed: string[] } {
  const merged: HookMap = {};
  const removed: string[] = [];
  for (const [event, matchers] of Object.entries(existing)) {
    const kept = matchers.filter((m) => !isParleyMatcher(m));
    if (kept.length !== matchers.length) removed.push(event);
    if (kept.length > 0) merged[event] = kept;
  }
  return { merged, removed };
}

function diff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) lines.push(`  - ${a[i]}`);
    if (b[i] !== undefined) lines.push(`  + ${b[i]}`);
  }
  return lines.join("\n");
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export interface AdapterStatus {
  installed: boolean;
  /** The skill on disk is byte-identical to what this version ships. */
  skillCurrent: boolean;
  /** Our hook entries in settings.json match what this version installs. */
  hooksCurrent: boolean;
  /** Someone edited the skill by hand; refreshing would discard that. */
  skillEdited: boolean;
  skillPath: string;
  settingsPath: string;
  /** The version that wrote the skill on disk, when it says so. */
  skillVersion: string | null;
}

/**
 * What is installed here versus what this binary ships.
 *
 * `parley update` replaces the executable, and for a long while that was all it
 * did — leaving the skill and hooks written by whatever version happened to run
 * `init`. The instructions an agent actually reads were the stalest part of the
 * install, which is the wrong thing to let drift.
 */
export function adapterStatus(repoRoot: string): AdapterStatus {
  const claudeDir = join(repoRoot, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const skillPath = join(claudeDir, "skills", "parley", "SKILL.md");

  const settings = readSettings(settingsPath);
  const installedHooks = (settings.hooks as HookMap) ?? {};
  const ours = Object.entries(installedHooks).filter(([, ms]) => ms.some(isParleyMatcher));
  const installed = ours.length > 0 || existsSync(skillPath);

  const { merged } = mergeHooks(installedHooks);
  const hooksCurrent =
    ours.length > 0 && JSON.stringify(merged) === JSON.stringify(installedHooks);

  const onDisk = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
  const skillCurrent = onDisk === SKILL;
  // A hand-edited skill is one that is neither current nor any shape we wrote;
  // we cannot tell which version produced it, so we warn rather than assume.
  const skillEdited = onDisk !== "" && !skillCurrent;

  return {
    installed, skillCurrent, hooksCurrent, skillEdited, skillPath, settingsPath,
    skillVersion: skillVersionAt(skillPath),
  };
}

/** Rewrite the skill and hooks to what this version ships. */
export async function refreshAdapter(
  repoRoot: string,
  opts: { assumeYes: boolean; json: boolean; discoveryDir?: string; silent?: boolean },
): Promise<boolean> {
  const status = adapterStatus(repoRoot);
  if (!status.installed) return false;
  if (status.skillCurrent && status.hooksCurrent) return false;

  if (!opts.json) {
    process.stdout.write("\nparley: the Claude Code adapter in this repository is from an older version.\n");
    if (!status.skillCurrent) {
      process.stdout.write(`        ${status.skillPath}\n`);
      process.stdout.write("          the skill is what the agent reads to learn the verbs; yours predates\n");
      process.stdout.write("          the current instructions.\n");
    }
    if (!status.hooksCurrent) {
      process.stdout.write(`        ${status.settingsPath}\n`);
      process.stdout.write("          the hook entries differ from what this version installs.\n");
    }
    if (status.skillEdited) {
      process.stdout.write("        NOTE: the skill differs from every version we ship, so it may have been\n");
      process.stdout.write("        edited by hand. Refreshing discards those edits.\n");
    }
  }

  if (!opts.assumeYes && !(await confirm("Refresh it?"))) {
    hookOutput(opts.json, "parley: left the adapter as it is.", { ok: true, refreshed: false });
    return false;
  }

  const claudeDir = join(repoRoot, ".claude");
  const settings = readSettings(status.settingsPath);
  const { merged } = mergeHooks((settings.hooks as HookMap) ?? {});
  mkdirSync(join(claudeDir, "skills", "parley"), { recursive: true });
  writeFileSync(status.settingsPath, `${JSON.stringify({ ...settings, hooks: merged }, null, 2)}\n`, "utf8");
  writeFileSync(status.skillPath, SKILL, "utf8");
  if (opts.discoveryDir) enableForRepo(opts.discoveryDir);

  if (!opts.silent) hookOutput(opts.json, "parley: adapter refreshed.", { ok: true, refreshed: true });
  return true;
}

export interface InitOptions { assumeYes: boolean; json: boolean; create?: boolean }

export async function installClaudeCode(repo: RepoInfo, opts: InitOptions): Promise<void> {
  const claudeDir = join(repo.root, ".claude");
  const detected = existsSync(claudeDir);
  // `create` is set when the caller knows a session will be opened here even
  // though there is no .claude/ yet — every folder of a workspace, for
  // instance, since Claude Code reads the skill from the folder it is opened in.
  if (!detected && !opts.create) {
    if (!opts.json) process.stdout.write(`parley: no .claude/ in ${repo.root}, skipping the Claude Code adapter.\n`);
    return;
  }

  const settingsPath = join(claudeDir, "settings.json");
  const settings = readSettings(settingsPath);
  const before = JSON.stringify(settings, null, 2);
  const { merged, added } = mergeHooks((settings.hooks as HookMap) ?? {});
  const next = { ...settings, hooks: merged };
  const after = JSON.stringify(next, null, 2);

  const skillPath = join(claudeDir, "skills", "parley", "SKILL.md");
  const skillExists = existsSync(skillPath);

  if (before === after && skillExists) {
    hookOutput(opts.json, "parley: already installed for Claude Code, nothing to do.", { ok: true, changed: false });
    return;
  }

  if (!opts.json) {
    process.stdout.write(`parley init — Claude Code detected at ${claudeDir}\n\n`);
    process.stdout.write(`Will write ${settingsPath}:\n${diff(before, after) || "  (no change)"}\n\n`);
    process.stdout.write(`Will ${skillExists ? "overwrite" : "create"} ${skillPath}\n`);
    process.stdout.write(`  the parley skill: how to use who / say / ask / note deliberately.\n\n`);
    process.stdout.write(`Hooks installed: ${added.join(", ")}\n`);
    process.stdout.write(`  SessionStart      join the bus under a provisional name and tell the agent to rename itself\n`);
    process.stdout.write(`  UserPromptSubmit  drain the inbox into context\n`);
    process.stdout.write(`  PreToolUse        drain, and settle territory on Edit/Write/NotebookEdit\n`);
    process.stdout.write(`  SessionEnd        leave and hand territory back\n\n`);
  }

  if (!opts.assumeYes && !(await confirm("Write these changes?"))) {
    hookOutput(opts.json, "parley: aborted, nothing written.", { ok: false, aborted: true });
    return;
  }

  mkdirSync(join(claudeDir, "skills", "parley"), { recursive: true });
  writeFileSync(settingsPath, `${after}\n`, "utf8");
  writeFileSync(skillPath, SKILL, "utf8");
  enableForRepo(repo.discoveryDir);

  hookOutput(opts.json, `parley: installed. Hooks in ${settingsPath}, skill in ${skillPath}.`, {
    ok: true, changed: true, settings: settingsPath, skill: skillPath, events: added,
  });
}

export async function uninstallClaudeCode(repo: RepoInfo, opts: { json: boolean }): Promise<void> {
  const settingsPath = join(repo.root, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;
  const settings = readSettings(settingsPath);
  const { merged, removed } = stripHooks((settings.hooks as HookMap) ?? {});
  const next = { ...settings, hooks: merged };
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  hookOutput(opts.json, `parley: removed hooks from ${removed.join(", ") || "nothing"}. The skill in .claude/skills/parley was left in place — delete it if you want it gone.`, {
    ok: true, removed,
  });
}
