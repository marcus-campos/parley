import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkspaceRoot, findWorkspaceScope, markAsWorkspace, membersOf } from "../../src/repo/workspace";

function workspace(repos: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "parley-ws-"));
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
