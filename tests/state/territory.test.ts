import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../src/protocol/types";
import { apply, initialState, makeCtx, tick } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 18, 14, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);
const MIN = 60_000;

function joined(state: State, name: string, ms = 0, extra: Record<string, unknown> = {}): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: `${name} mission`, ...extra }, at(ms));
  return (out.response as unknown as { id: string }).id;
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

describe("territory", () => {
  test("the race that matters: two fronts claiming the same path", () => {
    const first = apply(state, fin, { v: 1, op: "claim", paths: ["src/backend/finance/**"] }, at(100));
    const second = apply(state, campo, { v: 1, op: "claim", paths: ["src/backend/finance/services.py"] }, at(100));

    expect(first.response.ok).toBe(true);
    expect(second.response.ok).toBe(false);
    expect(second.response).toMatchObject({ error: { code: "CONFLICT" } });
    expect(state.claims).toHaveLength(1);
  });

  test("the conflict answer already carries owner, mission and since", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/backend/finance/**"], intent: "refatorar fechamento" }, at(100));
    const out = apply(state, campo, { v: 1, op: "claim", paths: ["src/backend/finance/services.py"] }, at(200));
    const conflicts = (out.response as unknown as { conflicts: { owner: { name: string; mission: string }; since: string }[] }).conflicts;
    expect(conflicts[0]!.owner.name).toBe("FINANCEIRO");
    expect(conflicts[0]!.owner.mission).toBe("FINANCEIRO mission");
    expect(conflicts[0]!.since).toBeTruthy();
  });

  test("a batch is all-or-nothing: no partially granted claim can exist", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/b.ts"] }, at(100));
    const out = apply(state, campo, { v: 1, op: "claim", paths: ["src/a.ts", "src/b.ts"] }, at(200));
    expect(out.response.ok).toBe(false);
    expect(state.claims.some((c) => c.pattern === "src/a.ts")).toBe(false);
  });

  test("windows and posix spellings are the same territory", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src\\app.ts"] }, at(100));
    const out = apply(state, campo, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(200));
    expect(out.response).toMatchObject({ error: { code: "CONFLICT" } });
  });

  test("release gives territory back", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(100));
    apply(state, fin, { v: 1, op: "release", paths: ["src/app.ts"] }, at(200));
    expect(apply(state, campo, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(300)).response.ok).toBe(true);
  });

  test("releasing someone else's claim is refused", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(100));
    expect(apply(state, campo, { v: 1, op: "release", paths: ["src/app.ts"] }, at(200)).response)
      .toMatchObject({ error: { code: "NOT_OWNER" } });
  });

  test("leaving returns everything", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/**"] }, at(100));
    apply(state, fin, { v: 1, op: "leave" }, at(200));
    expect(state.claims).toHaveLength(0);
  });

  test("mode off disables territory without breaking the call", () => {
    state.mode = "off";
    const out = apply(state, fin, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(100));
    expect(out.response).toMatchObject({ ok: true, mode: "off", ignored: true });
    expect(state.claims).toHaveLength(0);
  });
});

describe("auto-claim", () => {
  // These fronts hold a live connection, so the 5-minute presence lease never
  // fires and the 15-minute auto-claim TTL is what is actually under test.
  let live: string;
  beforeEach(() => {
    live = joined(state, "LIVE", 0, { connected: true });
  });

  test("expires after 15 idle minutes so a sweep does not own the repo", () => {
    apply(state, live, { v: 1, op: "claim", paths: ["src/app.ts"], auto: true }, at(0));
    tick(state, at(DEFAULTS.AUTO_CLAIM_TTL_MS - 1000));
    expect(state.claims).toHaveLength(1);
    tick(state, at(DEFAULTS.AUTO_CLAIM_TTL_MS + 1000));
    expect(state.claims).toHaveLength(0);
  });

  test("a fresh edit renews it", () => {
    apply(state, live, { v: 1, op: "claim", paths: ["src/app.ts"], auto: true }, at(0));
    apply(state, live, { v: 1, op: "claim", paths: ["src/app.ts"], auto: true }, at(14 * MIN));
    tick(state, at(14 * MIN + DEFAULTS.AUTO_CLAIM_TTL_MS - 1000));
    expect(state.claims).toHaveLength(1);
  });

  test("an explicit claim never expires by inactivity", () => {
    apply(state, live, { v: 1, op: "claim", paths: ["src/app.ts"] }, at(0));
    tick(state, at(10 * DEFAULTS.AUTO_CLAIM_TTL_MS));
    expect(state.claims).toHaveLength(1);
  });

  test("an explicit claim promotes an existing auto-claim", () => {
    apply(state, live, { v: 1, op: "claim", paths: ["src/app.ts"], auto: true }, at(0));
    apply(state, live, { v: 1, op: "claim", paths: ["src/app.ts"], intent: "refactor" }, at(1000));
    tick(state, at(10 * DEFAULTS.AUTO_CLAIM_TTL_MS));
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0]!.auto).toBe(false);
  });
});

describe("dead fronts", () => {
  test("a front that stops renewing its lease is announced, then released", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["a.ts", "b.ts", "c.ts"] }, at(0));

    const dropped = tick(state, at(DEFAULTS.LEASE_TTL_MS + 1000));
    const notice = dropped.broadcast.find((e) => e.text.includes("FINANCEIRO"))!;
    expect(notice.text).toContain("dropped holding 3 claim(s)");
    expect(notice.priority).toBe("high");
    expect(state.claims).toHaveLength(3); // still held during the grace period

    tick(state, at(DEFAULTS.LEASE_TTL_MS + DEFAULTS.ORPHAN_GRACE_MS + 2000));
    expect(state.claims).toHaveLength(0);
  });

  test("a live connection is proof of presence on its own", () => {
    const mcp = joined(state, "MCP-SESSION", 0, { connected: true });
    apply(state, mcp, { v: 1, op: "claim", paths: ["x.ts"] }, at(0));
    tick(state, at(10 * DEFAULTS.LEASE_TTL_MS));
    expect(state.participants[mcp]!.gone).toBe(false);
    expect(state.claims).toHaveLength(1);
  });
});

describe("permission", () => {
  test("asking an unclaimed path is granted immediately", () => {
    const out = apply(state, campo, { v: 1, op: "ask", path: "src/free.ts", reason: "x" }, at(100));
    expect(out.response).toMatchObject({ ok: true, state: "granted", reason: "unclaimed" });
  });

  test("the owner is pushed the request and can grant it", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/backend/finance/**"] }, at(0));
    const asked = apply(state, campo, { v: 1, op: "ask", path: "src/backend/finance/services.py", reason: "add 1 column" }, at(100));
    const reqId = (asked.response as unknown as { request: string }).request;
    expect(asked.broadcast[0]!.to).toBe("FINANCEIRO");
    expect(asked.broadcast[0]!.priority).toBe("high");

    const granted = apply(state, fin, { v: 1, op: "grant", request: reqId, scope: "once" }, at(200));
    expect(granted.response).toMatchObject({ ok: true, state: "granted", scope: "once" });
    expect(state.claims.some((c) => c.pattern === "src/backend/finance/services.py" && c.ownerId === campo)).toBe(true);
  });

  test("only the owner may answer", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/x.ts"] }, at(0));
    const asked = apply(state, campo, { v: 1, op: "ask", path: "src/x.ts", reason: "r" }, at(100));
    const reqId = (asked.response as unknown as { request: string }).request;
    expect(apply(state, campo, { v: 1, op: "grant", request: reqId }, at(200)).response)
      .toMatchObject({ error: { code: "NOT_OWNER" } });
  });

  test("deny carries the reason to the requester", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/x.ts"] }, at(0));
    const asked = apply(state, campo, { v: 1, op: "ask", path: "src/x.ts", reason: "r" }, at(100));
    const reqId = (asked.response as unknown as { request: string }).request;
    const denied = apply(state, fin, { v: 1, op: "deny", request: reqId, reason: "migration em curso" }, at(200));
    expect(denied.response).toMatchObject({ ok: true, state: "denied" });
    expect(denied.broadcast[0]!.text).toContain("migration em curso");
    expect(state.claims.some((c) => c.ownerId === campo)).toBe(false);
  });

  test("an unanswered request is granted AND names who stayed silent", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/backend/finance/**"] }, at(0));
    apply(state, campo, { v: 1, op: "ask", path: "src/backend/finance/services.py", reason: "r" }, at(0));

    const before = tick(state, at(DEFAULTS.PERMISSION_TTL_MS - 1000));
    expect(before.broadcast).toHaveLength(0);

    const after = tick(state, at(DEFAULTS.PERMISSION_TTL_MS + 1000));
    const notice = after.broadcast.find((e) => e.text.includes("by timeout"))!;
    expect(notice.text).toContain("TESTE-CAMPO took");
    expect(notice.text).toContain("FINANCEIRO did not answer");
    expect(notice.priority).toBe("high");
    expect(Object.values(state.requests)[0]!.state).toBe("granted_by_timeout");
  });

  test("a settled request cannot be answered twice", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/x.ts"] }, at(0));
    const asked = apply(state, campo, { v: 1, op: "ask", path: "src/x.ts", reason: "r" }, at(0));
    const reqId = (asked.response as unknown as { request: string }).request;
    apply(state, fin, { v: 1, op: "grant", request: reqId }, at(100));
    expect(apply(state, fin, { v: 1, op: "deny", request: reqId }, at(200)).response)
      .toMatchObject({ error: { code: "NOT_OWNER" } });
  });
});

describe("mode", () => {
  test("mode is repository-wide and the change is announced", () => {
    const out = apply(state, fin, { v: 1, op: "mode", mode: "enforced" }, at(0));
    expect(out.response).toMatchObject({ ok: true, mode: "enforced", previous: "advisory" });
    expect(out.broadcast[0]!.text).toContain("applies to every front");
  });
});

describe("lease and auto-claim interact as designed", () => {
  test("with the defaults the 5-minute lease fires before the 15-minute auto-claim TTL", () => {
    // Documented consequence: for a CLI-only front, death by lease is what
    // frees territory. The auto-claim TTL exists for fronts kept alive by a
    // live connection or by constant hook renewal.
    expect(DEFAULTS.LEASE_TTL_MS).toBeLessThan(DEFAULTS.AUTO_CLAIM_TTL_MS);
    apply(state, fin, { v: 1, op: "claim", paths: ["src/app.ts"], auto: true }, at(0));
    tick(state, at(DEFAULTS.LEASE_TTL_MS + 1000));
    expect(state.claims[0]!.orphanedAtMs).not.toBeNull();
  });
});
