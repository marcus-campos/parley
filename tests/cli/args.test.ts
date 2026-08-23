import { describe, expect, test } from "bun:test";
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
