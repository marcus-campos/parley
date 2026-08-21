// tests/brain/lexical.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { LexicalIndex } from "../../src/brain/lexical";

let index: LexicalIndex;
beforeEach(() => {
  index = new LexicalIndex();
  index.add("n_1", "note", "A armadilha do select2 um for apontando pra elemento escondido pode nao abrir o componente");
  index.add("n_2", "note", "DIVIDA CONHECIDA menu lateral do dashboard tem 37px de alvo em tablet deitado");
  index.add("n_3", "decision", "Mapa de URLs reais do yzilab-front por que /setting/reference da 404");
  index.add("n_4", "note", "templates/pages/app/screen_builder.html tem labels sem for");
});

describe("the lexical floor", () => {
  test("an identifier query finds the note that carries it", () => {
    expect(index.search("select2", 3)[0]!.id).toBe("n_1");
  });

  test("a filename query finds it, whole or in parts", () => {
    expect(index.search("screen_builder.html", 3)[0]!.id).toBe("n_4");
    expect(index.search("screen builder", 3)[0]!.id).toBe("n_4");
  });

  test("a route query finds the decision", () => {
    expect(index.search("/setting/reference", 3)[0]!.id).toBe("n_3");
  });

  test("Portuguese prose is retrieved as well as identifiers", () => {
    expect(index.search("menu lateral tablet", 3)[0]!.id).toBe("n_2");
  });

  test("results are ranked, and k is respected", () => {
    const hits = index.search("for", 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  test("a query matching nothing returns nothing, not the least-bad note", () => {
    expect(index.search("kubernetes helm chart", 3)).toEqual([]);
  });

  test("the same query on the same corpus always returns the same order", () => {
    const a = index.search("for", 4).map((h) => h.id);
    const b = index.search("for", 4).map((h) => h.id);
    expect(a).toEqual(b);
  });

  test("removing a document removes it from results", () => {
    index.remove("n_1");
    expect(index.search("select2", 3)).toEqual([]);
    expect(index.size).toBe(3);
  });

  // "do" sits in n_1, n_2 and n_3 — 3 of these 4 documents, a majority. IDF
  // never zeroes it out, so without a threshold it would still rank a note
  // above nothing; the score threshold exists precisely to stop that.
  test("a query matching only a term present in a majority of the corpus returns nothing", () => {
    expect(index.search("do", 3)).toEqual([]);
  });

  // "select2" sits in exactly 1 of 4 documents — distinctive by any reading
  // of the rule. Paired with the test above so the threshold can't pass by
  // rejecting every query.
  test("a query with a genuinely distinctive term still returns its hit", () => {
    expect(index.search("select2", 3)[0]!.id).toBe("n_1");
  });
});
