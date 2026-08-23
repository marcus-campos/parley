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

  test("release with no paths releases everything, whatever `all` says", () => {
    // `all` is not consulted when `paths` is empty — territory.ts reads
    // `frame.all === true || paths.length === 0`. Written down because a fix
    // report recorded the opposite as a measurement: it claimed
    // `parley release --all src/a.ts` was the one behaviour change the boolean
    // flag conversion cost, on the reasoning that the greedy parser swallows
    // the path as `--all`'s value, so `all` used to arrive false and now
    // arrives true. Both arrive with `paths: []`, and both release everything.
    // A wrong diagnosis recorded as fact is how the next person builds around
    // a phantom, so the behaviour gets a test instead of a paragraph.
    for (const all of [false, true, undefined]) {
      const fresh = initialState();
      const me = (apply(fresh, null, { v: 1, op: "join", name: "SOLO", mission: "m" }, at(0)).response as unknown as { id: string }).id;
      apply(fresh, me, { v: 1, op: "claim", paths: ["src/a.ts", "src/b.ts", "src/c.ts"] }, at(100));
      const out = apply(fresh, me, { v: 1, op: "release", paths: [], all }, at(200));
      expect(out.response.ok).toBe(true);
      expect(fresh.claims).toEqual([]);
    }
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

describe("listing pending requests", () => {
  test("an observer can see a request that was only pushed to its owner", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/x.ts"] }, at(0));
    apply(state, campo, { v: 1, op: "ask", path: "src/x.ts", reason: "one column", ttl_s: 300 }, at(0));

    const r = apply(state, fin, { v: 1, op: "requests" }, at(60_000));
    const list = (r.response as unknown as { requests: Record<string, unknown>[] }).requests;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      path: "src/x.ts", requester: "TESTE-CAMPO", owner: "FINANCEIRO",
      reason: "one column", state: "pending", seconds_left: 240,
    });
  });

  test("settled requests are hidden unless asked for", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/x.ts"] }, at(0));
    const asked = apply(state, campo, { v: 1, op: "ask", path: "src/x.ts", reason: "r" }, at(0));
    apply(state, fin, { v: 1, op: "grant", request: (asked.response as unknown as { request: string }).request }, at(100));

    expect((apply(state, fin, { v: 1, op: "requests" }, at(200)).response as unknown as { requests: unknown[] }).requests).toHaveLength(0);
    expect((apply(state, fin, { v: 1, op: "requests", all: true }, at(200)).response as unknown as { requests: unknown[] }).requests).toHaveLength(1);
  });
});

describe("a human has a voice, not a vote", () => {
  test("a human cannot grant, however much they would like to", () => {
    const human = joined(state, "Marcus", 0, { kind: "human" });
    apply(state, fin, { v: 1, op: "claim", paths: ["src/x.ts"] }, at(0));
    const asked = apply(state, campo, { v: 1, op: "ask", path: "src/x.ts", reason: "r" }, at(100));
    const id = (asked.response as unknown as { request: string }).request;

    const out = apply(state, human, { v: 1, op: "grant", request: id }, at(200));
    expect(out.response).toMatchObject({ error: { code: "OBSERVER_ONLY" } });
    expect(Object.values(state.requests)[0]!.state).toBe("pending");
  });

  test("a human cannot deny either", () => {
    const human = joined(state, "Marcus", 0, { kind: "human" });
    apply(state, fin, { v: 1, op: "claim", paths: ["src/x.ts"] }, at(0));
    const asked = apply(state, campo, { v: 1, op: "ask", path: "src/x.ts", reason: "r" }, at(100));
    const id = (asked.response as unknown as { request: string }).request;
    expect(apply(state, human, { v: 1, op: "deny", request: id }, at(200)).response)
      .toMatchObject({ error: { code: "OBSERVER_ONLY" } });
  });

  test("but a human speaks, and it lands at high priority on every front", () => {
    const human = joined(state, "Marcus", 0, { kind: "human" });
    const said = apply(state, human, { v: 1, op: "say", text: "não dropem coluna nenhuma hoje" }, at(100));
    expect(said.response.ok).toBe(true);

    const inbox = apply(state, fin, { v: 1, op: "drain" }, at(200)).response as unknown as {
      events: { text: string; priority: string; from: { kind: string } }[];
    };
    const msg = inbox.events.find((e) => e.text.startsWith("não dropem"))!;
    expect(msg.priority).toBe("high");
    expect(msg.from.kind).toBe("human");
  });

  test("an agent still cannot settle a request that is not theirs", () => {
    const other = joined(state, "MOBILE", 0);
    apply(state, fin, { v: 1, op: "claim", paths: ["src/x.ts"] }, at(0));
    const asked = apply(state, campo, { v: 1, op: "ask", path: "src/x.ts", reason: "r" }, at(100));
    const id = (asked.response as unknown as { request: string }).request;
    expect(apply(state, other, { v: 1, op: "grant", request: id }, at(200)).response)
      .toMatchObject({ error: { code: "NOT_OWNER" } });
  });
});

