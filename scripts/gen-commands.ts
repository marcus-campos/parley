#!/usr/bin/env bun
//
// Generates docs/reference/commands.md.
//
// SOURCE OF TRUTH — and why it is not what the plan says.
//
// The plan (docs/superpowers/plans/2026-08-20-docs-site.md, Task 6) says to
// read the command table out of `src/cli/args.ts`. There is no such table:
// args.ts is a generic tokeniser (`flags: Record<string, string | boolean>`)
// that has never known which commands exist. Two things in `src/cli/main.ts`
// do:
//
//   1. `USAGE` — the help text `parley --help` prints. It carries the
//      invocation of every command, its flags, its grouping and, for most,
//      a description. It is already the user-facing contract.
//   2. The `switch (parsed.command)` dispatch (plus a handful of
//      `parsed.command === "..."` / `argv[0] === "..."` branches above it).
//      This is exhaustive on names but blind to flags and prose.
//
// This generator reads both and refuses to emit anything when they disagree.
// That is the whole point of the task: adding a command to the dispatch
// without documenting it in USAGE does not quietly produce a page that omits
// it — it fails `bun run docs:commands`, and therefore fails CI. Documenting
// one that nothing dispatches fails the same way. Adding it to both changes
// this file's output, which `git diff --exit-code` in CI then demands you
// commit.
//
// Nothing here may depend on the clock, the filesystem order or a hash seed:
// CI regenerates the file and fails on any diff, so an unstable generator
// would turn every unrelated pull request red.
//
// One consequence of `docs:commands` being a shell redirect: the shell
// truncates docs/reference/commands.md before this script runs, so a run that
// throws leaves the file empty. That is loud rather than dangerous — CI fails
// either way, and `git checkout docs/reference/commands.md` puts it back — but
// it is worth knowing before you wonder where the page went.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The file that holds both sources of truth. */
export const MAIN_PATH = join(ROOT, "src", "cli", "main.ts");

/**
 * Entry points that dispatch on a name but are not commands people run.
 * `hook` is the Claude Code hook runner (JSON in, JSON out, invoked by the
 * hook itself); `help` and `version` are documented at the bottom of the page
 * as the global flags they are spelled as everywhere else. Anything starting
 * with `__` is hidden by convention (`__daemon`, `__refresh-adapters`).
 */
const NOT_A_COMMAND = new Set(["hook", "help", "version"]);

/**
 * A group of commands is titled by the command that anchors it, not by its
 * position: inserting a command at the top of a group must not rename the
 * group. A group with no anchor is a new group, and a new group needs a
 * human-written title — the generator stops instead of emitting a heading
 * called "Group 7". Titles follow the README's own grouping.
 */
const GROUP_TITLES: ReadonlyArray<readonly [anchor: string, title: string]> = [
  ["init", "Setting up and keeping current"],
  ["who", "Who is here"],
  ["say", "Talking"],
  ["claim", "Territory"],
  ["watch", "Watching"],
  ["grant", "Permission"],
  ["note", "Knowledge that outlives the session"],
  ["result", "Command results"],
  ["shape", "Modes and shapes"],
  ["work", "The work pool"],
];

export interface CommandVariant {
  /** One way USAGE spells it, e.g. `parley init [--yes] [--global]`. */
  invocation: string;
  /** What USAGE says that spelling does. Empty when USAGE says nothing. */
  description: string;
  /** Flags named in this invocation, sorted so the output cannot shuffle. */
  flags: string[];
}

export interface CommandEntry {
  /** The command word itself, e.g. `claim`. */
  name: string;
  /**
   * One per line USAGE spends on this command. `parley init` has two — the
   * workspace form and the ordinary one — and they say different things, so
   * they stay apart instead of being run into one paragraph.
   */
  variants: CommandVariant[];
}

export interface CommandGroup {
  title: string;
  commands: CommandEntry[];
}

export interface Usage {
  tagline: string;
  groups: CommandGroup[];
  globalFlags: string[];
}

