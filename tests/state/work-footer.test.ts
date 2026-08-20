import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import { poolFooterFor } from "../../src/state/work";
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
let responsivo: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(0));
  core = joined(state, "CORE", 10);
  responsivo = joined(state, "RESPONSIVO", 20);
});

describe("the pool footer", () => {
  test("an empty pool says nothing at all", () => {
    expect(poolFooterFor(state, responsivo)).toBe("");
  });

  test("shape bus says nothing, whatever is in state", () => {
    apply(state, null, { v: 1, op: "shape", shape: "bus" }, at(30));
    state.work.push({
      id: "w_1", paths: ["a.ts"], title: "x", evidenceIds: [], publishedById: core,
      publishedByName: "CORE", kind: "work", origin: "discovered", state: "open",
      offeredToId: null, offeredAtMs: null, takenById: null, orphanedAtMs: null,
      nudgedAtMs: null, reviewOf: null, at: new Date(T0).toISOString(),
    });
    expect(poolFooterFor(state, responsivo)).toBe("");
  });

  test("what is offered to me is named; what is open is only counted", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["mine/**"] }, at(50));
    apply(state, core, {
      v: 1, op: "work", title: "label sem for",
      paths: ["mine/a.html", "open/1.ts", "open/2.ts"],
    }, at(100));

    const footer = poolFooterFor(state, responsivo);
    expect(footer).toContain("mine/a.html");
    expect(footer).toContain("2 open");
    expect(footer).not.toContain("open/1.ts");
  });

  test("at most three offers are named, and the rest are counted", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["mine/**"] }, at(50));
    apply(state, core, {
      v: 1, op: "work", title: "x",
      paths: ["mine/1", "mine/2", "mine/3", "mine/4", "mine/5"],
    }, at(100));

    const footer = poolFooterFor(state, responsivo);
    expect(footer.split("\n").filter((l) => l.includes("mine/"))).toHaveLength(3);
    expect(footer).toContain("2 more");
  });

  test("the footer tells the agent the exact command, not a concept", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["mine/**"] }, at(50));
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["mine/a.html"] }, at(100));
    expect(poolFooterFor(state, responsivo)).toContain("parley take ");
  });
});
