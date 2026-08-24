/**
 * What the sidecar is told about an encoder. Serialised straight to its argv,
 * so every field here has to survive JSON.
 */
export interface EncoderSpec {
  /** Hugging Face repository id, resolved by the sidecar at load time. */
  repo: string;
  /** Quantisation. Absent means the default weights. */
  dtype?: "q4" | "q8" | "fp16";
  /** How token vectors become one vector. Wrong choice here costs accuracy. */
  pool: "mean" | "cls" | "last";
  /** Asymmetric models want the question and the note marked differently. */
  queryPrefix: string;
  passagePrefix: string;
  /**
   * The similarity below which a match is not a match, measured per model.
   *
   * Static models derive this at load time from their own vocabulary
   * (`calibrate.ts`), which an encoder cannot do — there is no table to take a
   * null distribution from, only a function you would have to run thousands of
   * times. So it is measured once, offline: unrelated question/note pairs
   * embedded, and the boundary placed above their mean by however many standard
   * deviations a sweep shows to be the knee. See the entry in `MODELS` for the
   * sweep that set the shipped value, and why it is not the statics' four.
   *
   * It doubles as the fingerprint `vectors.ts` stores, which is why two models
   * must never share one: a persisted index would then be reloaded against the
   * wrong model's vectors.
   */
  floor: number;
  /**
   * Every file the runtime actually fetches, relative to the model's
   * repository — enumerated rather than derived.
   *
   * It cannot be derived. The weight file's name depends on the quantisation
   * in a way that is not a rule: `q4` is `model_q4.onnx`, `q8` is
   * `model_quantized.onnx`, and only some models carry the external
   * `.onnx_data` sidecar next to the graph. This list is read off a working
   * install, and it exists so that somebody whose network refuses the download
   * can fetch these by hand — a browser goes through the corporate proxy that
   * the runtime cannot.
   */
  files: string[];
}

interface Common {
  name: string;
  dims: number;
  /**
   * Answers a person actually receives, out of 20 — see `BENCHMARK_SIZE` below
   * for what that means and how it is measured.
   *
   * This is the only claim the listing makes about a model, and it is measured,
   * never estimated: somebody choosing gets a rank they can act on instead of
   * adjectives they have to interpret.
   */
  score: number;
  /** Disk, in bytes, as the person will actually spend it. */
  bytes: number;
  /**
   * How much this model's ranking is trusted against the lexical one, measured.
   *
   * Not a global constant, because it cannot be: the right answer depends on
   * whether this particular model's opinions are worth more than a keyword
   * match. Weighting a good model heavily is what takes paraphrase recall from
   * 50 of 100 to 66. Weighting a weak one the same way is what takes it from
   * 24 to 22 — below answering with no model at all — because its noise then
   * outranks a lexical hit that was right.
   *
   * See `fuse` in `embed.ts` for the mechanism and `scripts/bench-recall.ts`
   * for how any value here is re-derived.
   */
  vectorWeight: number;
  /**
   * Resident memory the model itself costs, in MB, measured alone in a fresh
   * process with the interpreter's own baseline subtracted.
   *
   * Worth reading before assuming a transformer is the expensive option: the
   * largest static table here costs more memory than the recommended encoder,
   * because a vocabulary of that size becomes a very large JavaScript object.
   */
  ramMB: number;
  /**
   * Milliseconds to embed one note, steady state.
   *
   * This is not on anybody's critical path — notes are embedded in the
   * background and a query already has its lexical answer — so it is here to
   * set expectations about how long a first activation takes on a large
   * corpus, not as a reason to choose a worse model.
   */
  msPerNote: number;
}

/**
 * A token lookup table plus pooling: deterministic, microseconds, no native
 * runtime. Fits inside `bun build --compile`, which is why these work from the
 * single binary with nothing else installed.
 */
export interface StaticBrainModel extends Common {
  kind: "static";
  url: string;
  sha256: string;
  /** `wordlevel` needs only a regex split. `xlmr` needs a real tokenizer. */
  tokenizer: "wordlevel" | "xlmr";
}

