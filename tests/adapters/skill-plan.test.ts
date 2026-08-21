import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL } from "../../src/adapters/claude-code";

/**
 * Every command the CLI actually answers to, read out of the `switch` in
 * `main.ts` rather than copied here.
 *
 * This is the only part of this file that can catch anything but a deletion:
 * a skill that tells fronts to run `parley plan` is wrong the moment the
 * command is renamed, and a string assertion alone would stay green through
 * that rename. Reading the real switch is what makes the assertion a contract
 * between two files instead of a spellcheck.
 */
const CLI_COMMANDS = new Set(
  [...readFileSync(join(import.meta.dir, "../../src/cli/main.ts"), "utf8")
    .matchAll(/^\s+case "([a-z-]+)":/gm)].map((m) => m[1]!),
);

/**
 * The skill hard-wraps at 79 columns, so any sentence worth asserting on is
 * split across lines. Asserting on the raw text would make every reflow of a
 * paragraph a test failure — noise that teaches people to edit the test until
 * it passes. Collapse the whitespace and assert on what the sentence says.
 */
const PROSE = SKILL.replace(/\s+/g, " ");

describe("what the skill says about plans", () => {
  test("it names the command and where a plan comes from", () => {
    expect(PROSE).toContain("parley plan ");
    expect(PROSE).toContain("superpowers:writing-plans");
  });

  test("it tells the coordinator not to fan the tasks out by hand", () => {
    expect(PROSE).toContain("computes which tasks can run at the same time");
    expect(PROSE).toContain("do not fan them out by hand");
  });

  test("it tells a worker how a planned item is picked up, and that it cannot be handed back", () => {
    expect(PROSE).toContain("parley works --state open");
    expect(PROSE).toContain("parley done ");
    expect(PROSE).toContain("dispatched, not offered");
  });

  test("it says review is not optional and gates the wave", () => {
    expect(PROSE).toContain("The wave is not over until those reviews are done");
  });

  test.each(["plan", "shape", "works", "take", "done"])(
    "the skill names `parley %s` and the CLI still answers to it",
    (command) => {
      expect(PROSE).toContain(`parley ${command}`);
      expect(CLI_COMMANDS.has(command)).toBe(true);
    },
  );
});
