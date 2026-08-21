import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../src/protocol/types";
import { pendingFor } from "../../src/state/conversation";
import { apply, initialState, makeCtx, tick } from "../../src/state/machine";
import { idleFronts } from "../../src/state/work";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

// `connected: true` stands in for a live MCP session: a front the pool must
// see as present for the whole test, the way Rule 1 in `tick` already treats
// one ("a live connection is proof on its own"). Without it, a front that
// simply sits idle for the ORPHAN_POOL_MS window would have its *lease*
// expire first (LEASE_TTL_MS is shorter), and the doorbell would never get
// the chance to ring — a front the daemon has declared dead is not "idle",
// it is gone.
function joined(state: State, name: string, ms = 0, kind?: "human" | "agent"): string {
  const frame: Record<string, unknown> = { v: 1, op: "join", name, mission: `${name} mission`, connected: true };
  if (kind) frame.kind = kind;
  const out = apply(state, null, frame, at(ms));
  return (out.response as unknown as { id: string }).id;
}

let state: State;
let core: string;
let develop: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(0));
  core = joined(state, "CORE", 10);
  develop = joined(state, "DEVELOP", 20);
});

describe("the doorbell", () => {
  test("a front holding nothing is idle; one holding a claim is not", () => {
    expect(idleFronts(state).map((p) => p.name).sort()).toEqual(["CORE", "DEVELOP"]);
    apply(state, core, { v: 1, op: "claim", paths: ["src/**"] }, at(100));
    expect(idleFronts(state).map((p) => p.name)).toEqual(["DEVELOP"]);
  });

  test("an auto-claim does not make a front busy — it is a footprint, not a mission", () => {
    apply(state, core, { v: 1, op: "claim", paths: ["src/a.ts"], auto: true }, at(100));
    expect(idleFronts(state).map((p) => p.name).sort()).toEqual(["CORE", "DEVELOP"]);
  });

  test("a front holding a taken item is not idle", () => {
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    apply(state, develop, { v: 1, op: "take", id: state.work[0]!.id }, at(200));
    expect(idleFronts(state).map((p) => p.name)).toEqual(["CORE"]);
  });

  test("a human watching is not spare capacity, and is never named by the bell", () => {
    joined(state, "Marcus", 30, "human");

    // The human joined holding nothing, same as the two agents — but only the
    // agents are capacity. An implementation that just returned [] always
    // would also pass "Marcus is absent"; it would not pass this.
    const names = idleFronts(state).map((p) => p.name).sort();
    expect(names).toEqual(["CORE", "DEVELOP"]);

    apply(state, core, { v: 1, op: "claim", paths: ["src/**"] }, at(100));
    apply(state, core, { v: 1, op: "work", title: "32 triviais", paths: ["a.ts"] }, at(150));
    const rung = tick(state, at(150 + DEFAULTS.ORPHAN_POOL_MS + 1));

    expect(rung.broadcast.some((e) => e.text.includes("Marcus"))).toBe(false);
    expect(rung.broadcast.some((e) => e.text.includes("DEVELOP"))).toBe(true);
  });

  test("a pool left open rings the idle front, once and only once", () => {
    apply(state, core, { v: 1, op: "claim", paths: ["src/**"] }, at(50));
    apply(state, core, { v: 1, op: "work", title: "32 triviais", paths: ["a.ts"] }, at(100));

    const early = tick(state, at(100 + DEFAULTS.ORPHAN_POOL_MS - 1));
    expect(early.broadcast.filter((e) => e.text.includes("DEVELOP"))).toHaveLength(0);

    const rung = tick(state, at(100 + DEFAULTS.ORPHAN_POOL_MS + 1));
    const bell = rung.broadcast.filter((e) => e.text.includes("DEVELOP"));
    expect(bell).toHaveLength(1);
    expect(bell[0]!.priority).toBe("high");

    // Addressed to the idle front, not broadcast to the bus: CORE is busy
    // holding the claim and this bell is not about it, so it must never see
    // the event at all — not just be told to ignore it.
    expect(bell[0]!.to).toBe("DEVELOP");
    expect(pendingFor(state, core).some((e) => e.text.includes("is idle"))).toBe(false);
    expect(pendingFor(state, develop).some((e) => e.text.includes("is idle"))).toBe(true);

    const again = tick(state, at(100 + DEFAULTS.ORPHAN_POOL_MS + 5000));
    expect(again.broadcast.filter((e) => e.text.includes("DEVELOP"))).toHaveLength(0);
  });

  test("no idle front means no bell at all", () => {
    apply(state, core, { v: 1, op: "claim", paths: ["src/**"] }, at(50));
    apply(state, develop, { v: 1, op: "claim", paths: ["other/**"] }, at(60));
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    const out = tick(state, at(100 + DEFAULTS.ORPHAN_POOL_MS + 1));
    expect(out.broadcast.filter((e) => e.text.includes("pool"))).toHaveLength(0);
  });

  test("an explicit orphanPoolMs governs the bell, not just the default", () => {
    apply(state, core, { v: 1, op: "claim", paths: ["src/**"] }, at(50));
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));

    // Far short of DEFAULTS.ORPHAN_POOL_MS (10 min): an implementation that
    // silently ignored the override and used the default would stay silent
    // here too, so this only passes if the override actually governs.
    const shortTtl = 1000;
    const early = tick(state, at(100 + shortTtl - 1), { orphanPoolMs: shortTtl });
    expect(early.broadcast.filter((e) => e.text.includes("DEVELOP"))).toHaveLength(0);

    const rung = tick(state, at(100 + shortTtl + 1), { orphanPoolMs: shortTtl });
    expect(rung.broadcast.filter((e) => e.text.includes("DEVELOP"))).toHaveLength(1);
  });

  test("dropping a taken item resets the bell — a new stale episode may ring again", () => {
    apply(state, core, { v: 1, op: "claim", paths: ["src/**"] }, at(50));
    apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(100));
    const id = state.work[0]!.id;

    const firstRing = tick(state, at(100 + DEFAULTS.ORPHAN_POOL_MS + 1));
    expect(firstRing.broadcast.filter((e) => e.text.includes("DEVELOP"))).toHaveLength(1);
    expect(state.work[0]!.nudgedAtMs).not.toBeNull();

    // Taking it back off the pool and handing it back is a new stale episode,
    // not a continuation of the old one — `drop` is supposed to be free
    // (Task 4), and it would quietly stop being free if this stayed stamped.
    apply(state, develop, { v: 1, op: "take", id }, at(100 + DEFAULTS.ORPHAN_POOL_MS + 100));
    apply(state, develop, { v: 1, op: "drop", id }, at(100 + DEFAULTS.ORPHAN_POOL_MS + 200));
    expect(state.work[0]!.nudgedAtMs).toBeNull();

    const secondRing = tick(state, at(100 + DEFAULTS.ORPHAN_POOL_MS + 300));
    const bell = secondRing.broadcast.filter((e) => e.text.includes("DEVELOP"));
    expect(bell).toHaveLength(1);
    expect(bell[0]!.priority).toBe("high");
  });
});
