import { describe, expect, test } from "bun:test";
import { matchesPath, normalizeTerritoryPath, patternsOverlap } from "../../src/repo/paths";

describe("normalizeTerritoryPath", () => {
  test("Windows and POSIX spellings collapse to one territory", () => {
    expect(normalizeTerritoryPath("src\\app.ts")).toBe("src/app.ts");
    expect(normalizeTerritoryPath("src/app.ts")).toBe("src/app.ts");
  });

  test("leading slash, ./ and duplicate separators are stripped", () => {
    expect(normalizeTerritoryPath("/src//app.ts")).toBe("src/app.ts");
    expect(normalizeTerritoryPath("./src/app.ts")).toBe("src/app.ts");
  });

  test("interior .. resolves", () => {
    expect(normalizeTerritoryPath("src/lib/../app.ts")).toBe("src/app.ts");
  });

  test("escaping the repository root is refused", () => {
    expect(() => normalizeTerritoryPath("../secrets")).toThrow(/escapes repository root/);
  });

  test("an empty path is refused", () => {
    expect(() => normalizeTerritoryPath("./")).toThrow(/empty territory path/);
  });
});

describe("matchesPath", () => {
  test("a bare directory covers everything beneath it", () => {
    expect(matchesPath("src/backend", "src/backend/finance/services.py")).toBe(true);
    expect(matchesPath("src/backend", "src/backend")).toBe(true);
    expect(matchesPath("src/backend", "src/backendish/x.py")).toBe(false);
  });

  test("** spans any number of segments, including zero", () => {
    expect(matchesPath("src/**", "src/a/b/c.ts")).toBe(true);
    expect(matchesPath("src/**", "src")).toBe(true);
    expect(matchesPath("**/*.py", "src/backend/finance/services.py")).toBe(true);
  });

  test("* stops at the separator", () => {
    expect(matchesPath("src/*.ts", "src/app.ts")).toBe(true);
    expect(matchesPath("src/*.ts", "src/lib/app.ts")).toBe(false);
  });
});

describe("patternsOverlap", () => {
  test("the canonical conflict: a glob against a concrete file", () => {
    expect(patternsOverlap("src/backend/finance/**", "src/backend/finance/services.py")).toBe(true);
  });

  test("disjoint subtrees do not conflict", () => {
    expect(patternsOverlap("src/backend/**", "src/frontend/**")).toBe(false);
    expect(patternsOverlap("src/a.ts", "src/b.ts")).toBe(false);
  });

  test("nesting in either direction conflicts", () => {
    expect(patternsOverlap("src/**", "src/backend/finance/services.py")).toBe(true);
    expect(patternsOverlap("src/backend/finance/services.py", "src/**")).toBe(true);
  });

  test("extension globs across a subtree conflict with files in it", () => {
    expect(patternsOverlap("**/*.py", "src/backend/finance/services.py")).toBe(true);
    expect(patternsOverlap("**/*.py", "src/app.ts")).toBe(false);
  });

  test("identical patterns conflict", () => {
    expect(patternsOverlap("src/**", "src/**")).toBe(true);
  });

  test("undecidable wildcard pairs resolve to conflict, never to clear", () => {
    expect(patternsOverlap("src/*.ts", "src/a*")).toBe(true);
  });
});

describe("directory heuristic", () => {
  test("a dotted last segment reads as a file, not a directory", () => {
    expect(matchesPath("src/app.ts", "src/app.ts/nested.py")).toBe(false);
    expect(patternsOverlap("**/*.py", "src/app.ts")).toBe(false);
  });

  test("a leading dot still reads as a directory", () => {
    expect(matchesPath(".github", ".github/workflows/ci.yml")).toBe(true);
  });

  test("an explicit glob overrides the heuristic for odd directory names", () => {
    expect(matchesPath("src/v1.2/**", "src/v1.2/mod.ts")).toBe(true);
  });
});
