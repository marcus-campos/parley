import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flagBool, flagString, parseArgs } from "../../src/cli/args";

describe("parseArgs", () => {
  test("separates command, positionals and flags", () => {
    const p = parseArgs(["claim", "src/a.ts", "src/b.ts", "--intent", "refactor"]);
    expect(p.command).toBe("claim");
    expect(p.positional).toEqual(["src/a.ts", "src/b.ts"]);
    expect(p.flags.intent).toBe("refactor");
  });

  test("--flag=value form", () => {
    expect(parseArgs(["say", "--to=FINANCEIRO"]).flags.to).toBe("FINANCEIRO");
  });

  test("a flag with no value is boolean true", () => {
    const p = parseArgs(["claim", "src/a.ts", "--auto", "--json"]);
    expect(p.flags.auto).toBe(true);
    expect(p.flags.json).toBe(true);
  });

  test("--help and --version land in `command`, which is why main matches them there", () => {
    // Regression: `parley --help` used to fall through to the switch default and
    // exit 2, which made the installer's final sanity check report failure on a
    // perfectly good install.
    expect(parseArgs(["--help"]).command).toBe("--help");
    expect(parseArgs(["--version"]).command).toBe("--version");
    expect(parseArgs(["-v"]).command).toBe("-v");
  });

  test("flagString falls back when the flag is absent or boolean", () => {
    const p = parseArgs(["note", "--title"]);
    expect(flagString(p.flags, "title", "fallback")).toBe("fallback");
    expect(flagString(p.flags, "missing", "fallback")).toBe("fallback");
  });
});

describe("flagBool", () => {
  // `--no-open` is the only flag in the help text whose name is a negation, so
  // it is the one people write a value onto. parseArgs stores `--no-open=true`
  // and `--no-open true` as the string `"true"`, and an `=== true` test read
  // both as "not given": the browser opened on somebody who had just said not
  // to, twice. A documented flag the parser drops on the floor is the failure
  // the generator's own flag check exists to refuse.
  const bool = (argv: string[], key = "no-open") => flagBool(parseArgs(argv).flags, key);

  test("absent is false", () => {
    expect(bool(["watch", "--web"])).toBe(false);
  });

  test("bare is true", () => {
    expect(bool(["watch", "--no-open"])).toBe(true);
    expect(bool(["watch", "--no-open", "--web"])).toBe(true);
  });

  test("a value written onto it is read as a value, not ignored", () => {
    expect(bool(["watch", "--no-open=true"])).toBe(true);
    expect(bool(["watch", "--no-open", "true"])).toBe(true);
    expect(bool(["watch", "--no-open=false"])).toBe(false);
    expect(bool(["watch", "--no-open", "false"])).toBe(false);
  });

  test("the other spellings of off are off too", () => {
    for (const off of ["0", "no", "off", "FALSE", "Off"]) {
      expect(bool(["watch", `--no-open=${off}`])).toBe(false);
    }
  });

  test("anything else counts as meant, because silently ignoring it is worse", () => {
    expect(bool(["watch", "--no-open=yes"])).toBe(true);
    expect(bool(["watch", "--no-open=1"])).toBe(true);
  });
});

/**
 * Every boolean flag the CLI documents, read by one accessor.
 *
 * `--no-open` was fixed on its own last round, on the argument that it is the
 * only flag whose name is a negation and therefore the only one people write a
 * value onto. That argument does not survive contact with `--check=true` and
 * `--json=true`, which are at least as natural, especially from a script — and
 * `--check` was the worse instance by a long way: `parley update [--check]` is
 * the first line of USAGE, and `parley update --check=true` fell straight past
 * the dry run into a real replacement of the binary. With `--yes=true` also
 * dropped, it did that without asking.
 *
 * The generator's fourth flag check cannot see any of this: it catches a flag
 * that is documented and never read, and all ten of these were read. It is the
 * layer below.
 */
