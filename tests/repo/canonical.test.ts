import { describe, expect, test } from "bun:test";
import { canonicalizeRepoPath, repoId, type CanonEnv } from "../../src/repo/canonical";

const id = (p: string) => p;
const windows: CanonEnv = { platform: "win32", caseInsensitive: true, isWSL: false, realpath: id };
const wsl: CanonEnv = { platform: "linux", caseInsensitive: false, isWSL: true, realpath: id };
const linux: CanonEnv = { platform: "linux", caseInsensitive: false, isWSL: false, realpath: id };
const mac: CanonEnv = { platform: "darwin", caseInsensitive: true, isWSL: false, realpath: id };

describe("the WSL boundary", () => {
  test("Windows and WSL views of the same repo produce the SAME id", () => {
    const fromWindows = canonicalizeRepoPath("C:\\dev\\proj\\.git", windows);
    const fromWSL = canonicalizeRepoPath("/mnt/c/dev/proj/.git", wsl);
    expect(fromWindows).toBe("c/dev/proj/.git");
    expect(fromWSL).toBe("c/dev/proj/.git");
    expect(repoId(fromWindows)).toBe(repoId(fromWSL));
  });

  test("case differences on a Windows drive collapse, even seen from Linux", () => {
    // env.caseInsensitive is false here (Linux root), but /mnt/c is NTFS.
    expect(canonicalizeRepoPath("/mnt/C/DEV/Proj", wsl)).toBe("c/dev/proj");
    expect(canonicalizeRepoPath("c:\\DEV\\Proj", windows)).toBe("c/dev/proj");
  });

  test("a plain Linux box with a real /mnt/c is NOT reduced", () => {
    // Without this gate we would merge two unrelated repos into one bus.
    expect(canonicalizeRepoPath("/mnt/c/dev/proj", linux)).toBe("/mnt/c/dev/proj");
  });

  test("bare drive root", () => {
    expect(canonicalizeRepoPath("C:\\", windows)).toBe("c");
    expect(canonicalizeRepoPath("/mnt/c", wsl)).toBe("c");
  });
});

describe("normalisation", () => {
  test("case is preserved on case-sensitive filesystems", () => {
    expect(canonicalizeRepoPath("/home/User/Proj", linux)).toBe("/home/User/Proj");
  });

  test("case is folded on macOS", () => {
    expect(canonicalizeRepoPath("/Users/Marcus/Proj", mac)).toBe("/users/marcus/proj");
  });

  test("trailing and duplicated separators collapse", () => {
    expect(canonicalizeRepoPath("/home/user/proj///", linux)).toBe("/home/user/proj");
    expect(canonicalizeRepoPath("C:\\dev\\\\proj\\", windows)).toBe("c/dev/proj");
  });

  test("symlinks are resolved before anything else", () => {
    const env: CanonEnv = { ...linux, realpath: () => "/real/target" };
    expect(canonicalizeRepoPath("/link/to/proj", env)).toBe("/real/target");
  });
});

describe("repoId", () => {
  test("is 16 lowercase hex characters", () => {
    expect(repoId("c/dev/proj")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is stable across calls and distinct across inputs", () => {
    expect(repoId("c/dev/proj")).toBe(repoId("c/dev/proj"));
    expect(repoId("c/dev/proj")).not.toBe(repoId("c/dev/proj2"));
  });
});
