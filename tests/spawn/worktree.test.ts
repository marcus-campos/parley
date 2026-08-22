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

  test("an unchanged worktree is removed", async () => {
    const wt = addWorktree(repo, "pool-1");
    expect(await removeWorktreeIfClean(repo, wt.path)).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
  });

  test("a worktree with work in it is kept — nobody's changes are thrown away", async () => {
    const wt = addWorktree(repo, "pool-1");
    writeFileSync(join(wt.path, "b.txt"), "work happened\n");
    expect(await removeWorktreeIfClean(repo, wt.path)).toBe(false);
    expect(existsSync(wt.path)).toBe(true);
  });

  test("a committed worktree is clean again, and still is not thrown away while its front is live", async () => {
    // The case that makes "clean" a dangerous proxy for "abandoned": a front
    // that committed its work has a clean tree and is still sitting in it.
    // Cleanliness is only ever the second half of the test — `leave` is the
    // first (see src/daemon/server.ts, collectWorktree).
    const wt = addWorktree(repo, "pool-1");
    writeFileSync(join(wt.path, "b.txt"), "work happened\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: wt.path, stdio: "ignore" });
    git("add", "-A");
    git("commit", "-qm", "the front's work");
    expect(await removeWorktreeIfClean(repo, wt.path)).toBe(true);
  });

  test("removal never blocks the caller: git runs off the event loop", async () => {
    // The daemon serves every front on one loop, from `handle()` — the path
    // every hook frame takes, against a 30ms budget. Two synchronous `git`
    // subprocesses there are tens of milliseconds of dead air for every other
    // front on the bus.
    //
    // Measured, not asserted by inspection: a 1ms interval running across the
    // call. With `execFileSync` the whole body runs before any timer can fire
    // and the count is exactly 0; with `execFile` it is ~20 on this repository
    // for the same ~25ms of git. The threshold is deliberately far from both.
    const wt = addWorktree(repo, "pool-1");
    let ticks = 0;
    const interval = setInterval(() => { ticks++; }, 1);
    await removeWorktreeIfClean(repo, wt.path);
    clearInterval(interval);
    expect(ticks).toBeGreaterThan(3);
  });

  test("the bus key is unchanged: every worktree shares one git-common-dir", () => {
    const wt = addWorktree(repo, "pool-1");
    const common = (cwd: string) =>
      execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
    // Resolved, because /tmp is a symlink to /private/tmp on macOS.
    expect(existsSync(join(common(wt.path)))).toBe(true);
  });
});
