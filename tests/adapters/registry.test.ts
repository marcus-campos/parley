import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync as readFile, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { forgetRepo, pruneRegistry, readRegistry, registerRepo } from "../../src/adapters/registry";

// The temp state directory comes from `tests/preload.ts`, which sets it for
// every test file. This one only needs the witness below: `refreshAllAdapters`
// rewrites the hooks and skill of every repository in the registry, so if the
// redirect ever fails, this file is where it edits the person's own projects.
const realRegistry = join(homedir(), "Library", "Application Support", "parley", "repos.json");
const realBefore = existsSync(realRegistry) ? readFile(realRegistry, "utf8") : null;

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

describe("the machine's own registry", () => {
  // The witness. Everything above registers repositories and refreshes them;
  // this is what says the blast radius stayed inside the temp directory. It
  // reads the real file directly rather than through `readRegistry`, because
  // the whole point is to check the thing the override is hiding.
  test("is never read, written, or refreshed by this file", () => {
    expect(process.env.PARLEY_STATE_DIR).toBeTruthy();
    const now = existsSync(realRegistry) ? readFile(realRegistry, "utf8") : null;
    expect(now).toBe(realBefore);
  });

  test("the override is what redirects it, and production sets no such thing", () => {
    // A deletion detector for the seam itself: remove the override branch in
    // `registryPath` and the tests above go back to walking the real registry
    // silently, which is exactly the failure this file exists to have stopped.
    const src = readFile(join(import.meta.dir, "..", "..", "src", "adapters", "registry.ts"), "utf8");
    expect(src).toContain("process.env.PARLEY_STATE_DIR");
    const cli = readFile(join(import.meta.dir, "..", "..", "src", "cli", "main.ts"), "utf8");
    expect(cli).not.toContain("PARLEY_STATE_DIR");
  });
});
