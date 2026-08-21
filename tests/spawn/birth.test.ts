import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bearFront } from "../../src/spawn/birth";

interface Call { cmd: string; args: string[]; opts: Record<string, unknown> }

/**
 * `bearFront` calls the real `addWorktree` (Task 3) — that is the point, it is
 * the integration this task wires up. What must never be real is the *target*
 * repository: five other agents have worktrees open on the actual parley repo
 * right now, and `git worktree add` mutates the one `.git` every worktree
 * shares. So every test here gets its own throwaway repo, exactly like
 * `tests/spawn/worktree.test.ts` does, and the real spawn is always faked too
 * — a `bearFront` call that ever reached a real `claude` or `codex` binary
 * would start a live, unsupervised, billed agent session.
 */
let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "parley-birth-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "first");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function fakeSpawn(calls: Call[], unreffed: { count: number } = { count: 0 }) {
  const fn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return { pid: 4242, unref: () => { unreffed.count++; }, on() {}, stdout: null, stderr: null };
  }) as never;
  return { fn, unreffed };
}

describe("bearing a front", () => {
  test("the process is detached, hidden on Windows, and unreferenced", () => {
    const calls: Call[] = [];
    const { fn, unreffed } = fakeSpawn(calls);
    const born = bearFront({
      repoRoot: repo,
      config: { mode: "panel", harness: "claude-code", maxFronts: 6 },
      intent: { reason: "3 open items", forItemIds: ["w_1"] },
      index: 1,
      spawnFn: fn,
    });
    expect(born).not.toBeNull();
    expect(calls.length).toBe(1);
    expect(calls[0]!.opts.detached).toBe(true);
    expect(calls[0]!.opts.windowsHide).toBe(true);
    // A child left referenced would keep the daemon's event loop alive
    // forever waiting on a process it does not own.
    expect(unreffed.count).toBe(1);
  });

  test("the newborn is told its name, its bus and that it was born by parley", () => {
    const calls: Call[] = [];
    bearFront({
      repoRoot: repo,
      config: { mode: "panel", harness: "claude-code", maxFronts: 6 },
      intent: { reason: "3 open items", forItemIds: ["w_1"] },
      index: 1,
      spawnFn: fakeSpawn(calls).fn,
    });
    const env = calls[0]!.opts.env as Record<string, string>;
    expect(env.PARLEY_NAME).toContain("POOL");
    expect(env.PARLEY_BORN).toBe("parley");
  });

  test("the newborn is never told what to do — only where the pool is", () => {
    const calls: Call[] = [];
    bearFront({
      repoRoot: repo,
      config: { mode: "panel", harness: "claude-code", maxFronts: 6 },
      intent: { reason: "3 open items", forItemIds: ["w_1", "w_2"] },
      index: 1,
      spawnFn: fakeSpawn(calls).fn,
    });
    const prompt = calls[0]!.args.join(" ");
    expect(prompt).toContain("parley works");
    expect(prompt).not.toContain("w_1"); // no assignment: it chooses
    expect(prompt).not.toContain("w_2");
  });

  test("a spawn that throws returns null and never propagates", () => {
    const born = bearFront({
      repoRoot: repo,
      config: { mode: "panel", harness: "claude-code", maxFronts: 6 },
      intent: { reason: "x", forItemIds: [] },
      index: 1,
      spawnFn: (() => { throw new Error("no such binary"); }) as never,
    });
    expect(born).toBeNull();
  });

  test("terminal mode that cannot open degrades to panel rather than failing", () => {
    const calls: Call[] = [];
    const born = bearFront({
      repoRoot: repo,
      config: { mode: "terminal", harness: "claude-code", maxFronts: 6 },
      intent: { reason: "x", forItemIds: [] },
      index: 1,
      spawnFn: fakeSpawn(calls).fn,
      openTerminalFn: () => { throw new Error("no terminal here"); },
    } as never);
    expect(born).not.toBeNull();
    expect(born!.mode).toBe("panel");
    // A degrade that gives up entirely would also pass a "mode is panel"
    // assertion — proof of life is that the fallback spawn actually happened.
    expect(calls.length).toBe(1);
  });

  test("terminal mode with no injected opener still bears a front, via the default opener", () => {
    // Nothing in the daemon (src/daemon/server.ts) ever passes `openTerminalFn`
    // — production terminal mode relies entirely on `bearFront`'s own default.
    // This proves that default path is real code, not a no-op that only exists
    // to satisfy the one test above that injects its own opener.
    const calls: Call[] = [];
    const born = bearFront({
      repoRoot: repo,
      config: { mode: "terminal", harness: "claude-code", maxFronts: 6 },
      intent: { reason: "x", forItemIds: [] },
      index: 1,
      spawnFn: fakeSpawn(calls).fn,
    });
    expect(born).not.toBeNull();
    expect(calls.length).toBe(1);
  });

  test("a missing worktree (bad repoRoot) fails the whole birth, not half of it", () => {
    const calls: Call[] = [];
    const born = bearFront({
      repoRoot: join(repo, "does-not-exist"),
      config: { mode: "panel", harness: "claude-code", maxFronts: 6 },
      intent: { reason: "x", forItemIds: [] },
      index: 1,
      spawnFn: fakeSpawn(calls).fn,
    });
    expect(born).toBeNull();
    expect(calls.length).toBe(0);
  });
});
