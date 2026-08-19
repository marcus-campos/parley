import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { RepoInfo } from "../repo/locate";
import {
  disableForRepo, enableForRepo, installClaudeCode, installGlobalHooks,
  isEnabledForRepo, removeGlobalHooks, uninstallClaudeCode, writeGlobalHooks,
} from "./claude-code";
import {
  agentsFilePlan, codexPlan, detectMcpTargets, manualSnippet,
  projectMcpPlan, removeCodex, removeProjectMcp,
  writeAgentsFile, writeCodex, writeProjectMcp,
} from "./mcp-config";

/**
 * `parley init` for everything, not just Claude Code.
 *
 * It touches the user's configuration files, so it never writes blind: detect,
 * show the diff, ask, then write. Where a harness's format is not confirmed, it
 * prints the snippet instead of guessing — a config written on a guess fails
 * silently, and the user has no idea why.
 */

export interface InstallOptions { assumeYes: boolean; json: boolean; global?: boolean }

function diff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
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

export async function runInit(repo: RepoInfo, opts: InstallOptions): Promise<void> {
  if (opts.global) {
    const plan = installGlobalHooks();
    if (plan.before === plan.after) {
      if (!opts.json) process.stdout.write("parley: global hooks are already installed.\n");
    } else {
      if (!opts.json) {
        process.stdout.write(`\nparley: Claude Code hooks, GLOBAL — every project you open\n`);
        process.stdout.write(`        ${plan.path}\n${diff(plan.before, plan.after)}\n\n`);
        process.stdout.write("        They do nothing in a repository that was never set up with\n");
        process.stdout.write("        `parley init`, so this is safe to leave on.\n");
        process.stdout.write("        This is what makes every worktree work: .claude/ lives in the\n");
        process.stdout.write("        working tree and is usually gitignored, so per-project hooks\n");
        process.stdout.write("        simply do not exist in your other worktrees.\n");
      }
      if (opts.assumeYes || (await confirm(`Write ${plan.path}? This applies to every project.`))) {
        writeGlobalHooks();
        if (!opts.json) process.stdout.write("parley: global hooks installed.\n");
      }
    }
  }

  await installClaudeCode(repo, opts);
  // Every worktree of this repository shares the marker, so enabling it here
  // enables it for all of them.
  enableForRepo(repo.gitCommonDir);
  if (!opts.json && !opts.global) {
    process.stdout.write(`\nparley: enabled for this repository and all ${""}of its worktrees.\n`);
  }

  const targets = detectMcpTargets(repo.root);
  const written: string[] = [];
  const manual: string[] = [];

  for (const target of targets) {
    if (!target.detected) continue;

    if (!target.confirmed || !target.path) {
      manual.push(target.label);
      continue;
    }

    const plan = target.id === "codex" ? codexPlan(target.path) : projectMcpPlan(target.path);
    if (plan.before === plan.after) continue;

    if (!opts.json) {
      const scope = target.scope === "global"
        ? "GLOBAL — affects every repository on this machine"
        : "this repository only";
      process.stdout.write(`\nparley: ${target.label} (${scope})${target.note ? ` — ${target.note}` : ""}\n`);
      process.stdout.write(`        ${target.path}\n${diff(plan.before, plan.after)}\n`);
    }
    const question = target.scope === "global"
      ? `Write ${target.path}? This is a machine-wide change.`
      : `Write ${target.path}?`;
    if (opts.assumeYes || (await confirm(question))) {
      if (target.id === "codex") writeCodex(target.path);
      else writeProjectMcp(target.path);
      written.push(target.label);
    }
  }

  // AGENTS.md is how an agent with no MCP config at all still learns the rules.
  const agents = agentsFilePlan(repo.root);
  if (!agents.already) {
    if (!opts.json) {
      process.stdout.write(`\nparley: ${existsSync(agents.path) ? "append to" : "create"} ${agents.path}\n`);
      process.stdout.write("        a section telling any agent that reads it how to use the bus\n");
    }
    if (opts.assumeYes || (await confirm(`Write ${agents.path}?`))) {
      writeAgentsFile(repo.root);
      written.push("AGENTS.md");
    }
  }

  if (manual.length && !opts.json) {
    process.stdout.write(`\nparley: detected ${manual.join(", ")}, but their MCP config format is not\n`);
    process.stdout.write("        confirmed, so nothing was written for them. Add this by hand:\n\n");
    process.stdout.write(`${manualSnippet().split("\n").map((l) => `          ${l}`).join("\n")}\n\n`);
    process.stdout.write("        If you know the right file for one of these, a pull request naming it\n");
    process.stdout.write("        is the most useful thing you can send.\n");
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, written, manual })}\n`);
  } else if (written.length) {
    process.stdout.write(`\nparley: wrote ${written.join(", ")}.\n`);
  }
}

export async function runUninit(repo: RepoInfo, opts: { json: boolean; global?: boolean }): Promise<void> {
  if (opts.global) {
    const removed = removeGlobalHooks();
    if (!opts.json) {
      process.stdout.write(removed ? "parley: removed the global hooks.\n" : "parley: no global hooks to remove.\n");
    }
  }
  disableForRepo(repo.gitCommonDir);
  await uninstallClaudeCode(repo, opts);

  const removed: string[] = [];
  for (const target of detectMcpTargets(repo.root)) {
    if (!target.path || !target.confirmed) continue;
    const gone = target.id === "codex" ? removeCodex(target.path) : removeProjectMcp(target.path);
    if (gone) removed.push(target.path);
  }

  // AGENTS.md is left alone on purpose: by the time uninit runs, it is usually
  // a file the user has written other things into, and we only ever appended
  // one section to it.
  if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, removed })}\n`);
  else if (removed.length) {
    process.stdout.write(`parley: removed the MCP entry from ${removed.join(", ")}.\n`);
    process.stdout.write("parley: the parley section in AGENTS.md was left in place — delete it by hand if you want it gone.\n");
  }
}