function usageText(source: string): string {
  const marker = "const USAGE = `";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`no USAGE template literal in ${MAIN_PATH} — the CLI's help text moved`);
  const from = start + marker.length;
  const end = source.indexOf("`", from);
  if (end < 0) throw new Error("the USAGE template literal is never closed");
  return source.slice(from, end);
}

/** Parses the CLI's own help text into groups of commands. */
export function parseUsage(source: string): Usage {
  const lines = usageText(source).split("\n");
  const tagline = (lines[0] ?? "").trim();

  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") {
      if (current.length) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current);

  const globalFlags: string[] = [];
  const groups: CommandGroup[] = [];

  for (const block of blocks) {
    if (block[0]!.startsWith("Global flags:")) {
      globalFlags.push(block[0]!.slice("Global flags:".length).trim());
      for (const line of block.slice(1)) globalFlags.push(line.trim());
      continue;
    }
    const commands = parseBlock(block);
    if (commands.length === 0) continue;
    groups.push({ title: titleFor(commands), commands });
  }

  if (groups.length === 0) throw new Error("parsed no command groups out of USAGE");
  if (globalFlags.length === 0) throw new Error("parsed no global flags out of USAGE");
  return { tagline, groups, globalFlags };
}

function parseBlock(block: string[]): CommandEntry[] {
  const order: string[] = [];
  const byName = new Map<string, CommandEntry>();
  let last: CommandVariant | null = null;

  for (const line of block) {
    if (/^ {2}parley\s/.test(line)) {
      // `  parley buses               every bus on this machine` — the run of
      // two or more spaces is the column the descriptions start in.
      const [head = "", ...rest] = line.slice(2).split(/ {2,}/);
      const invocation = head.trim();
      const name = invocation.split(/\s+/)[1] ?? "";
      if (!name) throw new Error(`cannot read a command name out of: ${line}`);
      let entry = byName.get(name);
      if (!entry) {
        entry = { name, variants: [] };
        byName.set(name, entry);
        order.push(name);
      }
      last = { invocation, description: rest.join(" ").trim(), flags: [] };
      entry.variants.push(last);
      continue;
    }

    const continuation = line.trim();
    if (!continuation || !last) continue;
    // A continuation that opens with a bracket and arrives before any prose is
    // more flags for the invocation above it (`parley notes` wraps that way),
    // not a description of it.
    if (continuation.startsWith("[") && last.description === "") {
      last.invocation = `${last.invocation} ${continuation}`;
      continue;
    }
    last.description = last.description ? `${last.description} ${continuation}` : continuation;
  }

  for (const name of order) {
    for (const variant of byName.get(name)!.variants) variant.flags = flagsIn(variant.invocation);
  }
  return order.map((name) => byName.get(name)!);
}

