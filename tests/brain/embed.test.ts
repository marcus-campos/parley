import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embed, fuse, isLoadable, VectorIndex } from "../../src/brain/embed";

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
    expect(Array.from(embed(model, "select2 kubernetes"))).toEqual([1, 0]);
  });

  test("text with no known token gives a zero vector, and never a NaN", () => {
    const v = embed(model, "kubernetes helm");
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
    // "kubernetes helm" shares no token with the tiny vocabulary, so it
    // embeds to the zero vector (proved in the embeddings describe block
    // above). Reproduces the review's exact finding: without this guard,
    // every document ties at `cosine(zero, x) === 0` and comes back ranked.
    const zeroQuery = embed(model, "kubernetes helm");
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
});

describe("fusion never resurrects a document neither channel qualified", () => {
  test("both channels empty means the fused result is empty", () => {
    expect(fuse([], [], 5)).toEqual([]);
  });
});
