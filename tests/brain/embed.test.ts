import { describe, expect, test } from "bun:test";
import { aboveRelevanceFloor, debias, embed, fuse, isLoadable, VectorIndex } from "../../src/brain/embed";
import { calibrate, SEED } from "../../src/brain/calibrate";
import { FILLER_TOPICS, FILLER_WORDS_PER_TOPIC, FIXTURE_MODEL, TOPICS, buildFixtureModel, fillerWord } from "./fixtures/model";
import type { StaticModel } from "../../src/brain/embed";

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

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const NAMED_WORDS = Object.values(TOPICS).flat();
const TOPIC_NAMES = Object.keys(TOPICS);

/**
 * A hundred thousand notes about nothing any query is about: three to six
 * words, each from a different filler topic, scored against a two-word query
 * of named vocabulary that shares no token with any of them.
 *
 * The query varies note by note. A single fixed query makes its own
 * idiosyncratic half a constant shared by all hundred thousand scores, which
 * is a hidden common factor in what is supposed to be a rate.
 *
 * Measured both ways once: notes coherent within one filler topic score the
 * same as these incoherent ones, so the incoherent shape is not flattering
 * itself.
 */
function junkCorpus(m: StaticModel, mean: Float32Array, count = 100_000): number[] {
  const v = (text: string) => debias(embed(m, text), mean);
  const next = rng(0x1234567);
  const scores: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = NAMED_WORDS[Math.floor(next() * NAMED_WORDS.length)]!;
    let b = NAMED_WORDS[Math.floor(next() * NAMED_WORDS.length)]!;
    while (b === a) b = NAMED_WORDS[Math.floor(next() * NAMED_WORDS.length)]!;
    const length = 3 + Math.floor(next() * 4);
    const topics = new Set<number>();
    const words: string[] = [];
    while (words.length < length) {
      const topic = Math.floor(next() * FILLER_TOPICS);
      if (topics.has(topic)) continue;
      topics.add(topic);
      words.push(fillerWord(topic, Math.floor(next() * FILLER_WORDS_PER_TOPIC)));
    }
    scores.push(cosine(v(`${a} ${b}`), v(words.join(" "))));
  }
  return scores;
}

/**
 * Two thousand genuine matches, diluted the way a real long note dilutes one:
 * two words from the query's own topic — never the query's own tokens, so the
 * lexical channel would find none of these — buried under eight to fourteen
 * words drawn from the filler topics. This is deliberately the regime where
 * the floor decides: undiluted matches clear every floor between 3σ and 5σ
 * and prove nothing about the constant.
 *
 * The dilution comes from many independent topics rather than from three
 * named ones, and that is the difference between measuring the floor and
 * measuring one accident of the fixture's geometry — the header above the
 * rate tests carries the numbers.
 */
function genuineCorpus(m: StaticModel, mean: Float32Array): number[] {
  const v = (text: string) => debias(embed(m, text), mean);
  const next = rng(0x7654321);
  const scores: number[] = [];
  for (let i = 0; i < 2_000; i++) {
    const pool = TOPICS[TOPIC_NAMES[Math.floor(next() * TOPIC_NAMES.length)]!]!;
    // Two for the query and two for the note, all four distinct: the note
    // never repeats a token the query used.
    const picked: string[] = [];
    const used = new Set<string>();
    while (picked.length < 4) {
      const w = pool[Math.floor(next() * pool.length)]!;
      if (used.has(w)) continue;
      used.add(w);
      picked.push(w);
    }
    const words = picked.slice(2);
    const seen = new Set<string>();
    const dilution = 8 + Math.floor(next() * 7);
    while (words.length < 2 + dilution) {
      const w = fillerWord(Math.floor(next() * FILLER_TOPICS), Math.floor(next() * FILLER_WORDS_PER_TOPIC));
      if (seen.has(w)) continue;
      seen.add(w);
      words.push(w);
    }
    scores.push(cosine(v(picked.slice(0, 2).join(" ")), v(words.join(" "))));
  }
  return scores;
}

const unrelated = junkCorpus(model, mean);
const dilutedGenuine = genuineCorpus(model, mean);

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

  test("it has far more vocabulary than the gate a real model has to clear", () => {
    // `slices` is the vocabulary fact — how many 24-token slices the table can
    // lay out without repeating a word — and it is what `MIN_PAIRS = 256`
    // gates on. `samples` is how many pairs were actually drawn, which is a
    // constant. A fixture near the gate would carry more estimation noise in
    // its floor than a real model does; this one carries less.
    expect(calibration.slices).toBeGreaterThan(500);
    expect(calibration.samples).toBe(4096);
  });
});

