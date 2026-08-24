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
export const BENCHMARK_SIZE = 20;

/**
 * What those same 20 questions score with no model at all.
 *
 * The baseline belongs in the listing next to the models, because "14 of 20"
 * means nothing without it and every model here is *added* to this, never
 * instead of it. It is also the number that exposes an entry earning its
 * disk: one of the models below scores exactly this.
 */
export const LEXICAL_FLOOR_SCORE = 5;

/**
 * The measured field, and what it is a measurement of.
 *
 * Twenty questions against twenty notes, half Portuguese and half English,
 * each question answerable by exactly one note. The questions are written to
 * share as few words as possible with the note that answers them — a question
 * answerable by keyword match measures the lexical floor, which is already
 * there and costs nothing.
 *
 * `score` is not how often the right note ranked first. It is how often the
 * right note ranked first **and cleared the model's own relevance floor** —
 * that is, how often a person actually receives the answer. The distinction
 * turned out to be the whole story: `embeddinggemma-300m` ranks the right note
 * first 18 times out of 20, and an earlier version of this table nearly shipped
 * that number. Against a floor set the way the static models set theirs, one of
 * those 18 survived. What a person would have received was silence, from a
 * model advertised at 18 of 20.
 *
 * And it is measured **through the daemon**, not against the model in
 * isolation — enable it, write the notes, ask the questions over the socket,
 * take what comes back. That distinction cost a wrong number once already: the
 * recommended model clears its own floor on 16 of 20 when scored on cosine
 * alone, and returns 14 through the bus, because the vector ranking is fused
 * with the lexical one by reciprocal rank and fusion can reorder a winner. The
 * offline figure describes the model; only this one describes what a person
 * receives, which is what the listing promises.
 *
 * ```
 *                          score   over the     noise     RAM     disk   ms/note
 *                         (of 20)   floor      (of 380)
 *   the lexical floor         5        —          —        —       —       —
 *   embeddinggemma-300m      14       +9         8.2%   540 MB  209 MB   10
 *   multilingual-e5-small     9       +4         8.7%   800 MB  129 MB    4
 *   potion-base-32M           6       +1        15.5%   820 MB  230 MB    0.02
 *   potion-base-8M            6       +1        15.3%   250 MB   54 MB    0.01
 *   potion-base-2M            5        0         8.9%    90 MB   14 MB    0.01
 * ```
 *
 * Three things in that table are worth not skipping. `potion-base-2M` scores
 * exactly what no model at all scores: it costs disk and returns the floor's
 * own answers. The largest static costs **more memory than the recommended
 * encoder** for a third of the improvement — a vocabulary that size is a very
 * large JavaScript object, and "no runtime" was never the same as "cheap". And
 * `multilingual-e5-small` costs the most memory of anything here, which is the
 * opposite of what its disk footprint suggests.
 *
 * The `noise` column is measured offline, and is the one number here that
 * still is: it is a property of the model's own geometry — every question
 * against every note that does not answer it, 380 pairs — and it is what sets
 * each encoder's floor.
 *
 * HOW EACH ENCODER FLOOR WAS CHOSEN. Not by taste, and not by inheriting the
 * statics' four sigma — that silences an encoder almost completely. The rule is
 * a rule so that the next entry is not an argument: **take the highest recall
 * whose noise is no worse than the quietest model already shipping**, which is
 * `potion-base-2M` at 8.9%. Both encoders land on 1.5 sigma under it. Each
 * entry carries its own sweep, so the choice can be checked rather than
 * trusted.
 *
 * Twenty questions separates a good model from a weak one. It does not
 * separate two models a point apart, and this table should not be read as if
 * it did.
 */
export const MODELS: BrainModel[] = [
  {
    name: "embeddinggemma-300m",
    kind: "encoder",
    dims: 768,
    score: 14,
    ramMB: 540,
    msPerNote: 10,
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
    },
  },
  {
    name: "multilingual-e5-small",
    kind: "encoder",
    dims: 384,
    score: 9,
    // More memory than embeddinggemma, for fewer answers — the one number here
    // that surprises people, and the reason this entry is not the "light" one
    // it looks like. What it actually costs less of is disk and time.
    ramMB: 800,
    msPerNote: 4,
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
      floor: 0.834,
    },
  },
  // Below here: no runtime, no install, and they work from the bare binary.
  // That is a real thing to want, and people already have these enabled — but
  // they are not competitive on answers, and the scores say so.
  {
    name: "potion-base-32M",
    kind: "static",
    ramMB: 820,
    msPerNote: 0.02,
    dims: 512,
    score: 6,
    bytes: 241_275_225,
    url: "https://github.com/marcus-campos/parley/releases/download/v0.7.3/potion-base-32M.json",
    sha256: "f13a7eb79e26ca4863046e1a9f177bb4a99ac79c1cb834bbdac40458ab5af289",
    tokenizer: "wordlevel",
  },
  {
    name: "potion-base-8M",
    kind: "static",
    ramMB: 250,
    msPerNote: 0.01,
    dims: 256,
    score: 6,
    bytes: 56_905_102,
    url: "https://github.com/marcus-campos/parley/releases/download/v0.7.0/potion-base-8M.json",
    sha256: "189d1e8b67a5394ab4be1655adc4dcb8c8850b510aa1b0773d0f333eabd66c47",
    tokenizer: "wordlevel",
  },
  {
    name: "potion-base-2M",
    kind: "static",
    ramMB: 90,
    msPerNote: 0.01,
    dims: 64,
    score: 5,
    bytes: 14_758_931,
    url: "https://github.com/marcus-campos/parley/releases/download/v0.7.3/potion-base-2M.json",
    sha256: "04669e9bd91b6bf1c0cebb6b6cd397cb2ea1fd9cdf7084cd805b193c5fdd0235",
    tokenizer: "wordlevel",
  },
];

/** The one `brain enable` names when nobody picks. */
export const RECOMMENDED = "embeddinggemma-300m";

// Two models were measured and left out, for reasons worth keeping.
//
// `multilingual-e5-small` looked like the obvious light entry — 129 MB against
// embeddinggemma's 209, and three times faster per note. It is absent because
// its right answers and its wrong ones are not separable: its true matches
// score 0.79 to 0.87 while unrelated pairs average 0.79. No floor keeps the
// first and refuses the second — every threshold either returned noise or
// returned nothing. That is a model that cannot be given a floor, rather than
// one that needs a better floor.
//
// `snowflake-arctic-embed-l-v2` is genuinely strong, and the best of the set at
// Portuguese. It is 1.2 GB — six times embeddinggemma, for fewer answers.
// Dominated on both axes, so listing it would only make a longer menu.
//
// `potion-multilingual-128M` is still absent for its original reason: its
// tokenizer is XLM-R and this build's static loader carries only wordlevel. The
// encoder path makes it far less interesting than it was, since that path
// brings its own tokenizer and outscores it — but the note stays, because the
// next person to reach for it deserves to know it was considered.

export function findModel(name: string): BrainModel | undefined {
  return MODELS.find((m) => m.name === name);
}

/** Narrowing helpers, so call sites read as intent rather than as a tag check. */
export function isEncoder(m: BrainModel): m is EncoderBrainModel {
  return m.kind === "encoder";
}

export function isStatic(m: BrainModel): m is StaticBrainModel {
  return m.kind === "static";
}
