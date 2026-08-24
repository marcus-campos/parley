import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encoderDir, encoderInstalled, startEncoder } from "../../src/brain/encoder";
import type { EncoderBrainModel } from "../../src/brain/registry";

/**
 * These spawn a real process and speak the real protocol over real pipes —
 * they just do it to a sidecar that answers arithmetic instead of loading a
 * transformer.
 *
 * A mocked `spawn` would have proven that this file's own code calls its own
 * code. What can actually break here is the seam: line framing across chunk
 * boundaries, a ready handshake that never comes, a child that dies holding
 * somebody's request. All three need a process on the other end, and none of
 * them need onnxruntime.
 */

const MODEL: EncoderBrainModel = {
  name: "fake", kind: "encoder", dims: 3, score: 1, ramMB: 1, msPerNote: 1, bytes: 1,
  spec: { repo: "fake/fake", pool: "mean", queryPrefix: "q:", passagePrefix: "p:", floor: 0.5 },
};

/** A models directory with a sidecar in it that behaves as `body` says. */
function plantSidecar(body: string): string {
  const modelsDir = mkdtempSync(join(tmpdir(), "parley-enc-"));
  const dir = encoderDir(modelsDir);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "serve.ts"), body);
  return modelsDir;
}

/**
 * The honest sidecar: says ready, then answers each line with vectors derived
 * from the text so a test can tell one answer from another — and prefixes,
 * which is what proves the query/passage distinction survives the wire.
 */
const HONEST = `
const spec = JSON.parse(process.argv[2]);
const reply = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    const prefix = req.kind === "query" ? spec.queryPrefix : spec.passagePrefix;
    reply({ id: req.id, vectors: req.texts.map((t) => [(prefix + t).length, t.length, 1]) });
  }
});
reply({ ready: true, dims: 3 });
`;

describe("talking to an encoder that lives in another process", () => {
  test("nothing is spawned when nothing is installed", () => {
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-enc-"));
    expect(encoderInstalled(modelsDir)).toBe(false);
    expect(startEncoder(modelsDir, MODEL)).toBeNull();
  });

  test("a serve.ts without its dependencies is not an install", () => {
    // Half an install is the state a cancelled `bun install` leaves behind.
    // Spawning into it would fail at the import, which reads to a person as a
    // broken model rather than an incomplete install.
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-enc-"));
    mkdirSync(encoderDir(modelsDir), { recursive: true });
    writeFileSync(join(encoderDir(modelsDir), "serve.ts"), HONEST);
    expect(encoderInstalled(modelsDir)).toBe(false);
  });

  test("it waits for ready, then embeds — and the prefixes reach the far side", async () => {
    const handle = startEncoder(plantSidecar(HONEST), MODEL)!;
    expect(handle).not.toBeNull();

    const passages = await handle.encode("passage", ["abcd"]);
    // `p:` + `abcd` is 6 characters; the text alone is 4. The sidecar was told
    // which prefix to use by the spec it was spawned with, so this asserts the
    // spec survived argv, and that a passage was not silently sent as a query.
    expect(passages).toEqual([[6, 4, 1]]);

    const queries = await handle.encode("query", ["abcd"]);
    expect(queries).toEqual([[6, 4, 1]]);
    expect(handle.dims()).toBe(3);
    handle.close();
  });

  test("several texts in one call come back in the order they were sent", async () => {
    // The daemon matches vectors to ids by position. A sidecar that answered
    // out of order would attach every note's vector to a different note, and
    // recall would be confidently wrong rather than absent.
    const handle = startEncoder(plantSidecar(HONEST), MODEL)!;
    const out = await handle.encode("passage", ["a", "bb", "ccc"]);
    expect(out?.map((v) => v[1])).toEqual([1, 2, 3]);
    handle.close();
  });

  test("answers arriving split across chunks are still parsed", async () => {
    // Pipes do not respect message boundaries. This sidecar writes one byte at
    // a time, which is the pathological version of what a large vector does
    // naturally.
    const handle = startEncoder(
      plantSidecar(`
        const reply = (o) => { for (const ch of JSON.stringify(o) + "\\n") process.stdout.write(ch); };
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            reply({ id: JSON.parse(line).id, vectors: [[1, 2, 3]] });
          }
        });
        reply({ ready: true, dims: 3 });
      `),
      MODEL,
    )!;
    expect(await handle.encode("passage", ["x"])).toEqual([[1, 2, 3]]);
    handle.close();
  });

  test("a sidecar that never becomes ready gives up instead of hanging", async () => {
    const handle = startEncoder(plantSidecar(`setTimeout(() => {}, 60_000);`), MODEL, {
      readyTimeoutMs: 300,
    })!;
    expect(await handle.encode("passage", ["x"])).toBeNull();
    handle.close();
  });

  test("a sidecar that dies mid-request answers null rather than leaving a promise open", async () => {
    // The failure this is really about is a hung caller. `queryVector` awaits
    // this, and `handle` awaits `queryVector`, so a promise that never settles
    // would stall that connection's whole frame chain — a dead model taking
    // the bus down with it, which is the one thing that must not happen.
    const handle = startEncoder(
      plantSidecar(`
        const reply = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
        process.stdin.on("data", () => process.exit(1));
        reply({ ready: true, dims: 3 });
      `),
      MODEL,
    )!;
    expect(await handle.encode("passage", ["x"])).toBeNull();
  });

  test("a sidecar that answers nonsense is treated as no answer", async () => {
    // Wrong count, not an error field: the daemon zips vectors to ids by
    // index, so a short array would shift every remaining note's vector onto
    // the wrong note.
    const handle = startEncoder(
      plantSidecar(`
        const reply = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            reply({ id: JSON.parse(line).id, vectors: [[1, 2, 3]] });
          }
        });
        reply({ ready: true, dims: 3 });
      `),
      MODEL,
    )!;
    expect(await handle.encode("passage", ["a", "b"])).toBeNull();
    handle.close();
  });

  test("noise on the sidecar's stdout does not break the answers after it", async () => {
    // A dependency that logs to stdout would otherwise desynchronise the
    // stream permanently.
    const handle = startEncoder(
      plantSidecar(`
        const reply = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
        process.stdout.write("loading weights...\\n");
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            process.stdout.write("not json at all\\n");
            reply({ id: JSON.parse(line).id, vectors: [[9, 9, 9]] });
          }
        });
        reply({ ready: true, dims: 3 });
      `),
      MODEL,
    )!;
    expect(await handle.encode("passage", ["x"])).toEqual([[9, 9, 9]]);
    handle.close();
  });

  test("a closed handle stays closed", async () => {
    const handle = startEncoder(plantSidecar(HONEST), MODEL)!;
    expect(await handle.encode("passage", ["x"])).toEqual([[3, 1, 1]]);
    handle.close();
    expect(await handle.encode("passage", ["x"])).toBeNull();
  });

  test("embedding nothing asks nothing", async () => {
    const handle = startEncoder(plantSidecar(HONEST), MODEL)!;
    expect(await handle.encode("passage", [])).toBeNull();
    handle.close();
  });
});
