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

import { refreshAllAdapters } from "../../src/adapters/install";
import { adapterStatus } from "../../src/adapters/claude-code";
import { readFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

function setUp(): { gitCommonDir: string; root: string } {
  const r = repo();
  mkdirSync(joinPath(r.root, ".claude", "skills", "parley"), { recursive: true });
  writeFileSync(joinPath(r.root, ".claude", "settings.json"), "{}", "utf8");
  return r;
}

describe("refreshing without ceremony", () => {
  test("a skill parley wrote is brought up to date with no question asked", async () => {
    const r = setUp();
    // Pretend an older parley generated it: it carries our stamp.
    writeFileSync(
      joinPath(r.root, ".claude", "skills", "parley", "SKILL.md"),
      "---\nname: parley\n---\n\nold\n<!-- parley skill v0.1.0 -->\n",
      "utf8",
    );
    registerRepo(r.gitCommonDir, r.root);

    // assumeYes false on purpose: a generated file must not need a prompt.
    await refreshAllAdapters({ assumeYes: false, json: true });

    const status = adapterStatus(r.root);
    expect(status.skillCurrent).toBe(true);
    expect(readFileSync(status.skillPath, "utf8")).toContain("Say who you are, out loud");
  });

  test("a hand-written skill is left alone when nobody confirms", async () => {
    const r = setUp();
    const mine = "this is my own skill, do not touch\n";
    writeFileSync(joinPath(r.root, ".claude", "skills", "parley", "SKILL.md"), mine, "utf8");
    registerRepo(r.gitCommonDir, r.root);

    // No TTY under test, so `confirm` declines — the safe direction.
    await refreshAllAdapters({ assumeYes: false, json: true });

    expect(readFileSync(joinPath(r.root, ".claude", "skills", "parley", "SKILL.md"), "utf8")).toBe(mine);
  });

  test("with --yes even a hand-written one is replaced, because you said so", async () => {
    const r = setUp();
    writeFileSync(joinPath(r.root, ".claude", "skills", "parley", "SKILL.md"), "mine\n", "utf8");
    registerRepo(r.gitCommonDir, r.root);

    await refreshAllAdapters({ assumeYes: true, json: true });
    expect(adapterStatus(r.root).skillCurrent).toBe(true);
  });
});
