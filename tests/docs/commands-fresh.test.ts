import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAIN_PATH,
  dispatchedCommands,
  dispatchedFlags,
  parseUsage,
  renderCommandReference,
} from "../../scripts/gen-commands";

const root = join(import.meta.dir, "..", "..");
const mainSource = readFileSync(MAIN_PATH, "utf8");

// Windows runners check out with core.autocrlf on, which rewrites every LF in
// a text file to CRLF. That is a line-ending question, not a staleness one:
// normalise it away so this test fails for the reason it exists and not for
// the reason git checked the file out differently.
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

describe("the command reference", () => {
  test("the committed file matches what the CLI actually offers", () => {
    const onDisk = readFileSync(join(root, "docs", "reference", "commands.md"), "utf8");
    expect(lf(onDisk)).toBe(renderCommandReference());
  });

  test("it names every op-backed command", () => {
    const text = renderCommandReference();
    for (const command of ["claim", "release", "ask", "note", "works", "take", "shape"]) {
      expect(text).toContain(`parley ${command}`);
    }
  });

  test("it says the file is generated, so nobody edits it by hand", () => {
    expect(renderCommandReference()).toContain("generated");
  });
});

// The three tests above are the brief's, and on their own they are weak: the
// first one compares the committed file against the generator, so it stays
// green for any generator at all as long as `bun run docs:commands` ran last.
// A generator that emitted seven hardcoded words would satisfy all three. The
// tests below tie the output to the CLI source itself, so an implementation
// with no logic in it cannot pass them.
describe("the command reference is derived, not typed out", () => {
  // Deliberately re-derives the dispatch table with its own regexes instead of
  // reusing the generator's: a test that asks the implementation what the
  // right answer is cannot catch the implementation being wrong.
  function dispatchedByHand(): string[] {
    const switchAt = mainSource.indexOf("switch (parsed.command)");
    expect(switchAt).toBeGreaterThan(0);
    const inSwitches = mainSource.slice(switchAt);
    const names = new Set<string>();
    for (const m of inSwitches.matchAll(/case "([a-z][a-z0-9-]*)":/g)) names.add(m[1]!);
    for (const m of mainSource.matchAll(/(?:parsed|p)\.command === "([a-z][a-z0-9-]*)"/g)) names.add(m[1]!);
    for (const m of mainSource.matchAll(/argv\[0\] === "([a-z][a-z0-9-]*)"/g)) names.add(m[1]!);
    // Internal entry points, documented as such in the generator.
    for (const hidden of ["hook", "help", "version"]) names.delete(hidden);
    return [...names].sort();
  }

  test("every command the CLI dispatches has a section on the page", () => {
    const commands = dispatchedByHand();
    // A regex that matched nothing would make the loop below vacuous.
    expect(commands.length).toBeGreaterThanOrEqual(40);
    const text = renderCommandReference();
    for (const command of commands) {
      expect(text).toContain(`### \`parley ${command}\``);
    }
  });

  test("it has one section per command and invents none", () => {
    const text = renderCommandReference();
    const rendered = [...text.matchAll(/^### `parley ([a-z][a-z0-9-]*)`$/gm)].map((m) => m[1]!);
    expect(rendered).toEqual([...rendered].filter((c, i) => rendered.indexOf(c) === i));
    expect(rendered.sort()).toEqual(dispatchedByHand());
  });

  test("every group in the help text becomes a heading, and none is dropped", () => {
    const usage = parseUsage(mainSource);
    expect(usage.groups.length).toBeGreaterThanOrEqual(8);
    const text = renderCommandReference();
    for (const group of usage.groups) {
      expect(text).toContain(`## ${group.title}`);
      for (const command of group.commands) {
        expect(text).toContain(`### \`parley ${command.name}\``);
      }
    }
  });

  test("the invocation line of every command survives, flags and all", () => {
    const usage = parseUsage(mainSource);
    const text = renderCommandReference();
    let flagsSeen = 0;
    for (const group of usage.groups) {
      for (const command of group.commands) {
        for (const variant of command.variants) {
          expect(text).toContain(variant.invocation);
          for (const flag of variant.flags) {
            expect(text).toContain(`\`${flag}\``);
            flagsSeen++;
          }
        }
      }
    }
    // The flag assertions above are inside a loop that would be empty if flag
    // extraction returned nothing at all.
    expect(flagsSeen).toBeGreaterThanOrEqual(30);
  });

  test("the descriptions come from the help text, not from a second copy of it", () => {
    const text = renderCommandReference();
    // Distinctive phrases that exist exactly once in the CLI's USAGE string.
    expect(mainSource).toContain("run as an MCP server over stdio");
    expect(text).toContain("run as an MCP server over stdio");
    expect(mainSource).toContain("diagnose transport, repo identity and the WSL boundary");
    expect(text).toContain("diagnose transport, repo identity and the WSL boundary");
  });

  test("the global flags are carried over", () => {
    const text = renderCommandReference();
    expect(text).toContain("## Global flags");
    for (const flag of ["--json", "--as", "--quiet", "--help", "--version"]) {
      expect(text).toContain(flag);
    }
  });
});

// A generator that cannot see a new command is worse than no generator: the
// page looks maintained and is not. These two tests are the ones that make
// "add a command and nothing happens" impossible.
describe("a command that only exists on one side is an error", () => {
  // These fixtures are about command *names*. The generator also cross-checks
  // flags, and a help text spelling a flag nothing reads is an error there — so
  // the prologue reads back whatever flags the fixture's usage spells, leaving
  // the name mismatch as the only thing under test.
  const readsEveryFlagIn = (usage: string): string =>
    ["--json", ...(usage.match(/--[a-z][a-z0-9-]*/g) ?? [])]
      .map((f) => `parsed.flags["${f.slice(2)}"];`)
      .join(" ");

  const fake = (usage: string, cases: string[]): string =>
    [
      "const USAGE = `parley — fake",
      "",
      usage,
      "",
      "Global flags: --json (machine output)",
      "`;",
      `function out(parsed) { ${readsEveryFlagIn(usage)} }`,
      "switch (parsed.command) {",
      ...cases.map((c) => `  case "${c}": { break; }`),
      "}",
    ].join("\n");

  const territory = '  parley claim <paths...> [--intent "..."]    take files or globs';

  test("the fixture itself renders, so the failures below are about the mismatch", () => {
    expect(renderCommandReference(fake(territory, ["claim"]))).toContain("### `parley claim`");
  });

  test("a dispatched command missing from the help text fails the generator", () => {
    expect(() => renderCommandReference(fake(territory, ["claim", "frobnicate"]))).toThrow(
      /frobnicate/,
    );
  });

  test("a documented command nothing dispatches fails the generator too", () => {
    const usage = `${territory}\n  parley frobnicate          twiddle the frobs`;
    expect(() => renderCommandReference(fake(usage, ["claim"]))).toThrow(/frobnicate/);
  });

  test("a whole new group with no title fails rather than rendering untitled", () => {
    const usage = `${territory}\n\n  parley frobnicate          twiddle the frobs`;
    expect(() => renderCommandReference(fake(usage, ["claim", "frobnicate"]))).toThrow(/frobnicate/);
  });

  test("the dispatch reader sees the real CLI, not an empty set", () => {
    const found = dispatchedCommands(mainSource);
    expect(found.length).toBeGreaterThanOrEqual(40);
    for (const command of ["claim", "release", "ask", "note", "works", "take", "shape", "watch", "update", "mcp"]) {
      expect(found).toContain(command);
    }
    // Internal entry points must never surface on a page for people.
    for (const hidden of ["hook", "__daemon", "__refresh-adapters", "help", "version"]) {
      expect(found).not.toContain(hidden);
    }
  });
});

// `reconcile` cross-checks command *names*. Nothing cross-checked flags, so the
// page rendered `parley uninit` with no flags while `--global` was dispatched
// and working, and `docs/guide/setup.md` two clicks away told the reader to run
// `parley uninit [--global]`. Two pages of one site disagreed and the generated,
// authoritative-looking one was the wrong one. Five more flags were in the same
// state: --human, --open/--no-open, --text, --active.
describe("a flag that only exists on one side is an error too", () => {
  /**
   * A whole synthetic CLI: help text, a shared prologue every command runs
   * through, and a dispatch switch whose case bodies really read the flags they
   * are given. Flags arrive without their dashes.
   */
  const cli = (
    usage: string,
    cases: Array<[command: string, flags: string[]]>,
    sharedFlags: string[] = [],
  ): string =>
    [
      "const USAGE = `parley — fake",
      "",
      usage,
      "",
      "Global flags: --json (machine output)",
      "`;",
      `function out(parsed) { if (parsed.flags.json) return 1; ${sharedFlags
        .map((f) => `parsed.flags["${f}"];`)
        .join(" ")} }`,
      "switch (parsed.command) {",
      ...cases.map(
        ([name, flags]) =>
          `  case "${name}": { ${flags.map((f) => `p.flags["${f}"];`).join(" ")} break; }`,
      ),
      "}",
    ].join("\n");

  const claim = '  parley claim <paths...> [--intent "..."]    take files or globs';

  test("the fixture renders when both sides agree, so the failures below mean something", () => {
    const page = renderCommandReference(cli(claim, [["claim", ["intent"]]]));
    expect(page).toContain("### `parley claim`");
    expect(page).toContain("`--intent`");
  });

  test("a flag the dispatch reads and the help text omits fails the generator", () => {
    expect(() => renderCommandReference(cli(claim, [["claim", ["intent", "sneaky"]]]))).toThrow(
      /--sneaky/,
    );
  });

  test("a flag the help text spells and nothing reads fails the generator too", () => {
    // The `--no-open` shape: documented, inert, and the reader believes it
    // worked because nothing ever says otherwise.
    const usage = '  parley claim <paths...> [--intent "..."] [--ghost]    take files or globs';
    expect(() => renderCommandReference(cli(usage, [["claim", ["intent"]]]))).toThrow(/--ghost/);
  });

  test("a global flag counts as documented for every command", () => {
    // `--json` is read inside case bodies all over the real CLI and spelled
    // once, in the global block. That must not be an error.
    expect(() => renderCommandReference(cli(claim, [["claim", ["intent", "json"]]]))).not.toThrow();
  });

  test("a flag read in shared code must appear somewhere in the help text", () => {
    expect(() => renderCommandReference(cli(claim, [["claim", ["intent"]]], ["rogue"]))).toThrow(
      /--rogue/,
    );
  });

  test("but shared code may read a flag the help text spells on one command", () => {
    // `withSession` reads `--mission` for every session command while USAGE
    // spells it on `join` and `rename`. Demanding a per-command match there
    // would fire on correct code, so the shared check is deliberately weaker.
    expect(() => renderCommandReference(cli(claim, [["claim", ["intent"]]], ["intent"]))).not.toThrow();
  });

  test("a fall-through case label carries the flags of the body it falls into", () => {
    // `case "note":` sits directly above `case "decide": {` and shares every
    // line of it. A checker that gave the label an empty flag set would let an
    // undocumented flag through on the first of every fall-through pair.
    const usage = [
      '  parley note --title "..."          write it down',
      '  parley decide --title "..." [--tags a,b]    record something binding',
    ].join("\n");
    const source = cli(usage, []).replace(
      "switch (parsed.command) {",
      'switch (parsed.command) {\n  case "note":\n  case "decide": { p.flags["title"]; p.flags["tags"]; break; }',
    );
    expect(() => renderCommandReference(source)).toThrow(/parley note.*--tags/s);
  });

  test("the flag reader sees the real CLI, per command, not one flat pile", () => {
    const found = dispatchedFlags(mainSource);
    // Vacuity guards: a regex that matched nothing would make every assertion
    // below pass for the wrong reason.
    expect(found.byCommand.size).toBeGreaterThanOrEqual(20);
    expect([...found.byCommand.values()].reduce((n, f) => n + f.size, 0)).toBeGreaterThanOrEqual(50);

    // The six drift cases, re-derived here rather than taken from the
    // generator, and each confirmed against the line that reads it.
    expect(found.byCommand.get("uninit")).toContain("--global");
    expect(found.byCommand.get("watch")).toContain("--no-open");
    expect(found.byCommand.get("reply")).toContain("--text");
    expect(found.byCommand.get("notes")).toContain("--active");
    expect(found.shared).toContain("--human");
    // Attribution, not just presence: `--global` belongs to init AND uninit,
    // and `--active` must not leak onto every command in the group.
    expect(found.byCommand.get("init")).toContain("--global");
    expect(found.byCommand.get("results")?.has("--active")).toBe(false);
  });

  test("the flags the page renders are the flags the CLI reads", () => {
    // Independently: pull each command's section out of the rendered page and
    // check the flags the dispatch reads for it are all named there.
    const page = renderCommandReference();
    const sections = new Map<string, string>();
    const parts = page.split(/^### `parley ([a-z][a-z0-9-]*)`$/gm).slice(1);
    for (let i = 0; i + 1 < parts.length; i += 2) sections.set(parts[i]!, parts[i + 1]!);
    expect(sections.size).toBeGreaterThanOrEqual(40);

    const globals = ["--json", "--as", "--quiet", "--human", "--help", "--version"];
    let checked = 0;
    for (const [command, flags] of dispatchedFlags(mainSource).byCommand) {
      const section = sections.get(command);
      if (!section) continue;
      for (const flag of flags) {
        if (globals.includes(flag)) continue;
        expect(section).toContain(flag);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40);
  });
});

describe("the generated file is byte-stable", () => {
  test("two runs produce the same bytes", () => {
    expect(renderCommandReference()).toBe(renderCommandReference());
  });

  test("nothing in the generator can vary between runs", () => {
    // `git diff --exit-code` in CI turns any timestamp or shuffled ordering
    // into a red build on an unrelated pull request.
    const source = readFileSync(join(root, "scripts", "gen-commands.ts"), "utf8");
    expect(source).not.toMatch(/new Date|Date\.now|Math\.random|toISOString/);
  });

  test("it ends with exactly one newline, which is what the shell redirect writes", () => {
    const text = renderCommandReference();
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("the wiring that keeps it fresh", () => {
  test("package.json regenerates the file the test above compares against", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["docs:commands"]).toBe(
      "bun run scripts/gen-commands.ts > docs/reference/commands.md",
    );
  });

  test("CI regenerates and fails on a diff", () => {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("bun run docs:commands");
    expect(ci).toContain("git diff --exit-code docs/reference/commands.md");
    // One OS is enough for a file that is identical everywhere, and the step
    // must not be skipped on all of them by a typo in the guard.
    expect(ci).toMatch(/if: matrix\.os == 'ubuntu-latest'\s*\n\s*run: \|\n\s*bun run docs:commands/);
  });
});
