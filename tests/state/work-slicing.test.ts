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
let responsivo: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(0));
  core = joined(state, "CORE", 10);
  responsivo = joined(state, "RESPONSIVO", 20);
});

describe("slicing a work-list by ownership", () => {
  test("a path someone holds is offered to them; a path nobody holds stays open", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["templates/pages/**"] }, at(100));

    apply(state, core, {
      v: 1, op: "work", title: "label sem for",
      paths: ["templates/pages/a.html", "src/orphan.ts"],
    }, at(200));

    const offered = state.work.find((w) => w.paths[0] === "templates/pages/a.html")!;
    const open = state.work.find((w) => w.paths[0] === "src/orphan.ts")!;
    expect(offered.state).toBe("offered");
    expect(offered.offeredToId).toBe(responsivo);
    expect(offered.offeredAtMs).toBe(T0 + 200);
    expect(open.state).toBe("open");
    expect(open.offeredToId).toBeNull();
  });

  test("the publisher never offers work to itself", () => {
    apply(state, core, { v: 1, op: "claim", paths: ["src/**"] }, at(100));
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["src/a.ts"] }, at(200));
    expect(state.work[0]!.state).toBe("open");
  });

  test("the more specific claim wins when two overlap", () => {
    const auditor = joined(state, "AUDITOR", 110);
    // `claim` refuses overlap, so two live overlapping claims cannot arise
    // through the op. They can arrive from a replayed journal, and
    // ownerForPath has to be total over that.
    state.claims.push(
      { pattern: "templates/**", ownerId: responsivo, intent: "", since: new Date(T0 + 100).toISOString(), auto: false, lastTouchMs: T0 + 100, orphanedAtMs: null },
      { pattern: "templates/pages/app/screen_builder.html", ownerId: auditor, intent: "", since: new Date(T0 + 120).toISOString(), auto: false, lastTouchMs: T0 + 120, orphanedAtMs: null },
    );

    apply(state, core, { v: 1, op: "work", title: "x", paths: ["templates/pages/app/screen_builder.html"] }, at(200));

    expect(state.work[0]!.offeredToId).toBe(auditor);
  });

  test("on a tie in specificity, the older claim wins", () => {
    const auditor = joined(state, "AUDITOR", 110);
    // Same shape, same specificity — only the age differs. Deterministic
    // routing means a total order even when nothing else distinguishes the
    // two candidates.
    state.claims.push(
      { pattern: "templates/pages/**", ownerId: auditor, intent: "", since: new Date(T0 + 120).toISOString(), auto: false, lastTouchMs: T0 + 120, orphanedAtMs: null },
      { pattern: "templates/pages/**", ownerId: responsivo, intent: "", since: new Date(T0 + 100).toISOString(), auto: false, lastTouchMs: T0 + 100, orphanedAtMs: null },
    );

    apply(state, core, { v: 1, op: "work", title: "x", paths: ["templates/pages/a.html"] }, at(200));

    expect(state.work[0]!.offeredToId).toBe(responsivo);
  });

  test("an orphaned claim routes nothing: its owner is gone", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["templates/**"] }, at(100));
    state.claims[0]!.orphanedAtMs = T0 + 150;

    apply(state, core, { v: 1, op: "work", title: "x", paths: ["templates/a.html"] }, at(200));
    expect(state.work[0]!.state).toBe("open");
  });

  test("thirteen files, three owners: the slice is deterministic", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["a/**"] }, at(100));
    const auditor = joined(state, "AUDITOR", 110);
    apply(state, auditor, { v: 1, op: "claim", paths: ["b/**"] }, at(120));

    apply(state, core, {
      v: 1, op: "work", title: "64 casos",
      paths: ["a/1.html", "a/2.html", "b/1.html", "c/1.html", "c/2.html"],
    }, at(200));

    const byOwner = (id: string | null) => state.work.filter((w) => w.offeredToId === id).length;
    expect(byOwner(responsivo)).toBe(2);
    expect(byOwner(auditor)).toBe(1);
    expect(byOwner(null)).toBe(2);
  });
});
