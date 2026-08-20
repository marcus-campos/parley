import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../src/protocol/types";
import { apply, initialState, makeCtx, tick } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
const MIN = 60_000;
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

describe("tick and the pool", () => {
  test("an unanswered offer returns to the pool at exactly the TTL", () => {
    apply(state, responsivo, { v: 1, op: "claim", paths: ["a.ts"] }, at(100));
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(200));
    expect(state.work[0]!.state).toBe("offered");

    tick(state, at(200 + DEFAULTS.OFFER_TTL_MS - 1));
    expect(state.work[0]!.state).toBe("offered");

    const out = tick(state, at(200 + DEFAULTS.OFFER_TTL_MS + 1));
    expect(state.work[0]!.state).toBe("open");
    expect(state.work[0]!.offeredToId).toBeNull();
    expect(out.broadcast.some((e) => e.text.includes("a.ts"))).toBe(true);
  });

  test("an item held by a front that died comes back after the orphan grace", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    const id = state.work[0]!.id;
    apply(state, responsivo, { v: 1, op: "take", id }, at(200));

    // RESPONSIVO stops renewing its lease and is declared gone.
    tick(state, at(200 + DEFAULTS.LEASE_TTL_MS + 1));
    expect(state.work[0]!.state).toBe("taken");
    expect(state.work[0]!.orphanedAtMs).not.toBeNull();

    tick(state, at(200 + DEFAULTS.LEASE_TTL_MS + DEFAULTS.ORPHAN_GRACE_MS + 2));
    expect(state.work[0]!.state).toBe("open");
    expect(state.work[0]!.takenById).toBeNull();
  });

  test("a front that merely restarts gets its item back, it does not fight for it", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    const id = state.work[0]!.id;
    apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    tick(state, at(200 + DEFAULTS.LEASE_TTL_MS + 1));

    // Same name, same worktree: a re-attach inside the grace period.
    joined(state, "RESPONSIVO", 200 + DEFAULTS.LEASE_TTL_MS + 10);
    tick(state, at(200 + DEFAULTS.LEASE_TTL_MS + DEFAULTS.ORPHAN_GRACE_MS + 2));
    expect(state.work[0]!.state).toBe("taken");
  });

  test("a done item is never resurrected by tick", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    const id = state.work[0]!.id;
    apply(state, responsivo, { v: 1, op: "take", id }, at(200));
    apply(state, responsivo, { v: 1, op: "done", id }, at(210));
    tick(state, at(60 * MIN));
    expect(state.work[0]!.state).toBe("done");
  });
});
