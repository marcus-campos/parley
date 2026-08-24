/**
 * The encoder sidecar: its source, and how it gets installed.
 *
 * This file carries the worker as a string rather than as a module, because it
 * must survive `bun build --compile`. The compiled binary is one file with no
 * `node_modules` beside it; a worker that ran as an import would need
 * `@huggingface/transformers` linked into that binary, and that package pulls
 * `onnxruntime-node` — a native addon, which is the one thing a single-file
 * build cannot swallow.
 *
 * So the worker is text here, written to disk on `brain enable`, and run by a
 * `bun` that the person already has. That is the whole reason encoders are an
 * opt-in extra while the static models are not: statics are JSON, and JSON
 * fits inside the binary.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encoderDir } from "./encoder";
import type { EncoderBrainModel, EncoderSpec } from "./registry";

/**
 * The pinned version of the runtime the sidecar installs.
 *
 * Pinned rather than floating because this is somebody's machine downloading a
 * native addon: a range means the thing that worked on Tuesday can stop working
 * on Wednesday for a reason nobody in this repository changed.
 */
export const TRANSFORMERS_VERSION = "4.2.0";

/**
 * Packages whose install scripts are allowed to run, named one by one.
 *
 * `onnxruntime-node` genuinely needs its postinstall — that is what fetches the
 * native library for this platform, and without it the sidecar imports and then
 * dies. Bun blocks lifecycle scripts by default, which is the right default and
 * exactly why this list is explicit instead of `--all`: these two are the ones
 * this feature needs, and a transitive dependency that starts wanting to run
 * code at install time should have to be added here on purpose.
 */
const TRUSTED = ["onnxruntime-node", "protobufjs"];

const SERVE_TS = String.raw`
// Written by "parley brain enable". Edits here are lost on the next enable.
//
// One model, held in memory, answering NDJSON on stdin. The daemon spawns this
// and keeps it; loading the model costs seconds and embedding a text costs
// milliseconds, so the process outliving the request is the entire point.
import { AutoModel, AutoTokenizer, env } from "@huggingface/transformers";

const spec = JSON.parse(process.argv[2] ?? "{}");

// Where the weights live. transformers.js defaults to a directory inside its
// own package, which a reinstall is free to blow away — and that would
// silently re-download 200 MB. This puts them beside the sidecar instead,
// where they survive a reinstall and a person can find and delete them.
if (spec.cacheDir) env.cacheDir = spec.cacheDir;

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let model, tokenizer;
try {
  tokenizer = await AutoTokenizer.from_pretrained(spec.repo);
  model = await AutoModel.from_pretrained(spec.repo, spec.dtype ? { dtype: spec.dtype } : {});
} catch (e) {
  process.stderr.write("could not load " + spec.repo + ": " + (e && e.message) + "\n");
  process.exit(1);
}

// One text per forward pass, deliberately.
//
// Batching pads every sequence to the longest in the batch, and mean pooling
// then averages over the padding. That corrupts short inputs specifically —
// which is what a query is. Measured during selection: batched pooling cost
// several points of accuracy against the same model run one text at a time.
async function embed(text, isQuery) {
  const prefix = isQuery ? (spec.queryPrefix ?? "") : (spec.passagePrefix ?? "");
  const inputs = await tokenizer(prefix + text);
  const out = await model(inputs);
  const hidden = out.last_hidden_state ?? out.token_embeddings;
  const [, seq, dim] = hidden.dims;
  const data = hidden.data;
  const mask = inputs.attention_mask.data;
  const vec = new Array(dim).fill(0);

  if (spec.pool === "cls") {
    for (let d = 0; d < dim; d++) vec[d] = data[d];
  } else if (spec.pool === "last") {
    let last = 0;
    for (let s = 0; s < seq; s++) if (Number(mask[s]) === 1) last = s;
    for (let d = 0; d < dim; d++) vec[d] = data[last * dim + d];
  } else {
    let n = 0;
    for (let s = 0; s < seq; s++) {
      if (Number(mask[s]) !== 1) continue;
      n++;
      for (let d = 0; d < dim; d++) vec[d] += data[s * dim + d];
    }
    for (let d = 0; d < dim; d++) vec[d] /= Math.max(1, n);
  }

  // Normalised here, once, so cosine similarity downstream is a dot product
  // and nothing on the daemon side has to remember to do it.
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += vec[d] * vec[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) vec[d] /= norm;
  return vec;
}

// Truncation is the sidecar's own guard, not the daemon's: a note is whatever
// somebody wrote, and a pathological one must slow this process down rather
// than wedge it. The number is well past any real note.
const MAX_CHARS = 8000;

// Emitted before stdin is wired, and that ordering is load-bearing. A stdin
// that has already closed — which is exactly how the installer warms this —
// fires "end" the moment a handler is attached, and the process would exit
// before proving it can embed anything. Ready first, then listen.
reply({ ready: true, dims: (await embed("ready", false)).length });

let queue = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    // Serialised: onnxruntime sessions are not re-entrant, and interleaving
    // two forward passes on one session is how you get a crash that looks
    // like a bad model instead of a bad caller.
    queue = queue.then(async () => {
      try {
        const vectors = [];
        for (const text of req.texts ?? []) {
          vectors.push(await embed(String(text).slice(0, MAX_CHARS), req.kind === "query"));
        }
        reply({ id: req.id, vectors });
      } catch (e) {
        reply({ id: req.id, error: (e && e.message) || "embed failed" });
      }
    });
  }
});

process.stdin.on("end", () => process.exit(0));
`;

