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
      markAsWorkspace(root);
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
      markAsWorkspace(outer);
      markAsWorkspace(inner);
      expect(findWorkspaceRoot(join(inner, "src"))).toBe(inner);
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });

  test("parley files live in .parley/ at the workspace root", () => {
    const root = workspace(["a"]);
    try {
      markAsWorkspace(root);
      expect(findWorkspaceScope(root)?.discoveryDir).toBe(join(root, ".parley"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
