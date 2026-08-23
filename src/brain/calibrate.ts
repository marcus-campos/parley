import type { StaticModel } from "./embed";

/**
 * What a model has to hand over before it is allowed to filter anything.
 *
 * `mean` is the table's centre of mass — the one direction every row leans
 * on. Dense static embedding tables are anisotropic, which is a polite way of
 * saying that two texts about nothing in common still land at cosine 0.85 or
 * higher, because most of both vectors is that shared direction rather than
 * either text. Subtracting it is not a tuning trick: it is the difference
 * between a cosine that measures "how similar is this text" and one that
 * measures "how much of the table's own bias survived the mean-pooling."
 *
 * `floor` is the absolute cosine boundary, measured from THIS model's own
 * null distribution — what unrelated text actually scores against unrelated
 * text once `mean` is out of the way. It is a number about the model, not a
 * number about a query, so it does not care how many results came back or how
 * they compare to each other. Two identical documents both clear it; a corpus
 * of forty equally-irrelevant ones clears none of it.
 */
export interface Calibration {
  mean: Float32Array;
  floor: number;
  /** How many unrelated pairs the floor was measured over. Recorded so a reader can weigh it. */
  samples: number;
  /**
   * How many *disjoint* slices this vocabulary could supply — `samples` is how
   * many pairs were drawn, `slices` is how much independent vocabulary there
   * was to draw them from. They are different numbers for a good reason
   * (`SAMPLES` below), and the admission gate is this one, never that one.
   */
  slices: number;
  /**
   * The null distribution the floor came from, kept rather than discarded:
   * `floor` is `nullMean + FLOOR_SIGMAS * nullSd`, and a number nobody can
   * inspect is a number nobody can argue with. Two constants have already
   * been wrong here for exactly that reason.
   */
  nullMean: number;
  nullSd: number;
}

/**
 * The pseudo-documents the null is measured on: a few tokens on one side (a
 * query), a couple of dozen on the other (a note), pooled exactly the way
 * `embed` pools real text. Length matters enormously on the raw vectors — the
 * null cosine travels 5 to 12σ between the shortest and longest regimes,
 * measured — but after debiasing it is down to 0.07-0.35σ, which is the whole
 * reason the debias step exists and the reason one stored number can be
 * honest for every query. `debias` in embed.ts carries the table.
 */
const QUERY_TOKENS = 4;
const DOC_TOKENS = 20;
const TOKENS_PER_PAIR = QUERY_TOKENS + DOC_TOKENS;

/**
 * How much independent vocabulary a table must have before it is allowed a
 * floor at all. A table too small to reach `MIN_PAIRS` disjoint slices is a
 * toy, not a model: it does not get a guessed floor, it gets refused
 * (`null`), and the daemon degrades to the lexical floor and says so.
 *
 * 256 rather than a token handful, because a floor measured over a handful of
 * words is a floor decided by which words. Taking 400 independent samples of
 * K pairs from a pool of 300,000 unrelated pairs, estimating `mean + 4σ` from
 * each, and measuring what fraction of *fresh* unrelated pairs clears that
 * estimate:
 *
 * ```
 *   slices   floor sd   mean junk leak   worst-case junk leak
 *       33   0.54 nullSd        0.026%                 0.389%
 *       41   0.52 nullSd        0.028%                 1.338%
 *      128   0.28 nullSd        0.008%                 0.053%
 *      256   0.18 nullSd        0.007%                 0.032%
 * ```
 *
 * A model that just cleared a 33-slice gate could leak a hundred times what
 * the same floor leaks at 256, decided by nothing but which seed was compiled
 * in — with no refusal, no warning, and `brain enabled` reported honestly.
 *
 * Refusing is cheap here: refusal degrades to the lexical floor, which is the
 * behaviour this repository prefers over a confident guess anyway.
 */
const MIN_PAIRS = 256;

