import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlan } from "../../src/plan/parse";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "example-plan.md"), "utf8");

describe("parsing a superpowers plan", () => {
  test("it finds every task, in order", () => {
    const plan = parsePlan(fixture);
    expect(plan.tasks.map((t) => t.n)).toEqual([1, 2, 3]);
    expect(plan.tasks[1]!.title).toBe("Screen builder labels");
  });

  test("it reads the goal and the spec the plan argues from", () => {
    const plan = parsePlan(fixture);
    expect(plan.goal).toContain("tablet in landscape");
    expect(plan.spec).toBe("docs/superpowers/specs/2026-08-19-responsive-design.md");
  });

  test("Create, Modify and Test are all territory", () => {
    const plan = parsePlan(fixture);
    expect(plan.tasks[1]!.paths.sort()).toEqual([
      "static/js/labels.js",
      "templates/pages/app/screen_builder.html",
    ]);
  });

  test("a line range is stripped — the claim is the file, not the lines", () => {
    const plan = parsePlan(fixture);
    expect(plan.tasks[0]!.paths).toContain("static/css/custom.css");
    expect(plan.tasks[0]!.paths.join()).not.toContain("40-120");
  });

  test("a task with no Files block is returned with the reason, never dropped", () => {
    const plan = parsePlan(fixture);
    const orphan = plan.tasks.find((t) => t.n === 3)!;
    expect(orphan.paths).toEqual([]);
    expect(orphan.parseError).toContain("no **Files:** block");
  });

  test("windows spellings normalise like every other path", () => {
    const plan = parsePlan("### Task 1: x\n\n**Files:**\n- Modify: `src\\app.ts`\n");
    expect(plan.tasks[0]!.paths).toEqual(["src/app.ts"]);
  });

  test("a plan with no tasks parses to an empty list, not an exception", () => {
    expect(parsePlan("# Just a heading\n").tasks).toEqual([]);
  });

  test("bullets that are not paths are ignored rather than turned into territory", () => {
    const plan = parsePlan("### Task 1: x\n\n**Files:**\n- Modify: the database, somehow\n");
    expect(plan.tasks[0]!.paths).toEqual([]);
    expect(plan.tasks[0]!.parseError).toContain("no usable path");
  });

  test("indented Files bullets are captured in full, not truncated mid-block", () => {
    const plan = parsePlan(
      "### Task 1: x\n\n**Files:**\n  - Create: `a.ts`\n  - Modify: `b.ts`\n  - Test: `c.ts`\n",
    );
    expect(plan.tasks[0]!.paths.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(plan.tasks[0]!.parseError).toBeNull();
  });

  test("a heading with an empty title still registers as its own task, and does not absorb its neighbor", () => {
    const plan = parsePlan(
      "### Task 1: First\n\n**Files:**\n- Create: `a.ts`\n\n### Task 2:\n\n**Files:**\n- Create: `b.ts`\n",
    );
    expect(plan.tasks.map((t) => t.n)).toEqual([1, 2]);
    expect(plan.tasks[1]!.title).toBe("");
    expect(plan.tasks[1]!.paths).toEqual(["b.ts"]);
    // The empty-title task must not have folded its file into its predecessor.
    expect(plan.tasks[0]!.paths).toEqual(["a.ts"]);
  });

  test("a path that fails to normalize is not silently dropped when a sibling path succeeds", () => {
    const plan = parsePlan(
      "### Task 1: x\n\n**Files:**\n- Modify: `src/app.ts`\n- Modify: `../../escape.ts`\n",
    );
    expect(plan.tasks[0]!.paths).toEqual(["src/app.ts"]);
    expect(plan.tasks[0]!.parseError).not.toBeNull();
  });
});