/**
 * A real transformer, run by a sidecar process (`sidecar.ts`).
 *
 * Needs `bun` on PATH and a one-time dependency install, because
 * `onnxruntime-node` is a native addon and a native addon cannot live inside
 * the single compiled binary. That is the trade: several points of accuracy
 * for a runtime the static models do not require.
 */
export interface EncoderBrainModel extends Common {
  kind: "encoder";
  spec: EncoderSpec;
}

export type BrainModel = StaticBrainModel | EncoderBrainModel;

/** How many questions every `score` is out of. Shown next to the number so it reads as a fraction. */
export const BENCHMARK_SIZE = 100;

/**
 * What those same 20 questions score with no model at all.
 *
 * The baseline belongs in the listing next to the models, because "14 of 20"
 * means nothing without it and every model here is *added* to this, never
 * instead of it. It is also the number that exposes an entry earning its
 * disk: one of the models below scores exactly this.
 */
export const LEXICAL_FLOOR_SCORE = 24;

/**
 * The measured field, and what it is a measurement of.
 *
 * A hundred notes, half Portuguese and half English, and a hundred questions —
 * one per note, each written to share as little vocabulary as possible with the
 * note that answers it. A question answerable by keyword match measures the
 * lexical floor, which is free and already there.
 *
 * `score` is how often the right note **comes back as the answer**: past the
 * model's own relevance floor, through the fusion with the lexical ranking, out
 * of the socket. It is measured through a real daemon, not against the model in
 * isolation — cosine similarity alone gives a different and flattering number,
 * and that mistake shipped once.
 *
 * There is a second question family, and it is what keeps this honest: 92
 * exact-term queries, each an identifier or phrase appearing in exactly one
 * note. That is the lexical channel's job and it answers all 92 with no model
 * at all. It is here to catch a change that improves paraphrase by quietly
 * breaking symbol search — a trade nobody would accept if they were shown it.
 *
 * ```
 *                          paraphrase   Portuguese   exact term
 *                            (of 100)     (of 50)      (of 92)
 *   no model at all              24          11           92
 *   embeddinggemma-300m          66          29           90
 *   multilingual-e5-small        47          21           89
 * ```
 *
 * WHAT WAS REMOVED, AND WHY IT MATTERS MORE THAN WHAT WAS KEPT.
 *
 * Three static models used to be listed here, and one of them was the
 * recommendation. Measured on this corpus they are worse than no model at all,
 * on every axis, at every fusion weight tried:
 *
 * ```
 *                          paraphrase   Portuguese   exact term
 *   no model at all              24          11           92
 *   potion-base-32M              22           3           85
 *   potion-base-8M               18           3           80
 *   potion-base-2M               19           2           80
 * ```
 *
 * They essentially never answered in Portuguese; what an earlier benchmark
 * credited to them was the lexical channel working underneath. And they cost
 * exact-term recall, because a static table's opinion about an unfamiliar word
 * is noise, and noise fused with a correct keyword match displaces it.
 *
 * The 20-note benchmark this replaced could not see any of that — five times
 * fewer distractors is a much easier problem, and it scored those models as
 * mildly useful. Anybody who took the recommendation had worse recall than
 * leaving the brain off, which is the strongest argument in this file for
 * measuring the product rather than the model, on a corpus big enough to be
 * wrong on.
 *
 * `RETIRED` below keeps their names so somebody who enabled one is told what
 * happened rather than getting "unknown model".
 *
 * HOW EACH ENCODER FLOOR WAS CHOSEN. Not by taste, and not by inheriting the
 * statics' four sigma — that silences an encoder almost completely. The rule:
 * take the highest recall whose false-positive rate over unrelated
 * question/note pairs stays at or below 8.9%. Both encoders land on 1.5 sigma.
 * Each entry carries its own sweep, so the choice can be checked rather than
 * trusted.
 *
 * Reproduce any of it with `bun run bench:recall`. The corpus lives in
 * `tests/brain/fixtures/recall-benchmark.json`, and
 * `tests/brain/benchmark.test.ts` guards its properties on every test run.
 */
