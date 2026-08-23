import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { CommandResult, Ctx, Note, State } from "../../src/state/types";

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

  test("evidence carries live staleness, not the frozen-fresh stamp it was recorded with", () => {
    apply(state, core, { v: 1, op: "result", key: "test1", status: "pass", summary: "green", paths: ["a.ts"] }, at(60));
    apply(state, core, { v: 1, op: "result", key: "test2", status: "pass", summary: "still green", paths: ["b.ts"] }, at(60));

    // RESPONSIVO edits a.ts after test1 ran: test1 is invalidated. b.ts is
    // never touched, so test2 stays fresh — a control against an
    // implementation that just hardcodes a stale reason for everything.
    apply(state, responsivo, { v: 1, op: "claim", paths: ["a.ts"] }, at(80));

    const out = apply(state, core, {
      v: 1, op: "work", title: "x", paths: ["c.ts"], evidence: ["test1", "test2"],
    }, at(100));
    const id = (out.response as unknown as { items: { id: string }[] }).items[0]!.id;

    const taken = apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    const results = (taken.response as unknown as { evidence: { results: CommandResult[] } }).evidence.results;
    const stale = results.find((r) => r.key === "test1")!;
    const fresh = results.find((r) => r.key === "test2")!;
    expect(stale.staleBecause).toContain("RESPONSIVO touched a.ts");
    expect(fresh.staleBecause).toBeNull();
  });

  test("an offer is a first refusal, not obedience: the owner can drop it", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["a.ts"] }, at(50));
    const [id] = publish(state, core, ["a.ts"], 100);
    expect(state.work[0]!.state).toBe("offered");

    apply(state, responsivo, { v: 1, op: "drop", id, reason: "not my mission" }, at(200));
    expect(state.work[0]!.state).toBe("open");
    expect(state.work[0]!.offeredToId).toBeNull();
  });

  test("during the offer window, only the offeree may take it — and it still can", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["a.ts"] }, at(50));
    const [id] = publish(state, core, ["a.ts"], 100);
    expect(state.work[0]!.state).toBe("offered");

    const auditor = joined(state, "AUDITOR", 110);
    const outsider = apply(state, auditor, { v: 1, op: "take", id }, at(200));
    expect(outsider.response).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
      offeredTo: { id: responsivo, name: "RESPONSIVO" },
    });
    expect(state.work[0]!.state).toBe("offered");
    expect(state.work[0]!.takenById).toBeNull();

    // The gate is on everyone else, not on the offer itself: the offeree can
    // still take its own offered item, in the same instant.
    const offeree = apply(state, responsivo, { v: 1, op: "take", id }, at(210));
    expect(offeree.response.ok).toBe(true);
    expect(state.work[0]!.state).toBe("taken");
    expect(state.work[0]!.takenById).toBe(responsivo);
  });

  test("once the offer is gone, the item is open to whoever gets there first", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["a.ts"] }, at(50));
    const [id] = publish(state, core, ["a.ts"], 100);
    expect(state.work[0]!.state).toBe("offered");

    // Driving the lapse directly: expiring an unanswered offer back to `open`
    // is Task 5's tick-based machinery, and this test must not depend on it —
    // only on what take does once the item is `open` again. Object.assign,
    // not three literal assignments, so TS does not narrow `.state` to
    // `"open"` for the rest of the test.
    Object.assign(state.work[0]!, { state: "open", offeredToId: null, offeredAtMs: null });

    const auditor = joined(state, "AUDITOR", 110);
    const out = apply(state, auditor, { v: 1, op: "take", id }, at(200));
    expect(out.response.ok).toBe(true);
    expect(state.work[0]!.state).toBe("taken");
    expect(state.work[0]!.takenById).toBe(auditor);
  });

  /**
   * `origin` is what decides whether an item can be refused, so a front able
   * to set it from a frame could publish work its offeree is forbidden to
   * hand back — and `publishWork` routes an item AT whoever already holds the
   * path. RESPONSIVO holds `mine/**`, so CORE naming `origin: "planned"` used
   * to hand RESPONSIVO an item it could not drop: the front that discovered
   * the work acquiring authority over the front that holds the file, which is
   * the one hierarchy this module says it exists to do without. `tick` freed
   * it after five minutes, so it was a delay rather than a capture — but it
   * was a delay nobody consented to.
   *
   * A planned item is made by dispatching a plan, and by nothing else.
   * `plan-review.test.ts` covers that a real one is undroppable.
   */
  test("no frame can publish planned work — dispatch authority is not a field you set", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["mine/**"] }, at(50));
    const out = apply(state, core, {
      v: 1, op: "work", title: "task 5", paths: ["mine/a.ts"], origin: "planned",
    }, at(100));
    const id = (out.response as unknown as { items: { id: string }[] }).items[0]!.id;

    expect(state.work[0]!.origin).toBe("discovered");
    // And the consequence, which is the thing that actually mattered: the
    // front the item was aimed at can still refuse it.
    expect(state.work[0]!.offeredToId).toBe(responsivo);
    expect(apply(state, responsivo, { v: 1, op: "drop", id }, at(200)).response.ok).toBe(true);
    expect(state.work[0]!.state).toBe("open");
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

  test("a done item cannot be dropped back into the pool", () => {
    const [id] = publish(state, core, ["a.ts"], 100);
    apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    apply(state, responsivo, { v: 1, op: "done", id, summary: "3 labels" }, at(300));

    const dropped = apply(state, responsivo, { v: 1, op: "drop", id }, at(400));
    expect(dropped.response).toMatchObject({ ok: false, error: { code: "NOT_TAKEN" } });
    expect(state.work[0]!.state).toBe("done");
  });
});
