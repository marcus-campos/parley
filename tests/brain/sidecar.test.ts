import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encoderDir, encoderInstalled } from "../../src/brain/encoder";
import { bunAvailable, installEncoder, TRANSFORMERS_VERSION } from "../../src/brain/sidecar";
import type { EncoderBrainModel } from "../../src/brain/registry";

const MODEL: EncoderBrainModel = {
  name: "fake", kind: "encoder", dims: 3, score: 1, ramMB: 1, msPerNote: 1, bytes: 1,
  spec: { repo: "fake/fake", pool: "mean", queryPrefix: "q:", passagePrefix: "p:", floor: 0.5 },
};

/**
 * A stand-in for `bun`, recording what it was asked to do.
 *
 * The install runs `bun install` and then loads a model over the network. This
 * suite refuses to do either — a test that downloads 200 MB is a test nobody
 * runs — so what is checked is the part that can actually be wrong: which
 * commands, in which order, with which working directory, and what happens
 * when one of them fails.
 */
function recorder(fail?: string, warmStdout = '{"ready":true,"dims":768}\n') {
  const calls: { args: string[]; cwd?: string }[] = [];
  const runner = ((cmd: string, args: string[], opts: { cwd?: string } = {}) => {
    calls.push({ args: [cmd, ...args], cwd: opts.cwd });
    const failed = fail !== undefined && args.join(" ").includes(fail);
    // Only the warm run produces output — it is the one that speaks the
    // protocol. `bun install` and `bun pm trust` say nothing this cares about.
    const isWarm = args.some((a) => a.endsWith("serve.ts"));
    return {
      status: failed ? 1 : 0,
      stdout: isWarm && !failed ? warmStdout : "",
      stderr: "", output: [], pid: 1, signal: null,
    };
  }) as unknown as typeof import("node:child_process").spawnSync;
  return { calls, runner };
}

describe("installing the encoder runtime", () => {
  test("it writes a sidecar and a manifest, then installs and warms", () => {
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-inst-"));
    const { calls, runner } = recorder();

    expect(installEncoder(modelsDir, MODEL, runner)).toEqual({ ok: true });

    const dir = encoderDir(modelsDir);
    expect(existsSync(join(dir, "serve.ts"))).toBe(true);

    // The dependency is pinned, not ranged. A range means the install that
    // worked yesterday can break today for a reason nobody in this repository
    // changed — on somebody else's machine, at the moment they first try it.
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(manifest.dependencies["@huggingface/transformers"]).toBe(TRANSFORMERS_VERSION);

    // Install, then trust (bun blocks lifecycle scripts, and onnxruntime-node's
    // is what fetches the native library), then warm.
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "bun install",
      "bun pm",
      `bun ${join(dir, "serve.ts")}`,
    ]);
    expect(calls[1]!.args[2]).toBe("trust");
    // All of it inside the encoder directory, never the repository: this must
    // not create a node_modules next to somebody's source.
    for (const call of calls) expect(call.cwd).toBe(dir);
  });

  test("the model spec reaches the sidecar as its argument", () => {
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-inst-"));
    const { calls, runner } = recorder();
    installEncoder(modelsDir, MODEL, runner);

    const warm = calls.at(-1)!;
    expect(JSON.parse(warm.args[2]!)).toMatchObject(MODEL.spec);
  });

  test("a failed install is reported, not swallowed", () => {
    // The person is at a terminal watching this. An install that fails and
    // says `ok` would enable a brain that cannot start, and the only symptom
    // would be recall that never improves.
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-inst-"));
    const { runner } = recorder("install");
    const outcome = installEncoder(modelsDir, MODEL, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("bun install");
  });

  test("a model that will not load is a failed install", () => {
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-inst-"));
    const { runner } = recorder("serve.ts");
    const outcome = installEncoder(modelsDir, MODEL, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain(MODEL.name);
  });

  test("exiting cleanly without ever embedding is not a successful install", () => {
    // This is a defect that shipped in a first draft and was caught only by
    // running it for real. The worker exits 0 the moment stdin closes — which
    // is how the installer warms it — so a model that never loaded still
    // returned 0, and a person was told the brain was on when nothing had been
    // downloaded. Exit status cannot prove a model works; only the worker
    // saying `ready` with a width can, because it takes a forward pass to say.
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-inst-"));
    const { runner } = recorder(undefined, "");
    const outcome = installEncoder(modelsDir, MODEL, runner);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("could not produce an embedding");
  });

  test("the weights are kept outside node_modules, where a reinstall cannot lose them", () => {
    // transformers.js caches inside its own package by default, and
    // `bun install` may replace that tree wholesale — silently re-downloading
    // 200 MB. Installer and daemon must agree on one path outside it.
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-inst-"));
    const { calls, runner } = recorder();
    installEncoder(modelsDir, MODEL, runner);

    const spec = JSON.parse(calls.at(-1)!.args[2]!);
    expect(spec.cacheDir).toBe(join(encoderDir(modelsDir), "weights"));
    expect(spec.cacheDir).not.toContain("node_modules");
  });

  test("installing again refreshes the sidecar but does not reinstall", () => {
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-inst-"));
    const dir = encoderDir(modelsDir);
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    // A sidecar left by an older parley. An upgrade has to replace it, or the
    // binary and the worker disagree about the protocol between them.
    writeFileSync(join(dir, "serve.ts"), "// stale");

    const { calls, runner } = recorder();
    expect(installEncoder(modelsDir, MODEL, runner)).toEqual({ ok: true });

    expect(readFileSync(join(dir, "serve.ts"), "utf8")).not.toBe("// stale");
    // No `bun install`: node_modules is already there, and that is the step
    // that costs a network round trip.
    expect(calls.map((c) => c.args[1])).toEqual([join(dir, "serve.ts")]);
  });

  test("an install that finished is what the daemon looks for", () => {
    const modelsDir = mkdtempSync(join(tmpdir(), "parley-inst-"));
    const { runner } = recorder();
    // The fake runner never creates node_modules, so this proves the daemon's
    // readiness check is about the dependency tree and not merely about
    // `installEncoder` having been called.
    installEncoder(modelsDir, MODEL, runner);
    expect(encoderInstalled(modelsDir)).toBe(false);

    mkdirSync(join(encoderDir(modelsDir), "node_modules"), { recursive: true });
    expect(encoderInstalled(modelsDir)).toBe(true);
  });

  test("bun is detected by asking it, and a missing bun is not an exception", () => {
    expect(bunAvailable()).toBe(true); // this suite runs under bun
    const missing = (() => {
      throw new Error("spawn ENOENT");
    }) as unknown as typeof import("node:child_process").spawnSync;
    expect(bunAvailable(missing)).toBe(false);
  });
});
