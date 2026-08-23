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

let state: State;
let core: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  core = joined(state, "CORE", 0);
});

describe("shape", () => {
  test("a repository starts in bus, which is what ships today", () => {
    expect(state.shape).toBe("bus");
  });

  test("reading the shape without setting it does not change it", () => {
    const out = apply(state, core, { v: 1, op: "shape" }, at(100));
    expect(out.response).toMatchObject({ ok: true, shape: "bus" });
    expect(state.shape).toBe("bus");
  });

  test("setting the shape announces it to everyone", () => {
    const out = apply(state, core, { v: 1, op: "shape", shape: "pool" }, at(200));
    expect(out.response).toMatchObject({ ok: true, shape: "pool" });
    expect(state.shape).toBe("pool");
    expect(out.broadcast).toHaveLength(1);
    expect(out.broadcast[0]!.text).toContain("pool");
  });

  test("setting it to what it already is says nothing", () => {
    apply(state, core, { v: 1, op: "shape", shape: "pool" }, at(200));
    const again = apply(state, core, { v: 1, op: "shape", shape: "pool" }, at(300));
    expect(again.broadcast).toHaveLength(0);
  });

  test("an unknown shape is refused and changes nothing", () => {
    const out = apply(state, core, { v: 1, op: "shape", shape: "swarm" }, at(400));
    expect(out.response.ok).toBe(false);
    expect(state.shape).toBe("bus");
  });

  // Both orders, because one order proves only half of it: setting shape then
  // mode cannot catch `shape` resetting `mode`, and setting mode then shape
  // cannot catch the reverse. They are two axes, and the claim is that neither
  // touches the other.
  test("shape and mode are independent, whichever is set second", () => {
    apply(state, core, { v: 1, op: "shape", shape: "plan" }, at(500));
    apply(state, core, { v: 1, op: "mode", mode: "enforced" }, at(600));
    expect(state.shape).toBe("plan");
    expect(state.mode).toBe("enforced");

    const other = initialState("advisory");
    const front = joined(other, "CORE", 0);
    apply(other, front, { v: 1, op: "mode", mode: "enforced" }, at(700));
    apply(other, front, { v: 1, op: "shape", shape: "pool" }, at(800));
    expect(other.mode).toBe("enforced");
    expect(other.shape).toBe("pool");
  });
});
