import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVectors, saveVectors } from "../../src/brain/vectors";
import { VectorIndex } from "../../src/brain/embed";

// Every test injects its own throwaway directory — never the real
// machine-local state dir, the same discipline `download.ts` already keeps.
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "parley-vectors-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persisting the int8 vectors beside the journal", () => {
  test("a saved index reloads with the same neighbours", () => {
    const dir = tempDir();
    const index = new VectorIndex(2);
    index.add("n_1", new Float32Array([1, 0]), "note");
    index.add("n_2", new Float32Array([0, 1]), "result");
    saveVectors(dir, index);

    const reloaded = loadVectors(dir, 2);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.search(new Float32Array([1, 0]), 1)[0]!.id).toBe("n_1");
    expect(reloaded!.search(new Float32Array([1, 0]), 1)[0]!.kind).toBe("note");
    expect(reloaded!.search(new Float32Array([0, 1]), 1)[0]!.id).toBe("n_2");
    expect(reloaded!.search(new Float32Array([0, 1]), 1)[0]!.kind).toBe("result");
  });

  test("removing an id and re-saving is honoured on reload", () => {
    const dir = tempDir();
    const index = new VectorIndex(2);
    // Both share a positive-cosine direction with the query below, so a
    // failure to actually remove `n_1` (rather than the query simply not
    // matching it) is what this test would catch.
    index.add("n_1", new Float32Array([1, 1]));
    index.add("n_2", new Float32Array([1, 2]));
    index.remove("n_1");
    saveVectors(dir, index);

    const reloaded = loadVectors(dir, 2);
    expect(reloaded!.search(new Float32Array([1, 1]), 5).map((h) => h.id)).toEqual(["n_2"]);
  });

  test("nothing on disk yet degrades to null, not a throw", () => {
    const dir = tempDir();
    expect(loadVectors(dir, 2)).toBeNull();
  });

  test("a dims mismatch against the requested model refuses the file rather than misreading it", () => {
    const dir = tempDir();
    const index = new VectorIndex(2);
    index.add("n_1", new Float32Array([1, 0]));
    saveVectors(dir, index);

    expect(loadVectors(dir, 3)).toBeNull();
  });

  test("a corrupt file loads as null instead of throwing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "vectors.json"), "{ not json", "utf8");
    expect(loadVectors(dir, 2)).toBeNull();
  });

  /**
   * A syntactically valid file whose quantized `values` are not actually
   * numbers must not load. `dequantize` (vectors.ts) multiplies each stored
   * value by its scale with no further check — a string sneaking through
   * would produce a genuine `NaN` similarity at search time, silently
   * corrupting every ranking it touches. Reproduces the review's exact
   * finding.
   */
  test("a file whose quantized values are not numbers loads as null, never a NaN vector", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "vectors.json"),
      JSON.stringify({ dims: 2, entries: [{ id: "n_1", kind: "note", scale: 1, values: ["x", "y"] }] }),
      "utf8",
    );
    expect(loadVectors(dir, 2)).toBeNull();
  });
});