const PACKAGE_JSON = (version: string): string =>
  `${JSON.stringify(
    {
      name: "parley-encoder",
      private: true,
      type: "module",
      dependencies: { "@huggingface/transformers": version },
      trustedDependencies: TRUSTED,
    },
    null,
    2,
  )}\n`;

/**
 * The spec as the sidecar receives it: the registry's, plus where to keep the
 * weights. The daemon and the installer must pass the same thing, or the
 * daemon re-downloads what the installer already fetched.
 */
export function specFor(dir: string, model: EncoderBrainModel): EncoderSpec & { cacheDir: string } {
  return { ...model.spec, cacheDir: join(dir, "weights") };
}

export interface InstallOutcome {
  ok: boolean;
  /** Plain enough to print at somebody's terminal. */
  error?: string;
}

/** Is `bun` on PATH? The sidecar is TypeScript on disk; something must run it. */
export function bunAvailable(runner: typeof spawnSync = spawnSync): boolean {
  try {
    return runner("bun", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Put the sidecar on disk and install its dependency.
 *
 * Idempotent: the files are rewritten every time (so an upgraded parley
 * refreshes a stale worker) but `bun install` is skipped when `node_modules`
 * is already there, because that is the part that costs a network round trip.
 *
 * Returns an outcome rather than throwing. Everything a caller can do about a
 * failure here is tell the person and leave the brain off.
 */
export function installEncoder(
  modelsDir: string | undefined,
  model: EncoderBrainModel,
  runner: typeof spawnSync = spawnSync,
): InstallOutcome {
  const dir = encoderDir(modelsDir);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "serve.ts"), SERVE_TS);
    writeFileSync(join(dir, "package.json"), PACKAGE_JSON(TRANSFORMERS_VERSION));

    if (!existsSync(join(dir, "node_modules"))) {
      const installed = runner("bun", ["install"], { cwd: dir, stdio: "inherit" });
      if (installed.status !== 0) {
        return { ok: false, error: "bun install failed in the encoder directory" };
      }
      // Bun blocks lifecycle scripts on a fresh install even when
      // `trustedDependencies` names them, so this runs them explicitly. It is
      // a no-op when the packages are already built.
      runner("bun", ["pm", "trust", ...TRUSTED], { cwd: dir, stdio: "inherit" });
    }

    // Warm the model here, at the terminal, where a person can watch a 200 MB
    // download happen and cancel it. Doing it lazily would move that same
    // download inside the daemon, where the only symptom is a brain that is
    // inexplicably not answering yet.
    const warmed = runner("bun", [join(dir, "serve.ts"), JSON.stringify(specFor(dir, model))], {
      cwd: dir,
      stdio: ["pipe", "pipe", "inherit"],
      // Empty stdin: the worker says ready, then sees the stream end and exits.
      input: "",
      timeout: 30 * 60 * 1000,
      maxBuffer: 1024 * 1024,
    });

    // The exit code is not the check, and trusting it was a real defect: the
    // worker exits 0 on a closed stdin whether or not it ever loaded anything,
    // so a broken model reported a successful install and the person was told
    // the brain was on. What proves the install is the worker saying `ready`
    // with a width — it can only do that after a forward pass has run.
    if (warmed.status !== 0 || !String(warmed.stdout ?? "").includes(`"ready":true`)) {
      return { ok: false, error: `${model.name} downloaded but could not produce an embedding` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
