import { describe, expect, test } from "bun:test";
import { compareVersions, targetForThisMachine } from "../../src/cli/update";

describe("compareVersions", () => {
  test("orders releases the obvious way", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("a leading v is not part of the version", () => {
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("v1.0.0", "v0.9.9")).toBeGreaterThan(0);
  });

  test("10 is newer than 9, which string comparison gets backwards", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
  });

  test("missing components count as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });
});

describe("targetForThisMachine", () => {
  test("names an asset that the release workflow actually publishes", () => {
    // These five, and only these five, are built by .github/workflows/release.yml.
    const published = new Set([
      "parley-linux-x64", "parley-linux-arm64",
      "parley-darwin-x64", "parley-darwin-arm64",
      "parley-windows-x64.exe",
    ]);
    const target = targetForThisMachine();
    expect("error" in target || published.has(target.asset)).toBe(true);
  });
});
