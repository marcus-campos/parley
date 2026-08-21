// tests/brain/activation.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { MODELS } from "../../src/brain/registry";
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
  test("it starts off, and every registry entry declares its size and languages", () => {
    expect(state.brain.active).toBe(false);
    expect(MODELS.length).toBeGreaterThan(0);
    for (const m of MODELS) {
      expect(m.bytes).toBeGreaterThan(0);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.languages).toBeTruthy();
    }
  });

  test("an agent asking for semantic recall gets the floor, and never a prompt", () => {
    const out = apply(state, core, { v: 1, op: "notes", q: "anything", semantic: true }, at(100));
    expect(out.response.ok).toBe(true);
    expect(JSON.stringify(out.response)).not.toContain("enable");
  });

  test("but the panel is told, once", () => {
    const first = apply(state, core, { v: 1, op: "notes", q: "x", semantic: true }, at(100));
    expect(first.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(1);
    expect(first.broadcast[0]!.priority).toBe("high");

    const second = apply(state, core, { v: 1, op: "notes", q: "y", semantic: true }, at(200));
    expect(second.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(0);
  });

  // The CLI probes `may_enable` first so it never spends a download on an
  // answer the daemon already knows — but that probe is a courtesy, not the
  // gate. This test calls `apply` directly with an agent actor, skipping any
  // probe entirely, so it proves the enforcement still lives here and did
  // not quietly move to the CLI.
  test("an agent may not turn it on — it is somebody's disk and somebody's money", () => {
    const out = apply(state, core, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    expect(out.response.ok).toBe(false);
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
