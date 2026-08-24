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
    writeFileSync(join(dir, "spawn.json"), JSON.stringify({ mode: "panel", maxFronts: 1 }));

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
    writeFileSync(join(dir, "spawn.json"), JSON.stringify({ mode: "panel", maxFronts: 6 }));

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
      writeFileSync(join(dir, "spawn.json"), JSON.stringify({ mode: "panel", maxFronts }));
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

  test("replay reproduces a summon denied live, not what a hardcoded ceiling would grant", async () => {
    // `gitCommonDir` (and so `spawn.json`) and the journal both stay fixed
    // across the restart below — only the socket address changes, the same
    // way a real restart on a real repository keeps its config and its
    // journal but cannot reuse a socket a dead process still holds.
    const dir = tempRepo();
    writeFileSync(join(dir, "spawn.json"), JSON.stringify({ mode: "panel", maxFronts: 2 }));
    const journalPath = join(dir, "journal.ndjson");

    const first = new ParleyDaemon({
      gitCommonDir: dir,
      address: { kind: "unix", address: join(dir, "p1.sock") },
      journalPath,
      tickIntervalMs: 50,
    });
    daemons.push(first);
    const firstEndpoint = await first.listen();

    const a = await RawClient.connect(firstEndpoint.address);
    await a.send({ op: "join", name: "CORE", cwd: "/wt/a" });
    const b = await RawClient.connect(firstEndpoint.address);
    await b.send({ op: "join", name: "SECOND", cwd: "/wt/b" });

    // Two live agent fronts already fill the configured ceiling of 2 — denied,
    // live, and (per "journal BEFORE responding") still written to the journal.
    const denied = await a.send({ op: "summon", reason: "need a hand" });
    expect(denied).toMatchObject({ error: { code: "NO_CAPACITY" } });

    const live = first.snapshot();
    expect(live.lastBirthMs).toBeNull(); // sanity: a denial never stamps this

    a.close();
    b.close();
    await first.close();

    // Restart. Same repository, same journal, same `spawn.json` — a fresh
    // socket only, exactly like a real process restart on a real machine.
    const second = new ParleyDaemon({
      gitCommonDir: dir,
      address: { kind: "unix", address: join(dir, "p2.sock") },
      journalPath,
      tickIntervalMs: 50,
    });
    daemons.push(second);
    await second.listen();

    // The property to pin: replay reproduces what happened, not what would
    // have happened under a different (hardcoded) ceiling. If restore()'s
    // apply() ever again falls back to the default of 6, this replay sees two
    // agents (2 < 6) and silently *grants* the summon that was denied live —
    // stamping lastBirthMs and pushing an event that never existed in the
    // original session.
    const replayed = second.snapshot();
    expect(replayed.lastBirthMs).toBeNull();
    expect(replayed.events.length).toBe(live.events.length);
    expect(replayed.seq).toBe(live.seq);
  });

  test("a journal line whose frame is literally null is discarded, not replayed", async () => {
    // `typeof null === "object"`, so the replay guard — `typeof parsed.frame
    // === "object"` — admitted it, and every reader of an entry dereferences
    // `frame`. The codec refuses `null` long before anything reaches the
    // journal, which is exactly why the guard on the *replay* side is the one
    // that has to hold: it is what stands if the codec ever changes, and it is
    // read at boot, in a constructor, where a throw is a daemon that will not
    // start on a repository whose journal is already on disk.
    const dir = tempRepo();
    const journalPath = join(dir, "journal.ndjson");
    writeFileSync(journalPath, [
      JSON.stringify({ at: "2026-08-20T12:00:00.000Z", actorId: null, frame: { v: 1, op: "join", name: "CORE", cwd: "/wt/a" } }),
      JSON.stringify({ at: "2026-08-20T12:00:01.000Z", actorId: null, frame: null }),
      "",
    ].join("\n"));

    const { daemon, endpoint } = await startDaemon(dir, journalPath);
    const client = await RawClient.connect(endpoint.address);
    // It booted, it answers, and the good line either side of the bad one
    // replayed. Before the guard, `frame: null` was handed to `apply`, which
    // reads `frame.v` on its first line — a throw inside the constructor, so a
    // daemon that would not start at all.
    expect(await client.send({ op: "status" })).toMatchObject({ ok: true });
    expect(Object.values(daemon.snapshot().participants).map((p) => p.name)).toEqual(["CORE"]);
    client.close();
  });

  test("a birth window already spent is still spent after a restart", async () => {
    // `state.birthsAllowed` is journalled on purpose and documented as such:
    // it is a person's decision about their money, and a restart must not
    // revert it. `state.lastBirthMs` sits one field above it and was not,
    // because it is written inside `tick` and `tick` is never journalled — so
    // it came back `null` after every restart and a reboot ten seconds into a
    // five-minute cooldown bore again immediately. A restart loop therefore
    // spends real agent sessions in seconds, and the ceiling does not bound
    // it: a birth that never joins never becomes a live participant.
    const dir = tempRepo();
    const journalPath = join(dir, "journal.ndjson");
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    // A bare temp directory is not a worktree root, so `bearFrontFor` stops
    // before it spawns anything — the birth *decision* is exercised end to
    // end and no real agent session is ever started.
    const boot = async (sock: string) => {
      const daemon = new ParleyDaemon({
        gitCommonDir: dir,
        address: { kind: "unix", address: join(dir, sock) },
        journalPath,
        tickIntervalMs: 100_000, // ticks are driven by the frames the test sends
        now: () => clock,
      });
      daemons.push(daemon);
      return { daemon, endpoint: await daemon.listen() };
    };
    const providing = (daemon: ParleyDaemon) =>
      daemon.snapshot().events.filter((e) => e.text.includes("providing a front")).length;

    const first = await boot("p1.sock");
    const core = await RawClient.connect(first.endpoint.address);
    await core.send({ op: "join", name: "CORE", cwd: "/wt/a" });
    await core.send({ op: "shape", shape: "pool" });
    const mine = await core.send({ op: "work", title: "what CORE is on", paths: ["a.ts"] });
    await core.send({ op: "work", title: "what nobody took", paths: ["b.ts"] });
    const mineId = (mine as unknown as { items: { id: string }[] }).items[0]!.id;
    expect(await core.send({ op: "take", id: mineId })).toMatchObject({ ok: true });

    // The pool goes stale with the only front busy — nobody to ring, so parley
    // asks for capacity and spends the window.
    clock += DEFAULTS.ORPHAN_POOL_MS + 1;
    await core.send({ op: "who" });
    expect(first.daemon.snapshot().lastBirthMs).toBe(clock);
    expect(providing(first.daemon)).toBe(1);

    const bornAt = clock;
    core.close();
    await first.daemon.close();

    // Ten seconds into a five-minute window, the machine reboots.
    clock += 10_000;
    const second = await boot("p2.sock");
    expect(second.daemon.snapshot().lastBirthMs).toBe(bornAt);

    // A person joins — never idle capacity, so nothing here rings a doorbell
    // instead — and their first frame drives a tick.
    const person = await RawClient.connect(second.endpoint.address);
    await person.send({ op: "join", name: "MARCUS", kind: "human", cwd: "/wt/a" });
    expect(providing(second.daemon)).toBe(0);

    // The control, so this cannot pass by nothing ever being born again.
    clock = bornAt + DEFAULTS.BIRTH_COOLDOWN_MS + 1;
    await person.send({ op: "who" });
    expect(providing(second.daemon)).toBe(1);

    person.close();
  });
});
