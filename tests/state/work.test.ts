import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, State, WorkItem } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: `${name} mission` }, at(ms));
  return (out.response as unknown as { id: string }).id;
}
const items = (out: { response: unknown }) =>
  (out.response as { items: { id: string; path: string; state: string; offeredTo: string | null }[] }).items;

let state: State;
let core: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(0));
  core = joined(state, "CORE", 10);
});

describe("publishing work", () => {
  test("one item per path, all open when nobody owns anything", () => {
    const out = apply(state, core, {
      v: 1, op: "work",
      title: "label sem for",
      paths: ["templates/a.html", "templates/b.html", "templates/c.html"],
    }, at(100));

    expect(out.response.ok).toBe(true);
    expect(items(out)).toHaveLength(3);
    expect(items(out).every((i) => i.state === "open")).toBe(true);
    expect(state.work).toHaveLength(3);
  });

  test("the publisher is recorded by id and by name", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    expect(state.work[0]!.publishedById).toBe(core);
    expect(state.work[0]!.publishedByName).toBe("CORE");
  });

  test("evidence travels by reference, never copied", () => {
    const note = apply(state, core, { v: 1, op: "note", title: "the select2 trap", body: "..." }, at(50));
    const id = (note.response as unknown as { id: string }).id;
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"], evidence: [id] }, at(100));
    expect(state.work[0]!.evidenceIds).toEqual([id]);
  });

  test("windows spellings normalise like every other path", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["src\\app.ts"] }, at(100));
    expect(state.work[0]!.paths).toEqual(["src/app.ts"]);
  });

  test("a work item needs a title", () => {
    const out = apply(state, core, { v: 1, op: "work", paths: ["a.ts"] }, at(100));
    expect(out.response.ok).toBe(false);
  });

  test("publishing is refused in shape bus, because there is no pool to publish into", () => {
    apply(state, null, { v: 1, op: "shape", shape: "bus" }, at(90));
    const out = apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    expect(out.response.ok).toBe(false);
    expect(state.work).toHaveLength(0);
  });

  test("works lists what is in the pool, newest last", () => {
    apply(state, core, { v: 1, op: "work", title: "first", paths: ["a.ts"] }, at(100));
    apply(state, core, { v: 1, op: "work", title: "second", paths: ["b.ts"] }, at(200));
    const out = apply(state, core, { v: 1, op: "works" }, at(300));
    const work = (out.response as unknown as { work: WorkItem[] }).work;
    expect(work.map((w) => w.title)).toEqual(["first", "second"]);
  });

  test("works filters by state", () => {
    apply(state, core, { v: 1, op: "work", title: "first", paths: ["a.ts"] }, at(100));
    const out = apply(state, core, { v: 1, op: "works", state: "taken" }, at(300));
    expect((out.response as unknown as { work: WorkItem[] }).work).toHaveLength(0);
  });
});
