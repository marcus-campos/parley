import type { StaticModel } from "../../../src/brain/embed";

/**
 * A model fixture that looks like a real one.
 *
 * The fixture this replaces was six words in two dimensions, every vector
 * exactly `[1,0]` or `[0,1]`, which made every cosine a bit-exact tie. That
 * single property is what let the previous floor's tuning constant be set to
 * 0.001 or to 50 with the whole suite staying green: where the spread is
 * exactly zero, a constant multiplying the spread cannot matter. A fixture
 * that cannot fail is a fixture that proves nothing.
 *
 * So this one is generated the way a dense static embedding table actually
 * behaves:
 *
 * - **Anisotropic.** Every row carries the same large shared direction, so
 *   two words about nothing in common still land at cosine ~0.9. This is the
 *   property that made `MIN_SIMILARITY = 0` filter nothing at all.
 * - **No exact ties.** Every row has its own random idiosyncratic part, so no
 *   two cosines are equal and nothing cancels by accident.
 * - **Genuinely topical.** Words in the same topic share a second direction,
 *   so a Portuguese note really is closer to its English paraphrase than to
 *   an unrelated note — the signal semantic recall is supposed to find, and
 *   the direction a floor can wrongly reject.
 * - **Big enough that the floor is a property of the model.** Twelve thousand
 *   rows, so `calibrate` measures its null over the full 512 disjoint slices
 *   a real model gets — not the 41 a thousand-row table allowed. That is not
 *   about calibrating rather than refusing; it is about the floor being
 *   *stable*. Recalibrating the same table under a hundred different shuffle
 *   seeds moves the floor by 1.94 nullSd at 41 pairs — wider than the entire
 *   3σ-to-5σ band the design is pinned inside, so the seed alone could walk
 *   out of the box that `FLOOR_SIGMAS` is supposed to bound. At 512 pairs the
 *   same reshuffling moves it 0.65 nullSd, and the box holds. `MIN_PAIRS`
 *   carries the same table.
 *
 * Deterministic: same seed, same table, every run, every machine.
 */

function xorshift32(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function gaussian(next: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(next(), 1e-12))) * Math.cos(2 * Math.PI * next());
}

function unitVector(next: () => number, dims: number): number[] {
  const v = Array.from({ length: dims }, () => gaussian(next));
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / n);
}

export const DIMS = 128;

/** How much of every row is the table's shared direction, versus the word itself. */
const ANISOTROPY = 3;
/** How much of every row is its topic, versus the word itself. */
const TOPICALITY = 1;

/**
 * The words the tests name out loud, grouped by what they are about. The
 * `sidebar` group deliberately mixes Portuguese and English: this corpus is
 * Portuguese prose around English identifiers, and paraphrase across the two
 * is the single thing the brain buys that the lexical floor cannot.
 */
export const TOPICS: Record<string, string[]> = {
  sidebar: ["menu", "lateral", "barra", "oculto", "oculta", "sidebar", "hidden", "drawer", "painel", "collapse"],
  kubernetes: ["kubernetes", "helm", "chart", "cluster", "pod", "ingress", "namespace", "kubectl", "rollout", "replica"],
  database: ["postgres", "migration", "schema", "vacuum", "transacao", "banco", "consulta", "sequence", "rollback", "commit"],
  http: ["request", "header", "cookie", "timeout", "retry", "socket", "porta", "requisicao", "gateway", "payload"],
};

/**
 * Exported because the floor tests build their own unrelated corpora out of
 * these words, and a corpus that guessed at the topic count would quietly
 * stop being unrelated the day this table changed shape.
 */
export const FILLER_TOPICS = 800;
export const FILLER_WORDS_PER_TOPIC = 16;

/** The `t`-th filler topic's `w`-th word — the one place the naming lives. */
export function fillerWord(topic: number, word: number): string {
  return `w${topic}x${word}`;
}

export function buildFixtureModel(seed = 0x5eed1234): StaticModel {
  const next = xorshift32(seed);
  const shared = unitVector(next, DIMS);

  const vocab: Record<string, number[]> = {};
  const addTopic = (words: string[]) => {
    const direction = unitVector(next, DIMS);
    for (const word of words) {
      const idiosyncratic = unitVector(next, DIMS);
      vocab[word] = shared.map((s, i) =>
        // Rounded so the JSON a test writes to disk stays small. Four decimals
        // is far finer than the spread between any two rows, so it changes no
        // ordering — and rounding is itself deterministic.
        Math.round((ANISOTROPY * s + TOPICALITY * direction[i]! + idiosyncratic[i]!) * 1e4) / 1e4,
      );
    }
  };

  for (const words of Object.values(TOPICS)) addTopic(words);
  for (let t = 0; t < FILLER_TOPICS; t++) {
    addTopic(Array.from({ length: FILLER_WORDS_PER_TOPIC }, (_, w) => fillerWord(t, w)));
  }

  return { dims: DIMS, vocab };
}

/** Built once; every test shares it, since it is immutable data. */
export const FIXTURE_MODEL = buildFixtureModel();
