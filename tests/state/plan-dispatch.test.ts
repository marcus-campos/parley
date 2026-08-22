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

  test("planned items are marked planned, which is what makes a task undroppable", () => {
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

  // `openWave` publishes one item PER DECLARED PATH, so the number of tasks in
  // wave 0 is not the number of items it opened. The CLI prints this number as
  // "N item(s) open now" immediately above a `parley works --state open` that
  // would then list more of them than the line just claimed — and `parley plan`
  // is the first command the README and the skill both tell people to run.
  test("the count the response reports is items opened, not tasks in the wave", () => {
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts", "b.ts", "c.ts"])],
    }, at(100));

    expect(out.response).toMatchObject({ ok: true, waves: 1, opened: 3 });
    expect(state.work.filter((w) => w.state === "open")).toHaveLength(3);
  });

  // Same number for a wave whose tasks declare one path each — so the fix is
  // "count the items", not "multiply by something".
  test("one path per task still reports one item per task", () => {
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["b.ts"])],
    }, at(100));

    expect(out.response).toMatchObject({ ok: true, waves: 1, opened: 2 });
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

    // Task 4 gates the wave on the review the done just spawned, too.
    const review = state.work.find((w) => w.kind === "review" && w.reviewOf === first.id)!;
    apply(state, coord, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, coord, { v: 1, op: "done", id: review.id }, at(500));

    expect(state.plan!.waveIndex).toBe(1);
    const live = state.work.filter((w) => w.state === "open" || w.state === "offered");
    expect(live.map((w) => w.title)).toEqual(["Task 2"]);
  });

  // Pins "every item in the wave, not just one" as the advancement rule.
  // Task 1 and Task 2 share a wave because they do not collide with each
  // other; Task 3 collides with Task 1 on a.ts, so it is pushed to the wave
  // after. A regression that advanced on "some item done" instead of "every
  // item done" would dispatch Task 3 the moment Task 1 alone finished —
  // every existing test's multi-item waves happen to collide down to one
  // item per wave, so none of them would have caught that.
  test("a wave with two non-colliding tasks does not advance until BOTH are done, not just one", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [task(1, ["a.ts"]), task(2, ["b.ts"]), task(3, ["a.ts"])],
    }, at(100));

    const item1 = state.work.find((w) => w.title === "Task 1")!;
    const item2 = state.work.find((w) => w.title === "Task 2")!;

    apply(state, worker, { v: 1, op: "take", id: item1.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item1.id }, at(300));

    // Half the wave is done. The wave must NOT have advanced, and Task 3's
    // item must not exist yet.
    expect(state.plan!.waveIndex).toBe(0);
    expect(state.work.find((w) => w.title === "Task 3")).toBeUndefined();

    apply(state, worker, { v: 1, op: "take", id: item2.id }, at(400));
    apply(state, worker, { v: 1, op: "done", id: item2.id }, at(500));

    // Both tasks are done, but Task 4 gates the wave on their reviews too —
    // the wave must still not have advanced.
    expect(state.plan!.waveIndex).toBe(0);
    expect(state.work.find((w) => w.title === "Task 3")).toBeUndefined();

    const review1 = state.work.find((w) => w.kind === "review" && w.reviewOf === item1.id)!;
    const review2 = state.work.find((w) => w.kind === "review" && w.reviewOf === item2.id)!;
    apply(state, coord, { v: 1, op: "take", id: review1.id }, at(600));
    apply(state, coord, { v: 1, op: "done", id: review1.id }, at(700));
    apply(state, coord, { v: 1, op: "take", id: review2.id }, at(800));
    apply(state, coord, { v: 1, op: "done", id: review2.id }, at(900));

    // Now the whole wave is done, and only now does Task 3 open.
    expect(state.plan!.waveIndex).toBe(1);
    const task3 = state.work.find((w) => w.title === "Task 3");
    expect(task3?.state).toBe("open");
  });

  test("planning is refused outside shape plan", () => {
    apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(90));
    const out = apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    expect(out.response.ok).toBe(false);
  });
});
