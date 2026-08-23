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
// `docs:commands` passes --write and this script does the writing, rather than
// the shell redirecting stdout into the page. With a redirect the shell empties
// docs/reference/commands.md before bun even starts, so any run that threw left
// a zero-byte page behind; CI caught it, but docs.yml deploys on push to main
// with no dependency on ci.yml, so an empty page reaching main by a route that
// skipped CI would publish as a blank Commands page. Writing after rendering
// means a failed run changes nothing at all.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The file that holds both sources of truth. */
export const MAIN_PATH = join(ROOT, "src", "cli", "main.ts");

/** The page this generator owns. */
export const PAGE_PATH = join(ROOT, "docs", "reference", "commands.md");

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

/**
 * Where each command's own code starts, in source order.
 *
 * A "marker" is any of the three ways main.ts decides which command ran: a
 * `case "x":` label inside either dispatch switch, a `parsed.command === "x"`
 * test above them, or the `argv[0] === "x"` branches that run before a
 * repository is even located. A command's region runs from its marker to the
 * next one; everything before the first marker is shared code (`out`, `fail`,
 * `withSession`) that every command passes through.
 *
 * This is a lexical approximation, not a call graph, and it is deliberately
 * one: the alternative is following `runInit`, `runWebPanel` and friends into
 * other modules, and a generator that needs whole-program analysis to run is a
 * generator nobody will keep working.
 */
interface Region {
  command: string;
  from: number;
  to: number;
  /** `case "note":` falling straight through to `case "decide": {`. */
  fallsThrough: boolean;
}

function regionsOf(source: string): { regions: Region[]; sharedTo: number } {
  const switchAt = source.indexOf("switch (parsed.command)");
  if (switchAt < 0) throw new Error("no `switch (parsed.command)` in the CLI — the dispatch moved");

  const marks: { command: string; at: number; end: number; isCase: boolean }[] = [];
  for (const m of source.slice(switchAt).matchAll(/\bcase "([^"]+)":/g)) {
    marks.push({ command: m[1]!, at: switchAt + m.index!, end: switchAt + m.index! + m[0].length, isCase: true });
  }
  for (const m of source.matchAll(/\b(?:parsed|p)\.command === "([^"]+)"/g)) {
    marks.push({ command: m[1]!, at: m.index!, end: m.index! + m[0].length, isCase: false });
  }
  for (const m of source.matchAll(/\bargv\[0\] === "([^"]+)"/g)) {
    marks.push({ command: m[1]!, at: m.index!, end: m.index! + m[0].length, isCase: false });
  }
  marks.sort((a, b) => a.at - b.at);
  if (marks.length === 0) throw new Error("read no command markers out of the CLI dispatch");

  const regions: Region[] = marks.map((mark, i) => {
    const to = i + 1 < marks.length ? marks[i + 1]!.at : source.length;
    // A `case` label with nothing but whitespace and comments before the next
    // label is a fall-through: `case "note":` shares every line of the
    // `case "decide": {` body below it, flags included.
    const body = withoutComments(source.slice(mark.end, to)).trim();
    return { command: mark.command, from: mark.end, to, fallsThrough: mark.isCase && body === "" };
  });

  return { regions, sharedTo: marks[0]!.at };
}

/**
 * Comments out, code in.
 *
 * A comment explaining a flag is prose, and prose is exactly what this whole
 * generator refuses to trust — the comment at the `--no-open` fix names the
 * broken `parsed.flags.open` test it replaced, and reading that as a live flag
 * read would demand the help text document a flag no longer read anywhere.
 * The `[^:]` guard keeps `https://` and `uds://` inside string literals whole.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Every flag name read out of `parsed.flags` / `p.flags` in a slice of source. */
