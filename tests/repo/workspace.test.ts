import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkspaceRoot, findWorkspaceScope, markAsWorkspace, membersOf } from "../../src/repo/workspace";

function workspace(repos: string[]): string {
  // Real path throughout: on macOS the temp dir is reached through a symlink,
  // and parley resolves paths before comparing them.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "parley-ws-")));
  for (const r of repos) {
    mkdirSync(join(root, r, ".git"), { recursive: true });
    writeFileSync(join(root, r, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  }
  return root;
}

describe("a multi-root workspace as one bus", () => {
  test("finds the git repositories directly inside it", () => {
    const root = workspace(["backend", "frontend", "mobile"]);
    try {
      expect(membersOf(root)).toEqual(["backend", "frontend", "mobile"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a session anywhere inside lands on the same bus", () => {
    const root = workspace(["backend", "frontend"]);
    try {
      markAsWorkspace(root, { file: null, members: membersOf(root).map((m) => join(root, m)), at: "" });
      const fromBackend = findWorkspaceScope(join(root, "backend"));
      const fromFrontend = findWorkspaceScope(join(root, "frontend", "src"));
      expect(fromBackend?.repoId).toBe(fromFrontend!.repoId);
      // Territory is relative to the workspace, so it names the repository.
      expect(fromBackend?.root).toBe(root);
      expect(fromBackend?.scope).toBe("workspace");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("without the marker there is no workspace — it is never inferred", () => {
    // Guessing would put the same session on a different bus depending on where
    // it was started from, and territory that silently splits is worse than none.
    const root = workspace(["backend", "frontend"]);
    try {
      expect(findWorkspaceRoot(join(root, "backend"))).toBeNull();
      expect(findWorkspaceScope(join(root, "backend"))).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the nearest marked ancestor wins", () => {
    const outer = workspace(["a"]);
    try {
      const inner = join(outer, "a");
      markAsWorkspace(outer, { file: null, members: [join(outer, "a")], at: "" });
      markAsWorkspace(inner, { file: null, members: [inner], at: "" });
      expect(findWorkspaceRoot(join(inner, "src"))).toBe(inner);
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });

  test("parley files live in .parley/ at the workspace root", () => {
    const root = workspace(["a"]);
    try {
      markAsWorkspace(root, { file: null, members: membersOf(root).map((m) => join(root, m)), at: "" });
      expect(findWorkspaceScope(root)?.discoveryDir).toBe(join(root, ".parley"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

import { parseWorkspaceFile, readWorkspaceFile, findWorkspaceScope as scopeOf } from "../../src/repo/workspace";

describe("reading a .code-workspace", () => {
  test("takes only the folders it names, not everything in the directory", () => {
    // The real case: 7 folders in the workspace, 22 directories on disk.
    const root = workspace(["yzilab", "yzilab-front", "animalex-site", "unrelated", "another"]);
    try {
      const file = join(root, "yzilab.code-workspace");
      writeFileSync(file, JSON.stringify({
        folders: [{ name: "yzilab", path: "yzilab" }, { path: "yzilab-front" }, { path: "animalex-site" }],
      }), "utf8");

      const read = readWorkspaceFile(file)!;
      expect(read.root).toBe(root);
      expect(read.members.map((m) => m.split("/").pop())).toEqual(["yzilab", "yzilab-front", "animalex-site"]);
      expect(read.members.some((m) => m.endsWith("/unrelated"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a folder that is not a member keeps its own bus", () => {
    const root = workspace(["member", "outsider"]);
    try {
      markAsWorkspace(root, { file: null, members: [join(root, "member")], at: "" });
      expect(scopeOf(join(root, "member", "src"))?.root).toBe(root);
      // The whole point: `outsider` lives under the marked directory and is
      // still not part of this workspace.
      expect(scopeOf(join(root, "outsider"))).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("comments and trailing commas do not defeat it", () => {
    // VS Code accepts these, so refusing them would be refusing a valid file.
    const text = `{
      // the projects we work on together
      "folders": [
        { "path": "a" },
        { "path": "b" }, /* and b */
      ],
    }`;
    expect(parseWorkspaceFile(text)).toEqual(["a", "b"]);
  });

  test("a workspace whose folders sit above the file still gets one root", () => {
    const root = workspace(["one", "two"]);
    try {
      const nested = join(root, "one");
      const file = join(nested, "shared.code-workspace");
      writeFileSync(file, JSON.stringify({ folders: [{ path: "." }, { path: "../two" }] }), "utf8");
      const read = readWorkspaceFile(file)!;
      expect(read.root).toBe(root);
      expect(read.members.map((m) => m.split("/").pop()).sort()).toEqual(["one", "two"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a file with no folders is refused rather than making an empty bus", () => {
    const root = workspace(["a"]);
    try {
      const file = join(root, "empty.code-workspace");
      writeFileSync(file, JSON.stringify({ folders: [] }), "utf8");
      expect(readWorkspaceFile(file)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

import { symlinkSync } from "node:fs";
import { realPath } from "../../src/repo/workspace";

describe("symlinked paths", () => {
  test("two spellings of the same directory are the same member", () => {
    // /tmp is a symlink to /private/tmp on macOS, home directories are
    // symlinked on plenty of setups, and a harness may hand us either form.
    // Comparing them as text made a session inside a workspace fall back to
    // its own repository bus — silently, which is the worst kind.
    const root = workspace(["alpha", "beta"]);
    try {
      const real = root;
      markAsWorkspace(real, {
        file: null, members: [join(real, "alpha"), join(real, "beta")], at: "",
      });
      // Ask using the un-resolved spelling.
      const scope = scopeOf(join(root, "alpha", "src"));
      expect(scope).not.toBeNull();
      expect(realPath(scope!.root)).toBe(real);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a member reached through a symlink still belongs", () => {
    const root = workspace(["real"]);
    try {
      const resolved = root;
      const link = join(resolved, "link");
      symlinkSync(join(resolved, "real"), link);
      markAsWorkspace(resolved, { file: null, members: [join(resolved, "real")], at: "" });
      expect(scopeOf(link)).not.toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

import { commonAncestor, comparable, isWithin } from "../../src/repo/workspace";

describe("comparing paths across operating systems", () => {
  test("a backslash path is not treated as one giant segment", () => {
    // On Windows the separator is a backslash and the filesystem ignores case.
    // Splitting on "/" made every membership check fail there and turned the
    // common ancestor of a set of C:\... paths into "/".
    expect(comparable("C:\\Users\\me\\proj").includes("/")).toBe(true);
    expect(comparable("C:\\Users\\me\\proj")).not.toBe("/");
  });

  test("the common ancestor of sibling directories is their parent", () => {
    const root = workspace(["one", "two"]);
    try {
      expect(comparable(commonAncestor([join(root, "one"), join(root, "two")])))
        .toBe(comparable(root));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a single path is its own ancestor, never the filesystem root", () => {
    const root = workspace(["only"]);
    try {
      expect(comparable(commonAncestor([join(root, "only")]))).toBe(comparable(join(root, "only")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("isWithin accepts the directory itself and what is under it, nothing else", () => {
    const root = workspace(["a", "b"]);
    try {
      expect(isWithin(join(root, "a"), join(root, "a"))).toBe(true);
      expect(isWithin(join(root, "a", "src"), join(root, "a"))).toBe(true);
      expect(isWithin(join(root, "b"), join(root, "a"))).toBe(false);
      // A sibling whose name merely starts the same must not match.
      expect(isWithin(`${join(root, "a")}-other`, join(root, "a"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
