import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelPath } from "../../src/brain/download";
import { MODELS } from "../../src/brain/registry";
import { loadVectors } from "../../src/brain/vectors";
import { RawClient, daemons, dirs, startDaemon, tempRepo } from "./harness";

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REGISTERED = MODELS[0]!;

/**
 * A tiny, self-contained model — same shape as `tests/brain/fixtures/tiny-model.json`
 * — dropped at the path the real registry entry resolves to, so the daemon's
 * registry -> modelPath -> loadStaticModel chain is exercised end to end
 * without a real ~100MB download.
 */
function plantFixtureModel(modelsDir: string): void {
  const path = modelPath(REGISTERED, modelsDir);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ dims: 2, vocab: { select2: [1, 0], hidden: [1, 0], menu: [0, 1], lateral: [0, 1] } }),
    "utf8",
  );
}

describe("the brain, wired into a real daemon", () => {
  test("off: a query sharing no token with any note finds nothing", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"));
    const a = await RawClient.connect(endpoint.address);
    await a.send({ op: "join", name: "CORE", mission: "m" });
    await a.send({ op: "note", title: "o menu do sistema" });

    const out = await a.send({ op: "notes", q: "lateral" });
    expect((out as unknown as { notes: unknown[] }).notes).toEqual([]);
    a.close();
  });

  test("on: that same query finds the note by vector signal alone, with zero lexical overlap", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const core = await RawClient.connect(endpoint.address);
    await core.send({ op: "join", name: "CORE", mission: "m" });

    await core.send({ op: "note", title: "o menu do sistema" });
    const enabled = await human.send({ op: "brain", enable: REGISTERED.name });
    expect(enabled.ok).toBe(true);

    // "lateral" shares no token with "o menu do sistema" at all, so a purely
    // lexical search returns nothing (proved above) — this can only succeed
    // through the vector ranking, fused in.
    const out = await core.send({ op: "notes", q: "lateral" });
    const notes = (out as unknown as { notes: { title: string }[] }).notes;
    expect(notes.map((n) => n.title)).toEqual(["o menu do sistema"]);

    human.close();
    core.close();
  });

  /**
   * The review's exact reproduction, run against a real daemon: a query
   * sharing no token with the corpus at all, lexically or in the embedding
   * vocabulary. Before the relevance floor (`VectorIndex.search`,
   * `embed.ts`), the query embedded to the zero vector, every document tied
   * at `cosine(zero, x) === 0`, and `fuse` gave that tie a positive RRF
   * bump — resurrecting a hit neither ranking genuinely qualified. With the
   * floor in place, the vector channel returns `[]` for a zero-signal
   * query, lexical already returns `[]` (no shared token), and fusion of
   * two empty rankings must stay empty.
   */
  test("on: a query with zero signal — lexical or semantic — still finds nothing, not the least-bad note", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const core = await RawClient.connect(endpoint.address);
    await core.send({ op: "join", name: "CORE", mission: "m" });

    await core.send({ op: "note", title: "o menu do sistema" });
    const enabled = await human.send({ op: "brain", enable: REGISTERED.name });
    expect(enabled.ok).toBe(true);

    // Neither "kubernetes" nor "helm" is in the tiny vocabulary or the
    // corpus's text — zero signal on both channels at once.
    const out = await core.send({ op: "notes", q: "kubernetes helm" });
    expect((out as unknown as { notes: unknown[] }).notes).toEqual([]);

    human.close();
    core.close();
  });

  test("activating later backfills every note already in state, not just future ones", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });

    // Written *before* the brain is ever turned on.
    await human.send({ op: "note", title: "o menu do sistema" });
    await human.send({ op: "brain", enable: REGISTERED.name });

    const out = await human.send({ op: "notes", q: "lateral" });
    const notes = (out as unknown as { notes: { title: string }[] }).notes;
    expect(notes.map((n) => n.title)).toEqual(["o menu do sistema"]);
    human.close();
  });

  test("vectors persist beside the journal, so a restart does not need to re-embed", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const journal = join(dir, "journal.ndjson");
    const { endpoint } = await startDaemon(dir, journal, { modelsDir });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    await human.send({ op: "note", title: "o menu do sistema" });
    await human.send({ op: "brain", enable: REGISTERED.name });
    human.close();

    const persisted = loadVectors(dir, 2);
    expect(persisted).not.toBeNull();
    expect(persisted!.search(new Float32Array([0, 1]), 5).length).toBeGreaterThan(0);
  });

  test("enabling and disabling announce it to every other front on the bus", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const other = await RawClient.connect(endpoint.address);
    await other.send({ op: "join", name: "OTHER", mission: "m" });

    await human.send({ op: "brain", enable: REGISTERED.name });
    await new Promise((r) => setTimeout(r, 80));
    expect(JSON.stringify(other.pushes)).toContain(REGISTERED.name);

    other.pushes.length = 0;
    await human.send({ op: "brain", disable: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(JSON.stringify(other.pushes)).toContain("disabled");

    human.close();
    other.close();
  });

  test("a missing model file degrades to the lexical floor instead of erroring", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo(); // nothing planted at all
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const enabled = await human.send({ op: "brain", enable: REGISTERED.name });
    expect(enabled.ok).toBe(true);

    await human.send({ op: "note", title: "o menu do sistema" });
    const out = await human.send({ op: "notes", q: "menu" });
    expect(out.ok).toBe(true);
    human.close();
  });

  /**
   * The review's Important-3 finding: before this daemon knows whether it
   * can actually load what was just recorded, it must not tell the caller
   * "ok" and the bus "semantic recall now backs every front" — both would be
   * false the instant `loadBrain` fails. The state transition itself still
   * stands (`enabled.ok`) — a human's recorded decision — but what the
   * daemon tells everyone about its own ability to act on it must match
   * reality.
   */
  test("enabling reports honestly when the daemon cannot actually load what it just recorded", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo(); // nothing planted — loadStaticModel finds no file
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const other = await RawClient.connect(endpoint.address);
    await other.send({ op: "join", name: "OTHER", mission: "m" });

    const enabled = await human.send({ op: "brain", enable: REGISTERED.name });
    expect(enabled.ok).toBe(true);
    expect((enabled as unknown as { loaded?: boolean }).loaded).toBe(false);

    await new Promise((r) => setTimeout(r, 80));
    const text = JSON.stringify(other.pushes);
    expect(text).not.toContain("now backs every front");
    expect(text).toContain("could not load");

    human.close();
    other.close();
  });

  /**
   * The review's other Important-3 finding: `loadBrain`'s ordinary failure
   * branches (unknown registry name, missing/corrupt file) returned
   * silently. A daemon that boots with `state.brain.active` true from a
   * replayed journal, but whose model file is gone, must say so once — the
   * same nudge-once discipline `askedAtMs` already uses elsewhere in this
   * codebase — rather than leave every front believing semantic recall is
   * still backing them.
   */
  test("a brain recorded active but unloadable at boot says so once, to the rest of the bus", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const journal = join(dir, "journal.ndjson");
    const first = await startDaemon(dir, journal, { modelsDir });

    const setup = await RawClient.connect(first.endpoint.address);
    await setup.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    await setup.send({ op: "brain", enable: REGISTERED.name });
    setup.close();
    await first.daemon.close();

    // The model file disappears between restarts — a person moving
    // machines, or clearing a cache — while the journal still records the
    // decision to have it on.
    rmSync(modelPath(REGISTERED, modelsDir));

    const second = await startDaemon(dir, journal, { modelsDir });
    const a = await RawClient.connect(second.endpoint.address);
    await a.send({ op: "join", name: "A", mission: "m" });
    const b = await RawClient.connect(second.endpoint.address);
    await b.send({ op: "join", name: "B", mission: "m" });

    await new Promise((r) => setTimeout(r, 80));
    expect(JSON.stringify(a.pushes)).toContain("could not load");

    // Said once: a further request from the bus does not repeat it.
    a.pushes.length = 0;
    await b.send({ op: "status" });
    await new Promise((r) => setTimeout(r, 80));
    expect(a.pushes.length).toBe(0);

    a.close();
    b.close();
  });
});
