import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../src/protocol/types";
import { apply, initialState, makeCtx, tick } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);
const POOL = DEFAULTS.ORPHAN_POOL_MS;

// `connected: true` stands in for a live MCP session, same as the doorbell
// tests: without it a front sitting past ORPHAN_POOL_MS has already had its
// *lease* expire first (LEASE_TTL_MS is shorter), so tick's rule 1 declares it
// gone before rule 6 ever gets to ask whether it is idle.
function joined(state: State, name: string, ms = 0, extra: Record<string, unknown> = {}): string {
  const out = apply(
    state, null,
    { v: 1, op: "join", name, mission: `${name} mission`, connected: true, ...extra },
    at(ms),
  );
  return (out.response as unknown as { id: string }).id;
}
function busy(state: State, who: string, pattern: string, ms: number) {
  apply(state, who, { v: 1, op: "claim", paths: [pattern] }, at(ms));
}

let state: State;
let core: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(0));
  core = joined(state, "CORE", 10);
  busy(state, core, "src/**", 20);
});

describe("capacity", () => {
  test("an idle front means no birth: recycling is always cheaper than creating", () => {
    const develop = joined(state, "DEVELOP", 30);
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    const out = tick(state, at(100 + POOL + 1), { maxFronts: 6 });
    expect(out.birth).toBeNull();
    expect(develop).toBeTruthy();
  });

  test("an orphan pool with nobody idle asks for a front", () => {
    apply(state, core, { v: 1, op: "work", title: "32 triviais", paths: ["a.ts", "b.ts"] }, at(100));
    const out = tick(state, at(100 + POOL + 1), { maxFronts: 6 });
    expect(out.birth).not.toBeNull();
    expect(out.birth!.forItemIds).toHaveLength(2);
    expect(out.birth!.reason).toContain("2");
  });

  test("the intent is emitted, never the spawn — the state machine does no I/O", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    const out = tick(state, at(100 + POOL + 1), { maxFronts: 6 });
    expect(out.birth).not.toBeNull();
    // Nothing joined. The daemon has not run yet.
    expect(Object.keys(state.participants)).toHaveLength(1);
  });

  test("at most one birth per cooldown window", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts", "b.ts"] }, at(100));
    const first = tick(state, at(100 + POOL + 1), { maxFronts: 6 });
    expect(first.birth).not.toBeNull();

    const tooSoon = tick(state, at(100 + POOL + DEFAULTS.BIRTH_COOLDOWN_MS - 1), { maxFronts: 6 });
    expect(tooSoon.birth).toBeNull();

    const later = tick(state, at(100 + POOL + DEFAULTS.BIRTH_COOLDOWN_MS + 2), { maxFronts: 6 });
    expect(later.birth).not.toBeNull();
  });

  test("the ceiling is hard, and counts every live front", () => {
    for (let i = 0; i < 5; i++) busy(state, joined(state, `F${i}`, 30 + i), `f${i}/**`, 40 + i);
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    const out = tick(state, at(100 + POOL + 1), { maxFronts: 6 });
    expect(out.birth).toBeNull();
  });

  test("summon asks explicitly, and is refused at the ceiling", () => {
    const granted = apply(state, core, { v: 1, op: "summon", reason: "the plan needs a hand" }, at(200));
    expect(granted.response.ok).toBe(true);

    for (let i = 0; i < 5; i++) busy(state, joined(state, `F${i}`, 300 + i), `f${i}/**`, 310 + i);
    const refused = apply(state, core, { v: 1, op: "summon" }, at(400));
    expect(refused.response).toMatchObject({ error: { code: "NO_CAPACITY" } });
  });

  test("a front records who created it", () => {
    const born = joined(state, "POOL-1", 500, { born: "parley" });
    expect(state.participants[born]!.born).toBe("parley");
    expect(state.participants[core]!.born).toBe("person");
  });

  test("a failed spawn is self-healing: the cooldown passes and it asks again", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    tick(state, at(100 + POOL + 1), { maxFronts: 6 });        // the daemon tries and fails
    const retry = tick(state, at(100 + POOL + DEFAULTS.BIRTH_COOLDOWN_MS + 2), { maxFronts: 6 });
    expect(retry.birth).not.toBeNull();
  });
});
