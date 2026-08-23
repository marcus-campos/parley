import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, isNewbornWorktree, removeWorktreeIfClean } from "../../src/spawn/worktree";

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

  test("what it creates does not land in somebody's git status", () => {
    // A full checkout with its own .git, inside the working tree, is not the
    // person's to commit — and until this branch nothing wrote an ignore into
    // a user's repository, because `repoRootForExport()` returned null and no
    // worktree was ever created in one.
    const wt = addWorktree(repo, "pool-1");
    writeFileSync(join(repo, ".parley", "notes.md"), "# what this repository knows\n");

    // `-uall`, because the default collapses an untracked directory into one
    // line and would hide both halves of what this asserts.
    const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, encoding: "utf8" });
    expect(existsSync(wt.path)).toBe(true);
    expect(status).not.toContain("worktrees");
    // And only that: the notes file is the shared memory of the repository and
    // is meant to be committed, so an unqualified `.parley/` would be wrong.
    expect(status).toContain(".parley/notes.md");
  });

  test("an ignore file already there is left exactly as it is", () => {
    mkdirSync(join(repo, ".parley"), { recursive: true });
    writeFileSync(join(repo, ".parley", ".gitignore"), "# mine\nworktrees/\nscratch/\n");
    addWorktree(repo, "pool-1");
    expect(readFileSync(join(repo, ".parley", ".gitignore"), "utf8")).toContain("scratch/");
  });

  test("two newborns never collide", () => {
    const a = addWorktree(repo, "pool-1");
    const b = addWorktree(repo, "pool-2");
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
  });

  test("an unchanged worktree is removed", async () => {
    const wt = addWorktree(repo, "pool-1");
    expect(await removeWorktreeIfClean(repo, wt.path)).toBe("removed");
    expect(existsSync(wt.path)).toBe(false);
  });

  test("a worktree with work in it is kept — nobody's changes are thrown away", async () => {
    const wt = addWorktree(repo, "pool-1");
    writeFileSync(join(wt.path, "b.txt"), "work happened\n");
    expect(await removeWorktreeIfClean(repo, wt.path)).toBe("dirty");
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
    expect(await removeWorktreeIfClean(repo, wt.path)).toBe("removed");
  });

  test("a git that could not run is not proof the tree is clean", async () => {
    // The one guarantee git's own refusal cannot provide: it refuses a *dirty*
    // worktree, and it can only do that once you have already attempted the
    // removal. `git status` failing is a different thing, and the difference
    // between "unknown" and "clean" is somebody's uncommitted work.
    //
    // No fake git, and nothing injected: a directory outside any repository is
    // a path where `git status` genuinely cannot run.
    const outside = mkdtempSync(join(tmpdir(), "parley-not-a-repo-"));
    let insideSomeRepo = true;
    try { execFileSync("git", ["rev-parse", "--git-dir"], { cwd: outside, stdio: "ignore" }); }
    catch { insideSomeRepo = false; }
    expect(insideSomeRepo).toBe(false);

    try {
      expect(await removeWorktreeIfClean(repo, outside)).toBe("unknown");
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

/**
 * The guard that stands between `collectWorktree` and somebody's checkout.
 * `p.cwd` is wherever a front's process happened to be, not a fact about what
 * parley made — and `git worktree remove`'s own refusal is not what this is
 * for.
 */
describe("what parley made, and what it did not", () => {
  const root = join(tmpdir(), "some-repo");
  const home = join(root, ".parley", "worktrees");

  test("only what is inside .parley/worktrees is a newborn's directory", () => {
    expect(isNewbornWorktree(root, join(home, "pool-1"))).toBe(true);
    expect(isNewbornWorktree(root, join(home, "pool-1", "src"))).toBe(true);
    // The home itself is not one of them. The previous form admitted it
    // exactly, which read as if it excluded it.
    expect(isNewbornWorktree(root, home)).toBe(false);
    expect(isNewbornWorktree(root, root)).toBe(false);
    // A sibling whose name merely starts the same way is not inside it.
    expect(isNewbornWorktree(root, join(root, ".parley", "worktrees-of-mine"))).toBe(false);
    expect(isNewbornWorktree(root, join(tmpdir(), "elsewhere", "pool-1"))).toBe(false);
    expect(isNewbornWorktree(root, "")).toBe(false);
  });

  test("and it is addWorktree's own layout, not a second copy of it", () => {
    // A guard that spells the path out a second time is a guard that stops
    // matching the day the layout moves.
    const wt = addWorktree(repo, "pool-1");
    expect(isNewbornWorktree(repo, wt.path)).toBe(true);
  });
});
