import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../src/protocol/types";
import { apply, initialState, makeCtx, tick } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 18, 14, 0, 0);
let counter = { n: 0 };
const at = (msFromT0: number): Ctx => makeCtx(T0 + msFromT0, counter);

function joined(state: State, name: string, extra: Record<string, unknown> = {}, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: `${name} mission`, ...extra }, at(ms));
  expect(out.response.ok).toBe(true);
  return (out.response as unknown as { id: string }).id;
}

let state: State;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
});

describe("protocol version", () => {
  test("a mismatched version names both versions instead of failing obscurely", () => {
    const out = apply(state, null, { v: 99, op: "who" }, at(0));
    expect(out.response.ok).toBe(false);
    expect(out.response).toMatchObject({ error: { code: "PROTOCOL_MISMATCH", server: 1, client: 99 } });
  });

  test("an unknown op is named", () => {
    const out = apply(state, null, { v: 1, op: "teleport" }, at(0));
    expect(out.response).toMatchObject({ error: { code: "UNKNOWN_OP" } });
  });
});

describe("participation", () => {
  test("join returns identity, mode and peers", () => {
    joined(state, "FINANCEIRO");
    const out = apply(state, null, { v: 1, op: "join", name: "TESTE-CAMPO" }, at(1000));
    expect(out.response).toMatchObject({ ok: true, name: "TESTE-CAMPO", mode: "advisory" });
    expect((out.response as unknown as { peers: unknown[] }).peers).toHaveLength(1);
  });

  test("a duplicate name is refused with a usable suggestion", () => {
    joined(state, "FINANCEIRO");
    const out = apply(state, null, { v: 1, op: "join", name: "FINANCEIRO" }, at(1));
    expect(out.response).toMatchObject({ error: { code: "NAME_TAKEN", suggestion: "FINANCEIRO-2" } });
  });

  test("a restarted session reclaims its own id and read cursor", () => {
    const id = joined(state, "FINANCEIRO");
    apply(state, id, { v: 1, op: "leave" }, at(1000));
    const again = joined(state, "FINANCEIRO", {}, 2000);
    expect(again).toBe(id);
  });

  test("rename swaps the provisional name the hook assigned", () => {
    const id = joined(state, "WORKTREE-FIN");
    const out = apply(state, id, { v: 1, op: "rename", name: "FINANCEIRO", mission: "fechamento de KM" }, at(10));
    expect(out.response).toMatchObject({ ok: true, name: "FINANCEIRO", mission: "fechamento de KM" });
  });

  test("commands before joining are refused", () => {
    expect(apply(state, null, { v: 1, op: "say", text: "oi" }, at(0)).response)
      .toMatchObject({ error: { code: "NOT_JOINED" } });
  });
});

describe("conversation", () => {
  test("each front drains only what it has not seen, and never its own words", () => {
    const fin = joined(state, "FINANCEIRO");
    const campo = joined(state, "TESTE-CAMPO", {}, 10);
    apply(state, fin, { v: 1, op: "say", text: "vou mexer no alembic" }, at(20));

    const mine = apply(state, fin, { v: 1, op: "drain" }, at(30)).response as unknown as { events: unknown[] };
    expect(mine.events.some((e) => (e as { text: string }).text === "vou mexer no alembic")).toBe(false);

    const theirs = apply(state, campo, { v: 1, op: "drain" }, at(31)).response as unknown as { events: { text: string }[] };
    expect(theirs.events.some((e) => e.text === "vou mexer no alembic")).toBe(true);

    const again = apply(state, campo, { v: 1, op: "drain" }, at(32)).response as unknown as { events: unknown[] };
    expect(again.events).toHaveLength(0);
  });

  test("a directed message reaches only its addressee", () => {
    const fin = joined(state, "FINANCEIRO");
    const campo = joined(state, "TESTE-CAMPO", {}, 10);
    const outro = joined(state, "MOBILE", {}, 20);
    apply(state, fin, { v: 1, op: "say", to: "TESTE-CAMPO", text: "só pra você" }, at(30));

    const forCampo = apply(state, campo, { v: 1, op: "drain" }, at(40)).response as unknown as { events: { text: string }[] };
    const forOutro = apply(state, outro, { v: 1, op: "drain" }, at(41)).response as unknown as { events: { text: string }[] };
    expect(forCampo.events.some((e) => e.text === "só pra você")).toBe(true);
    expect(forOutro.events.some((e) => e.text === "só pra você")).toBe(false);
  });

  test("a human always speaks at high priority", () => {
    const human = joined(state, "Marcus", { kind: "human" });
    const agent = joined(state, "FINANCEIRO", {}, 10);
    apply(state, human, { v: 1, op: "say", text: "não dropem coluna nenhuma hoje" }, at(20));

    const inbox = apply(state, agent, { v: 1, op: "drain" }, at(30)).response as unknown as {
      events: { text: string; priority: string; from: { kind: string } }[];
    };
    const msg = inbox.events.find((e) => e.text.startsWith("não dropem"))!;
    expect(msg.priority).toBe("high");
    expect(msg.from.kind).toBe("human");
  });
});

describe("the ephemeral hook path", () => {
  test("the same name from the same worktree re-attaches instead of colliding", () => {
    const first = apply(state, null, { v: 1, op: "join", name: "FIN", cwd: "/repo/wt/fin" }, at(0));
    const id = (first.response as unknown as { id: string }).id;

    const again = apply(state, null, { v: 1, op: "join", name: "FIN", cwd: "/repo/wt/fin" }, at(60_000));
    expect(again.response).toMatchObject({ ok: true, id, reattached: true });
    expect(state.participants[id]!.lastSeenMs).toBe(T0 + 60_000);
    expect(Object.keys(state.participants)).toHaveLength(1);
  });

  test("the same name from a DIFFERENT worktree is still a real collision", () => {
    apply(state, null, { v: 1, op: "join", name: "FIN", cwd: "/repo/wt/a" }, at(0));
    const out = apply(state, null, { v: 1, op: "join", name: "FIN", cwd: "/repo/wt/b" }, at(10));
    expect(out.response).toMatchObject({ error: { code: "NAME_TAKEN", suggestion: "FIN-2" } });
  });

  test("re-attaching renews the lease, so a hook-driven front never expires", () => {
    apply(state, null, { v: 1, op: "join", name: "FIN", cwd: "/repo/wt/fin" }, at(0));
    for (let m = 1; m <= 20; m++) {
      apply(state, null, { v: 1, op: "join", name: "FIN", cwd: "/repo/wt/fin" }, at(m * 60_000));
      tick(state, at(m * 60_000));
    }
    expect(Object.values(state.participants)[0]!.gone).toBe(false);
  });
});