function flagsIn(invocation: string): string[] {
  const flags = new Set<string>();
  for (const m of invocation.matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(m[0]);
  return [...flags].sort();
}

function titleFor(commands: CommandEntry[]): string {
  const names = new Set(commands.map((c) => c.name));
  const matched = GROUP_TITLES.filter(([anchor]) => names.has(anchor));
  if (matched.length === 1) return matched[0]![1];
  const listed = commands.map((c) => c.name).join(", ");
  if (matched.length === 0) {
    throw new Error(
      `no title for the help-text group [${listed}] — a new group needs a heading: ` +
        `add one to GROUP_TITLES in scripts/gen-commands.ts, anchored on the command that names it`,
    );
  }
  throw new Error(
    `the help-text group [${listed}] matches several titles ` +
      `(${matched.map(([, t]) => t).join(" / ")}) — the anchors in GROUP_TITLES must be unique per group`,
  );
}

/**
 * Every command name the CLI actually dispatches: the `case` labels of the two
 * `switch` statements over the parsed command, plus the branches that run
 * before a repository is located (`update`, `watch`, `mcp`).
 *
 * The `case` scan starts at the first `switch (parsed.command)` and runs to the
 * end of the file. A future `switch` over something else down there would add
 * a name that USAGE does not document, and this generator would refuse to run
 * until someone said which it was. That is the safe direction to be wrong in:
 * a loud false alarm costs a minute, a silent omission is the exact failure
 * this file exists to prevent.
 */
export function dispatchedCommands(source: string): string[] {
  const switchAt = source.indexOf("switch (parsed.command)");
  if (switchAt < 0) throw new Error("no `switch (parsed.command)` in the CLI — the dispatch moved");

  const names = new Set<string>();
  for (const m of source.slice(switchAt).matchAll(/\bcase "([^"]+)":/g)) names.add(m[1]!);
  for (const m of source.matchAll(/\b(?:parsed|p)\.command === "([^"]+)"/g)) names.add(m[1]!);
  for (const m of source.matchAll(/\bargv\[0\] === "([^"]+)"/g)) names.add(m[1]!);

  const commands = [...names].filter((n) => !n.startsWith("__") && !NOT_A_COMMAND.has(n));
  if (commands.length === 0) throw new Error("read no commands out of the CLI dispatch");
  return commands.sort();
}

function reconcile(usage: Usage, dispatched: string[]): void {
  const documented = new Set(usage.groups.flatMap((g) => g.commands.map((c) => c.name)));
  const runnable = new Set(dispatched);

  const undocumented = dispatched.filter((c) => !documented.has(c));
  if (undocumented.length) {
    throw new Error(
      `the CLI dispatches ${undocumented.map((c) => `\`${c}\``).join(", ")} but USAGE in ` +
        `src/cli/main.ts never mentions it. Document it there — the help text and this page ` +
        `are the same contract, and a command nobody can read about may as well not exist.`,
    );
  }

  const phantom = [...documented].filter((c) => !runnable.has(c));
  if (phantom.length) {
    throw new Error(
      `USAGE documents ${phantom.map((c) => `\`${c}\``).join(", ")} but nothing in ` +
        `src/cli/main.ts dispatches it. Either wire it up or take it out of the help text.`,
    );
  }
}

// `<` opens a component as far as VitePress is concerned, and half these
// invocations are full of `<paths...>`. Inside a fence it is inert; in prose it
// is not, so descriptions get escaped.
const escapeProse = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const HEADER = "<!-- generated by scripts/gen-commands.ts — run `bun run docs:commands` -->";

/**
 * Renders the whole page. Pass a source string to render against something
 * other than the real CLI — the tests do, to prove the cross-check bites.
 */
export function renderCommandReference(source?: string): string {
  const text = source ?? readFileSync(MAIN_PATH, "utf8");
  const usage = parseUsage(text);
  const dispatched = dispatchedCommands(text);
  reconcile(usage, dispatched);

  const out: string[] = [
    HEADER,
    "",
    "# Commands",
    "",
    "This page is **generated** from the CLI itself — the `USAGE` help text in",
    "`src/cli/main.ts`, cross-checked against the command dispatch in the same file.",
    "Editing it by hand achieves nothing: the next `bun run docs:commands` overwrites",
    "it, and CI fails when the committed copy does not match what the CLI offers. A",
    "command that exists but is not in the help text, or is in the help text but does",
    "not exist, fails the generator rather than producing a page that quietly lies.",
    "",
    "It is the same text `parley --help` prints, so the two cannot disagree.",
    "",
  ];

  for (const group of usage.groups) {
    out.push(`## ${group.title}`, "");
    for (const command of group.commands) {
      out.push(`### \`parley ${command.name}\``, "");
      for (const variant of command.variants) {
        out.push("```", variant.invocation, "```", "");
        if (variant.description) out.push(escapeProse(variant.description), "");
        if (variant.flags.length) {
          out.push(`Flags: ${variant.flags.map((f) => `\`${f}\``).join(", ")}`, "");
        }
      }
    }
  }

  out.push("## Global flags", "", "Every command takes these.", "", "```", ...usage.globalFlags, "```", "");

  // Exactly one trailing newline: the `docs:commands` script writes this string
  // through a shell redirect and adds nothing of its own, so the file on disk
  // is byte-for-byte what this function returns.
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

if (import.meta.main) {
  process.stdout.write(renderCommandReference());
}
