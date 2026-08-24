# Shape Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a superpowers implementation plan into dispatched work on the bus — and compute, rather than guess, which tasks may run at the same time.

**Architecture:** A pure parser reads the `### Task N` / `**Files:**` structure that `superpowers:writing-plans` already requires, producing tasks with declared paths. `patternsOverlap` turns those paths into a collision graph. Tasks with no live collision dispatch together; the rest serialise. Dispatch is authoritative over fronts working the plan, and never over a front a person is directing by hand.

**Tech Stack:** TypeScript, Bun. No new dependencies. No changes to superpowers itself.

**Spec:** `docs/superpowers/specs/2026-08-20-shapes-work-pool-and-capacity-design.md` §5

**Depends on:** `docs/superpowers/plans/2026-08-20-work-pool.md` (all tasks). Capacity is optional — without it, planned work dispatches only to fronts that already exist.

## Global Constraints

- No `Date.now()`, no `Math.random()`, no I/O in the parser or anywhere under `src/state/`. The parser takes a string and returns data.
- A task whose `**Files:**` block will not parse is published as `open` with the parse failure as its title. **Never drop a task silently** — that is the one failure that would make the whole feature untrustworthy.
- A plan never overrides live possession. Dispatch authority covers fronts working the plan; a front a person is directing keeps its claim.
- The coordinator is a front, never the daemon. No model runs inside the bus.
- `bun run typecheck` and `bun test` must pass before every commit.

---

### Task 1: The plan parser

**Files:**
- Create: `src/plan/parse.ts`
- Create: `tests/plan/fixtures/example-plan.md`
- Test: `tests/plan/parse.test.ts`

**Interfaces:**
- Consumes: `normalizeTerritoryPath` from `src/repo/paths.ts`.
- Produces:
  ```ts
  export interface PlanTask {
    n: number;
    title: string;
    paths: string[];
    /** Set when the Files block was missing or unusable. The task is still returned. */
    parseError: string | null;
  }
  export interface ParsedPlan { goal: string; spec: string | null; tasks: PlanTask[] }
  export function parsePlan(markdown: string): ParsedPlan;
  ```

- [ ] **Step 1: Write the fixture**

```markdown
<!-- tests/plan/fixtures/example-plan.md -->
# Responsive Layer Implementation Plan

**Goal:** Make the dashboard usable on a tablet in landscape.

**Spec:** docs/superpowers/specs/2026-08-19-responsive-design.md

---

### Task 1: Sidebar targets

**Files:**
- Modify: `static/css/custom.css:40-120`
- Test: `tests/responsive/audit.py`

- [ ] **Step 1: Write the failing test**

### Task 2: Screen builder labels

**Files:**
- Modify: `templates/pages/app/screen_builder.html`
- Create: `static/js/labels.js`

- [ ] **Step 1: Write the failing test**

### Task 3: Something with no files at all

- [ ] **Step 1: Do a thing**
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/plan/parse.test.ts
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
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun test tests/plan/parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the parser**

```ts
// src/plan/parse.ts
import { normalizeTerritoryPath } from "../repo/paths";

export interface PlanTask {
  n: number;
  title: string;
  paths: string[];
  /** Set when the Files block was missing or unusable. The task is still returned. */
  parseError: string | null;
}

export interface ParsedPlan {
  goal: string;
  spec: string | null;
  tasks: PlanTask[];
}

