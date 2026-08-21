// tests/brain/footer-budget.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, Note, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: "m" }, at(ms));
  return (out.response as unknown as { id: string }).id;
}

let state: State;
let core: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  core = joined(state, "CORE", 0);
});

describe("what rides along on a claim", () => {
  test("all the notes for a path, while there are few", () => {
    for (let i = 0; i < 3; i++) {
      apply(state, core, { v: 1, op: "note", title: `n${i}`, paths: ["a.ts"] }, at(10 + i));
    }
    const other = joined(state, "OTHER", 50);
    const out = apply(state, other, { v: 1, op: "claim", paths: ["a.ts"] }, at(100));
    expect((out.response as unknown as { notes: Note[] }).notes).toHaveLength(3);
  });

  test("forty-three notes do not all ride along — that is a tax on every tool call", () => {
    for (let i = 0; i < 43; i++) {
      apply(state, core, { v: 1, op: "note", title: `n${i}`, paths: ["a.ts"] }, at(10 + i));
    }
    const other = joined(state, "OTHER", 100);
    const out = apply(state, other, { v: 1, op: "claim", paths: ["a.ts"] }, at(200));
    const response = out.response as unknown as { notes: Note[]; more_notes: number };
    expect(response.notes.length).toBeLessThanOrEqual(5);
    expect(response.more_notes).toBe(43 - response.notes.length);
  });

  test("a standing decision is never truncated away — it binds", () => {
    apply(state, core, { v: 1, op: "note", title: "routes end with a slash", kind: "decision", paths: ["a.ts"] }, at(10));
    for (let i = 0; i < 43; i++) {
      apply(state, core, { v: 1, op: "note", title: `n${i}`, paths: ["a.ts"] }, at(20 + i));
    }
    const other = joined(state, "OTHER", 100);
    const out = apply(state, other, { v: 1, op: "claim", paths: ["a.ts"] }, at(200));
    const notes = (out.response as unknown as { notes: Note[] }).notes;
    expect(notes.some((n) => n.kind === "decision")).toBe(true);
  });

  /**
   * The review's Important-5 finding: the two tests above pass separately,
   * and that separation is exactly what hid the bug. Decisions were exempt
   * from `NOTES_CAP` entirely — the right instinct on its own ("a standing
   * decision is never truncated away" above) — but "exempt" meant
   * "unbounded", so 30 decisions and 30 plain notes on one path answered a
   * claim with all 35, and 60 would have answered with all 60. This test
   * puts both a large decision count and a large plain-note count on the
   * same path in the same claim, which is the only way to see whether the
   * footer's *worst case* — not just its typical case — is actually bounded.
   */
  test("a decision present together with more_notes accounting — both caps hold at once", () => {
    for (let i = 0; i < 30; i++) {
      apply(state, core, { v: 1, op: "note", title: `decision ${i}`, kind: "decision", paths: ["a.ts"] }, at(10 + i));
    }
    for (let i = 0; i < 30; i++) {
      apply(state, core, { v: 1, op: "note", title: `note ${i}`, paths: ["a.ts"] }, at(100 + i));
    }
    const other = joined(state, "OTHER", 200);
    const out = apply(state, other, { v: 1, op: "claim", paths: ["a.ts"] }, at(300));
    const response = out.response as unknown as { notes: Note[]; more_notes: number; more_decisions: number };

    const decisionsReturned = response.notes.filter((n) => n.kind === "decision");
    const plainReturned = response.notes.filter((n) => n.kind !== "decision");

    // Decisions bind, so they still get their own cap — just not an exemption
    // from every cap at all.
    expect(decisionsReturned).toHaveLength(20);
    expect(response.more_decisions).toBe(10);

    // Plain notes are unaffected by how many decisions also live on the path.
    expect(plainReturned).toHaveLength(5);
    expect(response.more_notes).toBe(25);

    // The property that actually matters: the worst case is bounded,
    // regardless of how many decisions and plain notes exist on the path.
    expect(response.notes.length).toBeLessThanOrEqual(25);
  });
});
