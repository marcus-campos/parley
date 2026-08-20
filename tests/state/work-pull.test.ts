import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, Note, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: `${name} mission` }, at(ms));
  return (out.response as unknown as { id: string }).id;
}
function publish(state: State, who: string, paths: string[], ms: number, evidence: string[] = []): string[] {
  const out = apply(state, who, { v: 1, op: "work", title: "label sem for", paths, evidence }, at(ms));
  return (out.response as unknown as { items: { id: string }[] }).items.map((i) => i.id);
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

describe("pulling from the pool", () => {
  test("taking an open item makes it yours", () => {
    const [id] = publish(state, core, ["a.ts"], 100);
    const out = apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    expect(out.response.ok).toBe(true);
    expect(state.work[0]!.state).toBe("taken");
    expect(state.work[0]!.takenById).toBe(responsivo);
  });

  test("two fronts taking the same item at the same instant: exactly one wins", () => {
    const [id] = publish(state, core, ["a.ts"], 100);
    const auditor = joined(state, "AUDITOR", 110);
    const first = apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    const second = apply(state, auditor, { v: 1, op: "take", id }, at(200));
    expect(first.response.ok).toBe(true);
    expect(second.response.ok).toBe(false);
    expect(state.work[0]!.takenById).toBe(responsivo);
  });

  test("taking carries the evidence back, so nobody repays the discovery", () => {
    const noteOut = apply(state, core, {
      v: 1, op: "note", title: "the select2 trap",
      body: "a for pointing at a hidden element may not open the component",
    }, at(50));
    const noteId = (noteOut.response as unknown as { id: string }).id;
    const [id] = publish(state, core, ["a.ts"], 100, [noteId]);

    const out = apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    const evidence = (out.response as unknown as { evidence: { notes: Note[] } }).evidence;
    expect(evidence.notes).toHaveLength(1);
    expect(evidence.notes[0]!.title).toBe("the select2 trap");
  });

  test("an offer is a first refusal, not obedience: the owner can drop it", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["a.ts"] }, at(50));
    const [id] = publish(state, core, ["a.ts"], 100);
    expect(state.work[0]!.state).toBe("offered");

    apply(state, responsivo, { v: 1, op: "drop", id, reason: "not my mission" }, at(200));
    expect(state.work[0]!.state).toBe("open");
    expect(state.work[0]!.offeredToId).toBeNull();
  });

  test("a planned item cannot be dropped — dispatch is not an offer", () => {
    const out = apply(state, core, {
      v: 1, op: "work", title: "task 5", paths: ["a.ts"], origin: "planned",
    }, at(100));
    const id = (out.response as unknown as { items: { id: string }[] }).items[0]!.id;
    apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    const dropped = apply(state, responsivo, { v: 1, op: "drop", id }, at(300));
    expect(dropped.response.ok).toBe(false);
    expect(state.work[0]!.state).toBe("taken");
  });

  test("done is only for the front holding it", () => {
    const [id] = publish(state, core, ["a.ts"], 100);
    apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    const wrong = apply(state, core, { v: 1, op: "done", id }, at(300));
    expect(wrong.response).toMatchObject({ error: { code: "NOT_TAKEN" } });

    const right = apply(state, responsivo, { v: 1, op: "done", id, summary: "3 labels fixed" }, at(400));
    expect(right.response.ok).toBe(true);
    expect(state.work[0]!.state).toBe("done");
    expect(right.broadcast[0]!.text).toContain("3 labels fixed");
  });

  test("a done item cannot be taken again", () => {
    const [id] = publish(state, core, ["a.ts"], 100);
    apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    apply(state, responsivo, { v: 1, op: "done", id }, at(300));
    expect(apply(state, core, { v: 1, op: "take", id }, at(400)).response.ok).toBe(false);
  });
});
