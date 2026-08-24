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

/**
 * The winner must not depend on the order claims happen to sit in.
 * Asserting one order only would stay green against a comparator that
 * ignored every criterion and simply took the first or the last candidate —
 * so this builds a fresh state and runs the given claims in the order given,
 * letting each test call it twice with the pair reversed.
 */
function winnerFor(
  descriptors: { owner: string; pattern: string; lastTouchMs: number }[],
  path: string,
): string | null {
  const s = initialState("advisory");
  apply(s, null, { v: 1, op: "shape", shape: "pool" }, at(0));
  const publisherId = joined(s, "PUBLISHER", 0);

  const ids = new Map<string, string>();
  for (const d of descriptors) {
    if (!ids.has(d.owner)) ids.set(d.owner, joined(s, d.owner, 0));
  }
  for (const d of descriptors) {
    s.claims.push({
      pattern: d.pattern,
      ownerId: ids.get(d.owner)!,
      intent: "",
      since: new Date(d.lastTouchMs).toISOString(),
      auto: false,
      lastTouchMs: d.lastTouchMs,
      orphanedAtMs: null,
    });
  }

  apply(s, publisherId, { v: 1, op: "work", title: "x", paths: [path] }, at(0));
  const winnerId = s.work[0]!.offeredToId;
  if (winnerId === null) return null;
  for (const [name, id] of ids) if (id === winnerId) return name;
  return winnerId;
}

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
    // `claim` refuses overlap, so two live overlapping claims cannot arise
    // through the op. They can arrive from a replayed journal, and
    // ownerForPath has to be total over that.
    //
    // Asserted in both push orders: a comparator that just took the first or
    // the last candidate — ignoring specificity entirely — would still win
    // this test if the array happened to be built with the winner last.
    const broad = { owner: "RESPONSIVO", pattern: "templates/**", lastTouchMs: T0 + 100 };
    const specific = { owner: "AUDITOR", pattern: "templates/pages/app/screen_builder.html", lastTouchMs: T0 + 120 };
    const path = "templates/pages/app/screen_builder.html";

    expect(winnerFor([broad, specific], path)).toBe("AUDITOR");
    expect(winnerFor([specific, broad], path)).toBe("AUDITOR");
  });

  test("on a tie in specificity, the older claim wins", () => {
    // Same shape, same specificity — only the age differs. Deterministic
    // routing means a total order even when nothing else distinguishes the
    // two candidates, and — as above — both push orders must agree.
    const older = { owner: "RESPONSIVO", pattern: "templates/pages/**", lastTouchMs: T0 + 100 };
    const younger = { owner: "AUDITOR", pattern: "templates/pages/**", lastTouchMs: T0 + 120 };
    const path = "templates/pages/a.html";

    expect(winnerFor([younger, older], path)).toBe("RESPONSIVO");
    expect(winnerFor([older, younger], path)).toBe("RESPONSIVO");
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
