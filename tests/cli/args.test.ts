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
