import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embed, fuse, VectorIndex } from "../../src/brain/embed";

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
