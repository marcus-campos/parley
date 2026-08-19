import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 19, 11, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);
const body = <T>(r: unknown) => r as T;

function joined(state: State, name: string, ms = 0): string {
  return body<{ id: string }>(
    apply(state, null, { v: 1, op: "join", name, cwd: `/wt/${name}`, session: name }, at(ms)).response,
  ).id;
}

let state: State;
let develop: string;
let taxas: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  develop = joined(state, "DEVELOP", 0);
  taxas = joined(state, "TAXAS", 10);
});

describe("one front asking another", () => {
  test("the question reaches the addressee at high priority", () => {
    const asked = apply(state, develop, {
      v: 1, op: "question", to: "TAXAS", text: "voce esta segurando finance/services.py?",
    }, at(100));
    expect(asked.response).toMatchObject({ ok: true, to: "TAXAS" });
    expect(asked.broadcast[0]!.priority).toBe("high");
    expect(asked.broadcast[0]!.to).toBe("TAXAS");

    const inbox = body<{ events: { text: string }[] }>(
      apply(state, taxas, { v: 1, op: "drain" }, at(200)).response,
    );
    expect(inbox.events.some((e) => e.text.includes("finance/services.py"))).toBe(true);
  });

  test("only the addressee can answer, and only once", () => {
    const id = body<{ question: string }>(
      apply(state, develop, { v: 1, op: "question", to: "TAXAS", text: "?" }, at(100)).response,
    ).question;

    expect(apply(state, develop, { v: 1, op: "reply", id, text: "eu mesmo" }, at(200)).response)
      .toMatchObject({ error: { code: "NOT_OWNER" } });

    expect(apply(state, taxas, { v: 1, op: "reply", id, text: "nao encosto nele" }, at(300)).response.ok).toBe(true);
    expect(apply(state, taxas, { v: 1, op: "reply", id, text: "de novo" }, at(400)).response)
      .toMatchObject({ error: { code: "NOT_OWNER" } });
  });

  test("the asker can poll for the answer", () => {
    const id = body<{ question: string }>(
      apply(state, develop, { v: 1, op: "question", to: "TAXAS", text: "?" }, at(100)).response,
    ).question;

    expect(body<{ answered: boolean }>(
      apply(state, develop, { v: 1, op: "question_status", id }, at(200)).response,
    ).answered).toBe(false);

    apply(state, taxas, { v: 1, op: "reply", id, text: "pode ir" }, at(300));
    expect(body<{ answered: boolean; answer: string }>(
      apply(state, develop, { v: 1, op: "question_status", id }, at(400)).response,
    )).toMatchObject({ answered: true, answer: "pode ir" });
  });

  test("questions expire, so nobody waits forever on a dead session", () => {
    const id = body<{ question: string }>(
      apply(state, develop, { v: 1, op: "question", to: "TAXAS", text: "?", ttl_s: 60 }, at(0)).response,
    ).question;
    expect(body<{ expired: boolean }>(
      apply(state, develop, { v: 1, op: "question_status", id }, at(61_000)).response,
    ).expired).toBe(true);
  });
});

describe("what stops an idle agent going idle", () => {
  test("an unanswered question shows as undelivered exactly once", () => {
    // This is the loop guard: a question gets one hard nudge. Without it two
    // agents could block each other's Stop forever.
    apply(state, develop, { v: 1, op: "question", to: "TAXAS", text: "?" }, at(100));

    const first = body<{ undelivered: unknown[]; owed: unknown[] }>(
      apply(state, taxas, { v: 1, op: "questions", deliver: true }, at(200)).response,
    );
    expect(first.undelivered).toHaveLength(1);
    expect(first.owed).toHaveLength(1);

    const second = body<{ undelivered: unknown[]; owed: unknown[] }>(
      apply(state, taxas, { v: 1, op: "questions", deliver: true }, at(300)).response,
    );
    expect(second.undelivered).toHaveLength(0);
    // Still owed — it just stops interrupting.
    expect(second.owed).toHaveLength(1);
  });

  test("each side sees its own half of the exchange", () => {
    apply(state, develop, { v: 1, op: "question", to: "TAXAS", text: "?" }, at(100));

    const forTaxas = body<{ owed: unknown[]; waiting: unknown[] }>(
      apply(state, taxas, { v: 1, op: "questions" }, at(200)).response,
    );
    expect(forTaxas.owed).toHaveLength(1);
    expect(forTaxas.waiting).toHaveLength(0);

    const forDevelop = body<{ owed: unknown[]; waiting: unknown[] }>(
      apply(state, develop, { v: 1, op: "questions" }, at(210)).response,
    );
    expect(forDevelop.owed).toHaveLength(0);
    expect(forDevelop.waiting).toHaveLength(1);
  });

  test("an answered question stops appearing as owed", () => {
    const id = body<{ question: string }>(
      apply(state, develop, { v: 1, op: "question", to: "TAXAS", text: "?" }, at(100)).response,
    ).question;
    apply(state, taxas, { v: 1, op: "reply", id, text: "pronto" }, at(200));
    expect(body<{ owed: unknown[] }>(
      apply(state, taxas, { v: 1, op: "questions" }, at(300)).response,
    ).owed).toHaveLength(0);
  });

  test("you cannot question yourself into a loop", () => {
    expect(apply(state, develop, { v: 1, op: "question", to: "DEVELOP", text: "?" }, at(100)).response)
      .toMatchObject({ error: { code: "NOT_OWNER" } });
  });
});

