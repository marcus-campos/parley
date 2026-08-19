import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetRepo, pruneRegistry, readRegistry, registerRepo } from "../../src/adapters/registry";

const made: string[] = [];
function repo(): { gitCommonDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "parley-reg-"));
  made.push(root);
  const gitCommonDir = join(root, ".git");
  mkdirSync(gitCommonDir, { recursive: true });
  return { gitCommonDir, root };
}

afterEach(() => {
  for (const r of readRegistry()) if (r.root.includes("parley-reg-")) forgetRepo(r.gitCommonDir);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the registry of set-up repositories", () => {
  test("registering makes a repository findable, and is idempotent", () => {
    const a = repo();
    registerRepo(a.gitCommonDir, a.root);
    registerRepo(a.gitCommonDir, a.root);
    expect(readRegistry().filter((r) => r.gitCommonDir === a.gitCommonDir)).toHaveLength(1);
  });

  test("several repositories are all remembered — this is what one update covers", () => {
    const a = repo();
    const b = repo();
    registerRepo(a.gitCommonDir, a.root);
    registerRepo(b.gitCommonDir, b.root);
    const roots = readRegistry().map((r) => r.root);
    expect(roots).toContain(a.root);
    expect(roots).toContain(b.root);
  });

  test("a repository that was deleted is pruned rather than breaking the sweep", () => {
    const a = repo();
    registerRepo(a.gitCommonDir, a.root);
    rmSync(a.root, { recursive: true, force: true });
    expect(pruneRegistry().map((r) => r.root)).not.toContain(a.root);
  });

  test("forgetting removes only that one", () => {
    const a = repo();
    const b = repo();
    registerRepo(a.gitCommonDir, a.root);
    registerRepo(b.gitCommonDir, b.root);
    forgetRepo(a.gitCommonDir);
    const roots = readRegistry().map((r) => r.root);
    expect(roots).not.toContain(a.root);
    expect(roots).toContain(b.root);
  });
});
