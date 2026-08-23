import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sitePages } from "../../scripts/gen-citations";
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

/**
 * Every `--flag` `src/cli/main.ts` actually reads, plus every one USAGE spells.
 *
 * Comments quote old code on purpose — `flagBool`'s doc names the two idioms
 * it replaced — so what counts as a *read* is code with the comments stripped.
 */
function flagsTheCliReads(): Set<string> {
  const code = mainSource.replace(/^\s*\/\/.*$/gm, "");
  const known = new Set<string>();
  for (const m of code.matchAll(/\bflag(?:String|Bool)\(\s*(?:parsed|p)\.flags\s*,\s*"([^"]+)"/g)) known.add(`--${m[1]}`);
  for (const m of code.matchAll(/\b(?:parsed|p)\.flags\.([A-Za-z][\w$]*)/g)) known.add(`--${m[1]}`);
  for (const m of code.matchAll(/\b(?:parsed|p)\.flags\[\s*"([^"]+)"\s*\]/g)) known.add(`--${m[1]}`);
  const usage = mainSource.slice(mainSource.indexOf("const USAGE = `"), mainSource.indexOf("\n`;\n"));
  for (const m of usage.matchAll(/--[a-z][A-Za-z0-9-]*/g)) known.add(m[0]);
  return known;
}

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

  test("it carries the tagline, which is the first thing --help prints", () => {
    // The page claimed to be the same text `parley --help` prints while
    // dropping the one line that opens it: `parseUsage` extracted the tagline
    // and stored it, and the renderer never emitted it.
    const usage = parseUsage(mainSource);
    expect(usage.tagline).toContain("coordination bus");
    expect(renderCommandReference()).toContain(usage.tagline);
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

  test("a flag documented on the wrong command fails, even though something reads it", () => {
    // The gap the inert check leaves open. `--intent` is a real flag with a
    // real read, so "nothing in main.ts reads it" is false and check 3 stays
    // quiet — while `parley leave [--intent "..."]` renders on the reference
    // page and prints from `parley --help`, and the `leave` op discards it.
    // Proven on the real CLI before this check existed: generator exit 0,
    // 57 tests green, the page offering a flag that does nothing.
    const usage = [
      '  parley claim <paths...> [--intent "..."]    take files or globs',
      '  parley leave [--intent "..."]               step off the bus',
    ].join("\n");
    expect(() =>
      renderCommandReference(cli(usage, [["claim", ["intent"]], ["leave", []]])),
    ).toThrow(/parley leave.*--intent|--intent.*parley leave/s);
  });

  test("but a command whose own region reads nothing is fine when shared code reads it", () => {
    // The exemption that makes the check above usable rather than merely
    // strict, and the reason the naive version was rejected: `join`'s region
    // reads nothing at all, because `--as` and `--mission` are read in
    // `withSession` two hundred lines above the dispatch.
    const usage = [
      '  parley claim <paths...> [--intent "..."]    take files or globs',
      '  parley join [--mission "..."]               announce yourself',
    ].join("\n");
    expect(() =>
      renderCommandReference(cli(usage, [["claim", ["intent"]], ["join", []]], ["mission"])),
    ).not.toThrow();
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

// The generated page cannot go stale. The README's tables can, and had: `parley
// nudged` was dispatched, in USAGE, and described in the README's own prose, and
// missing from the "Talking" table. This is the third cross-check — README rows
// against the dispatch — so the tables cannot drift again while the page holds
// still.
describe("the README's command tables agree with the CLI", () => {
  /** The first cell of every `| `parley ...` |` row, prose column dropped. */
  function commandCells(): string[] {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    return [...readme.matchAll(/^\| (`parley [^|]*?) *\|/gm)].map((m) => m[1]!);
  }

  test("every command the CLI dispatches has a row, and every row a command", () => {
    const cells = commandCells();
    // A regex that stopped matching would make both set comparisons trivially
    // equal to each other and to nothing.
    expect(cells.length).toBeGreaterThanOrEqual(40);

    const inTables = new Set<string>();
    for (const cell of cells) {
      for (const m of cell.matchAll(/`parley ([a-z][a-z0-9-]*)/g)) inTables.add(m[1]!);
    }
    // Both directions: a row for a command nobody can run is the same defect
    // pointing the other way.
    expect([...inTables].sort()).toEqual(dispatchedCommands(mainSource).sort());
  });

  test("every flag the tables spell is a flag the help text offers", () => {
    // `parley history [--limit N] [--since SEQ]` sat here while main.ts's
    // history case sends only `limit` — the daemon op takes `since`, the
    // command line never passes it, and the README promised it anyway.
    const usage = parseUsage(mainSource);
    const documented = new Set<string>();
    for (const group of usage.groups) {
      for (const command of group.commands) {
        for (const variant of command.variants) for (const flag of variant.flags) documented.add(flag);
      }
    }
    for (const line of usage.globalFlags) {
      for (const m of line.matchAll(/--[a-z][a-z0-9-]*/g)) documented.add(m[0]);
    }

    let checked = 0;
    const unknown: string[] = [];
    for (const cell of commandCells()) {
      for (const m of cell.matchAll(/--[a-z][a-z0-9-]*/g)) {
        if (!documented.has(m[0])) unknown.push(`${m[0]} (in ${cell.trim()})`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    expect(unknown).toEqual([]);
  });

  test("every flag any published page spells is one the CLI actually reads", () => {
    // Two rounds of this class, found the same way and one page apart.
    //
    // `--open=false` sat in a README bullet under "In the browser" for the
    // whole life of this branch, promising a flag read nowhere: the spelling
    // is `--no-open`, and `parley watch --web --open=false` opened the browser
    // anyway. It survived a whole-branch review and two fix rounds because
    // reconcileFlags check 3 reads USAGE and the README cross-check above
    // reads *table rows*, and this was a bullet.
    //
    // The guard built for it read `README.md` and nothing else, so
    // `docs/ARCHITECTURE.md:72` kept documenting `--speak` — a flag that
    // exists nowhere in `src/`; speaking on the terminal panel is the `i`
    // keypress at `src/cli/watch.ts:469`, which USAGE itself says. That page
    // is in the sidebar (docs/.vitepress/config.ts). A guard whose scope is
    // one file closes the class for one file.
    //
    // WHAT THIS STILL CANNOT SEE, all accepted. The `--` anchor is what makes
    // the scan cheap enough to run over every page without false positives,
    // and it is the whole cost:
    //   - a flag written without it ("the `open` flag", "pass open=false");
    //   - a flag whose first character is not [a-z] (`--Web`, `--2fa`) — the
    //     CLI has none, and loosening it makes `--` in prose match;
    //   - a flag hard-wrapped across a line break.
    // Each needs a reader. What is closed is the spelled, unbroken, published
    // `--flag` — which is every instance either round actually found.
    const known = flagsTheCliReads();

    // Flags of other people's tools, quoted on a page as examples. Asserted by
    // equality, so the list cannot quietly grow to swallow a real defect — the
    // same arrangement as the sidebar exclusion set.
    const NOT_PARLEYS: Record<string, string> = {
      "--compile": "bun build --compile, in the packaging section",
      "--git-common-dir": "git rev-parse --git-common-dir, the bus key",
      "--noEmit": "tsc --noEmit",
    };
    expect(known.size).toBeGreaterThanOrEqual(20);

    const pages = ["README.md", ...sitePages(join(root, "docs"))];
    // Vacuity: a `sitePages` that returned nothing would pass silently.
    expect(pages.length).toBeGreaterThanOrEqual(10);

    let checked = 0;
    const unknown: string[] = [];
    const foreign = new Set<string>();
    for (const page of pages) {
      const text = readFileSync(join(root, page), "utf8");
      for (const flag of new Set([...text.matchAll(/--[a-z][A-Za-z0-9-]*/g)].map((m) => m[0]))) {
        checked++;
        if (known.has(flag)) continue;
        if (flag in NOT_PARLEYS) foreign.add(flag);
        else unknown.push(`${flag} (in ${page})`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40);
    expect(unknown.sort()).toEqual([]);
    // Both directions: an entry nobody needs is a hole waiting for a real
    // defect to fall into.
    expect([...foreign].sort()).toEqual(Object.keys(NOT_PARLEYS).sort());
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

  test("it ends with exactly one newline, which is what writeFileSync puts on disk", () => {
    const text = renderCommandReference();
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("the wiring that keeps it fresh", () => {
  test("package.json regenerates the file the test above compares against", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["docs:commands"]).toBe("bun run scripts/gen-commands.ts --write");
  });

  test("a failed generator leaves the page alone instead of emptying it", () => {
    // A shell redirect truncates the page before bun starts, so a run that
    // threw left a zero-byte Commands page behind. CI caught that; docs.yml
    // deploys on push to main independently of ci.yml, so a blank page could
    // reach the published site by a route that skipped CI.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["docs:commands"]).not.toContain(">");
    const generator = readFileSync(join(root, "scripts", "gen-commands.ts"), "utf8");
    // Rendering must happen before the write, not inside it.
    const render = generator.indexOf("const text = renderCommandReference();");
    const write = generator.indexOf("writeFileSync(PAGE_PATH, text)");
    expect(render).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(render);
  });

  test("the deploy workflow refuses to publish a stale reference", () => {
    // docs.yml triggers on push to main on its own and never ran the
    // generator, so a stale page deployed even though a *broken build* could
    // not. Bounded to staleness, and staleness is the one thing this branch
    // claims is impossible.
    const docs = readFileSync(join(root, ".github", "workflows", "docs.yml"), "utf8");
    expect(docs).toContain("bun run docs:commands");
    expect(docs).toContain("git diff --exit-code docs/reference/commands.md");
  });

  test("the deploy workflow configures Pages before it builds", () => {
    // Harmless while `base` is hardcoded, and a silent breakage the day it is
    // not: configure-pages is what resolves the base path a build would read.
    const docs = readFileSync(join(root, ".github", "workflows", "docs.yml"), "utf8");
    const configure = docs.indexOf("actions/configure-pages");
    const build = docs.indexOf("bun run docs:build");
    expect(configure).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(0);
    expect(configure).toBeLessThan(build);
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
