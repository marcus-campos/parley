import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../../src/protocol/types";
import { readEndpoint } from "../../src/daemon/endpoint";
import { ParleyDaemon } from "../../src/daemon/server";
import { RawClient, dirs, daemons, startDaemon, tempRepo } from "./harness";

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a real daemon over a real socket", () => {
  test("publishes a readable endpoint and answers status", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));
    expect(endpoint.protocol).toBe(1);
    expect(readEndpoint(dir)?.address).toBe(endpoint.address);

    const client = await RawClient.connect(endpoint.address);
    const status = await client.send({ op: "status" });
    expect(status).toMatchObject({ ok: true, mode: "advisory", participants: 0 });
    client.close();
  });

  test("THE test that matters: two clients claiming the same path at once", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));

    const a = await RawClient.connect(endpoint.address);
    const b = await RawClient.connect(endpoint.address);
    await a.send({ op: "join", name: "FINANCEIRO", cwd: "/wt/a" });
    await b.send({ op: "join", name: "TESTE-CAMPO", cwd: "/wt/b" });

    const [ra, rb] = await Promise.all([
      a.send({ op: "claim", paths: ["src/backend/finance/services.py"] }),
      b.send({ op: "claim", paths: ["src/backend/finance/**"] }),
    ]);

    const winners = [ra, rb].filter((r) => r.ok);
    const losers = [ra, rb].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ error: { code: "CONFLICT" } });

    a.close();
    b.close();
  });

  test("a message reaches the other session as an unsolicited push", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));

    const a = await RawClient.connect(endpoint.address);
    const b = await RawClient.connect(endpoint.address);
    await a.send({ op: "join", name: "FIN", cwd: "/wt/a" });
    await b.send({ op: "join", name: "CAMPO", cwd: "/wt/b" });

    await a.send({ op: "say", text: "confiram as heads do alembic" });
    await new Promise((r) => setTimeout(r, 80));

    const text = JSON.stringify(b.pushes);
    expect(text).toContain("confiram as heads do alembic");
    expect(JSON.stringify(a.pushes)).not.toContain("confiram as heads do alembic");

    a.close();
    b.close();
  });

  test("kill -9 costs nothing: the journal rebuilds territory and history", async () => {
    const dir = tempRepo();
    const journal = join(dir, "journal.ndjson");

    const first = await startDaemon(dir, journal);
    const a = await RawClient.connect(first.endpoint.address);
    await a.send({ op: "join", name: "FINANCEIRO", cwd: "/wt/a" });
    await a.send({ op: "claim", paths: ["src/backend/finance/**"], intent: "closing refactor" });
    await a.send({ op: "note", title: "CI runs tsc -b here", body: "solution-style tsconfig" });
    a.close();
    await first.daemon.close();

    // Same journal, brand new process-equivalent.
    const second = await startDaemon(dir, journal);
    const state = second.daemon.snapshot();
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0]!.pattern).toBe("src/backend/finance/**");
    expect(state.claims[0]!.intent).toBe("closing refactor");
    expect(state.notes).toHaveLength(1);
    // Nothing survives a restart connected: presence has to be re-proven.
    expect(Object.values(state.participants).every((p) => !p.connected)).toBe(true);
  });

  test("a torn last line does not stop the daemon from booting", async () => {
    const dir = tempRepo();
    const journal = join(dir, "journal.ndjson");
    const first = await startDaemon(dir, journal);
    const a = await RawClient.connect(first.endpoint.address);
    await a.send({ op: "join", name: "FIN", cwd: "/wt/a" });
    await a.send({ op: "claim", paths: ["src/app.ts"] });
    a.close();
    await first.daemon.close();

    await Bun.write(journal, `${await Bun.file(journal).text()}{"at":"2026-08-18T14:00:00.0`);

    const second = await startDaemon(dir, journal);
    expect(second.daemon.snapshot().claims).toHaveLength(1);
  });

  test("an unknown op is refused without dropping the connection", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));
    const a = await RawClient.connect(endpoint.address);
    expect(await a.send({ op: "teleport" })).toMatchObject({ error: { code: "UNKNOWN_OP" } });
    expect(await a.send({ op: "status" })).toMatchObject({ ok: true });
    a.close();
  });
});