const TASK_HEADING = /^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/;
const FILES_BLOCK = /^\*\*Files:\*\*\s*$/;
const FILE_LINE = /^-\s*(?:Create|Modify|Test)\s*:\s*`([^`]+)`/i;

/**
 * A superpowers plan already declares, for every task, the exact files it
 * touches. That block is a territory claim written by hand and approved by a
 * person — which is why parallelism here can be computed instead of guessed.
 *
 * Pure: markdown in, data out. No clock, no I/O. "Do two tasks in this plan
 * collide?" is therefore a deterministic unit test.
 */
export function parsePlan(markdown: string): ParsedPlan {
  const lines = markdown.split(/\r?\n/);
  const tasks: PlanTask[] = [];
  let goal = "";
  let spec: string | null = null;

  interface Building extends PlanTask { sawFiles: boolean }
  let current: Building | null = null;
  let inFiles = false;

  for (const line of lines) {
    if (!goal) {
      const m = line.match(/^\*\*Goal:\*\*\s*(.+)$/);
      if (m) { goal = m[1]!.trim(); continue; }
    }
    if (spec === null) {
      const m = line.match(/^\*\*Spec:\*\*\s*(.+)$/);
      if (m) { spec = m[1]!.trim().replace(/^`|`$/g, ""); continue; }
    }

    const heading = line.match(TASK_HEADING);
    if (heading) {
      if (current) tasks.push(finish(current));
      current = { n: Number(heading[1]), title: heading[2]!.trim(), paths: [], parseError: null, sawFiles: false };
      inFiles = false;
      continue;
    }
    if (!current) continue;

    if (FILES_BLOCK.test(line.trim())) { inFiles = true; current.sawFiles = true; continue; }
    if (inFiles) {
      if (line.trim() === "") continue;
      const file = line.match(FILE_LINE);
      if (file) {
        // `path.py:123-145` names lines. The unit of territory is the file.
        const raw = file[1]!.replace(/:\d+(-\d+)?$/, "");
        try { current.paths.push(normalizeTerritoryPath(raw)); } catch { /* not a path */ }
        continue;
      }
      if (line.startsWith("-")) continue;   // a bullet that is not a path
      inFiles = false;
    }
  }
  if (current) tasks.push(finish(current));

  return { goal, spec, tasks };
}

function finish(task: PlanTask & { sawFiles: boolean }): PlanTask {
  const { sawFiles, ...rest } = task;
  if (rest.paths.length > 0) return rest;
  // Two distinct reasons, because they are two distinct mistakes: a plan that
  // forgot the block, and a block that named something that is not a path.
  return {
    ...rest,
    parseError: sawFiles
      ? "**Files:** block present but no usable path inside it"
      : "no **Files:** block",
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/plan/parse.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/plan/parse.ts tests/plan
git commit -m "feat: o bloco Files de cada task já é uma claim, e dá para ler"
```

---

### Task 2: The collision graph

**Files:**
- Create: `src/plan/graph.ts`
- Test: `tests/plan/graph.test.ts`