export const MODELS: BrainModel[] = [
  {
    name: "embeddinggemma-300m",
    kind: "encoder",
    vectorWeight: 20,
    dims: 768,
    score: 66,
    ramMB: 510,
    msPerNote: 21,
    // The q4 weights and everything the tokenizer needs, measured on disk after
    // a real download — not the repository's total, which is far larger because
    // it carries every quantization at once.
    bytes: 218_726_989,
    spec: {
      repo: "onnx-community/embeddinggemma-300m-ONNX",
      // q4 is not the compromise here, it is the better entry. Measured against
      // q8 of the same model: the same score, a third less disk, and four times
      // faster per note.
      dtype: "q4",
      pool: "mean",
      // Prescribed by the model, and not decoration: these prefixes are what
      // tell an asymmetric model which side of the comparison it is embedding.
      // parley stores a note as one flat string with no separate title, so the
      // title slot is filled the way the model card says to fill it when there
      // is none.
      queryPrefix: "task: search result | query: ",
      passagePrefix: "title: none | text: ",
      // Two standard deviations above the mean of 380 unrelated pairs.
      //
      // The static models measure this at load time from their own vocabulary
      // (`calibrate.ts`), which has no equivalent here: there is no table to
      // take a null distribution from, only a function that would have to run
      // thousands of times. So it is measured once, offline, on the benchmark
      // corpus.
      //
      // Two sigma rather than the statics' four, and the number came from a
      // sweep rather than from taste — at four sigma, one correct answer of
      // twenty survives:
      //
      //   sigma   correct kept   wrong kept   unrelated passing (of 380)
      //     1.5        16             1            31
      //     2.0        14             1             7
      //     2.5        11             0             0
      //     4.0         1             0             0
      //
      // 2.0 is the knee. What it costs is the four weakest true matches; what
      // it buys is a null rate an order of magnitude below what the static
      // models ship with today.
      //
      // One caveat worth stating plainly: this is measured against twenty
      // unrelated notes. A repository whose notes are all about one codebase
      // has a tighter null distribution than that, so the real rate will be
      // higher than 1.8%. The vector channel is additive — fused with the
      // lexical ranking, never replacing it — so what that costs is extra
      // candidates in a fusion, not a wrong answer standing on its own.
      floor: 0.571,
      files: [
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "onnx/model_q4.onnx",
        "onnx/model_q4.onnx_data",
      ],
    },
  },
  {
    name: "multilingual-e5-small",
    kind: "encoder",
    vectorWeight: 20,
    dims: 384,
    score: 47,
    // More memory than embeddinggemma, for fewer answers — the one number here
    // that surprises people, and the reason this entry is not the "light" one
    // it looks like. What it actually costs less of is disk and time.
    ramMB: 800,
    msPerNote: 6,
    bytes: 135_392_016,
    spec: {
      repo: "Xenova/multilingual-e5-small",
      dtype: "q8",
      pool: "mean",
      queryPrefix: "query: ",
      passagePrefix: "passage: ",
      // Read the sweep before moving this. Unlike embeddinggemma, this model's
      // right answers and its unrelated pairs overlap heavily — true matches
      // score 0.79 to 0.87 against a null that averages 0.79 — so no floor
      // separates them cleanly and every choice trades recall for noise
      // directly:
      //
      //   sigma   correct kept   wrong kept   unrelated passing (of 380)
      //     1.0        11             7            74
      //     1.5        10             6            33
      //     2.0         7             3            10
      //     2.5         2             0             0
      //
      // 1.5 is what the shared rule picks (see below). It leaves six wrong
      // answers above the floor, which is more than embeddinggemma's one and
      // is the honest cost of this entry.
      floor: 0.8265,
      // No `.onnx_data` here: this model's weights fit inside the graph file,
      // which is why the list is per model rather than a pattern.
      files: [
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "onnx/model_quantized.onnx",
      ],
    },
  },
];

