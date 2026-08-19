import { describe, expect, test } from "bun:test";
import { flagString, parseArgs } from "../../src/cli/args";

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