/**
 * How many pairs to actually measure, which is deliberately not the same
 * number as the slices available.
 *
 * The floor is `nullMean + 4 * nullSd`, so it is an estimate, and its own
 * noise is `3 * nullSd / sqrt(samples)` — the `sd` term carries a factor of
 * four and dominates. Drawing every pair from its own disjoint slice caps the
 * sample count at `vocabulary / 24`, and that cap is what used to leave the
 * shuffle seed with real leverage over the floor. Measured on the test
 * fixture by recalibrating one table under 300 different seeds:
 *
 * ```
 *   samples   range over 300 seeds   sd of the floor   one calibration
 *       512             0.72 nullSd       0.135 nullSd            2.7ms
 *      1024             0.52 nullSd       0.094 nullSd            5.5ms
 *      2048             0.40 nullSd       0.071 nullSd           11.1ms
 *      4096             0.32 nullSd       0.050 nullSd           23.1ms
 *      8192             0.24 nullSd       0.032 nullSd           46.6ms
 * ```
 *
 * So pairs are drawn from repeated shuffles instead: a token may appear in
 * more than one pair, but never on both sides of the same one. The half of
 * "disjoint" that makes a pair *unrelated* is kept exactly; the half that
 * made the samples mutually independent is spent, and what it buys is an
 * estimate four times less arbitrary. The samples are correlated, so the
 * error falls slower than `1/sqrt(n)` would promise — the table above is the
 * measured fall, not the theoretical one.
 *
 * It helps most exactly where it matters most. On a table sitting right on
 * the `MIN_PAIRS` gate — 6,144 rows, 256 slices — 4,096 samples put the floor
 * in a 0.285 nullSd band across 300 seeds, which is tighter than the old
 * disjoint scheme managed on a table with fifty times the vocabulary.
 *
 * 4,096 and not 8,192 because the estimate is already well inside the band
 * `FLOOR_SIGMAS` is pinned in and boot is not free.
 */
const SAMPLES = 4096;

/**
 * How far above the null a hit has to land. Measured, not picked: at 4σ the
 * junk rate over unrelated text was 0.00% in every query/document length
 * combination tried, while paraphrase recall — a genuine match sharing NO
 * token with the query, the case the lexical floor cannot help with — stayed
 * between 78% and 100% in five of six. At 3σ recall gains almost nothing and
 * junk reappears in up to 18% of fifty-note queries. See the floor-fix report
 * for the full table.
 *
 * "4σ" is a name, not a promise of one-in-31,000. The debiased cosine's tail
 * is heavier than a Gaussian's: over 300,000 unrelated pairs on a 128-
 * dimension table, 0.006% cleared the population's own 4σ boundary against a
 * Gaussian's 0.003%, and at 5σ 0.0003% against 0.00003%. What the floor
 * promises is a boundary measured on the distribution that actually exists,
 * which is the thing neither previous attempt had.
 *
 * Two things push the measurement toward silence rather than noise, which is
 * the direction this repository prefers. The pseudo-documents below are
 * *incoherent* — words drawn from across the vocabulary — while real notes
 * are coherent, and the incoherent null is the wider of the two (sd 0.0910
 * against 0.0880 on the test fixture, matched lengths), so the floor comes
 * out slightly high. And a pair that happens to be genuinely related raises
 * the measured null, which raises the floor too.
 */
const FLOOR_SIGMAS = 4;

/**
 * A fixed seed, so the same model file always calibrates to the same floor.
 * A floor that drifted between daemon restarts would silently change what a
 * repository can recall, which is worse than a floor that is merely
 * imperfect. `Math.random()` is banned under `src/state/` for exactly this
 * reason; nothing here needs it either.
 *
 * It is a parameter of `calibrate` and not only a hidden constant because it
 * is the second free number in this file, and a free number nobody can vary
 * is a free number nobody can measure the leverage of. Production never
 * passes it. The tests do, so that "this floor is a property of the model and
 * not of this seed" is an assertion rather than a hope — see `MIN_PAIRS`
 * above for what that leverage actually is, and the fix-round-2 report for
 * the measurement.
 */
export const SEED = 0x9e3779b9;

