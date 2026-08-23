import { readFileSync } from "node:fs";
import type { Hit } from "./lexical";
import type { BrainModel } from "./registry";
import { tokenize } from "./tokenize";

/**
 * A static model: a token lookup table plus pooling, nothing else. No
 * forward pass, so no GPU, no threads, no floating-point nondeterminism —
 * the same input always yields the same vector, bit for bit, which is what
 * lets top-k be asserted exactly in a test rather than approximated.
 */
export interface StaticModel { dims: number; vocab: Record<string, number[]> }

/**
 * This build's loader understands only `wordlevel` — a token lookup plus
 * the regex split in `tokenize.ts`. `xlmr` needs the XLM-RoBERTa
 * SentencePiece tokenizer, which has no TypeScript path (only Python or
 * WASM); adding either is out of scope here, on purpose. The registry keeps
 * `xlmr` entries anyway — deleting them would hide that the intended model
 * is known and simply not yet loadable, which a reader deserves to see.
 *
 * A caller that skips this and enables an unloadable entry anyway is not in
 * danger: `loadStaticModel` still refuses whatever bytes land on disk
 * (they won't parse as the `{dims, vocab}` shape) and the daemon degrades to
 * the lexical floor, same as any other missing or corrupt model. This check
 * exists so that refusal happens *before* a person spends disk and time on
 * a download that was always going to end there.
 */
export function isLoadable(model: BrainModel): boolean {
  return model.tokenizer === "wordlevel";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A missing, truncated or malformed model file must never throw — it must
 * degrade to `null`, the same contract `ensureModel` (download.ts) already
 * keeps for a checksum failure. Every field is checked because a model file
 * is code-adjacent data: what shapes an agent's beliefs about this
 * repository, arriving over the network, is exactly the thing worth
 * distrusting.
 */
export function loadStaticModel(path: string): StaticModel | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validateStaticModel(parsed);
  } catch {
    return null;
  }
}

function validateStaticModel(parsed: unknown): StaticModel | null {
  if (!isRecord(parsed)) return null;
  const dims = parsed.dims;
  const vocab = parsed.vocab;
  if (typeof dims !== "number" || !Number.isFinite(dims) || dims <= 0) return null;
  if (!isRecord(vocab)) return null;
  for (const row of Object.values(vocab)) {
    if (!Array.isArray(row) || row.length !== dims || !row.every((x) => typeof x === "number")) return null;
  }
  return { dims, vocab: vocab as Record<string, number[]> };
}

/**
 * Lookup and mean, nothing more.
 *
 * Two details here are load-bearing, not incidental: an unknown token is
 * skipped rather than treated as zeros mixed into the average — it
 * contributes nothing, rather than poisoning the vector with a false
 * signal. And text with no known token at all returns the zero vector
 * (`seen === 0` short-circuits before the divide), never a NaN — a NaN
 * reaching a similarity score would silently corrupt every ranking it
 * touches, not just the one query that produced it.
 */
export function embed(model: StaticModel, text: string): Float32Array {
  const out = new Float32Array(model.dims);
  let seen = 0;
  for (const token of tokenize(text)) {
    const row = model.vocab[token];
    if (!row) continue;
    for (let i = 0; i < model.dims; i++) out[i]! += row[i]!;
    seen++;
  }
  if (seen === 0) return out;
  for (let i = 0; i < model.dims; i++) out[i]! /= seen;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a));
}

/** A zero vector (no known token, or an unloaded slot) has similarity zero to anything, never NaN. */
function cosine(a: Float32Array, b: Float32Array): number {
  const denom = norm(a) * norm(b);
  return denom === 0 ? 0 : dot(a, b) / denom;
}

/**
 * Take the table's centre of mass out of a vector, so what is left is the
 * text rather than the table.
 *
 * A dense static embedding table is anisotropic: most of every row is one
 * shared direction, so two texts with nothing in common still land at cosine
 * 0.85 and up, and where exactly they land drifts with how many tokens each
 * side pooled. Subtracting the mean row (`calibrate.ts`) removes that shared
 * direction, and with it almost all of the drift.
 *
 * Measured across every length regime from one token against one to eight
 * against sixty, on a 256-dimension table of 20,000 rows:
 *
 * ```
 *   raw null mean       1x1      1x6     4x20     8x60    span
 *   anisotropy 2.5   0.7583   0.8484   0.9549   0.9780   0.220
 *                sd  0.0205   0.0121   0.0044   0.0021
 *   anisotropy 5.0   0.9262   0.9561   0.9882   0.9944   0.068
 *                sd  0.0061   0.0033   0.0012   0.0005
 * ```
 *
 * That span is **11 σ of movement from text length alone measured against
 * the widest regime's own spread, and 100 to 126 σ against the narrowest's**
 * — on both tables. It is not a close thing, and no single raw floor can be
 * right for both a three-word query and a four-hundred-word note. (Two
 * earlier versions of this comment said 4 σ and then 5-12 σ. Both were
 * measured on a truncated grid — the first missing the 1x1 end, the second
 * missing the 8x60 end — and both understated the case for this function.)
 *
 * Centered, the σ is what stops moving: 0.061-0.064 in every regime, and
 * 0.086-0.091 on a 128-dimension table (it is `1/sqrt(dims)`, not a
 * constant). The centered *mean* is not perfectly still either, and what
 * moves it is not text length but whether the pooled text is *about
 * something*:
 *
 * ```
 *   centered null mean, 1x1 -> 8x60      T=200    T=20    T=12
 *   incoherent (words from anywhere)     0.06σ   0.03σ   0.02σ
 *   coherent   (words from one topic)    0.12σ   0.39σ   0.53σ
 * ```
 *
 * `T` is the number of independent topic directions the table has after the
 * mean row is out. Two *different* topic residuals have expected cosine
 * `-1/(T-1)`, and pooling more tokens converges each side onto its own topic
 * residual — so a coherent pair walks toward that value, which is **away
 * from zero and downward**, i.e. toward silence for long documents. An
 * incoherent pair never converges on anything and stays put, which is why
 * `calibrate` — whose pseudo-documents are incoherent — measures a null that
 * barely drifts at all. The size of the coherent drift is set by `T`, and a
 * table with a dozen effective directions is already close to the degeneracy
 * `floor >= 1` refuses outright. Against raw's 11-126 σ, either column is a
 * different universe, and that is what lets one stored floor be honest for
 * every query.
 *
 * The zero vector stays the zero vector, deliberately. Text with no known
 * token has nothing to compare, and `-mean` would be a real direction
 * pointing nowhere in particular — precisely the "least-bad note over
 * silence" answer the whole floor exists to refuse.
 */
