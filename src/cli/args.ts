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
 * A boolean flag, read the way a person spells one.
 *
 * `flags.x === true` is the right test for a flag that is only ever bare, and
 * it is what the rest of the CLI uses. It is the wrong test for a flag someone
 * will naturally write a value onto — and `--no-open` is that flag, because it
 * is the only one in the help text whose *name* is a negation. `parseArgs`
 * stores `--no-open=true` and `--no-open true` as the string `"true"`, so an
 * `=== true` test read both as "not given" and opened the browser on a person
 * who had just told it twice not to. That is a flag the parser drops on the
 * floor while the help text promises it works, one level below the check the
 * generator makes.
 *
 * So: absent is false, bare is true, and a value is read as a value. Anything
 * that is not a recognised "off" word counts as the flag being meant, because
 * the alternative is silently ignoring what somebody typed.
 */
export const flagBool = (flags: Parsed["flags"], key: string): boolean => {
  const value = flags[key];
  if (typeof value !== "string") return value === true;
  return !/^(false|0|no|off)$/i.test(value);
};
