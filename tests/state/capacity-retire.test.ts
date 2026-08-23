import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../src/protocol/types";
import { apply, initialState, makeCtx, tick } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

/**
 * When every tick in this file happens.
 *
 * Past `RETIRE_GRACE_MS` (60s), so a newborn is old enough to be invited home,
 * and well inside `LEASE_TTL_MS` (300s), so every participant is still alive
 * when rule 7 runs. That second half is not decoration. The version of "a
 * front a person opened is never retired" this replaces ticked at 24581s —
 * 6h49m, more than eighty lease windows — so `tick`'s rule 1 marked every
 * participant `gone` before rule 7 was reached, `retire` came back empty, and
 * the assertion was true of nothing. The `born` guard could be deleted
 * outright and the test stayed green.
 */
const LIVE = 120 * 1000;

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
    const out = tick(state, at(LIVE), { maxFronts: 6 });
    expect(out.retire).toContain(pool1);
  });

  test("a joinedAt nobody can parse buys the grace period, it does not lose it", () => {
    // Unreachable today: `joinedAt` is written by the daemon's own clock. But
    // the two directions are not equally wrong — one costs a front one more
    // grace period, the other names it for retirement on sight, which is the
    // direction the code took.
    state.participants[pool1]!.joinedAt = "not a timestamp";
    expect(tick(state, at(LIVE), { maxFronts: 6 }).retire).not.toContain(pool1);

    // The control, so this cannot pass by nothing ever being retired here.
    state.participants[pool1]!.joinedAt = new Date(T0 + 20).toISOString();
    expect(tick(state, at(LIVE), { maxFronts: 6 }).retire).toContain(pool1);
  });

  test("holding an item: it stays", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    apply(state, pool1, { v: 1, op: "take", id: state.work[0]!.id }, at(200));
    expect(tick(state, at(LIVE), { maxFronts: 6 }).retire).not.toContain(pool1);
  });

  test("an open item left in the pool: it stays", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    expect(tick(state, at(LIVE), { maxFronts: 6 }).retire).not.toContain(pool1);
  });

  test("holding territory it declared: it stays, because the doorbell already says it is busy", () => {
    // `idleFronts` treats a non-auto, non-orphaned claim as busy and will not
    // ring this front; `shouldRetire` used to ignore claims entirely and named
    // it for retirement in the very same tick. A front provably mid-edit
    // cannot be both.
    apply(state, pool1, { v: 1, op: "claim", paths: ["src/api/**"], intent: "rewriting the client" }, at(100));
    expect(tick(state, at(LIVE), { maxFronts: 6 }).retire).not.toContain(pool1);
  });

  test("an auto-claim is not territory: the footprint of an edit does not keep a front alive", () => {
    // Same asymmetry as the doorbell's: an auto-claim is where a front last
    // wrote, not a declaration of what it is doing.
    apply(state, pool1, { v: 1, op: "claim", paths: ["src/api/client.ts"], auto: true }, at(100));
    expect(tick(state, at(LIVE), { maxFronts: 6 }).retire).toContain(pool1);
  });

  test("a newborn is left alone until the grace period is up", () => {
    // It was born because the pool was stale. If another front empties the
    // pool while it is still starting, it must still get to look before being
    // told there is nothing to look at.
    const early = tick(state, at(20 + DEFAULTS.RETIRE_GRACE_MS - 1), { maxFronts: 6 });
    expect(early.retire).not.toContain(pool1);
    const later = tick(state, at(20 + DEFAULTS.RETIRE_GRACE_MS + 1), { maxFronts: 6 });
    expect(later.retire).toContain(pool1);
  });

  test("a front a person opened is never retired, however idle it is", () => {
    const develop = joined(state, "DEVELOP", 30);
    const out = tick(state, at(LIVE), { maxFronts: 6 });
    // Everyone is still alive at this tick — which is what makes the negative
    // assertion mean anything.
    expect(state.participants[develop]!.gone).toBe(false);
    expect(state.participants[pool1]!.gone).toBe(false);
    // DEVELOP is idle, holds nothing, and sits beside the same empty pool as
    // POOL-1. The only difference between them is who opened them.
    expect(out.retire).not.toContain(develop);
    expect(out.retire).toContain(pool1);
  });

  test("a human watching the panel is not a front to retire", () => {
    // A person could be marked `born: "parley"` by a frame anybody can send;
    // `kind` is the second guard, shared with `idleFronts`.
    const marcus = joined(state, "MARCUS", 40, { kind: "human", born: "parley" });
    expect(tick(state, at(LIVE), { maxFronts: 6 }).retire).not.toContain(marcus);
  });

  test("exactly one front is named, and it is the newborn", () => {
    // Renamed from "retiring frees a slot under the ceiling", which asserted
    // only `toHaveLength(1)` and said nothing about any ceiling. The ceiling
    // claim cannot be tested here at all: a retirable front is by definition
    // idle, and `tick`'s rule 6 recycles an idle front before it ever asks for
    // a birth — so the ceiling is never the binding constraint in any state
    // where `retire` is non-empty. See the fix-wave report.
    const out = tick(state, at(LIVE), { maxFronts: 6 });
    expect(out.retire).toEqual([pool1]);
  });

  test("invited once, not once per tick", () => {
    // The discipline stated ten lines above rule 7 for the doorbell: "rung
    // once per item ... so a front that reads nothing is never pushed round in
    // circles". Every other test in this file ticks exactly once, which is why
    // repetition was invisible; the daemon re-sent the notice every five
    // seconds and before every command the front made.
    expect(tick(state, at(LIVE), { maxFronts: 6 }).retire).toEqual([pool1]);
    expect(tick(state, at(LIVE + 5_000), { maxFronts: 6 }).retire).toEqual([]);
    expect(tick(state, at(LIVE + 10_000), { maxFronts: 6 }).retire).toEqual([]);
  });

  test("one invitation per episode: a pool that refills and empties rings again", () => {
    expect(tick(state, at(LIVE), { maxFronts: 6 }).retire).toEqual([pool1]);

    // Work arrives. The front has a reason to exist again.
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(LIVE + 1_000));
    expect(tick(state, at(LIVE + 2_000), { maxFronts: 6 }).retire).toEqual([]);

    // Somebody else clears the pool. This is a new episode, not the old one.
    apply(state, core, { v: 1, op: "take", id: state.work[0]!.id }, at(LIVE + 3_000));
    apply(state, core, { v: 1, op: "done", id: state.work[0]!.id }, at(LIVE + 4_000));
    expect(tick(state, at(LIVE + 5_000), { maxFronts: 6 }).retire).toEqual([pool1]);
  });
});

