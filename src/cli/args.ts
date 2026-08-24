export interface Parsed {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }
  return { command, positional, flags };
}

export const flagString = (flags: Parsed["flags"], key: string, fallback = ""): string =>
  typeof flags[key] === "string" ? (flags[key] as string) : fallback;

/**
 * A boolean flag, read the way a person spells one. The only reader of one.
 *
 * `parseArgs` stores `--x=true` and `--x true` as the string `"true"`, so the
 * CLI had two idioms and both were wrong at one end:
 *
 *   - `flags.x === true` read `--x=true` as **not given**. That is a flag the
 *     parser drops on the floor while the help text promises it works. The
 *     worst instance was `parley update --check=true`, documented at the top
 *     of USAGE, which fell through the dry run and performed a real update of
 *     the binary — and with `--yes=true` also dropped, it did so without ever
 *     asking. A browser window opening against `--no-open=true` was the same
 *     defect with a smaller bill.
 *   - `flags.x` read `--x=false` as **given**, so `--json=false` printed JSON.
 *     Harmless to type by hand, not harmless in `--json=$WANT_JSON`.
 *
 * So: absent is false, bare is true, and a value is read as a value —
 * `false|0|no|off` in any case is off, and anything else counts as the flag
 * being meant, because the alternative is silently ignoring what somebody
 * typed. One accessor, so the next boolean flag cannot pick the wrong idiom;
 * `flagsReadIn` in scripts/gen-commands.ts knows this name, which is how a
 * documented flag that nothing reads still fails the build.
 */
export const flagBool = (flags: Parsed["flags"], key: string): boolean => {
  const value = flags[key];
  if (typeof value !== "string") return value === true;
  return !/^(false|0|no|off)$/i.test(value);
};
