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

describe("history", () => {
  test("a panel joining late still sees what already happened", () => {
    const fin = joined(state, "FINANCEIRO", { cwd: "/wt/fin" });
    apply(state, fin, { v: 1, op: "say", text: "vou mexer no alembic" }, at(10));
    apply(state, fin, { v: 1, op: "say", text: "confiram as heads" }, at(20));

    const panel = joined(state, "PANEL", { kind: "human", cwd: "/wt/panel" }, 30);
    expect((apply(state, panel, { v: 1, op: "drain" }, at(40)).response as unknown as { events: unknown[] }).events)
      .toHaveLength(0);

    const past = apply(state, panel, { v: 1, op: "history" }, at(50)).response as unknown as {
      events: { text: string }[];
    };
    expect(past.events.some((e) => e.text === "vou mexer no alembic")).toBe(true);
    expect(past.events.some((e) => e.text === "confiram as heads")).toBe(true);
  });

  test("history does not move the read cursor", () => {
    const fin = joined(state, "FINANCEIRO", { cwd: "/wt/fin" });
    const campo = joined(state, "TESTE-CAMPO", { cwd: "/wt/campo" }, 10);
    apply(state, fin, { v: 1, op: "say", text: "olha isso" }, at(20));

    apply(state, campo, { v: 1, op: "history" }, at(30));
    const drained = apply(state, campo, { v: 1, op: "drain" }, at(40)).response as unknown as {
      events: { text: string }[];
    };
    expect(drained.events.some((e) => e.text === "olha isso")).toBe(true);
  });

  test("an agent's backlog never leaks a message directed at someone else", () => {
    const fin = joined(state, "FINANCEIRO", { cwd: "/wt/fin" });
    joined(state, "TESTE-CAMPO", { cwd: "/wt/campo" }, 10);
    const mobile = joined(state, "MOBILE", { cwd: "/wt/mob" }, 20);
    apply(state, fin, { v: 1, op: "say", to: "TESTE-CAMPO", text: "so pra voce" }, at(30));

    const past = apply(state, mobile, { v: 1, op: "history" }, at(40)).response as unknown as {
      events: { text: string }[];
    };
    expect(past.events.some((e) => e.text === "so pra voce")).toBe(false);
  });

  test("a human's backlog does include it, because watching means watching", () => {
    const fin = joined(state, "FINANCEIRO", { cwd: "/wt/fin" });
    joined(state, "TESTE-CAMPO", { cwd: "/wt/campo" }, 10);
    const panel = joined(state, "PANEL", { kind: "human", cwd: "/wt/panel" }, 20);
    apply(state, fin, { v: 1, op: "say", to: "TESTE-CAMPO", text: "so pra voce" }, at(30));

    const past = apply(state, panel, { v: 1, op: "history" }, at(40)).response as unknown as {
      events: { text: string; to: string | null }[];
    };
    const seen = past.events.find((e) => e.text === "so pra voce");
    expect(seen?.to).toBe("TESTE-CAMPO");
  });

  test("the limit is clamped, not trusted", () => {
    const fin = joined(state, "FINANCEIRO", { cwd: "/wt/fin" });
    for (let i = 0; i < 30; i++) apply(state, fin, { v: 1, op: "say", text: `m${i}` }, at(100 + i));
    const out = apply(state, fin, { v: 1, op: "history", limit: 5 }, at(500)).response as unknown as {
      events: unknown[];
    };
    expect(out.events).toHaveLength(5);
  });
});

describe("say returns what it created", () => {
  test("the sender gets the event back, since drain will never hand it over", () => {
    const human = joined(state, "Marcus", { kind: "human", cwd: "/wt/panel" });
    const out = apply(state, human, { v: 1, op: "say", text: "não dropem coluna hoje" }, at(100));

    const body = out.response as unknown as { seq: number; event: { seq: number; text: string; priority: string; from: { name: string; kind: string } } };
    expect(body.event.text).toBe("não dropem coluna hoje");
    expect(body.event.priority).toBe("high");
    expect(body.event.from).toMatchObject({ name: "Marcus", kind: "human" });
    expect(body.event.seq).toBe(body.seq);

    // And drain still refuses to give it back, so a panel that appends the
    // receipt cannot end up showing it twice.
    const mine = apply(state, human, { v: 1, op: "drain" }, at(200)).response as unknown as { events: unknown[] };
    expect(mine.events).toHaveLength(0);
  });

  test("it still reaches the other fronts", () => {
    const human = joined(state, "Marcus", { kind: "human", cwd: "/wt/panel" });
    const agent = joined(state, "FINANCEIRO", { cwd: "/wt/fin" }, 10);
    apply(state, human, { v: 1, op: "say", text: "aviso" }, at(100));

    const inbox = apply(state, agent, { v: 1, op: "drain" }, at(200)).response as unknown as {
      events: { text: string; priority: string }[];
    };
    expect(inbox.events.find((e) => e.text === "aviso")?.priority).toBe("high");
  });
});

