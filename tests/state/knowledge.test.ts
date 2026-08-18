import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 18, 14, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);
const body = <T>(r: unknown) => r as T;

function joined(state: State, name: string, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, cwd: `/wt/${name}`, session: name }, at(ms));
  return body<{ id: string }>(out.response).id;
}

let state: State;
let fin: string;
let campo: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  fin = joined(state, "FINANCEIRO", 0);
  campo = joined(state, "TESTE-CAMPO", 10);
});

describe("knowledge anchored to a path", () => {
  test("claiming a file hands you what is known about it, unasked", () => {
    // The whole point: the agent does not have to think to ask.
    apply(state, fin, {
      v: 1, op: "note",
      title: "this serializer is used by the mobile app too",
      body: "changing the field names breaks the collection screen",
      paths: ["src/backend/app/accounts/schemas.py"],
      tags: ["mobile"],
    }, at(100));
    apply(state, fin, { v: 1, op: "release", all: true }, at(150));

    const out = apply(state, campo, {
      v: 1, op: "claim", paths: ["src/backend/app/accounts/schemas.py"], auto: true,
    }, at(200));

    const notes = body<{ notes: { title: string }[] }>(out.response).notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe("this serializer is used by the mobile app too");
  });

  test("a note anchored to a glob reaches every file under it", () => {
    apply(state, fin, {
      v: 1, op: "note", title: "everything here is generated", paths: ["src/generated/**"],
    }, at(100));

    const out = apply(state, campo, { v: 1, op: "claim", paths: ["src/generated/api/client.ts"] }, at(200));
    expect(body<{ notes: unknown[] }>(out.response).notes).toHaveLength(1);
  });

  test("an unrelated path gets nothing, so the injection stays rare and precise", () => {
    apply(state, fin, { v: 1, op: "note", title: "about finance", paths: ["src/finance/**"] }, at(100));
    const out = apply(state, campo, { v: 1, op: "claim", paths: ["src/mobile/app.ts"] }, at(200));
    expect(body<{ notes: unknown[] }>(out.response).notes).toHaveLength(0);
  });

  test("filtering notes by path works from the CLI side too", () => {
    apply(state, fin, { v: 1, op: "note", title: "A", paths: ["src/a.ts"] }, at(100));
    apply(state, fin, { v: 1, op: "note", title: "B", paths: ["src/b.ts"] }, at(110));
    const out = apply(state, campo, { v: 1, op: "notes", path: "src/a.ts" }, at(200));
    const notes = body<{ notes: { title: string }[] }>(out.response).notes;
    expect(notes.map((n) => n.title)).toEqual(["A"]);
  });
});

describe("who touched this before me", () => {
  test("claiming tells you who was here recently and why", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/app.ts"], intent: "fix the env guard" }, at(0));
    apply(state, fin, { v: 1, op: "release", paths: ["src/app.ts"] }, at(1000));

    const out = apply(state, campo, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(4 * 60_000));
    const recent = body<{ recent: { byName: string; intent: string }[] }>(out.response).recent;
    expect(recent).toHaveLength(1);
    expect(recent[0]!.byName).toBe("FINANCEIRO");
    expect(recent[0]!.intent).toBe("fix the env guard");
  });

  test("your own earlier touch is not news to you", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(0));
    apply(state, fin, { v: 1, op: "release", paths: ["src/app.ts"] }, at(100));
    const out = apply(state, fin, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(200));
    expect(body<{ recent: unknown[] }>(out.response).recent).toHaveLength(0);
  });

  test("a touch from hours ago is history, not context", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(0));
    apply(state, fin, { v: 1, op: "release", paths: ["src/app.ts"] }, at(100));
    const out = apply(state, campo, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(3 * 60 * 60_000));
    expect(body<{ recent: unknown[] }>(out.response).recent).toHaveLength(0);
  });
});