describe("releasing a lock is the answer", () => {
  test("letting the path go hands it to whoever was waiting", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/state/**"] }, at(0));
    apply(state, campo, { v: 1, op: "ask", path: "src/state/machine.ts", reason: "one column" }, at(100));

    const out = apply(state, fin, { v: 1, op: "release", paths: ["src/state/**"] }, at(200));
    expect(out.response.ok).toBe(true);

    const request = Object.values(state.requests)[0]!;
    expect(request.state).toBe("granted");
    expect(state.claims.some((c) => c.pattern === "src/state/machine.ts" && c.ownerId === campo)).toBe(true);
    expect(out.broadcast.some((e) => e.text.includes("was waiting for it and now has it"))).toBe(true);
  });

  test("leaving does the same, so a finished session unblocks the queue", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/state/**"] }, at(0));
    apply(state, campo, { v: 1, op: "ask", path: "src/state/machine.ts", reason: "r" }, at(100));

    apply(state, fin, { v: 1, op: "leave" }, at(200));
    expect(Object.values(state.requests)[0]!.state).toBe("granted");
    expect(state.claims.some((c) => c.ownerId === campo)).toBe(true);
  });

  test("releasing an unrelated path settles nothing", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/state/**", "docs/**"] }, at(0));
    apply(state, campo, { v: 1, op: "ask", path: "src/state/machine.ts", reason: "r" }, at(100));

    apply(state, fin, { v: 1, op: "release", paths: ["docs/**"] }, at(200));
    expect(Object.values(state.requests)[0]!.state).toBe("pending");
  });

  test("a request for a free path never becomes a pending request at all", () => {
    // This is the rule that keeps the pending list meaningful: asking is only a
    // thing when somebody actually holds the path.
    const out = apply(state, campo, { v: 1, op: "ask", path: "src/untouched.ts", reason: "r" }, at(100));
    expect(out.response).toMatchObject({ ok: true, state: "granted", reason: "unclaimed" });
    expect(Object.keys(state.requests)).toHaveLength(0);
  });

  test("a settled request is not re-settled by a later release", () => {
    apply(state, fin, { v: 1, op: "claim", paths: ["src/state/**"] }, at(0));
    const asked = apply(state, campo, { v: 1, op: "ask", path: "src/state/machine.ts", reason: "r" }, at(100));
    const id = (asked.response as unknown as { request: string }).request;
    apply(state, fin, { v: 1, op: "deny", request: id, reason: "migration running" }, at(150));

    apply(state, fin, { v: 1, op: "release", paths: ["src/state/**"] }, at(200));
    expect(state.requests[id]!.state).toBe("denied");
    expect(state.claims.some((c) => c.ownerId === campo)).toBe(false);
  });
});

describe("a front that came back keeps what it was holding", () => {
  const S = "sess-x";

  test("re-attaching inside the grace period un-orphans the claims", () => {
    const first = apply(state, null, { v: 1, op: "join", name: "DEVELOP", cwd: "/repo", session: S }, at(0));
    const id = (first.response as unknown as { id: string }).id;
    apply(state, id, { v: 1, op: "claim", paths: ["src/backend/**"] }, at(0));

    // Long enough for the lease to lapse: the agent was thinking, or waiting
    // on the person, so no hook fired.
    tick(state, at(DEFAULTS.LEASE_TTL_MS + 1000));
    expect(state.claims[0]!.orphanedAtMs).not.toBeNull();

    apply(state, null, { v: 1, op: "join", name: "DEVELOP", cwd: "/repo", session: S }, at(DEFAULTS.LEASE_TTL_MS + 2000));
    expect(state.claims[0]!.orphanedAtMs).toBeNull();
    expect(state.claims[0]!.ownerId).toBe(id);

    // And it is not swept away by the next tick either.
    tick(state, at(DEFAULTS.LEASE_TTL_MS + DEFAULTS.ORPHAN_GRACE_MS + 3000));
    expect(state.claims).toHaveLength(1);
  });

  test("a front that never comes back still loses it", () => {
    const first = apply(state, null, { v: 1, op: "join", name: "GHOST", cwd: "/repo", session: "sess-ghost" }, at(0));
    const id = (first.response as unknown as { id: string }).id;
    apply(state, id, { v: 1, op: "claim", paths: ["src/ghost/**"] }, at(0));

    tick(state, at(DEFAULTS.LEASE_TTL_MS + 1000));
    tick(state, at(DEFAULTS.LEASE_TTL_MS + DEFAULTS.ORPHAN_GRACE_MS + 2000));
    expect(state.claims.some((c) => c.pattern === "src/ghost/**")).toBe(false);
  });
});
