import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { RepoInfo } from "../repo/locate";
import { forgetRepo, registerRepo } from "./registry";
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
  // enables it for all of them. The registry is what lets one `parley update`
  // reach every project instead of only the one you are standing in.
  enableForRepo(repo.discoveryDir);
  registerRepo(repo.gitCommonDir, repo.root, repo.discoveryDir);
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
  disableForRepo(repo.discoveryDir);
  forgetRepo(repo.gitCommonDir);
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

/**
 * Bring every registered repository's hooks and skill up to this version.
 *
 * Run as a separate process by `parley update`, deliberately: the updater has
 * already replaced the binary on disk, but its own memory still holds the
 * previous version's skill text. Writing from there produced the odd situation
 * where you had to run the update twice for the instructions to land.
 */
export async function refreshAllAdapters(
  opts: { assumeYes: boolean; json: boolean; here?: { gitCommonDir: string; root: string } | null },
): Promise<void> {
  const { adapterStatus, refreshAdapter } = await import("./claude-code");
  const { pruneRegistry, registerRepo } = await import("./registry");

  const registered = pruneRegistry();

  // The repository you are standing in always counts, registered or not.
  // Projects set up before the registry existed are not in it, and "update
  // says everything is current while doctor says outdated" is exactly the
  // contradiction that makes a tool untrustworthy.
  const repos = [...registered];
  if (opts.here && !repos.some((r) => r.gitCommonDir === opts.here!.gitCommonDir)) {
    if (adapterStatus(opts.here.root).installed) {
      repos.push({ ...opts.here, at: new Date().toISOString() });
      registerRepo(opts.here.gitCommonDir, opts.here.root);
    }
  }
  const stale = repos.filter((r) => {
    const status = adapterStatus(r.root);
    return status.installed && (!status.skillCurrent || !status.hooksCurrent);
  });

  if (stale.length === 0) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, refreshed: [], checked: repos.length })}\n`);
    else if (repos.length) process.stdout.write(`parley: hooks and skill are current in ${repos.length} project(s).\n`);
    // Saying nothing at all reads as "it did not run".
    else process.stdout.write("parley: no project has been set up yet (run: parley init).\n");
    return;
  }

  // A skill carrying our stamp is a file parley wrote, and rewriting our own
  // generated file needs no ceremony — asking about it is pure friction on the
  // one command whose whole job is to bring things up to date. A skill with no
  // stamp, or one that has been changed, might be somebody's work: that one
  // gets asked about, because refreshing would discard it.
  const ours = stale.filter((r) => adapterStatus(r.root).skillVersion !== null);
  const theirs = stale.filter((r) => adapterStatus(r.root).skillVersion === null);

  let approvedEdited = false;
  if (theirs.length > 0) {
    if (!opts.json) {
      process.stdout.write(`\nparley: ${theirs.length} project(s) have a skill that parley did not write,\n`);
      process.stdout.write("        or that was changed by hand. Refreshing would discard those edits:\n");
      for (const r of theirs) process.stdout.write(`        ${r.root}\n`);
    }
    approvedEdited = opts.assumeYes || (await confirm("Overwrite them?"));
  }

  const toRefresh = [...ours, ...(approvedEdited ? theirs : [])];
  if (toRefresh.length === 0) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, refreshed: [], skipped: theirs.length })}\n`);
    else process.stdout.write("parley: left them as they are.\n");
    return;
  }

  const refreshed: string[] = [];
  for (const r of toRefresh) {
    const done = await refreshAdapter(r.root, {
      assumeYes: true, json: true, silent: true, discoveryDir: r.discoveryDir ?? join(r.gitCommonDir, "parley"),
    });
    if (done) refreshed.push(r.root);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, refreshed, skipped: theirs.length - (approvedEdited ? theirs.length : 0) })}\n`);
  } else {
    process.stdout.write(`parley: refreshed hooks and skill in ${refreshed.length} project(s):\n`);
    for (const r of refreshed) process.stdout.write(`        ${r}\n`);
  }
}