describe("the boolean flags of the CLI", () => {
  const main = readFileSync(join(import.meta.dir, "..", "..", "src", "cli", "main.ts"), "utf8");
  // Line comments quote the old idioms on purpose; the rule is about code.
  const code = main.replace(/^\s*\/\/.*$/gm, "");

  test("none is read with `=== true`, which drops `--flag=true` on the floor", () => {
    const reads = [
      ...code.matchAll(/\b(?:parsed|p)\.flags\.[A-Za-z][\w$]*\s*===\s*true/g),
      ...code.matchAll(/\b(?:parsed|p)\.flags\[[^\]]*\]\s*===\s*true/g),
    ].map((m) => m[0]);
    expect(reads).toEqual([]);
  });

  test("none is read by bare truthiness either, which is the same defect mirrored", () => {
    // `flags.x` is true for the string "false", so `--json=false` printed
    // JSON. Harmless typed by hand, not harmless in `--json=$WANT_JSON`.
    // A comparison against a string literal is a string flag and is fine.
    const bare = [...code.matchAll(/\b(?:parsed|p)\.flags\.([A-Za-z][\w$]*)(\s*===\s*"[^"]*")?/g)]
      .filter((m) => !m[2])
      .map((m) => `--${m[1]}`);
    expect(bare).toEqual([]);
  });

  test("`parley update --check=true` is a dry run, as the first line of USAGE says", () => {
    const flags = parseArgs(["update", "--check=true", "--yes=true"]).flags;
    // What the parser actually stores, which is the root of all of this.
    expect(flags.check).toBe("true");
    expect(flags.check === true).toBe(false);
    expect(flagBool(flags, "check")).toBe(true);
    expect(flagBool(flags, "yes")).toBe(true);
  });

  test("every documented boolean flag reads a written value the same way", () => {
    for (const flag of ["check", "yes", "json", "global", "all", "auto", "fresh", "mine", "active", "web", "detach", "stop", "export", "import", "quiet", "human", "workspace"]) {
      expect(flagBool(parseArgs(["x"]).flags, flag)).toBe(false);
      expect(flagBool(parseArgs(["x", `--${flag}`]).flags, flag)).toBe(true);
      expect(flagBool(parseArgs(["x", `--${flag}=true`]).flags, flag)).toBe(true);
      expect(flagBool(parseArgs(["x", `--${flag}=false`]).flags, flag)).toBe(false);
    }
  });

  test("--detach=true does not detach forever, because the child no longer keeps it", () => {
    const argv = ["watch", "--web", "--detach=true"];
    expect(flagBool(parseArgs(argv).flags, "detach")).toBe(true);
    // The detached child is spawned with the parent's argv minus the flag. The
    // old filter was `a !== "--detach"`, which leaves `--detach=true` in place:
    // the child detaches too, and the one after it, and no generation ever
    // reaches runWebPanel — so the panel never starts and the chain does not
    // end. Bare `--detach` was always stripped, which is why nobody hit it.
    expect(argv.filter((a) => a !== "--detach")).toContain("--detach=true");
    expect(code).toContain('a !== "--detach" && !a.startsWith("--detach=")');
  });
});

import { defaultPortFor } from "../../src/cli/web";

describe("the web panel port", () => {
  test("is derived from the repository, so two projects do not collide", () => {
    // One fixed default meant the second project you opened a panel for simply
    // failed to start.
    const a = defaultPortFor("2ff64cd9cc60be28");
    const b = defaultPortFor("4d631eb877fe1b17");
    expect(a).not.toBe(b);
  });

  test("is the same every time for the same repository", () => {
    // The URL in your browser history has to keep working.
    expect(defaultPortFor("2ff64cd9cc60be28")).toBe(defaultPortFor("2ff64cd9cc60be28"));
  });

  test("stays in a sane range", () => {
    for (const id of ["a", "2ff64cd9cc60be28", "ffffffffffffffff", "0000000000000000"]) {
      const port = defaultPortFor(id);
      expect(port).toBeGreaterThanOrEqual(7717);
      expect(port).toBeLessThan(7717 + 200);
    }
  });
});
