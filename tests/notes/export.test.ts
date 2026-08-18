import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportNotes, parseNotes, readExportedNotes } from "../../src/notes/export";
import type { Note } from "../../src/state/types";

const note = (over: Partial<Note>): Note => ({
  id: "n_1", title: "t", body: "b", tags: [], paths: [], kind: "note",
  reversedBy: null, authorId: "p_1",
  authorName: "FINANCEIRO", at: "2026-08-18T14:00:00.000Z", ...over,
});

describe("notes round-trip through the versioned file", () => {
  test("what export writes, import reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-notes-"));
    try {
      const original: Note[] = [
        note({ id: "n_1", title: "the CI here runs tsc -b, not tsc --noEmit",
               body: "the root tsconfig is solution-style, so --noEmit checks nothing",
               tags: ["ci", "typescript"] }),
        note({ id: "n_2", title: "run alembic heads before creating a migration",
               body: "two heads from one parent is the failure we keep hitting", tags: ["alembic"] }),
      ];
      exportNotes(original, dir);

      const back = readExportedNotes(dir);
      expect(back).toHaveLength(2);
      expect(back[0]!.title).toBe("the CI here runs tsc -b, not tsc --noEmit");
      expect(back[0]!.tags).toEqual(["ci", "typescript"]);
      expect(back[0]!.body).toContain("solution-style");
      expect(back[1]!.title).toBe("run alembic heads before creating a migration");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a note with no tags and a multi-line body survives", () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-notes-"));
    try {
      exportNotes([note({ title: "one", body: "first line\n\nsecond line", tags: [] })], dir);
      const back = readExportedNotes(dir);
      expect(back[0]!.tags).toEqual([]);
      expect(back[0]!.body).toBe("first line\n\nsecond line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the generated preamble is not mistaken for a note", () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-notes-"));
    try {
      exportNotes([note({ title: "only one" })], dir);
      expect(readExportedNotes(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty file imports nothing rather than throwing", () => {
    expect(parseNotes("")).toEqual([]);
    expect(parseNotes("# parley notes\n\n_No notes yet._\n")).toEqual([]);
  });
});

describe("paths and decisions survive the round trip", () => {
  test("a path-anchored note comes back anchored", () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-notes-"));
    try {
      exportNotes([note({
        title: "this serializer is used by mobile too",
        body: "renaming fields breaks the collection screen",
        tags: ["mobile"], paths: ["src/backend/app/accounts/schemas.py"],
      })], dir);
      const back = readExportedNotes(dir);
      expect(back[0]!.paths).toEqual(["src/backend/app/accounts/schemas.py"]);
      expect(back[0]!.tags).toEqual(["mobile"]);
      expect(back[0]!.kind).toBe("note");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a decision comes back as a decision, not as a note", () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-notes-"));
    try {
      exportNotes([note({ title: "no Pydantic v2 yet", kind: "decision", paths: [] })], dir);
      const back = readExportedNotes(dir);
      expect(back[0]!.kind).toBe("decision");
      expect(back[0]!.title).toBe("no Pydantic v2 yet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("paths without tags parse on their own line", () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-notes-"));
    try {
      exportNotes([note({ title: "only paths", tags: [], paths: ["a.ts", "b/**"] })], dir);
      expect(readExportedNotes(dir)[0]!.paths).toEqual(["a.ts", "b/**"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
