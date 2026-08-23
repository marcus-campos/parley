import { describe, expect, test } from "bun:test";
import { aboveRelevanceFloor, debias, embed, fuse, isLoadable, VectorIndex } from "../../src/brain/embed";
import { calibrate } from "../../src/brain/calibrate";
import { FIXTURE_MODEL, TOPICS } from "./fixtures/model";

const model = FIXTURE_MODEL;
const calibration = calibrate(model);
if (!calibration) throw new Error("the fixture model must calibrate — every floor test below depends on it");
const { mean, floor } = calibration;

/** Exactly what the daemon does to text before it ever compares it (`vectorFor`, server.ts). */
const vec = (text: string) => debias(embed(model, text), mean);

function indexOf(docs: Record<string, string>): VectorIndex {
  const index = new VectorIndex(model.dims, floor);
  for (const [id, text] of Object.entries(docs)) index.add(id, vec(text));
  return index;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// The corpus every floor test below shares: notes about four unrelated things,
// written the way this repository's notes are actually written — Portuguese
// prose around English identifiers.
const SIDEBAR_PT = "o menu lateral oculto do painel";
const K8S = "rollout do pod no namespace do cluster";
const DB = "a migration do schema no postgres com rollback";
const HTTP = "o gateway devolveu timeout no socket da requisicao";

describe("static embeddings", () => {
  test("the same text always gives the same vector, bit for bit", () => {
    expect(Array.from(embed(model, "menu lateral"))).toEqual(Array.from(embed(model, "menu lateral")));
  });

  test("it is a lookup and a mean, so it is assertable", () => {
    // Accumulated token by token, exactly the way `embed` accumulates: a
    // Float32Array rounds on every store, so summing in one step instead of
    // two gives a different last bit.
    const expected = new Float32Array(model.dims);
    for (const token of ["menu", "lateral"]) {
      for (let i = 0; i < model.dims; i++) expected[i]! += model.vocab[token]![i]!;
    }
    for (let i = 0; i < model.dims; i++) expected[i]! /= 2;
    expect(Array.from(embed(model, "menu lateral"))).toEqual(Array.from(expected));
  });

  test("an unknown token contributes nothing rather than poisoning the vector", () => {
    expect(Array.from(embed(model, "menu zzyzx"))).toEqual(Array.from(embed(model, "menu")));
  });

  test("text with no known token gives a zero vector, and never a NaN", () => {
    expect(Array.from(embed(model, "zzyzx plugh")).every((x) => x === 0)).toBe(true);
  });

  test("debiasing leaves the zero vector alone — nothing to compare stays nothing to compare", () => {
    // Without this, text with no known token would debias to `-mean`, a real
    // direction pointing nowhere, and every document would be scored against
    // it. Silence is the honest answer, and this is what keeps it silent.
    expect(Array.from(debias(embed(model, "zzyzx plugh"), mean)).every((x) => x === 0)).toBe(true);
  });

  test("debiasing a real vector actually moves it — the mean is not zero", () => {
    const raw = embed(model, "menu lateral");
    expect(Array.from(debias(raw, mean))).not.toEqual(Array.from(raw));
  });

  test("nearest neighbours come back in order", () => {
    const index = indexOf({ n_1: SIDEBAR_PT, n_2: K8S });
    expect(index.search(vec("hidden sidebar"), 1)[0]!.id).toBe("n_1");
  });

  test("fusion puts a document both rankings agree on above one only a single ranking found", () => {
    const lex = [{ id: "a", score: 3, kind: "note" as const }, { id: "b", score: 2, kind: "note" as const }];
    const vecHits = [{ id: "b", score: 0.9, kind: "note" as const }, { id: "c", score: 0.8, kind: "note" as const }];
    expect(fuse(lex, vecHits, 3)[0]!.id).toBe("b");
  });

  test("fusion never invents a document neither ranking returned", () => {
    expect(fuse([{ id: "a", score: 1, kind: "note" }], [], 5).map((h) => h.id)).toEqual(["a"]);
  });
});

/**
 * The fixture's own credentials.
 *
 * The fixture this replaced was six words in two dimensions with every vector
 * exactly `[1,0]` or `[0,1]` — bit-exact cosine ties everywhere. Against a
 * spread of exactly zero, a constant that multiplies the spread cannot change
 * anything, which is how the previous floor passed its whole suite at
 * `FLOOR_Z = 0.001` and again at `FLOOR_Z = 50`. These tests exist so that
 * can never be true silently again: if somebody flattens this fixture, these
 * fail first and say why.
 */
describe("the fixture is a model, not a shape that cannot fail", () => {
  const crossTopic: number[] = [];
  const groups = Object.values(TOPICS);
  for (let a = 0; a < groups.length; a++) {
    for (let b = a + 1; b < groups.length; b++) {
      for (const x of groups[a]!) for (const y of groups[b]!) {
        crossTopic.push(cosine(Float32Array.from(model.vocab[x]!), Float32Array.from(model.vocab[y]!)));
      }
    }
  }

  test("it is anisotropic: two words about nothing in common still land at a high positive cosine", () => {
    expect(Math.min(...crossTopic)).toBeGreaterThan(0.6);
    expect(Math.max(...crossTopic)).toBeLessThan(0.98);
  });

  test("and no two of those cosines are equal — nothing here can cancel by accident", () => {
    expect(new Set(crossTopic.map((x) => x.toFixed(12))).size).toBe(crossTopic.length);
  });

  test("it has enough vocabulary for a null distribution to be measured over it", () => {
    expect(calibration.samples).toBeGreaterThanOrEqual(32);
  });
});

/**
 * The floor, in both directions, on a model-shaped table.
 *
 * Every score named in a comment here was measured against this fixture and
 * is quoted so a reader can see how much room each assertion actually has.
 * The floor for this table is ~0.384.
 */
describe("an absolute relevance floor, measured from the model's own null distribution", () => {
  test("a query about nothing in this corpus returns nothing, not the least-bad note", () => {
    const index = indexOf({ n_1: SIDEBAR_PT, n_2: DB, n_3: HTTP, n_4: "w0x0 w3x5 w6x10", n_5: "w19x7 w22x12 w26x1" });
    expect(index.search(vec("kubectl ingress replica"), 5).map((h) => h.id)).toEqual([]);
  });

  test("ten notes crowded at the table's own bias qualify none of them", () => {
    // The signature of an anisotropic table: every raw cosine here is high and
    // positive, and before this floor every one of these came back.
    const docs: Record<string, string> = {};
    for (let i = 0; i < 10; i++) docs[`n_${i}`] = `w${i}x1 w${i + 20}x4 w${i + 40}x7`;
    const index = indexOf(docs);
    const raw = index.search(vec("hidden sidebar"), 10);
    expect(raw.map((h) => h.id)).toEqual([]);
  });

  /**
   * The downward constraint on `FLOOR_SIGMAS`. This note shares no token and
   * no topic with the query, and is the highest-scoring such note found in
   * 60,000 random draws against this fixture: cosine 0.3421, against a floor
   * of 0.3841. Drop the constant by a single sigma (floor 0.2799) and this
   * junk comes back as a match.
   */
  test("the closest unrelated note in the whole table is still not close enough", () => {
    const index = indexOf({ n_1: "w20x15 w39x6 w10x3 w41x5" });
    expect(index.search(vec("hidden sidebar"), 5).map((h) => h.id)).toEqual([]);
  });

  test("a Portuguese note is found by an English query sharing no token with it", () => {
    // cosine 0.7356. This is the entire reason the brain exists: the lexical
    // channel has no term overlap here to fall back on.
    const index = indexOf({ n_1: SIDEBAR_PT, n_2: K8S, n_3: DB, n_4: HTTP });
    expect(index.search(vec("hidden sidebar"), 5).map((h) => h.id)).toEqual(["n_1"]);
  });

  /**
   * The upward constraint on `FLOOR_SIGMAS`. Two relevant words diluted among
   * eight irrelevant ones: cosine 0.4801, against a floor of 0.3841. Raise the
   * constant by a single sigma (floor 0.4883) and this genuine match is
   * silently dropped.
   */
  test("a genuine match diluted by a long note still clears the floor", () => {
    const index = indexOf({ n_1: "o painel oculto do gateway com timeout no cluster e no namespace" });
    expect(index.search(vec("hidden sidebar"), 5).map((h) => h.id)).toEqual(["n_1"]);
  });

  /**
   * The previous floor's worst failure, pinned so it cannot return. A z-score
   * asks "is this score unusual among the others?", so two identical perfect
   * matches mask each other and BOTH are rejected — cosine 1.0, an identical
   * embedding, thrown away. An absolute floor judges each candidate alone.
   */
  test("two identical notes both come back — neither masks the other", () => {
    const index = indexOf({ n_1: SIDEBAR_PT, n_2: SIDEBAR_PT, n_3: K8S, n_4: DB });
    expect(index.search(vec("hidden sidebar"), 5).map((h) => h.id).sort()).toEqual(["n_1", "n_2"]);
  });

  test("three genuine matches among ten notes return all three, not none", () => {
    const docs: Record<string, string> = {
      n_1: SIDEBAR_PT, n_2: "a barra lateral colapsada", n_3: "o drawer oculto do painel",
      n_4: K8S, n_5: DB, n_6: HTTP,
    };
    for (let i = 0; i < 4; i++) docs[`n_${7 + i}`] = `w${i * 5}x2 w${i * 5 + 30}x9`;
    const index = indexOf(docs);
    expect(index.search(vec("hidden sidebar"), 10).map((h) => h.id).sort()).toEqual(["n_1", "n_2", "n_3"]);
  });

  test("a query with no known token at all — the zero vector — matches nothing, not everything", () => {
    const index = indexOf({ n_1: SIDEBAR_PT, n_2: K8S });
    expect(index.search(vec("zzyzx plugh"), 5)).toEqual([]);
  });
});

/**
 * The floor's arithmetic, on plain numbers, with no cosine geometry in the
 * way. Every test here is a property the previous, relative floor did not
 * have.
 */
describe("aboveRelevanceFloor is absolute — a candidate is judged alone", () => {
  test("a perfect score always qualifies, however many other perfect scores there are", () => {
    expect(aboveRelevanceFloor([1, 1, 0, 0], 0.5)).toEqual([true, true, false, false]);
  });

  test("the same score gets the same verdict whether it stands alone or in a crowd", () => {
    const alone = aboveRelevanceFloor([0.9], 0.5);
    const crowd = aboveRelevanceFloor([0.9, 0.91, 0.92, 0.93, 0.94, 0.95], 0.5);
    expect(alone[0]).toBe(true);
    expect(crowd[0]).toBe(true);
  });

  test("one candidate and forty candidates are the same rule — there is no gate below which it stops applying", () => {
    // The previous floor did not engage below four candidates and fell back to
    // `score > 0` — which is the original bug, verbatim, for every small corpus.
    expect(aboveRelevanceFloor([0.2], 0.5)).toEqual([false]);
    expect(aboveRelevanceFloor([0.2, 0.2, 0.2], 0.5)).toEqual([false, false, false]);
  });

  test("a tie qualifies all of them or none of them, on its own merit", () => {
    expect(aboveRelevanceFloor([0.7, 0.7, 0.7, 0.7], 0.5)).toEqual([true, true, true, true]);
    expect(aboveRelevanceFloor([0.7, 0.7, 0.7, 0.7], 0.8)).toEqual([false, false, false, false]);
  });

  test("zero and negative never qualify, because a valid floor is always positive", () => {
    expect(aboveRelevanceFloor([0, -0.5, -1], 0.3)).toEqual([false, false, false]);
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

describe("fusion never resurrects a document neither channel qualified", () => {
  test("both channels empty means the fused result is empty", () => {
    expect(fuse([], [], 5)).toEqual([]);
  });
});
