import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../src/protocol/types";
import { apply, initialState, makeCtx, tick } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

/**
 * §4.7 — the human's voice on spending.
 *
 * A human on this bus has a voice and not a vote: territory and permission are
 * for the fronts to settle among themselves, because an unanswered request
 * that degrades into a request for a person's attention is the failure the
 * whole design exists to avoid. Capacity is the one exception and it is
 * narrow. Starting a front spends somebody's money on somebody's account, and
 * no front is ever the right one to decide that.
 *
 * The plan's original Step 1 asserted that `claim`, `take` and `shape` were
 * refused for a human and carved `shape` out as an exception. `feat/human-vote`
 * corrected that before this was written: there is no general `kind` guard to
 * carve anything out of, and there never was one on `claim`, `take` or
 * `shape` — a human was already unrestricted on all three. So this file tests
 * the gate that is actually new, and `shape` is not this task's business.
 */

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: `${name} mission` }, at(ms));
  return (out.response as unknown as { id: string }).id;
}

/** A pool that has been open long enough that `tick` would provide a front. */
function stalePool(state: State, ms: number): string {
  const core = joined(state, "CORE", ms);
  apply(state, core, { v: 1, op: "shape", shape: "pool" }, at(ms + 10));
  // An explicit claim is what makes CORE busy rather than spare capacity;
  // otherwise the pool rings its doorbell and never asks to be born.
  apply(state, core, { v: 1, op: "claim", paths: ["src/**"] }, at(ms + 20));
  apply(state, core, { v: 1, op: "work", title: "x", paths: ["a.ts"] }, at(ms + 30));
  return core;
}

let state: State;
let human: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  const out = apply(state, null, { v: 1, op: "join", name: "Marcus", kind: "human" }, at(0));
  human = (out.response as unknown as { id: string }).id;
});

describe("a human vetoes spending, not work", () => {
  test("stopping a front being born — that is money", () => {
    const out = apply(state, human, { v: 1, op: "summon", allow: false }, at(300));
    expect(out.response.ok).toBe(true);
    expect(state.birthsAllowed).toBe(false);
    // The panel has to show what the switch is switching, so the answer
    // carries the ceiling and how many fronts are live.
    expect(out.response).toMatchObject({ birthsAllowed: false, maxFronts: 6, live: 0 });
    // And everyone watching learns, at high priority — it changes what the
    // bus will do for every front on it.
    expect(out.broadcast.map((e) => e.text).join("")).toContain("stopped parley starting");
  });

  test("an agent cannot touch the veto — it is somebody's money", () => {
    const agent = joined(state, "CORE", 305);
    expect(apply(state, agent, { v: 1, op: "summon", allow: false }, at(310)).response)
      .toMatchObject({ error: { code: "OBSERVER_ONLY" } });
    expect(state.birthsAllowed).toBe(true);
  });

  test("and can lift it again, said once either way", () => {
    apply(state, human, { v: 1, op: "summon", allow: false }, at(300));
    const again = apply(state, human, { v: 1, op: "summon", allow: false }, at(310));
    // Re-affirming a veto already in place is not a louder veto.
    expect(again.broadcast).toEqual([]);
    expect(again.response.ok).toBe(true);

    const lifted = apply(state, human, { v: 1, op: "summon", allow: true }, at(320));
    expect(state.birthsAllowed).toBe(true);
    expect(lifted.broadcast.map((e) => e.text).join("")).toContain("allowed parley to start fronts again");
  });

  test("with births vetoed, an orphan pool asks for nothing", () => {
    apply(state, human, { v: 1, op: "summon", allow: false }, at(300));
    stalePool(state, 310);
    const out = tick(state, at(340 + DEFAULTS.ORPHAN_POOL_MS + 1), { maxFronts: 6 });
    expect(out.birth).toBeNull();
  });

  test("and without the veto that same pool does ask — otherwise the test above proves nothing", () => {
    stalePool(state, 310);
    const out = tick(state, at(340 + DEFAULTS.ORPHAN_POOL_MS + 1), { maxFronts: 6 });
    expect(out.birth).not.toBeNull();
  });

  test("a front asking for a hand by name is refused too", () => {
    // The veto would only hold for as long as nobody asked, otherwise: the
    // automatic path is stopped in `canBearFront`, and this is the same
    // refusal on the path a front asks for out loud.
    const agent = joined(state, "CORE", 305);
    expect(apply(state, agent, { v: 1, op: "summon", reason: "need a hand" }, at(310)).response.ok).toBe(true);

    apply(state, human, { v: 1, op: "summon", allow: false }, at(320));
    expect(apply(state, agent, { v: 1, op: "summon", reason: "need a hand" }, at(330)).response)
      .toMatchObject({ ok: false, error: { code: "NO_CAPACITY" } });
  });

  test("the veto is a decision, so it survives a restart", () => {
    // `birthsAllowed` lives on the state and is reached through `apply`, which
    // is what a journal replay re-runs. A veto that evaporated on the next
    // daemon would be a person's decision quietly reversed by an unrelated
    // restart — and the whole point is that it is theirs, not the process's.
    const frames = [
      { actor: null, frame: { v: 1, op: "join", name: "Marcus", kind: "human" } },
      { actor: "p_0001", frame: { v: 1, op: "summon", allow: false } },
    ];
    const replayed = initialState("advisory");
    const replayCounter = { n: 0 };
    for (const entry of frames) {
      apply(replayed, entry.actor, entry.frame, makeCtx(T0, replayCounter));
    }
    expect(replayed.birthsAllowed).toBe(false);
  });
});
