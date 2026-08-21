import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aboveRelevanceFloor, embed, fuse, isLoadable, VectorIndex } from "../../src/brain/embed";

const model = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "tiny-model.json"), "utf8"));

describe("static embeddings", () => {
  test("the same text always gives the same vector, bit for bit", () => {
    expect(Array.from(embed(model, "select2 hidden"))).toEqual(Array.from(embed(model, "select2 hidden")));
  });

  test("it is a lookup and a mean, so it is assertable", () => {
    expect(Array.from(embed(model, "select2"))).toEqual([1, 0]);
    expect(Array.from(embed(model, "menu lateral"))).toEqual([0, 1]);
  });

  test("an unknown token contributes nothing rather than poisoning the vector", () => {
    // "kubernetes" is deliberately not used here — the floor tests below make
    // it a real vocabulary entry, so an actually-unknown word is needed to
    // test this property.
    expect(Array.from(embed(model, "select2 zzyzx"))).toEqual([1, 0]);
  });

  test("text with no known token gives a zero vector, and never a NaN", () => {
    const v = embed(model, "zzyzx plugh");
    expect(Array.from(v).every((x) => x === 0)).toBe(true);
  });

  test("nearest neighbours come back in order", () => {
    const index = new VectorIndex(2);
    index.add("n_1", embed(model, "select2 hidden"));
    index.add("n_2", embed(model, "menu lateral"));
    expect(index.search(embed(model, "select2"), 1)[0]!.id).toBe("n_1");
  });

  test("fusion puts a document both rankings agree on above one only a single ranking found", () => {
    const lex = [{ id: "a", score: 3, kind: "note" as const }, { id: "b", score: 2, kind: "note" as const }];
    const vec = [{ id: "b", score: 0.9, kind: "note" as const }, { id: "c", score: 0.8, kind: "note" as const }];
    expect(fuse(lex, vec, 3)[0]!.id).toBe("b");
  });

  test("fusion never invents a document neither ranking returned", () => {
    const out = fuse([{ id: "a", score: 1, kind: "note" }], [], 5);
    expect(out.map((h) => h.id)).toEqual(["a"]);
  });
});

describe("which registry entries this build can actually load", () => {
  test("a wordlevel entry is loadable", () => {
    expect(isLoadable({
      name: "tiny", dims: 2, languages: "test", bytes: 1,
      url: "https://example.invalid/m.json", sha256: "0".repeat(64), tokenizer: "wordlevel",
    })).toBe(true);
  });

  test("an xlmr entry is not — this build has no XLM-RoBERTa tokenizer", () => {
    expect(isLoadable({
      name: "big", dims: 256, languages: "many", bytes: 1,
      url: "https://example.invalid/m.safetensors", sha256: "0".repeat(64), tokenizer: "xlmr",
    })).toBe(false);
  });
});


