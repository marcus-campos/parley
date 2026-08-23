// tests/brain/degradation.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureModel, modelPath } from "../../src/brain/download";
import { calibrate } from "../../src/brain/calibrate";
import { loadStaticModel } from "../../src/brain/embed";
import { LexicalIndex } from "../../src/brain/lexical";
import type { BrainModel } from "../../src/brain/registry";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, Note, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

describe("nothing here can stop the work", () => {
  test("brain off: the floor answers", () => {
    const index = new LexicalIndex();
    index.add("n_1", "note", "the select2 trap, a for pointing at a hidden element");
    expect(index.search("select2", 3)[0]!.id).toBe("n_1");
  });

  test("a corrupt model file loads as null instead of throwing", () => {
    const path = join(import.meta.dir, "fixtures", "corrupt-model.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(loadStaticModel(path)).toBeNull();
    unlinkSync(path);
  });

  describe("a model whose checksum does not match", () => {
    // ensureModel writes the fetched bytes to disk before it can hash them,
    // so this test — like download.test.ts's own checksum-mismatch case —
    // injects a throwaway base directory rather than let the real
    // machine-local models directory take that (briefly corrupt) write.
    let base: string;

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), "parley-brain-degradation-test-"));
    });

    afterEach(() => {
      rmSync(base, { recursive: true, force: true });
    });

    test("never activates the brain", async () => {
      const model: BrainModel = {
        name: "bad", dims: 4, languages: "x", bytes: 4,
        url: "https://example.invalid/m.bin", sha256: "f".repeat(64), tokenizer: "wordlevel",
      };
      const body = new TextEncoder().encode("not the model");
      const fetchFn = (async () => new Response(body)) as unknown as typeof fetch;
      expect(await ensureModel(model, fetchFn, base)).toBeNull();
      // A null-only assertion would pass even for a function that never wrote
      // the file at all — leaving the real defect (a corrupt file left on
      // disk, ready to be picked up by a later `existsSync` short-circuit in
      // `ensureModel` and treated as already-installed) unproven.
      expect(existsSync(modelPath(model, base))).toBe(false);
    });
  });

  /**
   * The README's degradation table used to claim a cold or broken lexical
   * index fell back to "path-anchored delivery, i.e. today's behaviour." It
   * does not, in either half, and the three tests below are what the table
   * now says instead.
   *
   * Path-anchored delivery is real and is genuinely underneath everything —
   * but it is `claim`'s footer, a different mechanism that reads `state`
   * directly, and no index failure can reach it. That is what this first test
   * proves, and why the table no longer names it as the index's fallback.
   */
  test("claim's path-anchored footer never consults an index at all, so no index failure can reach it", () => {
    counter = { n: 0 };
    const state: State = initialState("advisory");
    const id = (r: { response: unknown }) => (r.response as { id: string }).id;
    const core = id(apply(state, null, { v: 1, op: "join", name: "CORE", mission: "m" }, at(0)));
    apply(state, core, { v: 1, op: "note", title: "the select2 trap", paths: ["a.ts"] }, at(10));
    const other = id(apply(state, null, { v: 1, op: "join", name: "OTHER", mission: "m" }, at(20)));
    const out = apply(state, other, { v: 1, op: "claim", paths: ["a.ts"] }, at(30));
    // No index is involved at all. This is the floor beneath the floor, and it
    // is what parley did before any of this existed.
    expect((out.response as unknown as { notes: Note[] }).notes).toHaveLength(1);
  });

  /**
   * Index broken: the daemon's ranking `try` threw, so `toApply` stays the raw
   * frame — `q` on it, no `ids`. `listNotes` has no clock and no index and
   * cannot search on its own, so it answers the plain list, unranked. Not
   * silence, and not path-anchored delivery.
   */
  test("a query whose ranking failed answers the plain unranked list, not silence", () => {
    counter = { n: 0 };
    const state: State = initialState("advisory");
    const id = (r: { response: unknown }) => (r.response as { id: string }).id;
    const core = id(apply(state, null, { v: 1, op: "join", name: "CORE", mission: "m" }, at(0)));
    apply(state, core, { v: 1, op: "note", title: "the select2 trap" }, at(10));
    apply(state, core, { v: 1, op: "note", title: "o menu lateral" }, at(20));

    const out = apply(state, core, { v: 1, op: "notes", q: "kubernetes helm" }, at(30));
    const body = out.response as unknown as { notes: Note[]; ranked?: boolean };
    expect(body.notes).toHaveLength(2);
    // And it does not claim to be ranked, because it is not.
    expect(body.ranked).toBeUndefined();
  });

  /**
   * Index cold: the ranking worked and found nothing, so `ids` arrives empty
   * and the answer is an empty set that says it is ranked. Silence on purpose
   * — the opposite of the row above, and the reason the two cannot share one
   * table row.
   */
  test("a query that ranked and matched nothing answers an empty ranked set", () => {
    counter = { n: 0 };
    const state: State = initialState("advisory");
    const id = (r: { response: unknown }) => (r.response as { id: string }).id;
    const core = id(apply(state, null, { v: 1, op: "join", name: "CORE", mission: "m" }, at(0)));
    apply(state, core, { v: 1, op: "note", title: "the select2 trap" }, at(10));

    const out = apply(state, core, { v: 1, op: "notes", q: "kubernetes helm", ids: [], ranked: true }, at(30));
    expect(out.response as unknown as { notes: Note[]; ranked: boolean }).toMatchObject({ notes: [], ranked: true });
  });

  /**
   * A model this build can parse but cannot measure a null distribution over
   * gets no floor at all rather than a guessed one — the same `null` contract
   * `loadStaticModel` and `ensureModel` already keep for their own failures.
   */
  test("a model too small to measure a floor from calibrates to null, never to a guess", () => {
    expect(calibrate({ dims: 2, vocab: { menu: [1, 0], lateral: [0, 1] } })).toBeNull();
  });

  test("a model whose rows are all identical has no null to measure, so it calibrates to null too", () => {
    // Every row the same means every debiased vector is zero: the table can
    // say nothing about what unrelated looks like, so it may not say what
    // related looks like either.
    const vocab: Record<string, number[]> = {};
    for (let i = 0; i < 2000; i++) vocab[`t${i}`] = [1, 2, 3, 4];
    expect(calibrate({ dims: 4, vocab })).toBeNull();
  });

  test("an empty index answers nothing rather than throwing", () => {
    expect(new LexicalIndex().search("anything", 5)).toEqual([]);
  });

  test("a query of only unknown tokens returns nothing, not the least-bad note", () => {
    const index = new LexicalIndex();
    index.add("n_1", "note", "the select2 trap");
    expect(index.search("kubernetes helm chart", 5)).toEqual([]);
  });
});