/**
 * The floor, in both directions, on a model-shaped table.
 *
 * Every score named in a comment here was measured against this fixture and
 * is quoted so a reader can see how much room each assertion actually has.
 * The floor for this table is 0.3620, from nullMean -0.0007 and nullSd 0.0907
 * over 4,096 pairs, so a one-sigma move in the constant lands at 0.2713 or
 * 0.4527.
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
 * stay in — is what an earlier round had, and a hand-picked note is a fragile
 * thing to hang a constant on: regenerate the fixture and it stops being the
 * near-miss it was chosen for. So the same two constraints are asserted here
 * over corpora instead, thousands of notes at a time, generated
 * deterministically from the table's own vocabulary.
 *
 * Two things about how the corpora are built are load-bearing, and both were
 * wrong in the round before this one:
 *
 * - **The dilution is drawn from the filler topics, not from three named
 *   ones.** A long note that buries a match is about many things, and the
 *   average of many independent unrelated directions concentrates toward
 *   zero, while the average of three does not. Diluting from three topics
 *   made the recall rate a measurement of one accident — how those three
 *   directions happened to lean against the query's — rather than of the
 *   floor. Measured over twenty regenerated fixtures, that corpus put the
 *   count clearing the floor anywhere in 0..1185; drawing the dilution from
 *   the eight hundred filler topics instead puts it in 397..797.
 * - **The query varies.** Every note is scored against a different two-word
 *   query drawn from its own topic, so the query's own idiosyncratic half is
 *   averaged over the corpus instead of being a constant shared by all two
 *   thousand notes.
 *
 * Each bound below is checked in the seed sweeps that follow, over every
 * combination of twenty-four calibration seeds and six regenerated fixtures,
 * and each holds at `FLOOR_SIGMAS = 4` and breaks at 3 or at 5 across all of
 * them.
 */
describe("what the floor lets through, and what it holds back, as a rate", () => {
  const above = (scores: number[], bound: number) => scores.filter((s) => s > bound).length;

  test("two unrelated notes in a hundred thousand clear the floor — and one sigma lower, dozens do", () => {
    // Not "none": the debiased cosine's tail is heavier than a Gaussian's, so
    // 4σ is not the 1-in-31,000 the name suggests. Measured over 300,000
    // pairs on this table it is 1 in 16,000, and at 5σ 1 in 330,000 against a
    // Gaussian's 1 in 3,000,000. The floor is a boundary on a real
    // distribution, not a promise.
    //
    // 1 of 100,000 at the floor here. The second line is the downward
    // constraint and it does not rest on a note somebody went looking for:
    // one sigma lower the same corpus leaks 75, seventy-five times as much.
    expect(above(unrelated, floor)).toBeLessThanOrEqual(10);
    expect(above(unrelated, floor - calibration.nullSd)).toBeGreaterThanOrEqual(30);
  });

  /**
   * The upward constraint, as a band rather than a lower bound.
   *
   * 605 of 2,000 at 4σ. Both ends of the band are live: at 5σ the count falls
   * to 71 and the lower end fails, at 3σ it climbs to 1,489 and the upper end
   * fails. A floor that keeps this many diluted matches is a floor doing the
   * job; a floor that keeps almost all of them is not filtering, and one that
   * keeps almost none has stopped answering the paraphrase question the brain
   * exists for.
   */
  test("the floor keeps a real share of diluted genuine matches — neither almost all nor almost none", () => {
    expect(above(dilutedGenuine, floor)).toBeGreaterThanOrEqual(250);
    expect(above(dilutedGenuine, floor)).toBeLessThanOrEqual(1000);
  });

  /**
   * The same constraint said as a location instead of a tail count, because a
   * tail count is a high-gain statistic and a location is not.
   *
   * This is the assertion that survives regenerating the fixture. Across
   * twenty regenerated tables the count clearing the floor moves by a factor
   * of two while the median moves 0.37σ, and it is the median that says where
   * the floor actually sits relative to the matches it is judging: between the
   * median diluted match and one sigma above it. At 3σ the floor falls below
   * that median, at 5σ more than a sigma above it.
   */
  test("the floor lands within one sigma above the median diluted match, on the near side of it", () => {
    const median = dilutedGenuine.slice().sort((a, b) => a - b)[dilutedGenuine.length / 2]!;
    expect(median).toBeLessThanOrEqual(floor);
    expect(median).toBeGreaterThan(floor - calibration.nullSd);
  });

  /**
   * The calibration seed is the second free constant in `calibrate.ts`, and
   * the round before this one left it with more leverage than the box it was
   * supposed to sit inside: over a 1,500-seed sweep the floor reached
   * [3.62σ, 4.49σ], 0.87σ of travel against a green region 0.55σ wide, and
   * 100 of those 1,500 seeds broke one of the bounds asserted here. The
   * report of that round claimed the bounds held over the sweep. They did not.
   *
   * The fix was to stop the estimate being that noisy rather than to widen
   * the claim around it — `SAMPLES` in `calibrate.ts` carries the
   * measurement. The same 1,500-seed sweep now reaches [3.80σ, 4.14σ], and
   * every one of the 1,500 holds every bound. The two seeds below marked as
   * extremes are that sweep's own minimum and maximum, asserted by name so
   * this is a measurement rather than a hope.
   */
  test("the floor is a property of the model, not of the seed that shuffled its vocabulary", () => {
    const seeds = [
      SEED, 313 /* the 1,500-seed sweep's lowest floor */, 240 /* and its highest */,
      1, 2, 3, 6, 7, 11, 13, 24, 35, 47, 50, 74, 95, 138, 427, 436,
      12345, 999983, 0xdeadbeef, 0xcafebabe, 0x5eed1234,
    ];
    for (const seed of seeds) {
      const reshuffled = calibrate(model, seed);
      expect(reshuffled).not.toBeNull();
      const { floor: f, nullMean: nm, nullSd: sd } = reshuffled!;
      // The band the sweep actually reaches, asserted rather than described.
      expect((f - nm) / sd).toBeCloseTo(4, 10);
      expect(f).toBeGreaterThan(0.34);
      expect(f).toBeLessThan(0.38);
      expect(above(unrelated, f)).toBeLessThanOrEqual(10);
      expect(above(unrelated, f - sd)).toBeGreaterThanOrEqual(30);
      expect(above(dilutedGenuine, f)).toBeGreaterThanOrEqual(250);
      expect(above(dilutedGenuine, f)).toBeLessThanOrEqual(1000);
    }
  });
});

