import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSpawnConfig, SPAWN_DEFAULTS, writeSpawnConfig } from "../../src/cli/spawn-config";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "parley-spawn-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("spawn.json", () => {
  test("a repository with no file gets the defaults", () => {
    expect(readSpawnConfig(dir)).toEqual(SPAWN_DEFAULTS);
  });

  test("the defaults are panel mode and a ceiling of six", () => {
    expect(SPAWN_DEFAULTS.mode).toBe("panel");
    expect(SPAWN_DEFAULTS.maxFronts).toBe(6);
  });

  test("it round-trips", () => {
    writeSpawnConfig(dir, { mode: "terminal", harness: "codex", maxFronts: 3 });
    expect(readSpawnConfig(dir)).toEqual({ mode: "terminal", harness: "codex", maxFronts: 3 });
  });

  test("it lives inside the git directory, beside panel.json, and is never committed", () => {
    writeSpawnConfig(dir, { ...SPAWN_DEFAULTS, maxFronts: 2 });
    expect(readSpawnConfig(dir).maxFronts).toBe(2);
    // The file is at <gitCommonDir>/parley/spawn.json — same place panel.json lives.
  });

  test("a corrupt file falls back to the defaults instead of throwing", () => {
    mkdirSync(join(dir, "parley"), { recursive: true });
    writeFileSync(join(dir, "parley", "spawn.json"), "{ not json", "utf8");
    expect(readSpawnConfig(dir)).toEqual(SPAWN_DEFAULTS);
  });

  test("a nonsense mode falls back rather than spawning into nowhere", () => {
    mkdirSync(join(dir, "parley"), { recursive: true });
    writeFileSync(join(dir, "parley", "spawn.json"), JSON.stringify({ mode: "carrier-pigeon", maxFronts: 4 }), "utf8");
    const config = readSpawnConfig(dir);
    expect(config.mode).toBe("panel");
    expect(config.maxFronts).toBe(4);
  });

  test("a ceiling below one or absurdly high is clamped", () => {
    mkdirSync(join(dir, "parley"), { recursive: true });
    writeFileSync(join(dir, "parley", "spawn.json"), JSON.stringify({ mode: "panel", maxFronts: 0 }), "utf8");
    expect(readSpawnConfig(dir).maxFronts).toBe(1);
    writeFileSync(join(dir, "parley", "spawn.json"), JSON.stringify({ mode: "panel", maxFronts: 900 }), "utf8");
    expect(readSpawnConfig(dir).maxFronts).toBe(32);
  });
});
