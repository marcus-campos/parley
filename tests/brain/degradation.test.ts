// tests/brain/degradation.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureModel, modelPath } from "../../src/brain/download";
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

  test("index cold: path-anchored delivery still rides along on a claim", () => {
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

  test("an empty index answers nothing rather than throwing", () => {
    expect(new LexicalIndex().search("anything", 5)).toEqual([]);
  });

  test("a query of only unknown tokens returns nothing, not the least-bad note", () => {
    const index = new LexicalIndex();
    index.add("n_1", "note", "the select2 trap");
    expect(index.search("kubernetes helm chart", 5)).toEqual([]);
  });
});