describe("results nobody should have to reproduce", () => {
  test("a fresh result is offered as fresh", () => {
    apply(state, fin, {
      v: 1, op: "result", key: "bun test", status: "pass",
      summary: "128 pass, 0 fail", paths: ["src/**", "tests/**"],
    }, at(0));

    const out = apply(state, campo, { v: 1, op: "results" }, at(60_000));
    const results = body<{ results: { key: string; status: string; staleBecause: string | null }[] }>(out.response).results;
    expect(results[0]).toMatchObject({ key: "bun test", status: "pass", staleBecause: null });
  });

  test("touching a path it depended on makes it stale, with the reason", () => {
    apply(state, fin, {
      v: 1, op: "result", key: "bun test", status: "pass", paths: ["src/**"],
    }, at(0));
    apply(state, campo, { v: 1, op: "claim", paths: ["src/state/machine.ts"], auto: true }, at(60_000));

    const out = apply(state, campo, { v: 1, op: "results" }, at(120_000));
    const results = body<{ results: { staleBecause: string | null }[] }>(out.response).results;
    expect(results[0]!.staleBecause).toContain("TESTE-CAMPO touched src/state/machine.ts");
  });

  test("touching something it does not depend on leaves it fresh", () => {
    apply(state, fin, { v: 1, op: "result", key: "lint", status: "pass", paths: ["src/**"] }, at(0));
    apply(state, campo, { v: 1, op: "claim", paths: ["docs/README.md"], auto: true }, at(60_000));
    const out = apply(state, campo, { v: 1, op: "results", fresh: true }, at(120_000));
    expect(body<{ results: unknown[] }>(out.response).results).toHaveLength(1);
  });

  test("a result with no declared paths is invalidated by any edit at all", () => {
    // The safe default: better to re-run than to trust a stale green.
    apply(state, fin, { v: 1, op: "result", key: "e2e", status: "pass" }, at(0));
    apply(state, campo, { v: 1, op: "claim", paths: ["anything.md"], auto: true }, at(60_000));
    const out = apply(state, campo, { v: 1, op: "results", fresh: true }, at(120_000));
    expect(body<{ results: unknown[] }>(out.response).results).toHaveLength(0);
  });
});

describe("decisions bind until reversed", () => {
  test("a decision is announced at high priority, a note is not", () => {
    const decision = apply(state, fin, {
      v: 1, op: "note", kind: "decision", title: "no Pydantic v2 yet",
      body: "the mobile serializers depend on v1 coercion",
    }, at(100));
    expect(decision.broadcast[0]!.priority).toBe("high");
    expect(decision.broadcast[0]!.text).toContain("recorded a decision");

    const plain = apply(state, fin, { v: 1, op: "note", title: "just knowledge" }, at(200));
    expect(plain.broadcast).toHaveLength(0);
  });

  test("reversing keeps it in the record and stops it binding", () => {
    const made = apply(state, fin, { v: 1, op: "note", kind: "decision", title: "no Pydantic v2 yet" }, at(100));
    const id = body<{ id: string }>(made.response).id;

    const undone = apply(state, campo, { v: 1, op: "reverse", id, reason: "v2 shipped the compat layer" }, at(200));
    expect(undone.response.ok).toBe(true);
    expect(undone.broadcast[0]!.text).toContain("no longer binds");

    const active = apply(state, campo, { v: 1, op: "notes", kind: "decision", active: true }, at(300));
    expect(body<{ notes: unknown[] }>(active.response).notes).toHaveLength(0);

    // Still on the record, which is the difference between reversing and deleting.
    const all = apply(state, campo, { v: 1, op: "notes", kind: "decision" }, at(310));
    expect(body<{ notes: unknown[] }>(all.response).notes).toHaveLength(1);
  });

  test("a reversed decision stops being delivered on touch", () => {
    const made = apply(state, fin, {
      v: 1, op: "note", kind: "decision", title: "leave this file alone", paths: ["src/legacy.ts"],
    }, at(100));
    apply(state, fin, { v: 1, op: "reverse", id: body<{ id: string }>(made.response).id }, at(200));

    const out = apply(state, campo, { v: 1, op: "claim", paths: ["src/legacy.ts"] }, at(300));
    expect(body<{ notes: unknown[] }>(out.response).notes).toHaveLength(0);
  });
});