/** The one `brain enable` names when nobody picks. */
/**
 * Models that were listed and are not any more, with the reason.
 *
 * Kept by name so a daemon replaying a journal that enabled one can say what
 * happened. "Unknown model" reads as a bug in parley; the truth is that the
 * model was measured against the lexical floor it sits on top of and lost.
 */
export const RETIRED: { name: string; why: string }[] = [
  {
    name: "potion-base-32M",
    why: "measured worse than no model at all — 22 paraphrase answers of 100 against the floor's 24, " +
      "3 of 50 in Portuguese against 11, and it cost 7 of the 92 exact-term answers",
  },
  {
    name: "potion-base-8M",
    why: "measured worse than no model at all — 18 paraphrase answers of 100 against the floor's 24, " +
      "and it cost 12 of the 92 exact-term answers",
  },
  {
    name: "potion-base-2M",
    why: "measured worse than no model at all — 19 paraphrase answers of 100 against the floor's 24, " +
      "and it cost 12 of the 92 exact-term answers",
  },
];

export function retiredReason(name: string): string | undefined {
  return RETIRED.find((r) => r.name === name)?.why;
}

export const RECOMMENDED = "embeddinggemma-300m";

// WHAT ELSE WAS MEASURED, so the next person does not repeat it.
//
// Twelve encoders, screened on the same 100-note corpus. Only the answers that
// clear each model's own floor are counted, and each floor is set by the rule
// above rather than by taste:
//
//   embeddinggemma-300m      68/100   pt 33/50   508 MB RAM   21 ms/note
//   multilingual-e5-large    53/100   pt 28/50   866 MB RAM   31 ms   552 MB disk
//   gte-multilingual-base    53/100   pt 26/50   674 MB RAM   12 ms   341 MB disk
//   snowflake-arctic-l-v2    53/100   pt 28/50   368 MB RAM   91 ms  1207 MB disk
//   multilingual-e5-base     49/100   pt 25/50   955 MB RAM   12 ms
//   multilingual-e5-small    46/100   pt 20/50   799 MB RAM    6 ms
//   Qwen3-Embedding-0.6B     45/100   pt 19/50   805 MB RAM   61 ms
//   bge-m3                   42/100   pt 20/50   730 MB RAM  100 ms
//   paraphrase-mpnet-multi   38/100   pt 21/50  1363 MB RAM   11 ms
//   multilingual-MiniLM      28/100   pt 19/50   783 MB RAM    4 ms
//   LaBSE                    20/100   pt 15/50  1091 MB RAM   27 ms
//   jina-v2-base-de           3/100   pt  2/50   622 MB RAM   16 ms
//
// Nothing here displaces the recommendation, and the three that come closest
// are each dominated by it on more than one axis: `gte-multilingual-base` and
// `multilingual-e5-large` cost more disk AND more memory for fifteen fewer
// answers, and `snowflake-arctic-l-v2` wants 1.2 GB of disk for the same.
// A menu row that is worse on every axis a person cares about is not a choice,
// it is noise.
//
// Quantisation was checked too, on the recommendation itself. `q8` scores
// 70/100 against `q4`'s 68 — and costs four times the time per note, three
// times the memory, and 86 MB more disk. Two answers is inside this corpus's
// noise; the rest is not. `q4` ships.
//
// `potion-multilingual-128M` remains absent for its original reason: its
// tokenizer is XLM-R and this build's static loader carries only wordlevel.
// The encoder path makes it far less interesting than it was.

export function findModel(name: string, within: BrainModel[] = MODELS): BrainModel | undefined {
  return within.find((m) => m.name === name);
}

/** Narrowing helpers, so call sites read as intent rather than as a tag check. */
export function isEncoder(m: BrainModel): m is EncoderBrainModel {
  return m.kind === "encoder";
}

export function isStatic(m: BrainModel): m is StaticBrainModel {
  return m.kind === "static";
}
