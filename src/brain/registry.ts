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
 * Fill in the real sha256 for each entry when the asset is published; the tests
 * assert the shape, and the downloader refuses anything that does not match.
 */
export const MODELS: BrainModel[] = [
  {
    name: "potion-multilingual-128M-int8",
    dims: 256,
    languages: "101 languages, including Portuguese",
    bytes: 100 * 1024 * 1024,
    url: "https://huggingface.co/minishlab/potion-multilingual-128M/resolve/main/model.safetensors",
    sha256: "0".repeat(64),
    tokenizer: "xlmr",
  },
];

export function findModel(name: string): BrainModel | undefined {
  return MODELS.find((m) => m.name === name);
}
