import { describe, expect, test } from "bun:test";
import { SKILL } from "../../src/adapters/claude-code";
import { RECOMMENDED, RETIRED } from "../../src/brain/registry";

/**
 * The skill is the only thing that tells an agent a capability exists.
 *
 * Ranked recall shipped, was measured, was tuned, and was released — and for
 * all of that the skill never mentioned it, so the agents parley is written
 * for could not have known to use it. Nothing in the skill was *wrong*; the
 * feature was simply invisible, which is the failure mode a version stamp and
 * a green suite cannot see.
 */
const PROSE = SKILL.replace(/\s+/g, " ");

describe("what the skill says about recall", () => {
  test("it names the commands, so the capability is discoverable at all", () => {
    expect(PROSE).toContain("parley notes --query");
    expect(PROSE).toContain("parley results --query");
    expect(PROSE).toContain("--k ");
  });

  test("it says why to ask rather than to read the whole corpus", () => {
    // The failure this prevents is an agent calling bare `parley notes` on a
    // large corpus and spending its context on notes about something else.
    expect(PROSE).toContain("gives you every note");
    expect(PROSE).toContain("wrong tool");
  });

  test("it says silence is an answer, not a ranking that gave up", () => {
    // Without this an agent reads an empty result as a broken feature and
    // falls back to dumping the corpus — the exact behaviour the floor exists
    // to prevent.
    expect(PROSE).toContain("nothing at all when nothing is close");
    expect(PROSE).toContain("does not know");
  });

  test("it tells an agent to use the exact identifier when it has one", () => {
    // Keyword matching answers 92 of 92 exact-term queries and needs no model.
    // An agent that paraphrases a symbol it already knows is throwing that away.
    expect(PROSE).toContain("exact identifier");
  });

  test("it says the query works whether or not the model is on", () => {
    // Otherwise an agent checks `parley brain` first and skips the call when
    // it is off, losing the channel that answers regardless.
    expect(PROSE).toContain("ask the question anyway");
    expect(PROSE).toContain("same command either way");
  });

  test("it does not invite an agent to turn the model on", () => {
    // Enabling spends somebody's disk on somebody's machine, and the CLI
    // refuses an agent that tries. A skill that suggested it would send every
    // front into a refusal it was told to expect.
    expect(PROSE).toContain("never will be");
    expect(PROSE).not.toContain("parley brain enable");
  });

  test("it names no model, so a retired one cannot outlive its retirement here", () => {
    // Three models were listed, recommended, then measured as worse than no
    // model and withdrawn. A skill naming one would still be naming it now.
    for (const r of RETIRED) expect(PROSE).not.toContain(r.name);
    expect(PROSE).not.toContain(RECOMMENDED);
  });
});
