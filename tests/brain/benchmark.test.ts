import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexFromState } from "../../src/brain/lexical";
import { BENCHMARK_SIZE, LEXICAL_FLOOR_SCORE, MODELS } from "../../src/brain/registry";
import type { Note, State } from "../../src/state/types";

/**
 * The corpus behind every number in the registry, and the guard that keeps it
 * honest.
 *
 * The scores in `src/brain/registry.ts` are the only claim the model listing
 * makes, and until this file existed they were reproducible only by whoever
 * measured them. That is the wrong shape for a number a person spends 200 MB
 * of disk on: `scripts/bench-recall.ts` re-runs it against a real daemon, and
 * this suite checks the properties that make the corpus worth running at all.
 *
 * What is NOT here, deliberately: the scores. Reproducing one needs a real
 * model, a real download and a real daemon — minutes and hundreds of megabytes,
 * which is a script somebody runs, not a unit test everybody pays for. What is
 * here is everything that can make the *corpus* dishonest, because a benchmark
 * with a broken question set produces numbers that look measured and are not.
 */

interface Benchmark {
  notes: { lang: "pt" | "en"; q: string; title: string; body: string; paths: string; term: string }[];
  exactTerms: { query: string; answers: number }[];
}

const bench: Benchmark = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "recall-benchmark.json"), "utf8"),
);

/** Accent- and case-insensitive words, so Portuguese compares like English. */
function words(text: string): Set<string> {
  const flat = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return new Set(flat.match(/[a-z0-9_]+/g) ?? []);
}

const STOP = words(
  "the a an of to in is are was were and or for it that this with on at by not no as be been being do does did " +
  "o a os as de do da dos das um uma e ou para em no na nos nas que se por com nao sem ja mais muito quando " +
  "how why what where which who i my our we you your they their can could should would will",
);

const noteText = (n: Benchmark["notes"][number]): string => `${n.title} ${n.body} ${n.paths}`;

describe("the recall benchmark corpus", () => {
  test("it is big enough for a one-answer difference not to be the whole finding", () => {
    // The first version of this benchmark had twenty notes, and on twenty a
    // single question is five percent — enough to make noise look like a
    // result. It also flattered every model: five times fewer distractors is a
    // much easier problem than a real repository poses, and the scores that
    // shipped from it were measurably optimistic.
    expect(bench.notes.length).toBeGreaterThanOrEqual(100);
    expect(bench.exactTerms.length).toBeGreaterThanOrEqual(80);
  });

  test("both languages carry real weight, so one cannot hide behind the other", () => {
    const pt = bench.notes.filter((n) => n.lang === "pt").length;
    const en = bench.notes.filter((n) => n.lang === "en").length;
    // A model can be strong in English and useless in Portuguese — the static
    // models are exactly that — and a corpus that is mostly English would score
    // them as merely mediocre instead of showing it.
    expect(Math.min(pt, en) / bench.notes.length).toBeGreaterThan(0.4);
  });

  test("every note is the answer to exactly one question, and every question has one", () => {
    const titles = new Set(bench.notes.map((n) => n.title));
    expect(titles.size).toBe(bench.notes.length);
    for (const n of bench.notes) expect(n.q.trim().length).toBeGreaterThan(10);
  });

  test("a semantic question shares almost no vocabulary with the note that answers it", () => {
    // This is the property the whole corpus exists for. A question answerable
    // by keyword match measures the lexical floor, which is free and already
    // there — it would score a useless model as a good one.
    const overlaps = bench.notes.map((n) => {
      const q = [...words(n.q)].filter((w) => !STOP.has(w));
      const d = words(noteText(n));
      return q.filter((w) => d.has(w)).length / Math.max(1, q.length);
    });
    const mean = overlaps.reduce((a, b) => a + b, 0) / overlaps.length;
    expect(mean).toBeLessThan(0.25);
    // A handful of higher-overlap questions stay on purpose — real questions do
    // sometimes reuse a word — but they must not be the bulk of the corpus.
    expect(overlaps.filter((o) => o > 0.5).length / overlaps.length).toBeLessThan(0.05);
  });

  test("every exact-term query is answered by exactly one note", () => {
    // An exact-term query that two notes contain has no correct answer, so
    // scoring it measures nothing. Eight of the first hundred were like this
    // and were dropped rather than counted.
    for (const e of bench.exactTerms) {
      const holders = bench.notes.filter((m) => noteText(m).toLowerCase().includes(e.query.toLowerCase()));
      expect(holders).toHaveLength(1);
      expect(holders[0]).toBe(bench.notes[e.answers]!);
    }
  });

  test("the lexical floor alone answers the exact-term half, and fails the semantic half", () => {
    // The corpus has to separate the two channels or it cannot be used to
    // weigh them against each other. Run against the real lexical index, with
    // no model involved: near-perfect on terms, weak on paraphrase.
    const state = {
      notes: bench.notes.map((n, i) => ({
        id: `n_${i}`, kind: "note", title: n.title, body: n.body,
        tags: [], paths: [n.paths], reversedBy: null,
      })) as unknown as Note[],
      results: {},
    } as unknown as State;
    const index = indexFromState(state);

    const top = (q: string): string | null => index.search(q, 1)[0]?.id ?? null;
    const exact = bench.exactTerms.filter((e) => top(e.query) === `n_${e.answers}`).length;
    const semantic = bench.notes.filter((n, i) => top(n.q) === `n_${i}`).length;

    expect(exact / bench.exactTerms.length).toBeGreaterThan(0.9);
    expect(semantic / bench.notes.length).toBeLessThan(0.45);
  });

  test("the registry's baseline is stated on the same scale as its scores", () => {
    // `LEXICAL_FLOOR_SCORE` and every `score` have to be comparable numbers out
    // of `BENCHMARK_SIZE`, or the "gain" column in the listing is arithmetic on
    // two different measurements.
    expect(LEXICAL_FLOOR_SCORE).toBeLessThan(BENCHMARK_SIZE);
    for (const m of MODELS) expect(m.score).toBeLessThanOrEqual(BENCHMARK_SIZE);
  });
});
