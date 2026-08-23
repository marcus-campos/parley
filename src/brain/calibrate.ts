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
 * `embed` pools real text. Length matters on the raw vectors — the null
 * cosine drifts about 4σ between a one-token query and an eight-token one —
 * but after debiasing it stops mattering almost entirely, which is the whole
 * reason the debias step exists and the reason one stored number can be
 * honest for every query.
 */
const QUERY_TOKENS = 4;
const DOC_TOKENS = 20;
const TOKENS_PER_PAIR = QUERY_TOKENS + DOC_TOKENS;

/**
 * Enough pairs for a mean and a standard deviation to mean something, and a
 * cap so an enormous vocabulary does not turn boot into a benchmark. A table
 * too small to reach `MIN_PAIRS` is a toy, not a model: it does not get a
 * guessed floor, it gets refused (`null`), and the daemon degrades to the
 * lexical floor and says so.
 */
const MIN_PAIRS = 32;
const MAX_PAIRS = 512;

/**
 * How far above the null a hit has to land. Measured, not picked: at 4σ the
 * junk rate over unrelated text was 0.00% in every query/document length
 * combination tried, while paraphrase recall — a genuine match sharing NO
 * token with the query, the case the lexical floor cannot help with — stayed
 * between 78% and 100% in five of six. At 3σ recall gains almost nothing and
 * junk reappears in up to 18% of fifty-note queries. See the floor-fix report
 * for the full table.
 */
const FLOOR_SIGMAS = 4;

/**
 * A fixed seed, so the same model file always calibrates to the same floor.
 * A floor that drifted between daemon restarts would silently change what a
 * repository can recall, which is worse than a floor that is merely
 * imperfect. `Math.random()` is banned under `src/state/` for exactly this
 * reason; nothing here needs it either.
 */
const SEED = 0x9e3779b9;

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
 * Every pair uses its own disjoint slice of the shuffled vocabulary, so no
 * token appears on both sides of a comparison and no two samples share a
 * word. `null` — never a guess — whenever the table cannot support the
 * measurement: too few usable rows, or a result that is not a usable
 * boundary (not finite, at or below zero, at or above one). A model that
 * cannot say what unrelated looks like has not earned the right to say what
 * related looks like.
 */
export function calibrate(model: StaticModel): Calibration | null {
  const mean = meanRow(model);

  // An all-zero row carries no signal and would pool into a degenerate
  // pseudo-document; it is part of the table's mean, but not part of its null.
  const usable = Object.keys(model.vocab).filter((token) => model.vocab[token]!.some((x) => x !== 0));
  const pairs = Math.min(MAX_PAIRS, Math.floor(usable.length / TOKENS_PER_PAIR));
  if (pairs < MIN_PAIRS) return null;

  const next = xorshift32(SEED);
  const deck = shuffled(usable.sort(), next);

  const scores: number[] = [];
  for (let p = 0; p < pairs; p++) {
    const base = p * TOKENS_PER_PAIR;
    const query = deck.slice(base, base + QUERY_TOKENS);
    const doc = deck.slice(base + QUERY_TOKENS, base + TOKENS_PER_PAIR);
    scores.push(cosine(pooled(model, query, mean), pooled(model, doc, mean)));
  }

  const nullMean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - nullMean) ** 2, 0) / scores.length;
  const nullSd = Math.sqrt(variance);
  const floor = nullMean + FLOOR_SIGMAS * nullSd;

  if (!Number.isFinite(floor) || floor <= 0 || floor >= 1) return null;
  return { mean, floor, samples: scores.length, nullMean, nullSd };
}