**Interfaces:**
- Consumes: `PlanTask` from Task 1; `patternsOverlap` from `src/repo/paths.ts`.
- Produces:
  ```ts
  export interface Wave { tasks: PlanTask[] }
  export function collisions(tasks: PlanTask[]): Map<number, number[]>;
  export function waves(tasks: PlanTask[]): Wave[];
  ```
  `waves` returns tasks grouped so that no two tasks in one wave share a path, and a task never appears before a lower-numbered task it collides with.

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan/graph.test.ts
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
  });

  test("maybe is treated as collision, because a false clear costs two agents editing one file", () => {
    const out = waves([task(1, ["src/*/a.ts"]), task(2, ["src/*/b.ts"])]);
    expect(collisions(out.flatMap((w) => w.tasks)).get(1)).toContain(2);
  });

  test("the graph is reported, not just the waves", () => {
    const map = collisions([task(1, ["src/app.ts"]), task(2, ["src/app.ts"]), task(3, ["other.ts"])]);
    expect(map.get(1)).toEqual([2]);
    expect(map.get(3)).toEqual([]);
  });

  test("a task with no paths never collides and never blocks anything", () => {
    const out = waves([task(1, []), task(2, ["src/app.ts"])]);
    expect(out).toHaveLength(1);
  });

  test("thirteen files, three of which collide: four waves is wrong, two is right", () => {
    const out = waves([
      task(1, ["a.ts"]), task(2, ["b.ts"]), task(3, ["a.ts"]),
      task(4, ["c.ts"]), task(5, ["d.ts"]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.tasks.map((t) => t.n)).toEqual([1, 2, 4, 5]);
    expect(out[1]!.tasks.map((t) => t.n)).toEqual([3]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/plan/graph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// src/plan/graph.ts
import { patternsOverlap } from "../repo/paths";
import type { PlanTask } from "./parse";

export interface Wave {
  tasks: PlanTask[];
}

/**
 * Which tasks cannot run at the same time.
 *
 * `patternsOverlap` answers "maybe" as conflict on purpose: a false conflict
 * costs one wave of latency, a false clear costs two agents editing the same
 * file and finding out from CI.
 *
 * Every orchestrator on the market asks a human whether the tasks are
 * independent. This is the same question, answered from the paths the plan
 * already declares.
 */
export function collisions(tasks: PlanTask[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const a of tasks) map.set(a.n, []);
  for (const a of tasks) {
    for (const b of tasks) {
      if (a.n >= b.n) continue;
      const hits = a.paths.some((pa) => b.paths.some((pb) => patternsOverlap(pa, pb)));
      if (!hits) continue;
      map.get(a.n)!.push(b.n);
      map.get(b.n)!.push(a.n);
    }
  }
  return map;
}

/** Greedy by plan order: a task joins the first wave that holds nothing it collides with. */
export function waves(tasks: PlanTask[]): Wave[] {
  const ordered = [...tasks].sort((a, b) => a.n - b.n);
  const out: Wave[] = [];
  for (const task of ordered) {
    const wave = out.find(
      (w) => !w.tasks.some((other) =>
        task.paths.some((pa) => other.paths.some((pb) => patternsOverlap(pa, pb))),
      ),
    );
    if (wave) wave.tasks.push(task);
    else out.push({ tasks: [task] });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/plan/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plan/graph.ts tests/plan/graph.test.ts
git commit -m "feat: paralelismo deixa de ser palpite e passa a ser conta"
```

---

### Task 3: `parley plan` publishes a wave

**Files:**
- Modify: `src/state/work.ts` (add `dispatchPlan`)
- Modify: `src/state/types.ts` (add `State.plan`)
- Modify: `src/protocol/types.ts` (`OPS` gains `plan`)
- Modify: `src/state/machine.ts` (dispatch)
- Modify: `src/cli/main.ts` (`parley plan <file>` reads the file and sends the parsed tasks)
- Test: `tests/state/plan-dispatch.test.ts`

**Interfaces:**
- Consumes: `PlanTask` (Task 1), `waves` (Task 2), `publishWork` and `WorkItem` from the work-pool plan.
- Produces:
  - ```ts
    export interface PlanState {
      goal: string;
      spec: string | null;
      waves: { taskNumbers: number[] }[];
      waveIndex: number;
      itemsByTask: Record<number, string[]>;
    }
    ```
    on `State.plan: PlanState | null`.
  - `export function dispatchPlan(state, actorId, frame, ctx): Outcome` — frame `{ op: "plan", goal, spec, tasks: PlanTask[] }`.
  - The CLI does the file reading; the state machine only ever sees parsed data.

- [ ] **Step 1: Write the failing test**

```ts
// tests/state/plan-dispatch.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: `${name} mission` }, at(ms));
  return (out.response as unknown as { id: string }).id;
}
const task = (n: number, paths: string[]) => ({ n, title: `Task ${n}`, paths, parseError: null });

let state: State;
let coord: string;
let worker: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "plan" }, at(0));
  coord = joined(state, "COORD", 10);
  worker = joined(state, "WORKER", 20);
});

describe("dispatching a plan", () => {
  test("only the first wave becomes work; later waves wait", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [task(1, ["a.ts"]), task(2, ["b.ts"]), task(3, ["a.ts"])],
    }, at(100));

    expect(state.work.filter((w) => w.state !== "done")).toHaveLength(2);
    expect(state.plan!.waveIndex).toBe(0);
    expect(state.plan!.waves).toHaveLength(2);
  });

  test("planned items are marked planned, so they cannot be dropped", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    expect(state.work[0]!.origin).toBe("planned");
  });

  test("a plan never overrides live possession: a held path is not dispatched", () => {
    apply(state, worker, { v: 1, op: "claim", paths: ["a.ts"], intent: "person-directed work" }, at(50));
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["b.ts"])],
    }, at(100));

    const held = state.work.find((w) => w.paths[0] === "a.ts")!;
    expect(held.state).toBe("open");
    expect(held.takenById).toBeNull();
    expect(out.broadcast.some((e) => e.text.includes("waiting"))).toBe(true);
  });

  test("a task that would not parse is published, never dropped", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [{ n: 1, title: "mystery", paths: [], parseError: "no **Files:** block" }],
    }, at(100));
    expect(state.work).toHaveLength(1);
    expect(state.work[0]!.title).toContain("no **Files:** block");
    expect(state.work[0]!.state).toBe("open");
  });

  test("finishing every item in a wave advances to the next one", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [task(1, ["a.ts"]), task(2, ["a.ts"])],
    }, at(100));
    const first = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: first.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: first.id }, at(300));

    expect(state.plan!.waveIndex).toBe(1);
    expect(state.work.filter((w) => w.state === "open" || w.state === "offered")).toHaveLength(1);
  });

  test("planning is refused outside shape plan", () => {
    apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(90));
    const out = apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    expect(out.response.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/state/plan-dispatch.test.ts`
Expected: FAIL — `UNKNOWN_OP: plan`.

- [ ] **Step 3: Implement `dispatchPlan`**

Add `plan: PlanState | null` to `State`, `null` in `emptyState`, `"plan"` to `OPS`.

```ts
// src/state/work.ts
import { waves as computeWaves } from "../plan/graph";
import type { PlanTask } from "../plan/parse";

/**
 * A plan is dispatched one wave at a time.
 *
 * The waves come from the paths the plan declares, so a wave is a proof that
 * its tasks cannot collide — not an assurance that they probably do not.
 */
export function dispatchPlan(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  if (state.shape !== "plan") {
    return { state, response: err("UNKNOWN_OP", "plans are dispatched in shape plan — parley shape plan"), broadcast: [] };
  }
  const tasks = (Array.isArray(frame.tasks) ? frame.tasks : []) as PlanTask[];
  if (tasks.length === 0) return { state, response: err("UNKNOWN_OP", "a plan needs tasks"), broadcast: [] };

  const computed = computeWaves(tasks);
  state.plan = {
    goal: typeof frame.goal === "string" ? frame.goal : "",
    spec: typeof frame.spec === "string" ? frame.spec : null,
    waves: computed.map((w) => ({ taskNumbers: w.tasks.map((t) => t.n) })),
    waveIndex: 0,
    itemsByTask: {},
  };

  const broadcast = [pushEvent(state, ctx, {
    kind: "system", from: null, to: null, priority: "high",
    text: `${me.name} dispatched a plan: ${tasks.length} task(s) in ${computed.length} wave(s) — the waves are computed from the paths each task declares`,
    about: me.id,
  })];

  broadcast.push(...openWave(state, computed[0]!.tasks, tasks, ctx));
  return { state, response: ok({ waves: computed.length, dispatched: computed[0]!.tasks.length }), broadcast };
}

function openWave(state: State, waveTasks: PlanTask[], all: PlanTask[], ctx: Ctx): ConvEvent[] {
  const events: ConvEvent[] = [];
  for (const task of waveTasks) {
    const title = task.parseError ? `${task.title} — ${task.parseError}` : task.title;
    const paths = task.paths.length > 0 ? task.paths : ["(no declared path)"];
    for (const path of paths) {
      // Ruling (a): dispatch authority covers fronts working the plan, never a
      // front a person is directing by hand. A held path is published open and
      // announced as waiting, rather than taken from its owner.
      const holder = state.claims.find((c) => c.orphanedAtMs === null && !c.auto && matchesPath(c.pattern, path));
      const item: WorkItem = {
        id: ctx.nextId("w"),
        paths: [path],
        title,
        evidenceIds: state.plan?.spec ? [state.plan.spec] : [],
        publishedById: "", publishedByName: "the plan",
        kind: "work",
        origin: "planned",
        state: "open",
        offeredToId: null, offeredAtMs: null, takenById: null,
        orphanedAtMs: null, nudgedAtMs: null,
        reviewOf: null,
        at: ctx.now,
      };
      state.work.push(item);
      (state.plan!.itemsByTask[task.n] ??= []).push(item.id);
      if (holder) {
        const owner = state.participants[holder.ownerId];
        events.push(pushEvent(state, ctx, {
          kind: "system", from: null, to: null, priority: "normal",
          text: `task ${task.n} is waiting: ${path} is held by ${owner?.name ?? "someone"} — the plan does not take it`,
        }));
      }
    }
  }
  return events;
}
```

In `finishWork`, after marking an item `done`, if `state.plan` exists and every item of the current wave is `done`, advance `waveIndex` and call `openWave` for the next one.

- [ ] **Step 4: Add the CLI command**

```
parley plan <path-to-plan.md>
```

Reads the file, calls `parsePlan`, sends `{ op: "plan", goal, spec, tasks }`. The state machine never touches the filesystem.

- [ ] **Step 5: Run the tests**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/plan src/state src/protocol/types.ts src/cli/main.ts tests/state/plan-dispatch.test.ts
git commit -m "feat: um plano do superpowers vira onda de trabalho no barramento"
```

---

### Task 4: Review is a state, not an agreement

**Files:**
- Modify: `src/state/work.ts` (emit a review item on `done` under `shape plan`)
- Test: `tests/state/plan-review.test.ts`

**Interfaces:**
- Consumes: `WorkItem.kind` and `WorkItem.reviewOf` from the work-pool plan; `finishWork`.
- Produces: finishing a `planned` item under `shape plan` creates a `kind: "review"` item anchored to the same paths, offered to a front that is not the one that did the work.

- [ ] **Step 1: Write the failing test**

```ts
// tests/state/plan-review.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: `${name} mission` }, at(ms));
  return (out.response as unknown as { id: string }).id;
}
const task = (n: number, paths: string[]) => ({ n, title: `Task ${n}`, paths, parseError: null });

let state: State;
let coord: string;
let worker: string;
let auditor: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "plan" }, at(0));
  coord = joined(state, "COORD", 10);
  worker = joined(state, "WORKER", 20);
  auditor = joined(state, "AUDITOR", 30);
});

describe("review after every task", () => {
  test("finishing a planned task creates a review item for it", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    expect(review).toBeDefined();
    expect(review.reviewOf).toBe(item.id);
    expect(review.paths).toEqual(item.paths);
  });

  test("the front that did the work is never offered its own review", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    expect(review.offeredToId).not.toBe(worker);
  });

  test("a wave is not finished until its reviews are", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["a.ts"])],
    }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));
    expect(state.plan!.waveIndex).toBe(0);

    const review = state.work.find((w) => w.kind === "review")!;
    apply(state, auditor, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, auditor, { v: 1, op: "done", id: review.id, summary: "validated and committed" }, at(500));
    expect(state.plan!.waveIndex).toBe(1);
  });

  test("in shape pool a review item is published by hand, and behaves the same", () => {
    apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(600));
    const out = apply(state, worker, {
      v: 1, op: "work", title: "check my responsive pass", paths: ["b.ts"], kind: "review",
    }, at(700));
    expect(out.response.ok).toBe(true);
    expect(state.work.find((w) => w.paths[0] === "b.ts")!.kind).toBe("review");
  });

  test("no review is created in shape pool automatically — nobody agreed to one", () => {
    apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(600));
    apply(state, worker, { v: 1, op: "work", title: "x", paths: ["c.ts"] }, at(700));
    const item = state.work.find((w) => w.paths[0] === "c.ts")!;
    apply(state, auditor, { v: 1, op: "take", id: item.id }, at(800));
    apply(state, auditor, { v: 1, op: "done", id: item.id }, at(900));
    expect(state.work.filter((w) => w.kind === "review" && w.reviewOf === item.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/state/plan-review.test.ts`
Expected: FAIL — no review item is created.

- [ ] **Step 3: Implement it**

In `finishWork`, before advancing the wave:

```ts
  // superpowers already requires a review after every task. Making it an item
  // is what turns the reviewing front people run by agreement into a state the
  // bus can see: who asked, who took it, and whether the verdict was applied.
  if (state.shape === "plan" && item.origin === "planned" && item.kind === "work") {
    const reviewer = liveParticipants(state).find((p) => p.id !== me.id && p.kind === "agent");
    const review: WorkItem = {
      id: ctx.nextId("w"),
      paths: [...item.paths],
      title: `review: ${item.title}`,
      evidenceIds: [item.id, ...item.evidenceIds],
      publishedById: me.id,
      publishedByName: me.name,
      kind: "review",
      origin: "planned",
      state: reviewer ? "offered" : "open",
      offeredToId: reviewer?.id ?? null,
      offeredAtMs: reviewer ? ctx.nowMs : null,
      takenById: null,
      orphanedAtMs: null,
      nudgedAtMs: null,
      reviewOf: item.id,
      at: ctx.now,
    };
    state.work.push(review);
    const taskN = taskNumberOf(state, item.id);
    if (taskN !== null) (state.plan!.itemsByTask[taskN] ??= []).push(review.id);
  }
```

`taskNumberOf` is a lookup over the map the dispatch already built:

```ts
/** Which task an item belongs to, or null for work published outside a plan. */
function taskNumberOf(state: State, itemId: string): number | null {
  if (!state.plan) return null;
  for (const [n, ids] of Object.entries(state.plan.itemsByTask)) {
    if (ids.includes(itemId)) return Number(n);
  }
  return null;
}
```

Wave completion checks that every item in `itemsByTask` for the wave's task numbers is `done`, reviews included.

- [ ] **Step 4: Run everything**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/work.ts tests/state/plan-review.test.ts
git commit -m "feat: revisão de par vira estado do barramento, e não combinado entre humanos"
```

---

### Task 5: The skill tells the coordinator what to do

**Files:**
- Modify: `src/adapters/` (the skill text)
- Modify: `README.md` (a `shape plan` section)
- Test: `tests/adapters/skill-plan.test.ts`

**Interfaces:**
- Consumes: `SKILL` in `src/adapters/claude-code.ts:337` — today a module-private const built from `SKILL_BODY`.
- Produces: `SKILL` becomes `export const SKILL`, so the text can be asserted without reading an installed file. Adding an export renames nothing.

- [ ] **Step 1: Write the failing test**

```ts
// tests/adapters/skill-plan.test.ts
import { describe, expect, test } from "bun:test";
import { SKILL } from "../../src/adapters/claude-code";

describe("what the skill says about plans", () => {
  test("it names the command and where a plan comes from", () => {
    expect(SKILL).toContain("parley plan");
    expect(SKILL).toContain("superpowers:writing-plans");
  });

  test("it tells the coordinator not to hand-fan tasks out", () => {
    expect(SKILL).toContain("waves are computed");
  });

  test("it tells a worker that taking returns the evidence", () => {
    expect(SKILL).toContain("parley take");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/adapters/skill-plan.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the skill section**

Four sentences, no more:

> When you have written a plan with `superpowers:writing-plans`, run
> `parley plan <path>`. parley reads the `**Files:**` block of each task and
> computes which tasks can run at the same time — do not fan them out by hand
> and do not guess. Other fronts take the tasks and you advance as waves
> complete. Taking an item returns the evidence the front that found it left
> behind; read it before re-deriving anything.

- [ ] **Step 4: Document it in the README**

A `shape plan` section under **The three modes**, renamed nowhere — `mode` keeps its meaning, `shape` is a new heading beside it. State plainly that superpowers is not modified, and that this fills the `no — parallel session` branch its own decision tree already declares.

- [ ] **Step 5: Run everything**

Run: `bun test && bun run typecheck && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters README.md tests/adapters/skill-plan.test.ts
git commit -m "feat: a skill manda usar parley plan, e não distribuir task na mão"
```

---

### Task 6: End to end, over a real socket

**Files:**
- Test: `tests/integration/shape-plan.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/integration/shape-plan.test.ts
import { describe, expect, test } from "bun:test";
import { withDaemon } from "./harness";

describe("a plan, over the wire", () => {
  test("three tasks, two waves, two fronts, reviews included", async () => {
    await withDaemon(async (connect) => {
      const coord = await connect("COORD");
      const worker = await connect("WORKER");
      const auditor = await connect("AUDITOR");

      await coord.send({ v: 1, op: "shape", shape: "plan" });
      await coord.send({
        v: 1, op: "plan", goal: "g", spec: null,
        tasks: [
          { n: 1, title: "A", paths: ["a.ts"], parseError: null },
          { n: 2, title: "B", paths: ["b.ts"], parseError: null },
          { n: 3, title: "C", paths: ["a.ts"], parseError: null },
        ],
      });

      const wave1 = await worker.send({ v: 1, op: "works", state: "open" });
      expect(wave1.work).toHaveLength(2);          // task 3 collides with task 1

      for (const item of wave1.work) {
        await worker.send({ v: 1, op: "take", id: item.id });
        await worker.send({ v: 1, op: "done", id: item.id });
      }

      const reviews = await auditor.send({ v: 1, op: "works", state: "offered" });
      expect(reviews.work.every((w: { kind: string }) => w.kind === "review")).toBe(true);

      for (const r of reviews.work) {
        await auditor.send({ v: 1, op: "take", id: r.id });
        await auditor.send({ v: 1, op: "done", id: r.id, summary: "ok" });
      }

      const wave2 = await worker.send({ v: 1, op: "works", state: "open" });
      expect(wave2.work).toHaveLength(1);
      expect(wave2.work[0].paths[0]).toBe("a.ts");
    });
  });

  test("a plan does not take a file a person's front is holding", async () => {
    await withDaemon(async (connect) => {
      const coord = await connect("COORD");
      const person = await connect("RESPONSIVO");
      await coord.send({ v: 1, op: "shape", shape: "plan" });
      await person.send({ v: 1, op: "claim", paths: ["a.ts"], intent: "mine" });
      await coord.send({
        v: 1, op: "plan", goal: "g", spec: null,
        tasks: [{ n: 1, title: "A", paths: ["a.ts"], parseError: null }],
      });
      const claims = await person.send({ v: 1, op: "who" });
      expect(JSON.stringify(claims)).toContain("a.ts");   // still theirs
    });
  });
});
```

> `withDaemon` comes from `tests/integration/harness.ts`, extracted in
> `docs/superpowers/plans/2026-08-20-work-pool.md` Task 8 Step 1. Do that first
> if it is not there yet.


- [ ] **Step 2: Run it**

Run: `bun test tests/integration/shape-plan.test.ts`
Expected: PASS once Tasks 1-5 are in.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/shape-plan.test.ts
git commit -m "test: um plano inteiro atravessa o socket, com ondas e revisões"
```
