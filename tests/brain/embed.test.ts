import { describe, expect, test } from "bun:test";
import { aboveRelevanceFloor, debias, embed, fuse, isLoadable, VectorIndex } from "../../src/brain/embed";
import { calibrate, SEED } from "../../src/brain/calibrate";
import { FILLER_TOPICS, FILLER_WORDS_PER_TOPIC, FIXTURE_MODEL, TOPICS, fillerWord } from "./fixtures/model";

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

  test("it has enough vocabulary for the null to be measured over as many slices as a real model gets", () => {
    // 512 is `MAX_PAIRS`: the cap every production-sized table reaches. A
    // fixture that calibrates over fewer pairs than a real model carries more
    // estimation noise in its floor than production does, which is how the
    // shuffle seed came to have as much leverage over the floor as
    // `FLOOR_SIGMAS` — see the seed test below for what that costs.
    expect(calibration.samples).toBe(512);
  });
});

/**
 * The floor, in both directions, on a model-shaped table.
 *
 * Every score named in a comment here was measured against this fixture and
 * is quoted so a reader can see how much room each assertion actually has.
 * The floor for this table is 0.3561, from nullMean -0.0051 and nullSd 0.0903
 * over 512 pairs, so a one-sigma move in the constant lands at 0.2658 or
 * 0.4464.
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

  test("a Portuguese note is found by an English query sharing no token with it", () => {
    // cosine 0.7425. This is the entire reason the brain exists: the lexical
    // channel has no term overlap here to fall back on.
    const index = indexOf({ n_1: SIDEBAR_PT, n_2: K8S, n_3: DB, n_4: HTTP });
    expect(index.search(vec("hidden sidebar"), 5).map((h) => h.id)).toEqual(["n_1"]);
  });

  /**
   * One readable case of the upward constraint on `FLOOR_SIGMAS`; the rate
   * over two thousand such notes is asserted further down, which is where the
   * real evidence is. Two relevant words diluted among nine irrelevant ones:
   * cosine 0.4334, against a floor of 0.3561. Raise the constant by a single
   * sigma (floor 0.4464) and this genuine match is silently dropped — and it
   * stays above the floor for every calibration seed tried (highest 0.3738),
   * so it is the constant it constrains and not the shuffle.
   */
  test("a genuine match diluted by a long note still clears the floor", () => {
    const note = "a barra lateral sumiu depois da migration do schema no postgres com rollback no commit e timeout no gateway";
    const index = indexOf({ n_1: note });
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
 * The floor's evidence, as the rate it actually is.
 *
 * Two hand-picked notes — one junk that must stay out, one genuine that must
 * stay in — is what the previous round had, and a hand-picked note is a
 * fragile thing to hang a constant on: regenerate the fixture and it stops
 * being the near-miss it was chosen for. So the same two constraints are
 * asserted here over corpora instead, thousands of notes at a time, generated
 * deterministically from the table's own filler vocabulary.
 *
 * Each direction pins `FLOOR_SIGMAS` at plus or minus one sigma **on its
 * own**, because each test asserts both a bound at the floor and a bound one
 * sigma away from it:
 *
 * - drop the constant to 3 and the junk rate at the floor multiplies by 45;
 * - raise it to 5 and the recall rate at the floor collapses by 17.
 */
describe("what the floor lets through, and what it holds back, as a rate", () => {
  function rng(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  const query = vec("hidden sidebar");
  const scoreOf = (text: string) => cosine(query, vec(text));

  /**
   * Notes about nothing the query is about: three to six words, each from a
   * different filler topic, none of them a word the query knows. Measured
   * both ways — notes coherent within one filler topic score the same (94 of
   * 100,000 above the 3σ boundary against these 90), so the incoherent shape
   * is not flattering itself.
   */
  const unrelated = (() => {
    const next = rng(0x1234567);
    const scores: number[] = [];
    for (let i = 0; i < 100_000; i++) {
      const length = 3 + Math.floor(next() * 4);
      const topics = new Set<number>();
      const words: string[] = [];
      while (words.length < length) {
        const topic = Math.floor(next() * FILLER_TOPICS);
        if (topics.has(topic)) continue;
        topics.add(topic);
        words.push(fillerWord(topic, Math.floor(next() * FILLER_WORDS_PER_TOPIC)));
      }
      scores.push(scoreOf(words.join(" ")));
    }
    return scores;
  })();

  /**
   * Genuine matches, diluted the way a real long note dilutes one: two words
   * from the query's own topic — never the query's own tokens, so the lexical
   * channel would find none of these — buried under eight to fourteen words
   * from three other topics. This is deliberately the regime where the floor
   * decides: undiluted matches clear every floor between 3σ and 5σ and prove
   * nothing about the constant.
   */
  const dilutedGenuine = (() => {
    const next = rng(0x7654321);
    const topical = TOPICS.sidebar!.filter((w) => w !== "hidden" && w !== "sidebar");
    const others = [...TOPICS.kubernetes!, ...TOPICS.database!, ...TOPICS.http!];
    const scores: number[] = [];
    for (let i = 0; i < 2_000; i++) {
      const first = topical[Math.floor(next() * topical.length)]!;
      let second = topical[Math.floor(next() * topical.length)]!;
      while (second === first) second = topical[Math.floor(next() * topical.length)]!;
      const words = [first, second];
      const used = new Set<string>();
      const dilution = 8 + Math.floor(next() * 7);
      while (words.length < 2 + dilution) {
        const word = others[Math.floor(next() * others.length)]!;
        if (used.has(word)) continue;
        used.add(word);
        words.push(word);
      }
      scores.push(scoreOf(words.join(" ")));
    }
    return scores;
  })();

  const above = (scores: number[], bound: number) => scores.filter((s) => s > bound).length;

  test("two unrelated notes in a hundred thousand clear the floor — and one sigma lower, ninety do", () => {
    // Not "none": the debiased cosine's tail is heavier than a Gaussian's, so
    // 4σ is not the 1-in-31,000 the name suggests. Measured over 300,000
    // pairs on this table it is 1 in 16,000, and at 5σ 1 in 330,000 against a
    // Gaussian's 1 in 3,000,000. The floor is a boundary on a real
    // distribution, not a promise.
    expect(above(unrelated, floor)).toBeLessThanOrEqual(10);
    // ...and this is the downward constraint, no longer resting on one note
    // somebody went looking for: at 3σ the same corpus leaks 45 times as much.
    expect(above(unrelated, floor - calibration.nullSd)).toBeGreaterThanOrEqual(30);
  });

  test("most diluted genuine matches clear the floor — and one sigma higher, almost none do", () => {
    // 1185 of 2000 at 4σ; 70 of 2000 one sigma up. The upward constraint: at
    // 5σ this table stops answering the paraphrase question the brain exists
    // to answer.
    expect(above(dilutedGenuine, floor)).toBeGreaterThanOrEqual(800);
    expect(above(dilutedGenuine, floor + calibration.nullSd)).toBeLessThanOrEqual(300);
  });

  /**
   * The seed is the second free constant in `calibrate.ts`, and until this
   * test it had as much leverage over the floor as `FLOOR_SIGMAS` did: on the
   * thousand-row fixture this replaced, recalibrating under 300 shuffles put
   * the floor anywhere from 0.2696 to 0.5625 — below the 3σ floor to above
   * the 5σ floor — so a mutation table that read as a ±1σ box had a second
   * exit nobody was watching.
   *
   * A table big enough to reach `MAX_PAIRS` closes it. Over the seeds below
   * the floor moves between 0.3416 and 0.3738, 0.36 nullSd of travel, and
   * every verdict this suite depends on survives all of them.
   */
  test("the floor is a property of the model, not of the seed that shuffled its vocabulary", () => {
    const seeds = [SEED, 35, 47, 1, 2, 3, 7, 11, 13, 12345, 0xdeadbeef, 0xcafebabe, 0x5eed1234, 999983, 464367618, 271828182];
    for (const seed of seeds) {
      const reshuffled = calibrate(model, seed);
      expect(reshuffled).not.toBeNull();
      const { floor: f, nullSd: sd } = reshuffled!;
      expect(above(unrelated, f)).toBeLessThanOrEqual(10);
      expect(above(unrelated, f - sd)).toBeGreaterThanOrEqual(30);
      expect(above(dilutedGenuine, f)).toBeGreaterThanOrEqual(800);
      expect(above(dilutedGenuine, f + sd)).toBeLessThanOrEqual(300);
    }
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
