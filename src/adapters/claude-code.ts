import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { RepoInfo } from "../repo/locate";

/**
 * `parley init` touches the user's configuration files, so it never writes
 * blind: it detects, shows the diff, asks, and only then writes. `uninit`
 * removes exactly what it wrote and nothing else.
 */

const MARKER = "parley hook ";

interface HookCommand { type: "command"; command: string; timeout?: number }
interface HookMatcher { matcher?: string; hooks: HookCommand[] }
type HookMap = Record<string, HookMatcher[]>;

const PARLEY_HOOKS: HookMap = {
  SessionStart: [{ hooks: [{ type: "command", command: "parley hook SessionStart", timeout: 5 }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: "parley hook UserPromptSubmit", timeout: 5 }] }],
  PreToolUse: [
    {
      matcher: "Edit|Write|NotebookEdit|MultiEdit",
      hooks: [{ type: "command", command: "parley hook PreToolUse", timeout: 5 }],
    },
  ],
  SessionEnd: [{ hooks: [{ type: "command", command: "parley hook SessionEnd", timeout: 5 }] }],
};

const SKILL = `---
name: parley
description: Use when other agent sessions may be working in this same repository - coordinating file territory, asking permission for a file someone else holds, broadcasting intent, or recording durable knowledge for future sessions. Triggers on merge conflicts with another agent, "who is working on", "is anyone editing", or before a broad refactor.
---

# parley

Other agent sessions can be running in this repository right now, in other
worktrees. parley is the bus that keeps you from colliding with them.

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

A message from a participant marked \`(human)\` carries priority: it guides you.
It does not hold a veto, but do not treat it as one peer opinion among many.

## Territory

Editing a free file claims it automatically. You only need these when you want
to reserve ahead, or hand something back:

\`\`\`
parley claim 'src/backend/finance/**' --intent "closing refactor"
parley release 'src/backend/finance/**'
\`\`\`

A claim you took by editing expires after 15 idle minutes. A claim you asked for
explicitly is yours until you leave.

## When a file belongs to someone else

Do not edit around it and do not wait silently:

\`\`\`
parley ask src/backend/finance/services.py --reason "adding one column"
\`\`\`

The owner is pushed the request. If nobody answers within five minutes it is
granted to you and announced to everyone, naming who stayed silent. Waiting
longer than that is not politeness, it is waste.

## Knowledge worth keeping

\`say\` is conversation and dies resolved. \`note\` is knowledge every future
session needs, including sessions that do not exist yet:

\`\`\`
parley note --title "CI here runs tsc -b, not tsc --noEmit" \\
  --body "the root tsconfig is solution-style, so --noEmit checks nothing" \\
  --tags ci,typescript
parley notes --export
\`\`\`

\`--export\` writes \`.parley/notes.md\`, which is versioned in git. Commit it
when it makes sense; parley never commits for you.

## If parley is not running

Every command spawns the daemon if needed. If it still fails, keep working —
a broken parley must never stop the work. It degrades to advisory and says so.
`;

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

export interface InitOptions { assumeYes: boolean; json: boolean }

export async function installClaudeCode(repo: RepoInfo, opts: InitOptions): Promise<void> {
  const claudeDir = join(repo.root, ".claude");
  const detected = existsSync(claudeDir);
  if (!detected && !opts.assumeYes) {
    hookOutput(opts.json, `parley: no .claude/ in ${repo.root} — nothing detected to configure.\nRun with --yes to create it anyway.`, { ok: false, detected: false });
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

  hookOutput(opts.json, `parley: installed. Hooks in ${settingsPath}, skill in ${skillPath}.`, {
    ok: true, changed: true, settings: settingsPath, skill: skillPath, events: added,
  });
}

export async function uninstallClaudeCode(repo: RepoInfo, opts: { json: boolean }): Promise<void> {
  const settingsPath = join(repo.root, ".claude", "settings.json");
  const settings = readSettings(settingsPath);
  const { merged, removed } = stripHooks((settings.hooks as HookMap) ?? {});
  const next = { ...settings, hooks: merged };
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  hookOutput(opts.json, `parley: removed hooks from ${removed.join(", ") || "nothing"}. The skill in .claude/skills/parley was left in place — delete it if you want it gone.`, {
    ok: true, removed,
  });
}
