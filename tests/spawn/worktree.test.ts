import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, removeWorktreeIfClean } from "../../src/spawn/worktree";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "parley-wt-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "first");
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe("a worktree for a newborn front", () => {
  test("it exists on disk, on its own branch", () => {
    const wt = addWorktree(repo, "pool-1");
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
    expect(wt.branch).toContain("pool-1");
  });

  test("two newborns never collide", () => {
    const a = addWorktree(repo, "pool-1");
    const b = addWorktree(repo, "pool-2");
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
  });

  test("an unchanged worktree is removed", () => {
    const wt = addWorktree(repo, "pool-1");
    expect(removeWorktreeIfClean(repo, wt.path)).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });

  test("a worktree with work in it is kept — nobody's changes are thrown away", () => {
    const wt = addWorktree(repo, "pool-1");
    writeFileSync(join(wt.path, "b.txt"), "work happened\n");
    expect(removeWorktreeIfClean(repo, wt.path)).toBe(false);
    expect(existsSync(wt.path)).toBe(true);
  });

  test("the bus key is unchanged: every worktree shares one git-common-dir", () => {
    const wt = addWorktree(repo, "pool-1");
    const common = (cwd: string) =>
      execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
    // Resolved, because /tmp is a symlink to /private/tmp on macOS.
    expect(existsSync(join(common(wt.path)))).toBe(true);
  });
});