export function debias(vec: Float32Array, mean: Float32Array): Float32Array {
  if (norm(vec) === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! - mean[i]!;
  return out;
}

/**
 * Which of `scores` clear the floor — one boolean per input score, same
 * order.
 *
 * Absolute, and that is the entire point. The floor is a number about the
 * model (`calibrate.ts`), measured from what unrelated text actually scores
 * against unrelated text on that table, so a candidate is judged alone:
 * never against how many other candidates there are, never against how they
 * compare to each other.
 *
 * Two earlier shapes are both refused by that sentence. A fixed `> 0` is not
 * a floor at all on an anisotropic table, where every cosine is positive. A
 * per-query z-score is an outlier detector, and an outlier detector answers
 * "is this score unusual among the others?", never "is this document
 * relevant?" — so it passes a whole corpus of equally-irrelevant notes
 * whenever one of them is marginally less irrelevant, and rejects two
 * identical perfect matches because neither stands out against the other.
 * Both directions were wrong, and both are gone: identical matches all
 * qualify or all do not, together, exactly as their score deserves.
 */
export function aboveRelevanceFloor(scores: number[], floor: number): boolean[] {
  return scores.map((s) => s > floor);
}

interface Entry { vec: Float32Array; kind: Hit["kind"] }

/**
 * The vector twin of `LexicalIndex` (lexical.ts): held by the daemon, not
 * `state`, and rebuilt or reloaded (via vectors.ts) rather than replayed —
 * an embedding is a pure function of text, so there is nothing here worth
 * re-deriving from the journal frame by frame.
 */
export class VectorIndex {
  private readonly entries = new Map<string, Entry>();

  /**
   * `floor` is the model's own measured relevance boundary (`calibrate.ts`).
   * It is required, not optional with a default: a default would be a guessed
   * constant, and a guessed constant is what the two previous attempts at
   * this were. An index that cannot be told what unrelated looks like is not
   * built at all — the daemon leaves the brain off and the lexical floor
   * answers instead.
   */
  constructor(public readonly dims: number, public readonly floor: number) {}

  get size(): number { return this.entries.size; }

  /**
   * `kind` defaults to `"note"` so the two-argument call the interface
   * promises keeps working; the daemon, which knows the real kind for
   * every id it embeds, always passes it explicitly.
   */
  add(id: string, vec: Float32Array, kind: Hit["kind"] = "note"): void {
    this.entries.set(id, { vec, kind });
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  search(vec: Float32Array, k: number): Hit[] {
    // A query with no known token at all embeds to the zero vector — there is
    // nothing to compare, not universal agreement. `cosine` already answers 0
    // for it, and 0 is below every valid floor, so this is belt and braces
    // rather than the load-bearing rule it was when the floor was 0 itself.
    // It stays because it says the honest thing out loud: silence, not
    // universal agreement.
    if (norm(vec) === 0) return [];

    const scored = [...this.entries.entries()].map(([id, e]) => ({ id, score: cosine(vec, e.vec), kind: e.kind }));
    const qualifies = aboveRelevanceFloor(scored.map((h) => h.score), this.floor);

    return scored
      .filter((_, i) => qualifies[i])
      // Ties break on the id, so the same corpus always answers in the same
      // order — the same rule `LexicalIndex.search` uses.
      .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
      .slice(0, k);
  }

  /** For `vectors.ts` to persist. Not part of the interface the brief names; additive. */
  all(): { id: string; vec: Float32Array; kind: Hit["kind"] }[] {
    return [...this.entries.entries()].map(([id, e]) => ({ id, vec: e.vec, kind: e.kind }));
  }
}

/**
 * Reciprocal rank fusion.
 *
 * Not a hedge: lexical carries the identifiers, vectors carry the paraphrase,
 * and every sentence in this corpus has both — Portuguese prose around
 * English identifiers. A document both rankings agree on outranks one only a
 * single ranking found (each contributes its own reciprocal-rank bump, so
 * agreement adds up), and a document neither ranking returned can never
 * appear — the score map is only ever populated from `lexical` and `vector`
 * themselves.
 */
export function fuse(lexical: Hit[], vector: Hit[], k: number): Hit[] {
  const RRF_K = 60;
  const scores = new Map<string, { score: number; kind: Hit["kind"] }>();
  const add = (hits: Hit[]) => hits.forEach((h, rank) => {
    const prev = scores.get(h.id);
    const bump = 1 / (RRF_K + rank + 1);
    scores.set(h.id, { score: (prev?.score ?? 0) + bump, kind: prev?.kind ?? h.kind });
  });
  add(lexical);
  add(vector);
  return [...scores.entries()]
    .sort((a, b) => (b[1].score - a[1].score) || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([id, v]) => ({ id, score: v.score, kind: v.kind }));
}