describe("a relevance floor for the vector channel — no ties at zero, no least-bad note", () => {
  test("a query with no known token at all — the zero vector — matches nothing, not everything", () => {
    const index = new VectorIndex(2);
    index.add("n_1", embed(model, "select2 hidden"));
    index.add("n_2", embed(model, "menu lateral"));
    // "zzyzx plugh" shares no token with the tiny vocabulary, so it embeds to
    // the zero vector (proved in the embeddings describe block above). This
    // is the independent `norm(vec) === 0` short-circuit in `search` — not
    // the relevance floor below, which is exercised on a real, non-zero
    // vector instead.
    const zeroQuery = embed(model, "zzyzx plugh");
    expect(index.search(zeroQuery, 5)).toEqual([]);
  });

  test("a genuinely orthogonal (zero-similarity) document does not qualify either", () => {
    const index = new VectorIndex(2);
    index.add("n_1", embed(model, "menu lateral"));
    // "select2" is orthogonal to "menu"/"lateral" in the tiny vocabulary
    // (cosine 0 exactly) — a real, non-zero query vector, but with nothing
    // in common with the only document in the index.
    expect(index.search(embed(model, "select2"), 5)).toEqual([]);
  });

  test("genuine semantic signal still returns its hit — the floor must not refuse everything", () => {
    const index = new VectorIndex(2);
    index.add("n_1", embed(model, "select2 hidden"));
    index.add("n_2", embed(model, "menu lateral"));
    // "lateral" alone shares a real, positive-cosine direction with n_2.
    const hits = index.search(embed(model, "lateral"), 5);
    expect(hits.map((h) => h.id)).toEqual(["n_2"]);
  });

  /**
   * The review's exact finding, reproduced with a real, non-zero query
   * vector rather than the zero-vector short-circuit above: "kubernetes" and
   * "helm" are both planted in the tiny vocabulary pointing the same biased
   * direction (`[1, 1]`) — simulating the anisotropy a real dense embedding
   * table has, where arbitrary unrelated text lands at high positive cosine.
   * The query shares no real topic with any of the four documents, but ties
   * every one of them at cosine 1/√2 ≈ 0.707 — the exact "everything looks
   * similar" signature `MIN_SIMILARITY = 0` used to let straight through.
   * Four documents, not two: below `MIN_CANDIDATES_FOR_FLOOR` the relative
   * floor does not engage at all, so this needs the corpus large enough to
   * arm it.
   */
  test("an anisotropic tie across the whole corpus does not qualify — the floor, not the zero-vector short-circuit", () => {
    const index = new VectorIndex(2);
    index.add("n_1", embed(model, "select2 hidden"));
    index.add("n_2", embed(model, "menu lateral"));
    index.add("n_3", embed(model, "select2"));
    index.add("n_4", embed(model, "lateral"));

    const query = embed(model, "kubernetes helm");
    // Guard: if this were the zero vector, the assertion below would be
    // proving the short-circuit again, not the floor — the exact mistake
    // the review found in this file before the fixture was made dense.
    expect(Array.from(query).some((x) => x !== 0)).toBe(true);
    expect(index.search(query, 5)).toEqual([]);
  });

  test("a genuine standout still clears the floor, even inside the same anisotropic-tied corpus", () => {
    const index = new VectorIndex(2);
    index.add("n_1", embed(model, "select2 hidden"));
    index.add("n_2", embed(model, "menu lateral"));
    index.add("n_3", embed(model, "select2"));
    // Shares the query's own tokens, not just their shared bias — a real
    // match, not table geometry.
    index.add("n_4", embed(model, "helm chart guide"));

    const hits = index.search(embed(model, "kubernetes helm"), 5);
    expect(hits.map((h) => h.id)).toEqual(["n_4"]);
  });
});

describe("the relative floor's own arithmetic — aboveRelevanceFloor on plain numbers", () => {
  test("below the gate (fewer than 4 candidates), only the absolute rule applies: a genuinely positive score always qualifies", () => {
    expect(aboveRelevanceFloor([0, 1])).toEqual([false, true]);
    expect(aboveRelevanceFloor([0.9, 0.91, 0.92])).toEqual([true, true, true]);
  });

  test("a tie across every candidate — the anisotropic signature — qualifies none of them", () => {
    expect(aboveRelevanceFloor([0.7, 0.7, 0.7, 0.7])).toEqual([false, false, false, false]);
  });

  test("a genuine standout clears the floor even though it also drags the mean up", () => {
    // A single, whole-population mean+2σ over these four values would
    // exclude 0.95 too (mean 0.275, sd ≈0.39, floor ≈1.05) — the masking
    // failure leave-one-out exists to avoid: a candidate is judged against
    // its peers, never against a distribution its own value has polluted.
    expect(aboveRelevanceFloor([0.05, 0.05, 0.05, 0.95])).toEqual([false, false, false, true]);
  });

  test("zero or negative never qualifies, however it compares to its peers", () => {
    expect(aboveRelevanceFloor([0, -0.5, -0.5, -0.5])).toEqual([false, false, false, false]);
  });
});

describe("fusion never resurrects a document neither channel qualified", () => {
  test("both channels empty means the fused result is empty", () => {
    expect(fuse([], [], 5)).toEqual([]);
  });
});