/**
 * The fixture seed, which is the axis the round before this one left open.
 *
 * `buildFixtureModel(0x5eed1234)` is one draw of eight hundred and four topic
 * directions in 128 dimensions, and on the corpora that round shipped, the
 * upward bound held at that draw and at essentially no other: rebuilt at
 * twenty seeds the count clearing the floor was 1185 at the shipped one and
 * 0, 356, 2, 1, 726, 0, 38, 1, 34, 20, 0, 5, 33 ... at the rest. The shipped
 * seed was the maximum of its own distribution on exactly the statistic the
 * bound needed — so the next person to regenerate the fixture would have found
 * the recall test red, and the cheapest way to green it would have been to
 * lower `FLOOR_SIGMAS`. The fixture pointed at the wrong repair.
 *
 * It no longer does, and this test is what says so. The corpora above changed
 * shape (the dilution is drawn from many topics, the query varies), and on
 * the corpora as they now stand every bound holds at every regenerated
 * fixture, with the same margins. A fixture regenerated at a new seed does
 * not turn the floor red; if some future change to the fixture does, this
 * test is where it goes red, and it names the fixture rather than the
 * constant.
 */
describe("the floor's bounds survive regenerating the fixture itself", () => {
  const above = (scores: number[], bound: number) => scores.filter((s) => s > bound).length;

  test.each([1, 2, 3, 4, 5, 6])("a fixture rebuilt at seed %i holds every bound", (fixtureSeed) => {
    const rebuilt = buildFixtureModel(fixtureSeed);
    const c = calibrate(rebuilt);
    expect(c).not.toBeNull();
    const { floor: f, nullSd: sd } = c!;
    // A quarter of the hundred thousand the shipped fixture is measured over:
    // this test pays for six tables, and the bounds below are the same rates
    // at a quarter of the count. Verified at 3σ, 4σ and 5σ over six fixtures
    // and eight calibration seeds — green only at four, on both bounds.
    const junk = junkCorpus(rebuilt, c!.mean, 25_000);
    const genuine = genuineCorpus(rebuilt, c!.mean);
    const median = genuine.slice().sort((a, b) => a - b)[genuine.length / 2]!;

    expect(above(junk, f)).toBeLessThanOrEqual(3);
    expect(above(junk, f - sd)).toBeGreaterThanOrEqual(10);
    expect(above(genuine, f)).toBeGreaterThanOrEqual(250);
    expect(above(genuine, f)).toBeLessThanOrEqual(1000);
    expect(median).toBeLessThanOrEqual(f);
    expect(median).toBeGreaterThan(f - sd);
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
