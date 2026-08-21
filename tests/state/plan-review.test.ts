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

    // Whoever it landed on — the rule says only "not the author," never a
    // specific front — closes it out, and only then does the wave move.
    // Captured before `take`, which mutates `offeredToId` back to null on
    // the same object.
    const review = state.work.find((w) => w.kind === "review")!;
    const reviewer = review.offeredToId!;
    apply(state, reviewer, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, reviewer, { v: 1, op: "done", id: review.id, summary: "validated and committed" }, at(500));
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

  // Scarcity: the rule says "never fall back to the author," not merely
  // "prefer someone else." With only one live front, that front is both the
  // author and the only candidate — an implementation that fell back to it
  // when the candidate pool is empty would still pass every other test here,
  // since all of them join at least two agents.
  test("with no other front available, the review is published open — never to the author", () => {
    const solo = initialState("advisory");
    apply(solo, null, { v: 1, op: "shape", shape: "plan" }, at(1000));
    const only = joined(solo, "ONLY", 1010);
    apply(solo, only, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["z.ts"])] }, at(1100));
    const item = solo.work[0]!;
    apply(solo, only, { v: 1, op: "take", id: item.id }, at(1200));
    apply(solo, only, { v: 1, op: "done", id: item.id }, at(1300));

    const review = solo.work.find((w) => w.kind === "review" && w.reviewOf === item.id)!;
    expect(review.state).toBe("open");
    expect(review.offeredToId).toBeNull();
  });

  // A review is `kind: "review"`, never `kind: "work"` — the guard in
  // finishWork checks exactly that. Without it, closing a review under
  // shape plan would spawn a review of the review, and so on forever.
  test("finishing a review creates no review of the review", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    const reviewer = review.offeredToId!;
    apply(state, reviewer, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, reviewer, { v: 1, op: "done", id: review.id, summary: "looks good" }, at(500));

    expect(state.work.filter((w) => w.kind === "review" && w.reviewOf === review.id)).toHaveLength(0);
  });
});
