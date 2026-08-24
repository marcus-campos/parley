import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encoderDir } from "../../src/brain/encoder";
import { manualSteps } from "../../src/brain/sidecar";
import { isEncoder, MODELS } from "../../src/brain/registry";

/**
 * The way out for a machine whose runtime cannot reach huggingface.co.
 *
 * A TLS-inspecting proxy — a corporate network, a VPN, endpoint security —
 * stops the runtime from fetching even file metadata, while the browser on the
 * same machine downloads happily, because it trusts the proxy's certificate.
 * So the last resort is to fetch the files by hand.
 *
 * That only helps if three things are exactly right, and each is a test here:
 * the list of files is complete, the destination is the path that will
 * actually be read, and the sidecar stops using the network once they are
 * there. The third is what turns instructions into a solution rather than a
 * longer way to fail.
 */
describe("placing a model by hand", () => {
  const encoders = MODELS.filter(isEncoder);

  test("there is at least one encoder to say this about", () => {
    expect(encoders.length).toBeGreaterThan(0);
  });

  for (const model of encoders) {
    describe(model.name, () => {
      test("names a graph and everything needed to tokenise", () => {
        // A list missing tokenizer.json produces a model that loads and then
        // fails at the first query, which is a worse failure than not loading.
        const files = model.spec.files;
        expect(files).toContain("config.json");
        expect(files).toContain("tokenizer.json");
        expect(files).toContain("tokenizer_config.json");
        expect(files.some((f) => f.startsWith("onnx/") && f.endsWith(".onnx"))).toBe(true);
      });

      test("the weight file matches the quantisation actually requested", () => {
        // Measured, not derived: `q4` is `model_q4.onnx` and `q8` is
        // `model_quantized.onnx`. Guessing one naming rule for both produces a
        // 404 in the middle of somebody's manual recovery.
        const graph = model.spec.files.find((f) => f.startsWith("onnx/") && f.endsWith(".onnx"))!;
        if (model.spec.dtype === "q4") expect(graph).toBe("onnx/model_q4.onnx");
        if (model.spec.dtype === "q8") expect(graph).toBe("onnx/model_quantized.onnx");
      });

      test("external weight data is listed when the graph needs it", () => {
        // `.onnx_data` exists for some models and not others, which is exactly
        // why the list is per model. When it is listed it must sit beside its
        // graph, or the runtime cannot find it.
        const data = model.spec.files.filter((f) => f.endsWith(".onnx_data"));
        for (const d of data) {
          expect(model.spec.files).toContain(d.replace(".onnx_data", ".onnx"));
        }
      });

      test("the instructions point at the directory that is actually read", () => {
        // The whole recovery hangs on this path being the one the sidecar
        // opens. `specFor` builds it as <encoderDir>/weights/<repo>, and a
        // drifting copy here would send somebody's 200 MB somewhere harmless.
        const base = mkdtempSync(join(tmpdir(), "parley-manual-"));
        const steps = manualSteps(model, base);
        expect(steps).toContain(join(encoderDir(base), "weights", model.spec.repo));
      });

      test("every file is given as a full URL, one per line", () => {
        const steps = manualSteps(model);
        for (const f of model.spec.files) {
          expect(steps).toContain(`https://huggingface.co/${model.spec.repo}/resolve/main/${f}`);
        }
      });

      test("it says what to run afterwards", () => {
        // Instructions that end with the files on disk leave somebody holding
        // 200 MB and no next step.
        expect(manualSteps(model)).toContain(`parley brain enable ${model.name}`);
      });
    });
  }

  test("the worker stops using the network once the files are on disk", () => {
    // Without this the runtime still reaches out to check what it already has,
    // and fails identically with the model sitting right there — which would
    // make every instruction above a longer way to reach the same wall.
    const template = require("node:fs").readFileSync(
      join(import.meta.dir, "..", "..", "src", "brain", "sidecar.ts"), "utf8",
    ) as string;
    expect(template).toContain("env.allowRemoteModels = false");
    // Gated on the model being present, not set unconditionally — otherwise a
    // first install could never download anything.
    expect(template).toContain('existsSync(join(spec.cacheDir, spec.repo, "config.json"))');
  });
});
