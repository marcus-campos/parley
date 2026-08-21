import { tokenize } from "./tokenize";
import type { State } from "../state/types";

export interface Hit {
  id: string;
  score: number;
  kind: "note" | "decision" | "result";
}

const K1 = 1.2;
const B = 0.75;

/**
 * Below this many documents, "a term present in half the corpus" is not a
 * meaningful signal — it is one or two notes, and the threshold below would
 * just as easily throw away the only note there is. The rule only switches
 * on once the corpus is big enough for document frequency to mean something.
 */
const MIN_DOCS_FOR_THRESHOLD = 4;

interface Doc { id: string; kind: Hit["kind"]; length: number; freq: Map<string, number> }

/**
 * The floor. Always present, deterministic, no model, no download.
 *
 * It is not a consolation prize: it is what answers while the brain is off,
 * what answers if the model is missing, and what a fresh install has on day
 * one. The brain is strictly additive on top of this.
 */
export class LexicalIndex {
  private docs = new Map<string, Doc>();
  private postings = new Map<string, Set<string>>();
  private totalLength = 0;

  get size(): number { return this.docs.size; }

  add(id: string, kind: Hit["kind"], text: string): void {
    this.remove(id);
    const tokens = tokenize(text);
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    this.docs.set(id, { id, kind, length: tokens.length, freq });
    this.totalLength += tokens.length;
    for (const term of freq.keys()) {
      let set = this.postings.get(term);
      if (!set) { set = new Set(); this.postings.set(term, set); }
      set.add(id);
    }
  }

  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.totalLength -= doc.length;
    this.docs.delete(id);
    for (const term of doc.freq.keys()) {
      const set = this.postings.get(term);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.postings.delete(term);
    }
  }

  search(query: string, k: number): Hit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.docs.size === 0) return [];
    const avg = this.totalLength / this.docs.size;
    const scores = new Map<string, number>();
    /**
     * A hit qualifies only if it matched a term that does not appear in a
     * majority of the corpus. IDF already pushes ubiquitous terms toward
     * zero, but never all the way there, so without this a note sharing
     * only a common word with the query would still outrank returning
     * nothing — and returning the least-bad note is worse than silence
     * (spec §6). Document frequency is scale-free: the same rule reads the
     * same way on a four-note index and a four-hundred-note one.
     */
    const requireDistinctive = this.docs.size >= MIN_DOCS_FOR_THRESHOLD;
    const matchedDistinctive = new Set<string>();

    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (this.docs.size - posting.size + 0.5) / (posting.size + 0.5));
      const isDistinctive = posting.size <= this.docs.size / 2;
      for (const id of posting) {
        const doc = this.docs.get(id)!;
        const f = doc.freq.get(term) ?? 0;
        const score = idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avg)));
        scores.set(id, (scores.get(id) ?? 0) + score);
        if (isDistinctive) matchedDistinctive.add(id);
      }
    }

    const candidates = requireDistinctive
      ? [...scores.entries()].filter(([id]) => matchedDistinctive.has(id))
      : [...scores.entries()];

    return candidates
      // Ties break on the id, so the same corpus always answers in the same order.
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, k)
      .map(([id, score]) => ({ id, score, kind: this.docs.get(id)!.kind }));
  }
}

/** Rebuilt from state on daemon boot; state is itself rebuilt from the journal. */
export function indexFromState(state: State): LexicalIndex {
  const index = new LexicalIndex();
  for (const note of state.notes) {
    if (note.reversedBy !== null) continue;
    index.add(note.id, note.kind, [note.title, note.body, note.tags.join(" "), note.paths.join(" ")].join(" "));
  }
  for (const result of Object.values(state.results)) {
    index.add(result.key, "result", [result.key, result.summary, result.paths.join(" ")].join(" "));
  }
  return index;
}