describe("only one daemon may serve a repository", () => {
  test("a second daemon refuses instead of stealing the live socket", async () => {
    const dir = tempRepo();
    const first = await startDaemon(dir, join(dir, "journal.ndjson"));

    const intruder = new ParleyDaemon({
      gitCommonDir: dir,
      address: { kind: "unix", address: first.endpoint.address },
      journalPath: join(dir, "journal.ndjson"),
      tickIntervalMs: 50,
    });

    let refused = false;
    try {
      await intruder.listen();
    } catch (e) {
      refused = (e as Error).name === "DaemonAlreadyRunning";
    }
    expect(refused).toBe(true);

    // The original is untouched and still answering.
    const client = await RawClient.connect(first.endpoint.address);
    expect(await client.send({ op: "status" })).toMatchObject({ ok: true });
    client.close();
    expect(readEndpoint(dir)?.pid).toBe(first.endpoint.pid);
  });

  test("a leftover socket from a dead daemon is cleared, not respected", async () => {
    const dir = tempRepo();
    const first = await startDaemon(dir, join(dir, "journal.ndjson"));
    const address = first.endpoint.address;
    await first.daemon.close();

    // Recreate the stale file the way a kill -9 would leave it.
    await Bun.write(address, "");
    const second = await startDaemon(dir, join(dir, "journal.ndjson"));
    expect(second.endpoint.address).toBe(address);

    const client = await RawClient.connect(address);
    expect(await client.send({ op: "status" })).toMatchObject({ ok: true });
    client.close();
  });

  test("editing spawn.json raises the daemon's birth ceiling without a restart", async () => {
    const dir = tempRepo();
    // maxFronts: 1 from boot — the one participant that is about to join
    // already fills that ceiling, so a stale, nobody-idle pool must stay
    // silent no matter how many ticks run.
    mkdirSync(join(dir, "parley"), { recursive: true });
    writeFileSync(join(dir, "parley", "spawn.json"), JSON.stringify({ mode: "panel", maxFronts: 1 }));

    // The clock is injected so the pool can age past ORPHAN_POOL_MS (10
    // minutes) without the test actually waiting ten minutes — only the real
    // setInterval that drives ticks, and the watcher's fs event, need real time.
    let simulatedMs = Date.UTC(2026, 7, 20, 12, 0, 0);
    const daemon = new ParleyDaemon({
      gitCommonDir: dir,
      address: { kind: "unix", address: join(dir, "p.sock") },
      journalPath: join(dir, "journal.ndjson"),
      tickIntervalMs: 20,
      now: () => simulatedMs,
    });
    daemons.push(daemon);
    const endpoint = await daemon.listen();

    const a = await RawClient.connect(endpoint.address);
    await a.send({ op: "join", name: "CORE", cwd: "/wt/a" });
    await a.send({ op: "shape", shape: "pool" });
    // CORE holds a claim so it counts as busy, not idle — otherwise tick's
    // rule 6 recycles CORE itself instead of ever considering a birth, and
    // this test would not be exercising the ceiling at all.
    await a.send({ op: "claim", paths: ["src/**"] });
    await a.send({ op: "work", title: "32 triviais", paths: ["a.ts"] });

    simulatedMs += DEFAULTS.ORPHAN_POOL_MS + 1;
    await new Promise((r) => setTimeout(r, 150)); // several real tick intervals
    expect(JSON.stringify(a.pushes)).not.toContain("providing a front");

    // Raise the ceiling on disk while the daemon is already running and
    // already past the cooldown-free first attempt — this is the one write
    // the watcher, not the boot-time read, is responsible for picking up.
    writeFileSync(join(dir, "parley", "spawn.json"), JSON.stringify({ mode: "panel", maxFronts: 6 }));

    const deadline = Date.now() + 3_000;
    let sawBirth = false;
    while (Date.now() < deadline && !sawBirth) {
      await new Promise((r) => setTimeout(r, 30));
      sawBirth = JSON.stringify(a.pushes).includes("providing a front");
    }
    expect(sawBirth).toBe(true);

    a.close();
  });

  test("summon honors the repository's configured ceiling, not a hardcoded default", async () => {
    async function summonAtCeiling(maxFronts: number) {
      const dir = tempRepo();
      mkdirSync(join(dir, "parley"), { recursive: true });
      writeFileSync(join(dir, "parley", "spawn.json"), JSON.stringify({ mode: "panel", maxFronts }));
      const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));

      const a = await RawClient.connect(endpoint.address);
      await a.send({ op: "join", name: "CORE", cwd: "/wt/a" });
      const b = await RawClient.connect(endpoint.address);
      await b.send({ op: "join", name: "SECOND", cwd: "/wt/b" });

      // Two live agent fronts already joined; summon is asking for a third.
      const result = await a.send({ op: "summon", reason: "need a hand" });
      a.close();
      b.close();
      return result;
    }

    // The same two-participant setup, only the configured ceiling differs —
    // proves the daemon reads `spawn.json`'s `maxFronts` for `summon`, not a
    // hardcoded 6. A refuse-everything implementation would fail the second
    // half; a grant-everything implementation would fail the first.
    const refused = await summonAtCeiling(2);
    expect(refused).toMatchObject({ error: { code: "NO_CAPACITY" } });

    const granted = await summonAtCeiling(6);
    expect(granted).toMatchObject({ ok: true, summoned: true });
  });
});
