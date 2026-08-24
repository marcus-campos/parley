export interface BrainModel {
  name: string;
  dims: number;
  /** Human-readable, shown at the prompt before anyone agrees to a download. */
  languages: string;
  bytes: number;
  url: string;
  sha256: string;
  /** `wordlevel` needs only a regex split. `xlmr` needs a real tokenizer. */
  tokenizer: "wordlevel" | "xlmr";
}

/**
 * Static models only.
 *
 * A token lookup table plus pooling: deterministic, microseconds, and no
 * per-platform native runtime — which is what keeps the Windows, WSL and arm64
 * work intact. Transformer models are excluded on all three counts.
 *
 * `sha256` and `bytes` are the published asset's, read from the host's own
 * metadata rather than guessed: the hash is what the downloader refuses on, and
 * the size is what a person is shown before they agree to spend their disk. A
 * placeholder in either is worse than no entry — one refuses every download
 * that would have worked, and the other asks for consent against a number that
 * is not the number.
 */
export const MODELS: BrainModel[] = [
  {
    name: "potion-base-32M",
    dims: 512,
    languages: "English and Portuguese — the one to take unless the disk hurts",
    // Measured, not guessed. On a 20-question / 20-note bilingual benchmark of
    // the thing parley actually does — an agent asks, a note answers — this
    // returns 19 of 20 correct answers past the floor against the 8M's 15, with
    // the same top-1 ranking. What it buys is answers the smaller one swallows.
    bytes: 241_275_225,
    url: "https://github.com/marcus-campos/parley/releases/download/v0.7.3/potion-base-32M.json",
    sha256: "f13a7eb79e26ca4863046e1a9f177bb4a99ac79c1cb834bbdac40458ab5af289",
    tokenizer: "wordlevel",
  },
  {
    name: "potion-base-8M",
    dims: 256,
    languages: "English and Portuguese — a quarter of the disk, most of the answers",
    bytes: 56_905_102,
    url: "https://github.com/marcus-campos/parley/releases/download/v0.7.0/potion-base-8M.json",
    sha256: "189d1e8b67a5394ab4be1655adc4dcb8c8850b510aa1b0773d0f333eabd66c47",
    tokenizer: "wordlevel",
  },
  {
    name: "potion-base-2M",
    dims: 64,
    languages: "English — small enough for a laptop that is already struggling",
    // Kept honest: on the same benchmark this one is weak, and the listing says
    // so. It is here for a machine where 230 MB is not a trade somebody wants
    // to make, not because it is a good answer.
    bytes: 14_758_931,
    url: "https://github.com/marcus-campos/parley/releases/download/v0.7.3/potion-base-2M.json",
    sha256: "04669e9bd91b6bf1c0cebb6b6cd397cb2ea1fd9cdf7084cd805b193c5fdd0235",
    tokenizer: "wordlevel",
  },
];

/** The one `brain enable` takes when nobody names one. */
export const RECOMMENDED = "potion-base-32M";

// potion-multilingual-128M is deliberately absent, and it is the one somebody
// writing Portuguese would reach for. Its tokenizer is XLM-R, which this build
// does not carry; converting it to whole words instead — measured — scores
// WORSE than potion-base-8M in Portuguese, because half the Portuguese
// vocabulary only exists as subword pieces and whole-word extraction drops it.
// Bring it back with real Unigram segmentation, not before.

// potion-multilingual-128M is deliberately absent. It is a real model and it is
// the one somebody writing Portuguese notes would want — but its tokenizer is
// XLM-R, which this build does not carry, so listing it means a person reads the
// name they want, types it, and is refused. A menu whose only entry cannot be
// chosen is worse than a shorter menu: it teaches that the feature is broken
// rather than that this build is narrower than the field.
//
// Bring it back with an XLM-R tokenizer, not before.

export function findModel(name: string): BrainModel | undefined {
  return MODELS.find((m) => m.name === name);
}
