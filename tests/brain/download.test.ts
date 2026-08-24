// tests/brain/download.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureModel, modelPath } from "../../src/brain/download";
import type { StaticBrainModel } from "../../src/brain/registry";

const body = new TextEncoder().encode("pretend this is a model");
const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");

const model = (sha: string): StaticBrainModel => ({
  name: "test-model", kind: "static", dims: 4, score: 1, ramMB: 1, msPerNote: 1, bytes: body.length,
  url: "https://example.invalid/model.bin", sha256: sha, tokenizer: "wordlevel",
});

const okFetch = (async () => new Response(body)) as unknown as typeof fetch;

describe("getting a model onto the machine", () => {
  // A suite that mutates a developer's real machine-local state directory is
  // a trap someone will fall into (the same finding filed against the last
  // branch's adapter-registry tests) — every test that touches disk gets its
  // own throwaway directory, injected via the optional base-directory
  // parameter, instead of the real `models` folder under the OS state dir.
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "parley-brain-test-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("a good download lands in the machine-local state directory, not in the repository", async () => {
    const path = await ensureModel(model(digest), okFetch, base);
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(path!).not.toContain(process.cwd());
  });

  test("a checksum mismatch deletes the file and returns null", async () => {
    const bad = model("f".repeat(64));
    const path = await ensureModel(bad, okFetch, base);
    expect(path).toBeNull();
    expect(existsSync(modelPath(bad, base))).toBe(false);
  });

  test("a network failure returns null and never throws", async () => {
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await ensureModel(model(digest), failing, base)).toBeNull();
  });

  test("an HTTP error is a failure, not a zero-byte model", async () => {
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await ensureModel(model(digest), notFound, base)).toBeNull();
    expect(existsSync(modelPath(model(digest), base))).toBe(false);
  });

  test("a model already on disk is not downloaded again", async () => {
    let calls = 0;
    const counting = (async () => { calls++; return new Response(body); }) as unknown as typeof fetch;
    await ensureModel(model(digest), counting, base);
    await ensureModel(model(digest), counting, base);
    expect(calls).toBe(1);
  });

  test("one download serves every repository — it is a fact about the machine", () => {
    // No base directory here: this asserts the real, production default —
    // safe because modelPath is pure path arithmetic and performs no I/O.
    expect(modelPath(model(digest))).toContain("models");
    expect(modelPath(model(digest))).not.toContain(process.cwd());
  });
});
