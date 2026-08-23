import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const scratch: string[] = [];
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

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

/**
 * Terminal mode is the one path where identity does not travel in `env` but in
 * a command line typed into somebody's shell — and `do script` (macOS) and
 * `cmd /k` (Windows) hand that command to a shell that *stays alive*. The old
 * form exported PARLEY_BORN and `cd`-ed into the newborn's worktree, so the
 * window a person got back after the agent finished was a prompt that still
 * claimed to be a parley-born front standing in `.parley/worktrees/pool-1`.
 * Work there, close the session, and `collectWorktree` deletes the checkout.
 *
 * Nothing here is faked except the harness binary: the command asserted on is
 * the one `bearFront` really builds for a real terminal, it is run by a real
 * `sh`, and what it delivers is read back out of a real process's environment.
 */
describe.if(process.platform !== "win32")("terminal mode: what the window is told, and what it keeps", () => {
  /** The command string production hands a terminal, out of whatever the platform wraps it in. */
  function commandFromLaunch(args: string[]): string {
    const arg = args.find((a) => a.includes("PARLEY_BORN"));
    expect(arg).toBeDefined();
    if (!arg!.startsWith("tell application")) return arg!;
    const marker = "do script ";
    const quoted = arg!.slice(arg!.indexOf(marker) + marker.length);
    return quoted.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }

  function launch(): { command: string; worktree: string } {
    const calls: Call[] = [];
    // No `openTerminalFn`: this is the default opener, the only one production
    // ever uses.
    const born = bearFront({
      repoRoot: repo,
      config: { mode: "terminal", harness: "claude-code", maxFronts: 6 },
      intent: { reason: "2 open item(s) and no idle front", forItemIds: ["w_1"] },
      index: 1,
      spawnFn: fakeSpawn(calls).fn,
    });
    expect(born).not.toBeNull();
    return { command: commandFromLaunch(calls[0]!.args), worktree: born!.worktree };
  }

  /** A `claude` on PATH that records what it was actually given. */
  function stubHarness(): { path: string; seen: string } {
    const dir = tempDir("parley-bin-");
    const seen = join(dir, "seen");
    writeFileSync(join(dir, "claude"), `#!/bin/sh\n{ printenv PARLEY_BORN; printenv PARLEY_NAME; pwd; } > '${seen}'\n`);
    chmodSync(join(dir, "claude"), 0o755);
    return { path: `${dir}:${process.env.PATH}`, seen };
  }

  test("the newborn's own process is told who it is, and starts in its worktree", () => {
    const { command, worktree } = launch();
    const harness = stubHarness();
    execFileSync("sh", ["-c", command], { env: { PATH: harness.path }, encoding: "utf8" });
    const [born, name, cwd] = readFileSync(harness.seen, "utf8").trim().split("\n");
    expect(born).toBe("parley");
    expect(name).toContain("POOL");
    expect(realpathSync(cwd!)).toBe(realpathSync(worktree));
  });

  test("and the shell it was typed into keeps none of it — no identity, no worktree cwd", () => {
    const { command } = launch();
    const harness = stubHarness();
    const window = tempDir("parley-window-");
    // What the person gets back when `claude -p` exits: the same shell, still
    // running, still theirs. Whatever it carries now, it carries into their
    // next session.
    const after = execFileSync(
      "sh",
      ["-c", `${command}\necho "born=[$PARLEY_BORN]"\necho "name=[$PARLEY_NAME]"\necho "cwd=[$(pwd)]"`],
      { cwd: window, env: { PATH: harness.path }, encoding: "utf8" },
    );
    expect(after).toContain("born=[]");
    expect(after).toContain("name=[]");
    expect(after).toContain(`cwd=[${realpathSync(window)}]`);
  });
});
