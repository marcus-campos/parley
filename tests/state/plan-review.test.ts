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
