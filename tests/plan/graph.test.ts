import { describe, expect, test } from "bun:test";
import { collisions, waves } from "../../src/plan/graph";
import type { PlanTask } from "../../src/plan/parse";

const task = (n: number, paths: string[]): PlanTask => ({ n, title: `Task ${n}`, paths, parseError: null });

describe("computing what may run together", () => {
  test("disjoint tasks share one wave", () => {
    const out = waves([task(1, ["a/x.ts"]), task(2, ["b/y.ts"]), task(3, ["c/z.ts"])]);
    expect(out).toHaveLength(1);
    expect(out[0]!.tasks.map((t) => t.n)).toEqual([1, 2, 3]);
  });

  test("two tasks touching the same file are serialised, in plan order", () => {
    const out = waves([task(1, ["src/app.ts"]), task(2, ["src/app.ts"])]);
    expect(out).toHaveLength(2);
    expect(out[0]!.tasks.map((t) => t.n)).toEqual([1]);
    expect(out[1]!.tasks.map((t) => t.n)).toEqual([2]);
  });

  test("a glob colliding with a file is a collision", () => {
    const out = waves([task(1, ["src/**"]), task(2, ["src/app.ts"])]);
    expect(out).toHaveLength(2);
    expect(out[0]!.tasks.map((t) => t.n)).toEqual([1]);
    expect(out[1]!.tasks.map((t) => t.n)).toEqual([2]);
  });

  // patternsOverlap resolves an undecidable wildcard pair (both sides carry a
  // wildcard) to conflict, never to clear — see tests/repo/paths.test.ts,
  // "undecidable wildcard pairs resolve to conflict, never to clear". This
  // test proves the graph preserves that bias rather than re-deciding it:
  // "src/*.ts" and "src/a*" name genuinely different, overlapping-but-not-
  // identical sets, and the codebase would rather over-serialise than miss it.
  test("maybe is treated as collision, because a false clear costs two agents editing one file", () => {
    const out = waves([task(1, ["src/*.ts"]), task(2, ["src/a*"])]);
    expect(collisions(out.flatMap((w) => w.tasks)).get(1)).toContain(2);
  });

  test("the graph is reported, not just the waves", () => {
    const map = collisions([task(1, ["src/app.ts"]), task(2, ["src/app.ts"]), task(3, ["other.ts"])]);
    expect(map.get(1)).toEqual([2]);
    expect(map.get(2)).toEqual([1]);
    expect(map.get(3)).toEqual([]);
  });

  test("a task with no paths never collides and never blocks anything", () => {
    const out = waves([task(1, []), task(2, ["src/app.ts"])]);
    expect(out).toHaveLength(1);
    expect(out[0]!.tasks.map((t) => t.n)).toEqual([1, 2]);
  });

  test("five tasks, one collision: two waves, not five and not one", () => {
    const out = waves([
      task(1, ["a.ts"]), task(2, ["b.ts"]), task(3, ["a.ts"]),
      task(4, ["c.ts"]), task(5, ["d.ts"]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.tasks.map((t) => t.n)).toEqual([1, 2, 4, 5]);
    expect(out[1]!.tasks.map((t) => t.n)).toEqual([3]);
  });

  describe("duplicate task numbers", () => {
    // Task 1's parser does not validate that task numbers are unique — a
    // plan that repeats a number is a malformed plan, not this module's to
    // reject outright (no function here may throw). `collisions` keys its
    // result by task number, so two tasks sharing a number cannot be told
    // apart in that Map. Chosen behaviour: union, never drop. If ANY task
    // carrying a number collides with another number, that collision is
    // reported for the shared number — the same "maybe is a conflict" bias
    // as patternsOverlap, applied one level up. A number never collides
    // with itself: that is not information the Map's caller could act on.
    test("collisions unions across duplicate numbers instead of losing one task's real collision", () => {
      const tasks = [task(1, ["a.ts"]), task(1, ["b.ts"]), task(2, ["a.ts"])];
      const map = collisions(tasks);
      expect(map.get(1)).toEqual([2]);
      expect(map.get(1)).not.toContain(1);
      expect(map.get(2)).toEqual([1]);
    });

    test("waves still schedules each duplicate-numbered task by its own real paths, not by its shared number", () => {
      const tasks = [task(1, ["a.ts"]), task(1, ["b.ts"]), task(2, ["a.ts"])];
      const out = waves(tasks);
      expect(out).toHaveLength(2);
      expect(out[0]!.tasks.map((t) => t.paths[0])).toEqual(["a.ts", "b.ts"]);
      expect(out[0]!.tasks.map((t) => t.n)).toEqual([1, 1]);
      expect(out[1]!.tasks.map((t) => t.paths[0])).toEqual(["a.ts"]);
      expect(out[1]!.tasks.map((t) => t.n)).toEqual([2]);
    });
  });
});
