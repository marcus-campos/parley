import { readFileSync } from "node:fs";
import type { Hit } from "./lexical";
import { tokenize } from "./tokenize";

/**
 * A static model: a token lookup table plus pooling, nothing else. No
 * forward pass, so no GPU, no threads, no floating-point nondeterminism —
 * the same input always yields the same vector, bit for bit, which is what
 * lets top-k be asserted exactly in a test rather than approximated.
 */
export interface StaticModel { dims: number; vocab: Record<string, number[]> }

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
    return [...this.entries.entries()]
      .map(([id, e]) => ({ id, score: cosine(vec, e.vec), kind: e.kind }))
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
