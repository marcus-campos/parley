import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL } from "../../src/adapters/claude-code";

const MAIN = readFileSync(join(import.meta.dir, "../../src/cli/main.ts"), "utf8");

/**
 * Every command the CLI answers to, read out of `main.ts` rather than copied
 * here.
 *
 * `main.ts` dispatches from more than one place, so this reads more than one
 * place: two `switch` statements on the parsed command — one before a session
 * exists, one inside `withSession` — and, before either of them, a chain of
 * `argv[0] === "..."` / `parsed.command === "..."` checks. That chain is where
 * `mcp`, `hook`, `update`, `watch` and the two hidden `__` commands live. A
 * list read only out of the `case` labels would call `watch` a command the CLI
 * does not answer to, which is a false red — and a false red on an assertion
 * this thin teaches the next person to delete the assertion.
 *
 * This is the only part of this file that can catch anything but a deletion:
 * a skill that tells fronts to run `parley plan` is wrong the moment the
 * command is renamed, and a string assertion alone would stay green through
 * that rename. Reading the real dispatch is what makes the assertion a
 * contract between two files instead of a spellcheck.
 */
const CLI_COMMANDS = new Set([
  ...[...MAIN.matchAll(/^\s+case "([a-z-]+)":/gm)].map((m) => m[1]!),
  ...[...MAIN.matchAll(/(?:argv\[0\]|parsed\.command) === "([a-z_-]+)"/g)].map((m) => m[1]!),
]);

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

  test("it tells a worker how a planned task is picked up, and that it cannot be handed back", () => {
    expect(PROSE).toContain("parley works --state open");
    expect(PROSE).toContain("parley done ");
    expect(PROSE).toContain("dispatched, not offered");
  });

  // C1: the skill said a planned item is never named in the footer and that
  // `drop` refuses it — both false for a review, which is the one planned item
  // that is offered by name. A front reading the old sentence and then meeting
  // its own footer would read parley as broken.
  test("it says a review is the planned item that can be handed back", () => {
    expect(PROSE).toContain("A review is the one planned item that *is* an offer");
    expect(PROSE).toContain("`drop` accepts it");
  });

  test("it says review is not optional and gates the wave", () => {
    expect(PROSE).toContain("The wave is not over until those reviews are done");
  });

  // The list above is only worth reading if it covers both dispatch sites.
  // `watch` and `mcp` exist only in the pre-switch chain and `join` only in a
  // `switch`, so this fails the moment the extraction narrows back to one of
  // the two — which is the shape of the false red the comment describes.
  test("the command list covers both dispatch sites in main.ts", () => {
    expect(CLI_COMMANDS.has("join")).toBe(true);
    expect(CLI_COMMANDS.has("watch")).toBe(true);
    expect(CLI_COMMANDS.has("mcp")).toBe(true);
    expect(CLI_COMMANDS.has("update")).toBe(true);
  });

  test.each(["plan", "shape", "works", "take", "done"])(
    "the skill names `parley %s` and the CLI still answers to it",
    (command) => {
      expect(PROSE).toContain(`parley ${command}`);
      expect(CLI_COMMANDS.has(command)).toBe(true);
    },
  );
});
