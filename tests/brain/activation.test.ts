// tests/brain/activation.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { BENCHMARK_SIZE, isStatic, MODELS } from "../../src/brain/registry";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0, extra: Record<string, unknown> = {}): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: "m", ...extra }, at(ms));
  return (out.response as unknown as { id: string }).id;
}

let state: State;
let core: string;
let human: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  core = joined(state, "CORE", 0);
  human = joined(state, "Marcus", 10, { kind: "human" });
});

describe("turning the brain on", () => {
  test("it starts off, and every registry entry declares its cost and its score", () => {
    expect(state.brain.active).toBe(false);
    expect(MODELS.length).toBeGreaterThan(0);
    for (const m of MODELS) {
      expect(m.bytes).toBeGreaterThan(0);
      // The score is the only claim the listing makes, so an unmeasured entry
      // is worse than an absent one: it would rank against models that were
      // actually run.
      expect(m.score).toBeGreaterThan(0);
      expect(m.score).toBeLessThanOrEqual(BENCHMARK_SIZE);
      if (isStatic(m)) {
        expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      } else {
        // An encoder has no file to checksum — it is fetched by its runtime —
        // so what has to be pinned instead is the floor, which doubles as the
        // fingerprint the persisted vectors are validated against.
        expect(m.spec.floor).toBeGreaterThan(0);
        expect(m.spec.repo).toBeTruthy();
      }
    }
  });

  test("no two models share a floor, because the vector cache tells them apart by it", () => {
    // `vectors.ts` stores dims+floor as the fingerprint proving a persisted
    // index belongs to the model now loaded. Two models sharing both would let
    // one model's vectors be loaded as the other's, and every ranking after
    // that would be nonsense that looks like a working brain.
    const fingerprints = MODELS.map((m) => `${m.dims}:${isStatic(m) ? m.name : m.spec.floor}`);
    expect(new Set(fingerprints).size).toBe(MODELS.length);
  });

  test("an agent asking for semantic recall gets the floor, and never a prompt", () => {
    const out = apply(state, core, { v: 1, op: "notes", q: "anything", semantic: true }, at(100));
    expect(out.response.ok).toBe(true);
    expect(JSON.stringify(out.response)).not.toContain("enable");
  });

  /**
   * `results --query` has been putting `semantic: true` on the wire since the
   * flag existed, and `listResults` never read it — a field journaled forever
   * and acted on by nobody, so a person whose fronts happened to ask through
   * `results` was never told the brain exists at all.
   */
  test("asking through results earns the same notice asking through notes does", () => {
    const out = apply(state, core, { v: 1, op: "results", q: "bun test", semantic: true }, at(100));
    expect(out.response.ok).toBe(true);
    expect(out.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(1);
  });

  test("and it is one notice for the bus, not one per op — notes after results says nothing more", () => {
    const first = apply(state, core, { v: 1, op: "results", q: "bun test", semantic: true }, at(100));
    expect(first.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(1);

    const second = apply(state, core, { v: 1, op: "notes", q: "x", semantic: true }, at(200));
    expect(second.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(0);
  });

  test("a plain listing is not asking, so it earns nothing — through either op", () => {
    expect(apply(state, core, { v: 1, op: "results" }, at(100)).broadcast).toHaveLength(0);
    expect(apply(state, core, { v: 1, op: "notes" }, at(110)).broadcast).toHaveLength(0);
    expect(state.brain.askedAtMs).toBeNull();
  });

  test("with the brain on, asking earns no notice at all — there is nothing to discover", () => {
    apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(50));
    const out = apply(state, core, { v: 1, op: "results", q: "bun test", semantic: true }, at(100));
    expect(out.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(0);
  });

  test("but the panel is told, once", () => {
    const first = apply(state, core, { v: 1, op: "notes", q: "x", semantic: true }, at(100));
    expect(first.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(1);
    expect(first.broadcast[0]!.priority).toBe("high");

    const second = apply(state, core, { v: 1, op: "notes", q: "y", semantic: true }, at(200));
    expect(second.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(0);
  });

  // The CLI probes `may_enable` first so it never spends a download on an
  // This block used to assert the reducer refused an agent, and its comment
  // said the point was proving enforcement "did not quietly move to the CLI".
  // It moved, deliberately, and the reason is worth keeping rather than
  // deleting with the assertion:
  //
  //   * The old check refused an agent that did not pass `--human`, and its own
  //     error message told the reader to pass `--human`. Verified against the
  //     shipped 0.7.1 binary: an agent passing it was enabled. A control whose
  //     bypass is printed in its own refusal is a speed bump.
  //   * Standing there cost a person their identity. Requiring `kind: "human"`
  //     meant joining the bus, and joining derived a name from the branch —
  //     which already belonged to the agent working on it. The person
  //     reattached to that agent and was refused by this very check.
  //   * What the rule protects is the download, and the download is CLI-side.
  //     Measured, not assumed: reaching this op directly with no model on disk
  //     flips a flag and buys nothing — the search degrades to the lexical
  //     floor. With a model already there it turns on what somebody paid for.
  //
  // So the reducer accepts, and the refusal lives where the fact it needs is:
  // `tests/cli/brain.test.ts` pins it against the compiled binary.
  test("the reducer accepts whoever reaches it, because the spending is CLI-side", () => {
    const out = apply(state, core, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    expect(out.response.ok).toBe(true);
  });

  test("the watching human may", () => {
    const out = apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    expect(out.response.ok).toBe(true);
    expect(state.brain.active).toBe(true);
    expect(state.brain.model).toBe(MODELS[0]!.name);
  });

  test("a model that is not in the registry is refused", () => {
    const out = apply(state, human, { v: 1, op: "brain", enable: "something-off-the-internet" }, at(300));
    expect(out.response.ok).toBe(false);
    expect(state.brain.active).toBe(false);
  });

  test("status is readable by anyone", () => {
    const out = apply(state, core, { v: 1, op: "brain" }, at(400));
    expect(out.response).toMatchObject({ ok: true, active: false });
  });

  test("status tells the calling participant whether it may enable — both ways, not a constant", () => {
    const forAgent = apply(state, core, { v: 1, op: "brain" }, at(400));
    expect(forAgent.response).toMatchObject({ ok: true, may_enable: false });

    const forHuman = apply(state, human, { v: 1, op: "brain" }, at(400));
    expect(forHuman.response).toMatchObject({ ok: true, may_enable: true });
  });

  test("disabling puts it back on the floor without losing the corpus", () => {
    apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    apply(state, human, { v: 1, op: "brain", disable: true }, at(400));
    expect(state.brain.active).toBe(false);
  });
});

/**
 * `setMode` and `setShape` already announce a changed bus-wide setting so
 * every front learns it without polling — `brain enable`/`disable` shipped
 * without that broadcast (Task 5) because nothing conditioned behaviour on
 * `brain.active` yet. This task is what changes that, so the announcement
 * is no longer optional.
 */
describe("turning the brain on or off is announced, the same way mode and shape are", () => {
  test("enabling broadcasts once, at high priority, naming the model", () => {
    const out = apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    expect(out.broadcast).toHaveLength(1);
    expect(out.broadcast[0]!.priority).toBe("high");
    expect(out.broadcast[0]!.text).toContain(MODELS[0]!.name);
  });

  test("disabling broadcasts once too", () => {
    apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    const out = apply(state, human, { v: 1, op: "brain", disable: true }, at(400));
    expect(out.broadcast).toHaveLength(1);
    expect(out.broadcast[0]!.priority).toBe("high");
  });

  test("enabling the model that is already active changes nothing, so nothing is announced again", () => {
    apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    const out = apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(400));
    expect(out.broadcast).toHaveLength(0);
  });

  test("disabling while already off changes nothing, so nothing is announced", () => {
    const out = apply(state, human, { v: 1, op: "brain", disable: true }, at(300));
    expect(out.broadcast).toHaveLength(0);
  });

  test("a refused attempt — an unknown model — announces nothing", () => {
    // The "wrong actor" half is gone with the `kind` gate above. What is left
    // is the half that was always about the frame rather than the caller.
    const unknownModel = apply(state, human, { v: 1, op: "brain", enable: "not-a-model" }, at(300));
    expect(unknownModel.response.ok).toBe(false);
    expect(unknownModel.broadcast).toHaveLength(0);
  });

  test("every other front hears it, exactly like a mode change", () => {
    const out = apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    expect(out.broadcast[0]).toMatchObject({ kind: "system", from: null, to: null, priority: "high" });
  });
});