function flagsReadIn(rawSlice: string): Set<string> {
  const slice = withoutComments(rawSlice);
  const found = new Set<string>();
  for (const m of slice.matchAll(/\b(?:parsed|p)\.flags\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) found.add(`--${m[1]!}`);
  for (const m of slice.matchAll(/\b(?:parsed|p)\.flags\[\s*"([^"]+)"\s*\]/g)) found.add(`--${m[1]!}`);
  for (const m of slice.matchAll(/\bflagString\(\s*(?:parsed|p)\.flags\s*,\s*"([^"]+)"/g)) found.add(`--${m[1]!}`);
  return found;
}

export interface DispatchedFlags {
  /** Flags read inside one command's own region, keyed by command name. */
  byCommand: Map<string, Set<string>>;
  /** Flags read in code every command runs through — `withSession`, `out`, `fail`. */
  shared: Set<string>;
}

/**
 * Which flags the CLI actually reads, and for which command.
 *
 * `reconcile` above cross-checks command *names* only, which is why the page
 * could promise that nothing here goes stale while rendering `parley uninit`
 * with no flags at all — `--global` was read at the dispatch and absent from
 * the help text, and five more flags were in the same state. Names were never
 * the whole contract; a reader who is told a command cannot quietly lie reads
 * the flag list as part of that.
 */
export function dispatchedFlags(source: string): DispatchedFlags {
  const { regions, sharedTo } = regionsOf(source);

  const byCommand = new Map<string, Set<string>>();
  const add = (command: string, flags: Set<string>): void => {
    const into = byCommand.get(command) ?? new Set<string>();
    for (const f of flags) into.add(f);
    byCommand.set(command, into);
  };

  // Two passes, because one is not enough. A command's flags are the union of
  // every region carrying its name — `case "decide": {` opens the body, and
  // two `p.command === "decide"` tests inside it split that body into three
  // regions, only the middle of which reads any flags. So the fall-through
  // label `case "note":` cannot simply inherit the region that follows it: it
  // has to inherit everything the command it falls into ended up with.
  for (const region of regions) {
    if (region.fallsThrough) continue;
    add(region.command, flagsReadIn(source.slice(region.from, region.to)));
  }
  for (let i = 0; i < regions.length; i++) {
    if (!regions[i]!.fallsThrough) continue;
    // Walk past any further fall-through labels stacked on the same body.
    let j = i + 1;
    while (j < regions.length && regions[j]!.fallsThrough) j++;
    const target = regions[j];
    if (target) add(regions[i]!.command, byCommand.get(target.command) ?? new Set());
  }

  return { byCommand, shared: flagsReadIn(source.slice(0, sharedTo)) };
}

/** Flags a USAGE invocation line spells, per command, plus the global block. */
function documentedFlags(usage: Usage): { byCommand: Map<string, Set<string>>; global: Set<string> } {
  const byCommand = new Map<string, Set<string>>();
  for (const group of usage.groups) {
    for (const command of group.commands) {
      // Only the invocation line counts, never the description prose beside
      // it. The page's `Flags:` list is rendered from `variant.flags`, so a
      // flag mentioned in a blurb and missing from the invocation is exactly
      // the page that under-reports what the command takes — which is the
      // defect this check exists for. Proven by mutation: while descriptions
      // counted, deleting `[--no-open]` and `[--active]` from their invocation
      // lines left the generator perfectly happy.
      const flags = new Set<string>();
      for (const variant of command.variants) {
        for (const flag of variant.flags) flags.add(flag);
      }
      byCommand.set(command.name, flags);
    }
  }
  const global = new Set<string>();
  for (const line of usage.globalFlags) {
    for (const m of line.matchAll(/--[a-z][a-z0-9-]*/g)) global.add(m[0]);
  }
  return { byCommand, global };
}

/**
 * The same contract as `reconcile`, one level down.
 *
 * Three checks, and the asymmetry between them is the honest part:
 *
 *  1. A flag read inside a command's own region and absent from that command's
 *     help-text line fails. This is the direction that produces a page which
 *     lies — `parley uninit --global` worked and the page said the command
 *     took no flags at all.
 *  2. A flag read in shared code must at least appear somewhere in USAGE.
 *     `withSession` reads `--mission` for every session command while the help
 *     text spells it on `join` and `rename`, so this one cannot be per-command
 *     without inventing a claim the source does not make.
 *  3. A flag USAGE documents that nothing in main.ts reads fails. That is the
 *     `--no-open` case: spelled in the help text, never read, silently inert.
 *
 * What is deliberately NOT checked: "this command's line documents a flag its
 * own region never reads". `join`'s region reads nothing — `--as` and
 * `--mission` are read in `withSession`, two hundred lines above it — so that
 * check would fire on correct code. Catching it needs a call graph, and the
 * cost of that is a generator that stops being maintained.
 */
function reconcileFlags(usage: Usage, source: string): void {
  const dispatched = dispatchedFlags(source);
  const { byCommand: documented, global } = documentedFlags(usage);

  const everywhere = new Set(global);
  for (const flags of documented.values()) for (const f of flags) everywhere.add(f);

  for (const [command, flags] of dispatched.byCommand) {
    // Hidden entry points (`__daemon`, `hook`) have no page and no help-text
    // line; whatever they read is covered by the shared check below.
    const own = documented.get(command);
    if (!own) continue;
    const missing = [...flags].filter((f) => !own.has(f) && !global.has(f)).sort();
    if (missing.length) {
      throw new Error(
        `\`parley ${command}\` reads ${missing.map((f) => `\`${f}\``).join(", ")} but USAGE in ` +
          `src/cli/main.ts does not spell it on that command's line. Add it there — the page ` +
          `renders the flag list straight off the help text, so an undocumented flag becomes a ` +
          `reference page that says the command takes fewer options than it does.`,
      );
    }
  }

  const orphanShared = [...dispatched.shared].filter((f) => !everywhere.has(f)).sort();
  if (orphanShared.length) {
    throw new Error(
      `the CLI reads ${orphanShared.map((f) => `\`${f}\``).join(", ")} in code every command ` +
        `runs through, and USAGE in src/cli/main.ts never mentions it anywhere. Put it in the ` +
        `global flags block, or on the command that owns it.`,
    );
  }

  const readAnywhere = new Set(dispatched.shared);
  for (const flags of dispatched.byCommand.values()) for (const f of flags) readAnywhere.add(f);
  const inert = [...everywhere].filter((f) => !readAnywhere.has(f)).sort();
  if (inert.length) {
    throw new Error(
      `USAGE documents ${inert.map((f) => `\`${f}\``).join(", ")} but nothing in ` +
        `src/cli/main.ts ever reads it. A flag in the help text that the parser drops on the ` +
        `floor is worse than an undocumented one: somebody will type it and believe it worked.`,
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
  reconcileFlags(usage, text);

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
    "Every invocation, flag and description below is the text `parley --help`",
    "prints, so the two cannot disagree. It opens on the same line:",
    "",
    `> ${escapeProse(usage.tagline)}`,
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
  const text = renderCommandReference();
  // Render first, write second. Nothing touches the page until the generator
  // has produced a whole one.
  if (process.argv.includes("--write")) writeFileSync(PAGE_PATH, text);
  else process.stdout.write(text);
}
