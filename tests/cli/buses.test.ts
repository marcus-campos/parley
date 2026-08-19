import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summariseBuses } from "../../src/cli/buses";
import { forgetRepo, readRegistry, registerRepo } from "../../src/adapters/registry";
import { comparable, markAsWorkspace } from "../../src/repo/workspace";
import { locateRepo } from "../../src/repo/locate";
import { execFileSync } from "node:child_process";

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

describe("finding where the conversation is", () => {
  test("members of a workspace collapse onto one bus, not one row each", () => {
    // Otherwise you get four rows for one bus and open the wrong panel.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "parley-buses-")));
    const registered: string[] = [];
    try {
      for (const name of ["alpha", "beta"]) gitRepo(join(root, name));
      markAsWorkspace(root, {
        file: null, members: [join(root, "alpha"), join(root, "beta")], at: "",
      });

      for (const name of ["alpha", "beta"]) {
        const dir = join(root, name);
        registerRepo(join(dir, ".git"), dir, join(root, ".parley"));
        registered.push(join(dir, ".git"));
      }

      const mine = summariseBuses().filter((b) => comparable(b.root).startsWith(comparable(root)));
      expect(mine).toHaveLength(1);
      expect(mine[0]!.scope).toBe("workspace");
      expect(comparable(mine[0]!.root)).toBe(comparable(root));
    } finally {
      for (const key of registered) forgetRepo(key);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a repository outside the workspace keeps its own bus", () => {
    // Asserted on scope resolution rather than on the aggregate: the registry
    // is machine-wide state that other tests write to, and a flaky assertion
    // about "how many buses exist" tells you nothing about the property that
    // matters — which is that a folder under a marked directory, but not named
    // by it, is not part of that workspace.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "parley-buses-")));
    try {
      for (const name of ["member", "outsider"]) gitRepo(join(root, name));
      markAsWorkspace(root, { file: null, members: [join(root, "member")], at: "" });

      const inside = locateRepo(join(root, "member"));
      expect(inside.scope).toBe("workspace");
      expect(comparable(inside.root)).toBe(comparable(root));

      const outside = locateRepo(join(root, "outsider"));
      expect(outside.scope).toBe("repository");
      expect(comparable(outside.root)).toBe(comparable(join(root, "outsider")));

      // Different scope means a different bus, which is the whole point.
      expect(outside.repoId).not.toBe(inside.repoId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a registered path that no longer exists is dropped, not reported", () => {
    const before = summariseBuses().length;
    registerRepo("/nowhere/.git", "/nowhere", "/nowhere/.git/parley");
    expect(summariseBuses().length).toBe(before);
    forgetRepo("/nowhere/.git");
    expect(readRegistry().some((r) => r.root === "/nowhere")).toBe(false);
  });
});
