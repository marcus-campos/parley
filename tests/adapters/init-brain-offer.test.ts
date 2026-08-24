import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What `parley init` may and may not do on its own.
 *
 * The offer at the end of `init` is the only place parley proposes spending
 * somebody's disk, and the only place it can run a third party's installer. So
 * the interesting assertions here are all refusals — the paths where it must
 * stay silent — because those are what separate an offer from an ambush, and
 * they are invisible in a happy-path test.
 *
 * These read the source rather than driving a terminal: the gates are early
 * returns before any I/O, and a test that spawned a TTY to prove a function
 * returns early would be testing the pseudo-terminal.
 */
const SOURCE = readFileSync(join(import.meta.dir, "..", "..", "src", "adapters", "install.ts"), "utf8");
const OFFER = SOURCE.slice(SOURCE.indexOf("async function offerTheBrain"));

describe("the brain offer at the end of init", () => {
  test("it stays silent without a terminal, and under --json", () => {
    // `init` runs inside scripts and inside other tools. A prompt there hangs
    // or corrupts the JSON somebody is parsing.
    expect(OFFER).toContain("opts.json");
    expect(OFFER).toContain("!process.stdin.isTTY");
  });

  test("--yes does not mean yes to this", () => {
    // The flag means "do not ask about the files you write". Reading it as
    // "download 209 MB" takes a much larger permission than it granted, and
    // `init --yes` is exactly what automation runs.
    expect(OFFER).toContain("opts.assumeYes");
    const guard = OFFER.slice(0, OFFER.indexOf("\n\n"));
    expect(guard).toContain("return");
  });

  test("an agent session is not offered anything", () => {
    // The same check `brain enable` makes, and for the same reason: a harness
    // stamps its session into the environment, a person's shell does not.
    for (const v of ["CLAUDE_CODE_SESSION_ID", "CODEX_SESSION_ID", "CURSOR_TRACE_ID"]) {
      expect(OFFER).toContain(v);
    }
  });

  test("it does not offer what is already on", () => {
    expect(OFFER).toContain("brainIsOn");
  });

  test("saying no leaves the command, not a dead end", () => {
    // Refusing has to cost nothing and teach the way back.
    expect(OFFER).toContain("Left off");
    expect(OFFER).toContain("parley brain enable");
  });

  test("bun is never installed without its own separate yes", () => {
    // Two different permissions: spending disk on a model, and running a third
    // party's installer. One answer must not be read as both.
    const bunPart = OFFER.slice(OFFER.indexOf("bunAvailable"));
    expect(bunPart).toContain("confirm(");
    expect(bunPart).toContain("https://bun.sh/install");
  });

  test("a failed install is not reported as an activation", () => {
    expect(OFFER).toContain("installed.ok");
    expect(OFFER).toContain("the install did not finish");
  });

  test("the numbers it quotes come from the registry, not from prose", () => {
    // A hardcoded "66 of 100" here would outlive the measurement that produced
    // it — which is exactly how the old listing ended up recommending a model
    // that had become the worst option.
    expect(OFFER).toContain("model.score");
    expect(OFFER).toContain("LEXICAL_FLOOR_SCORE");
    expect(OFFER).toContain("BENCHMARK_SIZE");
    expect(OFFER).toContain("model.bytes");
    expect(OFFER).not.toMatch(/answers 66 of/);
  });
});
