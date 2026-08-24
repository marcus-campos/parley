import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultModelsDir } from "./download";
import type { EncoderBrainModel } from "./registry";
import { specFor } from "./sidecar";

/**
 * A transformer encoder, in a process of its own.
 *
 * The static models this repository shipped first are a table lookup: no
 * runtime, no native code, and they fit inside `bun build --compile` because
 * they are just JSON. An encoder is not. It needs onnxruntime, which is a
 * native addon, and a native addon cannot be embedded in a single compiled
 * binary — so the choice was either to stop shipping one binary, or to keep the
 * encoder outside it.
 *
 * It lives outside. `parley brain enable` installs it beside the model; the
 * daemon spawns it and talks over stdin/stdout in NDJSON, the same shape the
 * bus itself speaks. If it is missing, slow, or dies mid-sentence, every path
 * here answers `null` and the lexical floor takes the query — which is the rule
 * that outranks the feature: a broken parley must never stop the work.
 *
 * Why a long-lived process rather than one invocation per embedding: loading
 * the model costs between 0.4 and 17 seconds depending on which one somebody
 * chose, and embedding a note costs 3 to 12 milliseconds. Paying the load once
 * is the whole difference between a brain that answers and a brain nobody
 * waits for.
 */

/** What the sidecar is asked, and what it answers. One line of JSON each way. */
interface EncodeRequest {
  id: number;
  /** `query` and `passage` are different for asymmetric models — see PREFIXES. */
  kind: "query" | "passage";
  texts: string[];
}

interface EncodeResponse {
  id: number;
  vectors?: number[][];
  error?: string;
}

/**
 * How long to wait before deciding the sidecar is not coming.
 *
 * Generous on purpose. This never runs on the hook path — notes are embedded by
 * the daemon in the background and a query already has its lexical answer in
 * hand — so the cost of waiting is a slower semantic result, while the cost of
 * giving up early is no semantic result at all.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long a cold start may take before the whole thing is written off. */
const READY_TIMEOUT_MS = 120_000;

export interface EncoderHandle {
  /** Embed text. `null` on any failure, never a throw. */
  encode(kind: "query" | "passage", texts: string[]): Promise<number[][] | null>;
  /** Vector width, known only once the sidecar has said hello. */
  dims(): number | null;
  close(): void;
}

/**
 * Where `brain enable` puts the sidecar.
 *
 * `baseDir` defaults to the same machine-local models directory the static
 * downloader uses, so one install serves every repository — and tests pass a
 * throwaway directory instead of writing into a developer's real state.
 */
export function encoderDir(baseDir?: string): string {
  return join(baseDir ?? defaultModelsDir(), "encoder");
}

/** Is an encoder installed and ready to be spawned? */
export function encoderInstalled(modelsDir?: string): boolean {
  return existsSync(join(encoderDir(modelsDir), "serve.ts"))
    && existsSync(join(encoderDir(modelsDir), "node_modules"));
}

/**
 * Start the sidecar and return a handle.
 *
 * Returns `null` rather than throwing when it cannot start — a missing install,
 * a `bun` that is not on PATH, a model that will not load. Every one of those
 * is a degrade, not an error: the caller already has a lexical answer.
 */
export function startEncoder(
  modelsDir: string | undefined,
  model: EncoderBrainModel,
  opts: { spawnFn?: typeof spawn; readyTimeoutMs?: number } = {},
): EncoderHandle | null {
  const dir = encoderDir(modelsDir);
  if (!encoderInstalled(modelsDir)) return null;

  let child: ChildProcess;
  try {
    // The same spec the installer warmed with — weights included. A daemon
    // that passed only `model.spec` would look in transformers' own default
    // directory, find nothing, and quietly re-download 200 MB.
    child = (opts.spawnFn ?? spawn)("bun", [join(dir, "serve.ts"), JSON.stringify(specFor(dir, model))], {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }

  let dims: number | null = null;
  let dead = false;
  let nextId = 1;
  const waiting = new Map<number, (r: EncodeResponse) => void>();
  let buffer = "";

  const die = (why: string): void => {
    if (dead) return;
    dead = true;
    process.stderr.write(`parley: the encoder stopped (${why}) — the lexical floor is answering\n`);
    for (const settle of waiting.values()) settle({ id: -1, error: why });
    waiting.clear();
    try { child.kill(); } catch { /* already gone */ }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let cut: number;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as EncodeResponse & { ready?: boolean; dims?: number };
        if (msg.ready === true && typeof msg.dims === "number") { dims = msg.dims; continue; }
        const settle = waiting.get(msg.id);
        if (settle) { waiting.delete(msg.id); settle(msg); }
      } catch {
        // A line that is not JSON is the sidecar's own noise, not an answer.
      }
    }
  });

  // The sidecar's stderr is where a model download reports itself. It is the
  // person's own machine spending their disk; saying nothing would be worse.
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) process.stderr.write(`parley encoder: ${text}\n`);
  });

  child.on("exit", (code) => die(`exit ${code}`));
  child.on("error", (e) => die((e as Error).message));

  const ready = new Promise<boolean>((resolve) => {
    const deadline = Date.now() + (opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const poll = setInterval(() => {
      if (dims !== null) { clearInterval(poll); resolve(true); return; }
      if (dead || Date.now() > deadline) { clearInterval(poll); resolve(false); }
    }, 50);
    poll.unref?.();
  });

  return {
    dims: () => dims,
    close: () => die("closed"),
    async encode(kind, texts) {
      if (dead || texts.length === 0) return null;
      if (!(await ready)) return null;
      const id = nextId++;
      const request: EncodeRequest = { id, kind, texts };
      const answer = await new Promise<EncodeResponse>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve({ id, error: "timed out" });
        }, REQUEST_TIMEOUT_MS);
        timer.unref?.();
        waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
        try {
          child.stdin?.write(`${JSON.stringify(request)}\n`);
        } catch {
          clearTimeout(timer);
          waiting.delete(id);
          resolve({ id, error: "the encoder is not accepting input" });
        }
      });
      if (answer.error || !answer.vectors || answer.vectors.length !== texts.length) return null;
      return answer.vectors;
    },
  };
}
