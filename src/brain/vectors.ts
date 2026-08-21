import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hit } from "./lexical";
import { VectorIndex } from "./embed";

const FILE_NAME = "vectors.json";

/**
 * Persistence only — no maths lives here. `embed.ts` is the pure,
 * fully-testable half; this is the I/O half, held to the same standard
 * `download.ts` already sets for that line: every read degrades to `null`
 * rather than throwing, so a broken or missing file never stops the daemon
 * booting — it just re-embeds from `state` instead (see `server.ts`).
 *
 * Each component is quantized to a signed byte, scaled per vector so the
 * full int8 range is used regardless of the model's own value range —
 * cheap on disk, and the scale factor makes the loss just quantization
 * noise rather than clipping.
 */
interface StoredEntry { id: string; kind: Hit["kind"]; scale: number; values: number[] }
interface StoredFile { dims: number; entries: StoredEntry[] }

const INT8_MAX = 127;

function quantize(vec: Float32Array): { scale: number; values: number[] } {
  let max = 0;
  for (const x of vec) max = Math.max(max, Math.abs(x));
  const scale = max === 0 ? 1 : max / INT8_MAX;
  return { scale, values: Array.from(vec, (x) => Math.round(x / scale)) };
}

function dequantize(entry: StoredEntry, dims: number): Float32Array {
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = (entry.values[i] ?? 0) * entry.scale;
  return out;
}

export function saveVectors(dir: string, index: VectorIndex): void {
  const entries: StoredEntry[] = index.all().map(({ id, vec, kind }) => {
    const { scale, values } = quantize(vec);
    return { id, kind, scale, values };
  });
  const file: StoredFile = { dims: index.dims, entries };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FILE_NAME), JSON.stringify(file), "utf8");
}

function isStoredFile(value: unknown, dims: number): value is StoredFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.dims !== dims || !Array.isArray(v.entries)) return false;
  const validKinds: readonly string[] = ["note", "decision", "result"];
  return v.entries.every(
    (e): e is StoredEntry =>
      typeof e === "object" && e !== null &&
      typeof (e as StoredEntry).id === "string" &&
      validKinds.includes((e as StoredEntry).kind) &&
      typeof (e as StoredEntry).scale === "number" &&
      Array.isArray((e as StoredEntry).values) &&
      // The same check `loadStaticModel` already applies to a vocabulary row
      // (embed.ts) — reused here rather than a second one: a syntactically
      // valid file whose values are not actually numbers (`["x","y"]`) must
      // not load, because `dequantize` would multiply straight through to a
      // NaN similarity that corrupts every ranking it touches, silently.
      (e as StoredEntry).values.every((x) => typeof x === "number"),
  );
}

/**
 * `dims` is the caller's own expectation — the active model's — not a value
 * trusted from the file. A file saved by a different model (a different
 * `dims`) is refused wholesale rather than partially misread: reloading it
 * quietly would mix vectors from two different embedding spaces into one
 * index, corrupting every similarity score it produces from then on.
 */
export function loadVectors(dir: string, dims: number): VectorIndex | null {
  try {
    const path = join(dir, FILE_NAME);
    if (!existsSync(path)) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isStoredFile(parsed, dims)) return null;
    const index = new VectorIndex(dims);
    for (const entry of parsed.entries) index.add(entry.id, dequantize(entry, dims), entry.kind);
    return index;
  } catch {
    return null;
  }
}
