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
    // Not "-int8": there is no int8 asset in that repository, and the URL
    // below serves the full-precision weights. The name promised a file that
    // does not exist.
    name: "potion-multilingual-128M",
    dims: 256,
    languages: "101 languages, including Portuguese",
    bytes: 512_361_560,
    url: "https://huggingface.co/minishlab/potion-multilingual-128M/resolve/main/model.safetensors",
    sha256: "14b5eb39cb4ce5666da8ad1f3dc6be4346e9b2d601c073302fa0a31bf7943397",
    tokenizer: "xlmr",
  },
];

export function findModel(name: string): BrainModel | undefined {
  return MODELS.find((m) => m.name === name);
}
