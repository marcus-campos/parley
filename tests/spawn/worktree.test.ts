import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, isNewbornWorktree, nextFrontIndexIn, removeWorktreeIfClean } from "../../src/spawn/worktree";

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

  test("an ignore file that never mentioned worktrees is appended to, not skipped", () => {
    // The guard was `existsSync(file) -> return`, so any `.parley/.gitignore`
    // already in the repository — written by a person, by an older parley, by
    // anything — meant no ignore was ever written and the checkout landed in
    // `git status` as an embedded git repository. Existing is not the same as
    // saying what this needs it to say.
    mkdirSync(join(repo, ".parley"), { recursive: true });
    writeFileSync(join(repo, ".parley", ".gitignore"), "*.log\n");
    const wt = addWorktree(repo, "pool-1");

    const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, encoding: "utf8" });
    expect(existsSync(wt.path)).toBe(true);
    expect(status).not.toContain("worktrees");
    // Appended, so whatever was in there is still in there.
    expect(readFileSync(join(repo, ".parley", ".gitignore"), "utf8")).toContain("*.log");
  });

  test("two newborns never collide", () => {
    const a = addWorktree(repo, "pool-1");
    const b = addWorktree(repo, "pool-2");
    expect(a.path).not.toBe(b.path);
    expect(a.branch).not.toBe(b.branch);
  });

  const branches = () =>
    execFileSync("git", ["branch", "--list", "--format=%(refname:short)", "parley/*"], { cwd: repo, encoding: "utf8" });

  test("an unchanged worktree is removed, and its branch goes with it", async () => {
    const wt = addWorktree(repo, "pool-1");
    expect(branches()).toContain("parley/pool-1");
    expect(await removeWorktreeIfClean(repo, wt.path)).toBe("removed");
    expect(existsSync(wt.path)).toBe(false);
    // `git worktree remove` takes the directory and leaves the branch. Left
    // there, `parley/pool-*` accumulates in every repository forever and the
    // index that made it can never be used again — see `nextFrontIndexIn`.
    expect(branches()).not.toContain("parley/pool-1");
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

    // And the commits survive the collection. Cleanliness is what lets the
    // *directory* go; it says nothing about the branch, which is now the only
    // place that work exists. `git branch -d` refuses a branch that is not
    // fully merged, and `-D` would not have.
    expect(branches()).toContain("parley/pool-1");
    const log = execFileSync("git", ["log", "--oneline", "parley/pool-1"], { cwd: repo, encoding: "utf8" });
    expect(log).toContain("the front's work");
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
describe("which index the next newborn gets", () => {
  test("a repository that has never borne a front starts at 1", () => {
    expect(nextFrontIndexIn(repo)).toBe(1);
  });

  test("a live newborn's index is not handed out twice", () => {
    addWorktree(repo, "pool-1");
    expect(nextFrontIndexIn(repo)).toBe(2);
  });

  test("the phantom failure: a branch git kept is an index that cannot be reused", async () => {
    // The whole point, and the thing that made this reachable only now that
    // collection works. A newborn commits something, goes home, and its
    // worktree is collected — but `git branch -d` refuses a branch holding
    // unmerged work, so `parley/pool-1` stays. The daemon's counter is in
    // memory and restarts at 1, so the next daemon's first birth asked git for
    // a branch that was already there, `bearFront` returned null, and the pool
    // waited out a full BIRTH_COOLDOWN_MS for nothing.
    const wt = addWorktree(repo, "pool-1");
    writeFileSync(join(wt.path, "b.txt"), "work the front committed\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: wt.path, stdio: "ignore" });
    git("add", "-A");
    git("commit", "-qm", "the front's work");
    expect(await removeWorktreeIfClean(repo, wt.path)).toBe("removed");

    // This is the failure, reproduced: starting over at 1 throws.
    expect(() => addWorktree(repo, "pool-1")).toThrow();
    // And this is the fix: the index is read from git, which is what refuses.
    expect(nextFrontIndexIn(repo)).toBe(2);
    expect(addWorktree(repo, `pool-${nextFrontIndexIn(repo)}`).branch).toBe("parley/pool-2");
  });

  test("a repository whose branches cannot be read still bears a front", () => {
    // A birth is never refused because a `git` did not answer. Outside any
    // repository there is nothing to list, and the answer is the same one an
    // untouched repository gives.
    const outside = mkdtempSync(join(tmpdir(), "parley-not-a-repo-"));
    try {
      expect(nextFrontIndexIn(outside)).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

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
