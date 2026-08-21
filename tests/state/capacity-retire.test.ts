import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx, tick } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0, extra: Record<string, unknown> = {}): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: `${name} mission`, ...extra }, at(ms));
  return (out.response as unknown as { id: string }).id;
}

let state: State;
let core: string;
let pool1: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(0));
  core = joined(state, "CORE", 10);
  pool1 = joined(state, "POOL-1", 20, { born: "parley" });
});

describe("retiring a newborn", () => {
  test("empty pool and nothing held: it goes home", () => {
    const out = tick(state, at(1000), { maxFronts: 6 });
    expect(out.retire).toContain(pool1);
  });

  test("holding an item: it stays", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    apply(state, pool1, { v: 1, op: "take", id: state.work[0]!.id }, at(200));
    expect(tick(state, at(1000), { maxFronts: 6 }).retire).not.toContain(pool1);
  });

  test("an open item left in the pool: it stays", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    expect(tick(state, at(1000), { maxFronts: 6 }).retire).not.toContain(pool1);
  });

  test("a front a person opened is never retired, however idle it is", () => {
    const develop = joined(state, "DEVELOP", 30);
    const out = tick(state, at(24581 * 1000), { maxFronts: 6 });
    expect(out.retire).not.toContain(develop);
  });

  test("retiring frees a slot under the ceiling", () => {
    const out = tick(state, at(1000), { maxFronts: 6 });
    expect(out.retire).toHaveLength(1);
    // Without this, six idle newborns would hold the ceiling and none of them work.
  });
});