describe("closing the loop", () => {
  test("the asker acknowledges, and only the asker can", () => {
    const id = body<{ question: string }>(
      apply(state, develop, { v: 1, op: "question", to: "TAXAS", text: "?" }, at(100)).response,
    ).question;
    apply(state, taxas, { v: 1, op: "reply", id, text: "pode ir" }, at(200));

    expect(apply(state, taxas, { v: 1, op: "ack", id }, at(300)).response)
      .toMatchObject({ error: { code: "NOT_OWNER" } });

    const acked = apply(state, develop, { v: 1, op: "ack", id, text: "entendi, sigo em frente" }, at(400));
    expect(acked.response).toMatchObject({ ok: true, acknowledged: true });
    expect(acked.broadcast[0]!.to).toBe("TAXAS");
    expect(acked.broadcast[0]!.text).toContain("entendi");
  });

  test("acknowledging before there is an answer is refused", () => {
    const id = body<{ question: string }>(
      apply(state, develop, { v: 1, op: "question", to: "TAXAS", text: "?" }, at(100)).response,
    ).question;
    expect(apply(state, develop, { v: 1, op: "ack", id }, at(200)).response)
      .toMatchObject({ error: { code: "NOT_OWNER" } });
  });

  test("an arrived answer is flagged unseen once, then stops nagging", () => {
    const id = body<{ question: string }>(
      apply(state, develop, { v: 1, op: "question", to: "TAXAS", text: "?" }, at(100)).response,
    ).question;
    apply(state, taxas, { v: 1, op: "reply", id, text: "pode ir" }, at(200));

    const first = body<{ unseen_answers: unknown[] }>(
      apply(state, develop, { v: 1, op: "questions", deliver: true }, at(300)).response,
    );
    expect(first.unseen_answers).toHaveLength(1);

    const second = body<{ unseen_answers: unknown[] }>(
      apply(state, develop, { v: 1, op: "questions", deliver: true }, at(400)).response,
    );
    expect(second.unseen_answers).toHaveLength(0);
  });
});

describe("permission nudges each side exactly once", () => {
  test("the owner is told once that someone is blocked on their path", () => {
    apply(state, taxas, { v: 1, op: "claim", paths: ["src/finance/services.py"] }, at(0));
    apply(state, develop, {
      v: 1, op: "ask", path: "src/finance/services.py", reason: "3 linhas",
    }, at(100));

    const first = body<{ needs_my_decision: unknown[] }>(
      apply(state, taxas, { v: 1, op: "requests", deliver: true }, at(200)).response,
    );
    expect(first.needs_my_decision).toHaveLength(1);

    const second = body<{ needs_my_decision: unknown[] }>(
      apply(state, taxas, { v: 1, op: "requests", deliver: true }, at(300)).response,
    );
    expect(second.needs_my_decision).toHaveLength(0);
  });

  test("the asker is told once that it was settled", () => {
    apply(state, taxas, { v: 1, op: "claim", paths: ["src/x.py"] }, at(0));
    const asked = apply(state, develop, { v: 1, op: "ask", path: "src/x.py", reason: "r" }, at(100));
    const rid = body<{ request: string }>(asked.response).request;

    expect(body<{ settled_for_me: unknown[]; i_am_waiting_on: unknown[] }>(
      apply(state, develop, { v: 1, op: "requests", deliver: true }, at(150)).response,
    )).toMatchObject({ settled_for_me: [], i_am_waiting_on: [{}] });

    apply(state, taxas, { v: 1, op: "grant", request: rid }, at(200));

    const after = body<{ settled_for_me: { state: string }[] }>(
      apply(state, develop, { v: 1, op: "requests", deliver: true }, at(300)).response,
    );
    expect(after.settled_for_me[0]!.state).toBe("granted");

    expect(body<{ settled_for_me: unknown[] }>(
      apply(state, develop, { v: 1, op: "requests", deliver: true }, at(400)).response,
    ).settled_for_me).toHaveLength(0);
  });
});