function xorshift32(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Fisher-Yates against a seeded generator: deterministic, and unrelated to the sorted order. */
function shuffled<T>(items: T[], next: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function meanRow(model: StaticModel): Float32Array {
  const out = new Float32Array(model.dims);
  const rows = Object.values(model.vocab);
  if (rows.length === 0) return out;
  for (const row of rows) for (let i = 0; i < model.dims; i++) out[i]! += row[i]!;
  for (let i = 0; i < model.dims; i++) out[i]! /= rows.length;
  return out;
}

/** Mean-pool a group of vocabulary rows and take the table's centre of mass out of it. */
function pooled(model: StaticModel, tokens: string[], mean: Float32Array): Float32Array {
  const out = new Float32Array(model.dims);
  for (const token of tokens) {
    const row = model.vocab[token]!;
    for (let i = 0; i < model.dims; i++) out[i]! += row[i]!;
  }
  for (let i = 0; i < model.dims; i++) out[i]! = out[i]! / tokens.length - mean[i]!;
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Measure what "unrelated" scores like on this particular table, and turn it
 * into one absolute boundary.
 *
 * The objection that sank a hand-picked constant was that there is no
 * deployed model to calibrate against. That is true while somebody is typing
 * the constant — and it stops being true the moment a model is actually
 * loaded, which is here. The samples are built from the model's own
 * vocabulary rather than from a probe corpus of real sentences: two
 * arbitrary distinct words ARE mutually unrelated, by construction, in every
 * language the table happens to cover, with no probe list to maintain and no
 * way for the probes to be missing from the vocabulary. The occasional pair
 * that happens to be related pulls the measured null slightly up, which
 * raises the floor slightly, which errs toward silence — the direction this
 * repository already prefers everywhere else.
 *
 * No token ever appears on both sides of one comparison, which is what makes
 * the pair unrelated by construction. Pairs are drawn from repeated shuffles
 * of the whole vocabulary rather than from one pass over it, so a token may
 * appear in more than one pair; `SAMPLES` carries the measurement of why that
 * trade is worth making. `null` — never a guess — whenever the table cannot
 * support the measurement: too little vocabulary to lay out `MIN_PAIRS`
 * disjoint slices, or a result that is not a usable boundary (not finite, at
 * or below zero, at or above one). A model that cannot say what unrelated
 * looks like has not earned the right to say what related looks like.
 */
export function calibrate(model: StaticModel, seed: number = SEED): Calibration | null {
  const mean = meanRow(model);

  // An all-zero row carries no signal and would pool into a degenerate
  // pseudo-document; it is part of the table's mean, but not part of its null.
  const usable = Object.keys(model.vocab).filter((token) => model.vocab[token]!.some((x) => x !== 0));
  const slices = Math.floor(usable.length / TOKENS_PER_PAIR);
  if (slices < MIN_PAIRS) return null;

  const next = xorshift32(seed);
  const sorted = usable.sort();

  // Walk the shuffled deck a slice at a time, and reshuffle when it runs out.
  // Within one pair the two sides never share a token, which is the half of
  // "disjoint" that makes the pair unrelated. Across pairs a token may recur,
  // which is the half spent to buy `SAMPLES` samples instead of `slices` of
  // them — see `SAMPLES` for what that costs and what it buys.
  const scores: number[] = [];
  let deck = shuffled(sorted, next);
  let cursor = 0;
  for (let p = 0; p < SAMPLES; p++) {
    if (cursor + TOKENS_PER_PAIR > deck.length) {
      deck = shuffled(sorted, next);
      cursor = 0;
    }
    const query = deck.slice(cursor, cursor + QUERY_TOKENS);
    const doc = deck.slice(cursor + QUERY_TOKENS, cursor + TOKENS_PER_PAIR);
    cursor += TOKENS_PER_PAIR;
    scores.push(cosine(pooled(model, query, mean), pooled(model, doc, mean)));
  }

  const nullMean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - nullMean) ** 2, 0) / scores.length;
  const nullSd = Math.sqrt(variance);
  const floor = nullMean + FLOOR_SIGMAS * nullSd;

  if (!Number.isFinite(floor) || floor <= 0 || floor >= 1) return null;
  return { mean, floor, samples: scores.length, slices, nullMean, nullSd };
}
