import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readEndpoint } from "../../src/daemon/endpoint";
import { ParleyDaemon, thrownMessage } from "../../src/daemon/server";
import { RawClient, dirs, daemons, startDaemon, tempRepo } from "./harness";

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Boot a daemon with stderr captured, restoring it however the boot ends. */
async function bootCapturingStderr(dir: string, journal: string) {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const started = await startDaemon(dir, journal);
    return { daemon: started.daemon, stderr: written.join("") };
  } finally {
    (process.stderr as unknown as { write: unknown }).write = original;
  }
}

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

  /**
   * A line that will not parse is already handled one layer down, and
   * `Journal.replay` gives the reason: a bus that will not boot because of one
   * torn line is worse than a bus missing its final event. An entry that
   * parses and then THROWS inside the reducer is the same damage one layer up,
   * and strictly worse — the journal is written before the frame is applied,
   * so a poisoned frame reaches disk before anyone can know it is poison, and
   * every subsequent start replays it. Refusing to boot would make the
   * repository undispatchable permanently, since the restart is the thing that
   * replays it.
   *
   * The poison here is `frame: null`, which throws for a reason nothing is
   * going to fix out from under this test: `apply` reads `frame.v` on the way
   * in, and `typeof null === "object"` is the whole of what `replay` checks
   * before handing the entry over. The stderr assertion pins WHICH layer
   * absorbed it — if `replay` is ever tightened to reject a null frame, this
   * goes red rather than passing vacuously.
   */
  test("a journal entry that throws is skipped, and the bus still boots", async () => {
    const dir = tempRepo();
    const journal = join(dir, "journal.ndjson");
    const first = await startDaemon(dir, journal);
    const a = await RawClient.connect(first.endpoint.address);
    await a.send({ op: "join", name: "FIN", cwd: "/wt/a" });
    await a.send({ op: "claim", paths: ["src/app.ts"] });
    await a.send({ op: "note", title: "CI runs tsc -b here", body: "solution-style tsconfig" });
    a.close();
    await first.daemon.close();

    // Spliced BETWEEN good entries, not appended: the entries after it are
    // what an abort-on-first-failure would have thrown away.
    const good = (await Bun.file(journal).text()).trimEnd().split("\n");
    const poison = JSON.stringify({ at: "2026-08-20T12:00:00.000Z", actorId: null, frame: null });
    await Bun.write(journal, [good[0], poison, ...good.slice(1), ""].join("\n"));

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    let second: Awaited<ReturnType<typeof startDaemon>>;
    try {
      second = await startDaemon(dir, journal);
    } finally {
      (process.stderr as unknown as { write: unknown }).write = original;
    }

    const state = second.daemon.snapshot();
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0]!.pattern).toBe("src/app.ts");
    expect(state.notes).toHaveLength(1);
    expect(written.join("")).toContain("skipped 1 journal entry");
    // Named, not just counted: repairing this by hand means knowing which one.
    expect(written.join("")).toContain("2026-08-20T12:00:00.000Z");
  });

  /**
   * `skipped 1 journal entry(ies)` counts entries, and entries are not the
   * damage. Poison the JOIN and every later entry of that session is journaled
   * under a participant id nothing ever created: each replays, is refused
   * `NOT_JOINED`, and writes nothing. The state is not corrupt and the ruling
   * to skip is unchanged — but an operator repairing this by hand was told one
   * entry was lost when a whole session went with it.
   *
   * The assertion is the measured number, not the prose: a message that warned
   * about dependents in general would pass without ever counting one. The
   * unjoined frame at the end is what pins the `actorId !== null` half — it is
   * refused `NOT_JOINED` too, and it is nobody's dependent.
   */
  test("a skipped entry reports the session that went with it, not only itself", async () => {
    const dir = tempRepo();
    const journal = join(dir, "journal.ndjson");
    const first = await startDaemon(dir, journal);
    const a = await RawClient.connect(first.endpoint.address);
    await a.send({ op: "join", name: "FIN", cwd: "/wt/a" });
    await a.send({ op: "claim", paths: ["src/app.ts"] });
    await a.send({ op: "note", title: "CI runs tsc -b here", body: "solution-style tsconfig" });
    a.close();
    // Journaled under no participant at all, and refused for the same code.
    const b = await RawClient.connect(first.endpoint.address);
    expect(await b.send({ op: "claim", paths: ["src/other.ts"] }))
      .toMatchObject({ error: { code: "NOT_JOINED" } });
    b.close();
    await first.daemon.close();

    const good = (await Bun.file(journal).text()).trimEnd().split("\n");
    expect(JSON.parse(good[0]!).frame.op).toBe("join");
    const poison = JSON.stringify({ at: "2026-08-20T12:00:00.000Z", actorId: null, frame: null });
    await Bun.write(journal, [poison, ...good.slice(1), ""].join("\n"));

    const { daemon, stderr } = await bootCapturingStderr(dir, journal);

    const state = daemon.snapshot();
    expect(Object.values(state.participants)).toHaveLength(0);
    expect(state.claims).toHaveLength(0);
    expect(state.notes).toHaveLength(0);

    expect(stderr).toContain("skipped 1 journal entry");
    expect(stderr).toContain("2 journal entry(ies) named a participant that no surviving entry joined");
    // A deletion detector, and only that: it catches the correction being
    // removed, never the message being wrong. The measured half above is what
    // discriminates. It is here because the count alone is what misled, and a
    // dependent loss is not always a participant — a skipped `claim` costs a
    // later `release`, which nothing here can count.
    expect(stderr).toContain("counts entries, not the state they would have written");
  });

  /**
   * The same session-wide loss with NOTHING skipped: a torn line is discarded
   * one layer down, in `Journal.replay`, and if the torn line was the join then
   * every entry after it is orphaned while `failed` stays empty. This is not a
   * hypothetical shape — a partially written last line is exactly what `kill
   * -9` produces, and the join is as likely to be it as any other frame.
   */
  test("a discarded line costs its session too, and that is reported", async () => {
    const dir = tempRepo();
    const journal = join(dir, "journal.ndjson");
    const first = await startDaemon(dir, journal);
    const a = await RawClient.connect(first.endpoint.address);
    await a.send({ op: "join", name: "FIN", cwd: "/wt/a" });
    await a.send({ op: "claim", paths: ["src/app.ts"] });
    a.close();
    await first.daemon.close();

    const good = (await Bun.file(journal).text()).trimEnd().split("\n");
    await Bun.write(journal, [good[0]!.slice(0, 30), ...good.slice(1), ""].join("\n"));

    const { daemon, stderr } = await bootCapturingStderr(dir, journal);

    expect(daemon.snapshot().claims).toHaveLength(0);
    expect(stderr).toContain("discarded 1 unreadable journal line");
    expect(stderr).not.toContain("skipped");
    expect(stderr).toContain("1 journal entry(ies) named a participant that no surviving entry joined");
  });

  /**
   * The control, and the one that makes the guard load-bearing rather than
   * decorative: `NOT_JOINED` under a real participant id is reachable on a
   * PERFECTLY healthy journal. Two connections may share a session — the hook
   * opens a new one on every tool call — and so share an id; one of them
   * leaving marks that participant `gone`, and `actorOf` refuses a gone
   * participant, so the other's next frame is refused under a non-null actor.
   * Counting orphans unconditionally would print a lost-session warning on a
   * boot where nothing was lost at all.
   */
  test("a healthy journal reports no lost session, even when an entry was refused NOT_JOINED", async () => {
    const dir = tempRepo();
    const journal = join(dir, "journal.ndjson");
    const first = await startDaemon(dir, journal);
    const a = await RawClient.connect(first.endpoint.address);
    const joined = await a.send({ op: "join", name: "FIN", session: "s1", cwd: "/wt/a" });
    const b = await RawClient.connect(first.endpoint.address);
    const reattached = await b.send({ op: "join", name: "FIN", session: "s1", cwd: "/wt/a" });
    // The premise: both connections are bound to ONE participant.
    expect((reattached as unknown as { id: string }).id).toBe((joined as unknown as { id: string }).id);

    await a.send({ op: "leave" });
    expect(await b.send({ op: "claim", paths: ["src/app.ts"] }))
      .toMatchObject({ error: { code: "NOT_JOINED" } });
    a.close();
    b.close();
    await first.daemon.close();

    const { stderr } = await bootCapturingStderr(dir, journal);
    expect(stderr).not.toContain("skipped");
    expect(stderr).not.toContain("discarded");
    expect(stderr).not.toContain("named a participant");
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

/**
 * `restore` reports a skipped entry by reading what the reducer threw, and
 * `(e as Error).message` was a cast rather than a check — the identical shape
 * to the `frame.tasks as PlanTask[]` this branch removed, and to the
 * `entry.frame.op` read one expression earlier, which DID take the boot down
 * in the first draft of that fix.
 *
 * Tested directly rather than through a poisoned journal because a journal
 * cannot reach it: every `throw` under `src/` raises an `Error`, and so do the
 * engine's own. So this pins the shape against deletion and can never go red
 * for a live bug — the honest version of the same trade the `livePlanItems`
 * breadth test makes.
 */
describe("the skip reporter never trusts what was thrown to be an Error", () => {
  test("an Error still reports its own message", () => {
    expect(thrownMessage(new Error("undefined is not an object"))).toBe("undefined is not an object");
  });

  test("a thrown string is its own message", () => {
    expect(thrownMessage("boom")).toBe("boom");
  });

  test("null is described instead of dereferenced", () => {
    expect(() => thrownMessage(null)).not.toThrow();
    expect(thrownMessage(null)).toContain("null");
  });

  test("a hostile toString is described, never invoked", () => {
    let called = false;
    const hostile = { toString() { called = true; throw new Error("gotcha"); } };
    expect(() => thrownMessage(hostile)).not.toThrow();
    expect(called).toBe(false);
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
});
