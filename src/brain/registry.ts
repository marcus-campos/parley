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
    // model2vec's potion-base-8M, converted to the flat `{dims, vocab}` shape
    // `loadStaticModel` reads. The published safetensors is not that shape, and
    // a registry entry whose file the loader cannot parse is an entry that
    // refuses every download that would have worked.
    name: "potion-base-8M",
    dims: 256,
    languages: "English — strongest on identifiers, file names and code prose",
    bytes: 56_905_102,
    url: "https://github.com/marcus-campos/parley/releases/download/v0.7.0/potion-base-8M.json",
    sha256: "189d1e8b67a5394ab4be1655adc4dcb8c8850b510aa1b0773d0f333eabd66c47",
    tokenizer: "wordlevel",
  },
];

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