/**
 * §4.4 promises a newborn's worktree is removed **on death**. The
 * implementation delivered removal on *saying goodbye*: `scheduleCollection`
 * had exactly one call site, the `leave` branch, and nothing in rule 1 — the
 * rule that decides a front is dead — ever asked for one.
 */
describe("a newborn that dies without saying goodbye", () => {
  test("rule 1 names it, so somebody downstream can collect it", () => {
    // No `leave`, no SessionEnd: SIGKILL, a crash, a closed laptop, a harness
    // that fires no end hook. The lease is the only thing that notices.
    // CORE keeps its socket, so the assertions below are about POOL-1 alone.
    state.participants[core]!.connected = true;
    state.participants[pool1]!.connected = false;
    state.participants[pool1]!.lastSeenMs = T0 + 20;

    const out = tick(state, at(DEFAULTS.LEASE_TTL_MS + 1_000), { maxFronts: 6 });
    expect(state.participants[pool1]!.gone).toBe(true);
    expect(out.died).toEqual([pool1]);
  });

  test("said once, not once per tick — a corpse is not collected twice", () => {
    state.participants[core]!.connected = true;
    state.participants[pool1]!.connected = false;
    state.participants[pool1]!.lastSeenMs = T0 + 20;
    expect(tick(state, at(DEFAULTS.LEASE_TTL_MS + 1_000), { maxFronts: 6 }).died).toEqual([pool1]);
    expect(tick(state, at(DEFAULTS.LEASE_TTL_MS + 2_000), { maxFronts: 6 }).died).toEqual([]);
  });

  test("a front still renewing its lease is not dead", () => {
    // The control. Without it the two above pass on a `died` that is always
    // everybody.
    state.participants[core]!.connected = true;
    state.participants[pool1]!.connected = false;
    state.participants[pool1]!.lastSeenMs = T0 + 20;
    expect(tick(state, at(DEFAULTS.LEASE_TTL_MS - 1_000), { maxFronts: 6 }).died).toEqual([]);
  });
});
