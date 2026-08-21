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

    // Task 3 collides with Task 1 on a.ts, so it belongs one wave later.
    // A bare count would also pass an implementation that dispatched all
    // three tasks and happened to produce two items some other way — assert
    // which tasks are actually live, not merely how many there are.
    const live = state.work.filter((w) => w.state !== "done").map((w) => w.title).sort();
    expect(live).toEqual(["Task 1", "Task 2"]);
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

    // Asserting only that the item is open would also pass an implementation
    // that published nothing at all and silently released the worker's claim.
    // The claim itself must still be standing, owned by the same front.
    const claim = state.claims.find((c) => c.pattern === "a.ts");
    expect(claim?.ownerId).toBe(worker);
    expect(claim?.orphanedAtMs).toBeNull();
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

  // Task 1's contract change: paths.length > 0 and parseError !== null can
  // now coexist (a **Files:** block with several bullets, one of which could
  // not be normalized). The title must name THAT reason, not claim the task
  // has no paths — and every real path it does carry must still get dispatched.
  test("a task with real paths and a partial-capture parseError keeps its paths, and its title names the real reason", () => {
    const partial = {
      n: 1,
      title: "Task 1",
      paths: ["a.ts", "b.ts"],
      parseError: "**Files:** block has a path that could not be normalized; capture is partial",
    };
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [partial] }, at(100));

    expect(state.work).toHaveLength(2);
    expect(state.work.map((w) => w.paths[0]).sort()).toEqual(["a.ts", "b.ts"]);
    for (const item of state.work) {
      expect(item.title).toContain("capture is partial");
      expect(item.title.toLowerCase()).not.toContain("no **files:**");
      expect(item.title.toLowerCase()).not.toContain("no usable path");
    }
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
    const live = state.work.filter((w) => w.state === "open" || w.state === "offered");
    expect(live.map((w) => w.title)).toEqual(["Task 2"]);
  });

  test("planning is refused outside shape plan", () => {
    apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(90));
    const out = apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    expect(out.response.ok).toBe(false);
  });
});
