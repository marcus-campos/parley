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
 * A fixed cosine boundary cannot be the floor: dense static embedding tables
 * are anisotropic — arbitrary, unrelated text pairs land at high positive
 * cosine, which is what a real `potion` model is — so a constant of `0`
 * excludes only the exactly-orthogonal case and lets an anisotropic corpus
 * rank and pass in full, every time. There is no positive float worth
 * hand-picking instead either: there is no deployed model yet to calibrate
 * one against (the one registry entry is `xlmr`, which this build cannot
 * load — see `isLoadable`), and a guess made without that evidence would be
 * worse than none.
 *
 * So the floor is computed from the distribution THIS query actually
 * produces over THIS index — the direct analogue of `requireDistinctive` on
 * the lexical side (lexical.ts): distinctively similar, not similar at all.
 * A hit must beat the mean and spread of every OTHER scored document by
 * `FLOOR_Z` standard deviations, on top of still needing a genuinely
 * positive cosine (never just "less negative than the rest" — the same
 * boundary the old constant drew, kept here as a floor under the floor).
 *
 * "Every OTHER document" — leave-one-out — is load-bearing, not a stylistic
 * choice: folding a candidate's own score into the mean and standard
 * deviation it is then compared against lets a genuine, dominant match drag
 * its own threshold up as it drags the mean up (a real match at 0.95 among
 * three unrelated hits at 0.05 raises the whole-population mean enough that
 * a plain, single mean+2σ excludes the 0.95 hit too — outlier detection
 * calls this masking). Scoring each candidate against the *rest* of the
 * field, never against a distribution its own value has already polluted,
 * is what lets a real standout still clear the bar while a merely
 * anisotropic tie to the whole corpus never does — both directions proved in
 * embed.test.ts.
 *
 * Below `MIN_CANDIDATES_FOR_FLOOR`, "distinctively above the rest" cannot be
 * asked of one or two points (mean and spread over a single peer are not a
 * distribution) — the same discipline `LexicalIndex.search` already applies
 * to document frequency before treating a term's rarity as signal
 * (`MIN_DOCS_FOR_THRESHOLD`, lexical.ts). Below the gate, a hit qualifies on
 * the old absolute rule alone: a genuinely positive cosine.
 */
const FLOOR_Z = 2;
const MIN_CANDIDATES_FOR_FLOOR = 4;

/**
 * Which of `scores` are distinctively similar, not merely similar at all —
 * one boolean per input score, same order. Exported so the floor's
 * statistics are assertable directly, on plain numbers, without having to
 * reverse-engineer a cosine geometry that produces them (`VectorIndex.search`
 * below is the only caller in production).
 */
export function aboveRelevanceFloor(scores: number[]): boolean[] {
  if (scores.length < MIN_CANDIDATES_FOR_FLOOR) return scores.map((s) => s > 0);

  const sum = scores.reduce((a, b) => a + b, 0);
  const sumSq = scores.reduce((a, b) => a + b * b, 0);
  const n = scores.length;

  return scores.map((x) => {
    if (x <= 0) return false;
    const othersN = n - 1;
    const othersMean = (sum - x) / othersN;
    // Population variance of the n-1 peers, from the running sums rather
    // than a second pass per candidate — the same one-pass-stats trick, just
    // with this candidate's own contribution subtracted back out first.
    // Clamped at 0 for the floating-point sliver that can otherwise land
    // just under it when every peer is identical.
    const othersVar = Math.max(0, (sumSq - x * x) / othersN - othersMean * othersMean);
    const floor = othersMean + FLOOR_Z * Math.sqrt(othersVar);
    return x > floor;
  });
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

  constructor(public readonly dims: number) {}

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
    // nothing to compare, not universal agreement. Without this, every
    // document would tie at `cosine(zero, x) === 0`, get ranked, and receive
    // a positive RRF bump once fused — resurrecting "least-bad note over
    // silence" through the one channel the lexical floor already closed it
    // on (Task 2's distinctiveness threshold). Silence is the honest answer.
    if (norm(vec) === 0) return [];

    const scored = [...this.entries.entries()].map(([id, e]) => ({ id, score: cosine(vec, e.vec), kind: e.kind }));
    const qualifies = aboveRelevanceFloor(scored.map((h) => h.score));

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