describe("identity is keyed on the session, not the name", () => {
  const S = "sess-abc123";

  test("a front that renamed itself is not recreated by the next hook", () => {
    // This is the churn: the hook re-derives the branch name on every tool
    // call, so keyed on the name the agent came back as a brand new front.
    const first = apply(state, null, { v: 1, op: "join", name: "DEVELOP", cwd: "/repo", session: S }, at(0));
    const id = (first.response as unknown as { id: string }).id;
    apply(state, id, { v: 1, op: "rename", name: "PRUMO", mission: "fechar pendências" }, at(10));

    const nextHook = apply(state, null, { v: 1, op: "join", name: "DEVELOP", cwd: "/repo", session: S }, at(20));
    expect(nextHook.response).toMatchObject({ ok: true, id, name: "PRUMO", reattached: true });
    expect(Object.keys(state.participants)).toHaveLength(1);
  });

  test("two sessions in the same worktree stay two fronts", () => {
    // Keyed on name+cwd these merged into one, which is the same bug seen from
    // the other side: both derive the branch name and both are in one repo.
    apply(state, null, { v: 1, op: "join", name: "DEVELOP", cwd: "/repo", session: "sess-a" }, at(0));
    const second = apply(state, null, { v: 1, op: "join", name: "DEVELOP", cwd: "/repo", session: "sess-b" }, at(10));

    expect(second.response).toMatchObject({ error: { code: "NAME_TAKEN", suggestion: "DEVELOP-2" } });
    const retry = apply(state, null, { v: 1, op: "join", name: "DEVELOP-2", cwd: "/repo", session: "sess-b" }, at(20));
    expect(retry.response.ok).toBe(true);
    expect(Object.keys(state.participants)).toHaveLength(2);
  });

  test("a session that dropped comes back as itself, name and all", () => {
    const first = apply(state, null, { v: 1, op: "join", name: "DEVELOP", cwd: "/repo", session: S }, at(0));
    const id = (first.response as unknown as { id: string }).id;
    apply(state, id, { v: 1, op: "rename", name: "LEME", mission: "auditoria" }, at(10));

    tick(state, at(DEFAULTS.LEASE_TTL_MS + 1000));
    expect(state.participants[id]!.gone).toBe(true);

    const back = apply(state, null, { v: 1, op: "join", name: "DEVELOP", cwd: "/repo", session: S }, at(DEFAULTS.LEASE_TTL_MS + 2000));
    expect(back.response).toMatchObject({ ok: true, id, name: "LEME" });
    expect(Object.keys(state.participants)).toHaveLength(1);
  });

  test("callers with no session still re-attach by name and worktree", () => {
    const first = apply(state, null, { v: 1, op: "join", name: "SHELL", cwd: "/repo" }, at(0));
    const id = (first.response as unknown as { id: string }).id;
    const again = apply(state, null, { v: 1, op: "join", name: "SHELL", cwd: "/repo" }, at(10));
    expect(again.response).toMatchObject({ ok: true, id, reattached: true });
  });
});

describe("what an observer sees, and what it costs to keep watching", () => {
  test("a human sees a private message between two agents", () => {
    // Not a privacy boundary: the person is accountable for this repository,
    // and coordination they cannot see is coordination they cannot correct.
    const fin = joined(state, "FINANCEIRO", { cwd: "/wt/fin" });
    const campo = joined(state, "TESTE-CAMPO", { cwd: "/wt/campo" }, 10);
    const mobile = joined(state, "MOBILE", { cwd: "/wt/mob" }, 20);
    const human = joined(state, "Marcus", { kind: "human", cwd: "/wt/panel" }, 30);

    apply(state, fin, { v: 1, op: "say", to: "TESTE-CAMPO", text: "só entre nós" }, at(40));

    const forHuman = apply(state, human, { v: 1, op: "drain" }, at(50)).response as unknown as {
      events: { text: string; to: string | null }[];
    };
    const seen = forHuman.events.find((e) => e.text === "só entre nós");
    expect(seen).toBeDefined();
    expect(seen!.to).toBe("TESTE-CAMPO");

    // Another agent still does not.
    const forMobile = apply(state, mobile, { v: 1, op: "drain" }, at(60)).response as unknown as {
      events: { text: string }[];
    };
    expect(forMobile.events.some((e) => e.text === "só entre nós")).toBe(false);
  });

  test("drain is incremental: a second pull costs nothing when nothing happened", () => {
    const fin = joined(state, "FINANCEIRO", { cwd: "/wt/fin" });
    const campo = joined(state, "TESTE-CAMPO", { cwd: "/wt/campo" }, 10);

    apply(state, fin, { v: 1, op: "say", text: "primeira" }, at(20));
    const first = apply(state, campo, { v: 1, op: "drain" }, at(30)).response as unknown as { events: unknown[] };
    expect(first.events).toHaveLength(1);

    const second = apply(state, campo, { v: 1, op: "drain" }, at(40)).response as unknown as { events: unknown[] };
    expect(second.events).toHaveLength(0);

    apply(state, fin, { v: 1, op: "say", text: "segunda" }, at(50));
    const third = apply(state, campo, { v: 1, op: "drain" }, at(60)).response as unknown as {
      events: { text: string }[];
    };
    expect(third.events).toHaveLength(1);
    expect(third.events[0]!.text).toBe("segunda");
  });

  test("a front that lost its context can re-read a window it names", () => {
    const fin = joined(state, "FINANCEIRO", { cwd: "/wt/fin" });
    const campo = joined(state, "TESTE-CAMPO", { cwd: "/wt/campo" }, 10);
    for (const t of ["um", "dois", "três"]) apply(state, fin, { v: 1, op: "say", text: t }, at(20));

    const drained = apply(state, campo, { v: 1, op: "drain" }, at(30)).response as unknown as {
      events: { seq: number }[];
    };
    const firstSeq = drained.events[0]!.seq;

    const again = apply(state, campo, { v: 1, op: "history", since: firstSeq - 1 }, at(40)).response as unknown as {
      events: { text: string }[];
      cursor: number;
    };
    expect(again.events.map((e) => e.text)).toEqual(["um", "dois", "três"]);
    expect(again.cursor).toBeGreaterThan(0);

    // And re-reading did not move the cursor, so the next drain is still empty.
    expect((apply(state, campo, { v: 1, op: "drain" }, at(50)).response as unknown as { events: unknown[] }).events)
      .toHaveLength(0);
  });
});

describe("a front is never told about its own actions", () => {
  test("your own join, claim and release do not come back to you", () => {
    const fin = joined(state, "FINANCEIRO", { cwd: "/wt/fin" });
    const campo = joined(state, "TESTE-CAMPO", { cwd: "/wt/campo" }, 10);
    apply(state, fin, { v: 1, op: "claim", paths: ["src/a.ts"] }, at(20));
    apply(state, fin, { v: 1, op: "release", paths: ["src/a.ts"] }, at(30));

    const mine = apply(state, fin, { v: 1, op: "drain" }, at(40)).response as unknown as {
      events: { text: string }[];
    };
    expect(mine.events.some((e) => e.text.includes("FINANCEIRO claimed"))).toBe(false);
    expect(mine.events.some((e) => e.text.includes("FINANCEIRO released"))).toBe(false);
    expect(mine.events.some((e) => e.text.includes("FINANCEIRO joined"))).toBe(false);

    // Everyone else does hear about it — that is the whole point of the bus.
    const theirs = apply(state, campo, { v: 1, op: "drain" }, at(50)).response as unknown as {
      events: { text: string }[];
    };
    expect(theirs.events.some((e) => e.text.includes("FINANCEIRO claimed"))).toBe(true);
  });

  test("renaming yourself does not survive as news to you", () => {
    const fin = joined(state, "WORKTREE-FIN", { cwd: "/wt/fin" });
    apply(state, fin, { v: 1, op: "rename", name: "FINANCEIRO", mission: "fechamento" }, at(20));
    const mine = apply(state, fin, { v: 1, op: "drain" }, at(30)).response as unknown as { events: unknown[] };
    expect(mine.events).toHaveLength(0);
  });

  test("the filter follows the participant, not the name they had", () => {
    // Matching on the name inside the text would break here.
    const fin = joined(state, "WORKTREE-FIN", { cwd: "/wt/fin" });
    apply(state, fin, { v: 1, op: "claim", paths: ["src/a.ts"] }, at(20));
    apply(state, fin, { v: 1, op: "rename", name: "PRUMO" }, at(30));
    apply(state, fin, { v: 1, op: "release", paths: ["src/a.ts"] }, at(40));

    const mine = apply(state, fin, { v: 1, op: "drain" }, at(50)).response as unknown as { events: unknown[] };
    expect(mine.events).toHaveLength(0);
  });
});
