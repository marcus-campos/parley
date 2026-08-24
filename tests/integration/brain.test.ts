import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelPath } from "../../src/brain/download";
import { RETIRED, type StaticBrainModel } from "../../src/brain/registry";
import { calibrate } from "../../src/brain/calibrate";
import { loadVectors } from "../../src/brain/vectors";
import { DIMS, FIXTURE_MODEL } from "../brain/fixtures/model";
import { RawClient, daemons, dirs, startDaemon, tempRepo } from "./harness";

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A static entry this suite owns, rather than one the product happens to list.
 *
 * Everything here plants a model *file* on disk and measures what the daemon
 * does with it — a table that loads, one too small to calibrate, one that
 * vanishes between restarts. That is the static path, and the daemon takes the
 * registry it resolves against from its options, so these tests do not care
 * what the listing offers. They used to: the listing stopped carrying any
 * static entry and a dozen tests about calibration and persistence went red for
 * a reason that had nothing to do with either.
 */
const REGISTERED: StaticBrainModel = {
  name: "test-static", kind: "static", vectorWeight: 1, dims: DIMS, score: 1,
  ramMB: 1, msPerNote: 1, bytes: 1,
  url: "https://example.invalid/model.json", sha256: "0".repeat(64), tokenizer: "wordlevel",
};

/** Handed to every daemon here, so `state.brain.model` resolves to the fixture. */
const REGISTRY = [REGISTERED];

/**
 * The generated model fixture (`tests/brain/fixtures/model.ts`) dropped at the
 * path the real registry entry resolves to, so the daemon's registry ->
 * modelPath -> loadStaticModel -> calibrate chain is exercised end to end
 * without a real download of the published asset.
 *
 * It is a generated table rather than a handful of hand-written rows because
 * a hand-written one cannot fail honestly: the fixture this replaced had
 * every vector at exactly `[1,0]` or `[0,1]`, so every cosine was a bit-exact
 * tie and the floor's own constant could be set to anything without a single
 * test noticing. This one is anisotropic, has no ties, and is large enough for
 * `calibrate` to measure a null distribution over.
 */
function plantFixtureModel(modelsDir: string): void {
  const path = modelPath(REGISTERED, modelsDir);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(FIXTURE_MODEL), "utf8");
}

/** What the daemon will measure off that file — the tests need the same number. */
const FIXTURE_FLOOR = calibrate(FIXTURE_MODEL)!.floor;

// Portuguese prose, English query, not one shared token: the case the lexical
// channel cannot answer and the brain exists for.
const NOTE_PT = "o menu lateral oculto do painel";
const QUERY_EN = "hidden sidebar";

describe("the brain, wired into a real daemon", () => {
  test("a name the daemon's registry does not carry is refused, and nothing is recorded", async () => {
    // This check used to live in the reducer and moved here, so it needs a test
    // here — a guard that relocates without its test is a guard that quietly
    // stops existing.
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { models: REGISTRY });
    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });

    const out = await human.send({ op: "brain", enable: "something-off-the-internet" });
    expect(out.ok).toBe(false);

    const status = await human.send({ op: "brain" });
    expect(status).toMatchObject({ active: false, model: null });
    human.close();
  });

  test("a model that was listed once is refused with the reason it was withdrawn", async () => {
    // "Unknown model" reads as parley losing track of its own registry. The
    // truth is that it was measured against the lexical floor it sits on top of
    // and lost, and the person deserves that sentence rather than a shrug.
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { models: REGISTRY });
    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });

    const out = await human.send({ op: "brain", enable: RETIRED[0]!.name });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toContain("no longer offered");
    human.close();
  });

  test("off: a query sharing no token with any note finds nothing", async () => {
    const dir = tempRepo();
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { models: REGISTRY });
    const a = await RawClient.connect(endpoint.address);
    await a.send({ op: "join", name: "CORE", mission: "m" });
    await a.send({ op: "note", title: NOTE_PT });

    const out = await a.send({ op: "notes", q: QUERY_EN });
    expect((out as unknown as { notes: unknown[] }).notes).toEqual([]);
    a.close();
  });

  test("on: that same query finds the note by vector signal alone, with zero lexical overlap", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const core = await RawClient.connect(endpoint.address);
    await core.send({ op: "join", name: "CORE", mission: "m" });

    await core.send({ op: "note", title: NOTE_PT });
    const enabled = await human.send({ op: "brain", enable: REGISTERED.name });
    expect(enabled.ok).toBe(true);

    // "hidden sidebar" shares no token with the Portuguese note at all, so a
    // purely lexical search returns nothing (proved above) — this can only
    // succeed through the vector ranking, fused in.
    const out = await core.send({ op: "notes", q: QUERY_EN });
    const notes = (out as unknown as { notes: { title: string }[] }).notes;
    expect(notes.map((n) => n.title)).toEqual([NOTE_PT]);

    human.close();
    core.close();
  });

  /**
   * The genuinely zero-signal case: a query sharing no token with the corpus
   * at all, lexically or in the embedding vocabulary, so it embeds to the
   * zero vector. This exercises the independent `norm(vec) === 0`
   * short-circuit in `VectorIndex.search` (embed.ts) — not the relevance
   * floor, which needs a real, non-zero query vector to exercise at all (see
   * the next test for that).
   */
  test("on: a query with zero signal — lexical or semantic — still finds nothing, not the least-bad note", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const core = await RawClient.connect(endpoint.address);
    await core.send({ op: "join", name: "CORE", mission: "m" });

    await core.send({ op: "note", title: NOTE_PT });
    const enabled = await human.send({ op: "brain", enable: REGISTERED.name });
    expect(enabled.ok).toBe(true);

    // Neither "opentelemetry" nor "zzyzx" is in the fixture vocabulary or the
    // corpus's text — zero signal on both channels at once.
    const out = await core.send({ op: "notes", q: "opentelemetry zzyzx" });
    expect((out as unknown as { notes: unknown[] }).notes).toEqual([]);

    human.close();
    core.close();
  });

  /**
   * The review's exact reproduction, run against a real daemon. Four notes,
   * and a query that shares no lexical token with any of them and no topic
   * either. Before the floor, a fixed `MIN_SIMILARITY = 0` let every document
   * scoring above zero cosine straight through, and on an anisotropic table
   * that is all of them; the relative floor that replaced it let them through
   * too, whenever one was marginally less irrelevant than the rest. The query
   * embeds to a real, non-zero vector — asserted below — so this is the floor
   * being tested, not the zero-vector short-circuit.
   */
  test("on: a query unrelated to a 4-note corpus still finds nothing — the floor, not the least-bad note", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const core = await RawClient.connect(endpoint.address);
    await core.send({ op: "join", name: "CORE", mission: "m" });

    await core.send({ op: "note", title: NOTE_PT });
    await core.send({ op: "note", title: "a barra lateral colapsada" });
    await core.send({ op: "note", title: "o drawer oculto do painel" });
    await core.send({ op: "note", title: "collapse do menu" });
    const enabled = await human.send({ op: "brain", enable: REGISTERED.name });
    expect(enabled.ok).toBe(true);

    const out = await core.send({ op: "notes", q: "kubectl ingress replica" });
    expect((out as unknown as { notes: unknown[] }).notes).toEqual([]);

    human.close();
    core.close();
  });

  /**
   * The other direction, which the previous floor got catastrophically wrong:
   * two identical notes masked each other under a per-query z-score and BOTH
   * were rejected, cosine 1.0 and all. An absolute floor judges each candidate
   * alone, so both come back.
   */
  test("on: two identical notes both come back — neither masks the other", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    await human.send({ op: "note", title: NOTE_PT });
    await human.send({ op: "note", title: NOTE_PT, body: "escrito duas vezes" });
    await human.send({ op: "note", title: "rollout do pod no namespace do cluster" });
    await human.send({ op: "note", title: "a migration do schema no postgres" });
    await human.send({ op: "brain", enable: REGISTERED.name });

    const out = await human.send({ op: "notes", q: QUERY_EN });
    const notes = (out as unknown as { notes: { title: string }[] }).notes;
    expect(notes.map((n) => n.title)).toEqual([NOTE_PT, NOTE_PT]);

    human.close();
  });

  /**
   * The other half of the previous floor's collapse, and until now the only
   * one of the two pinned at unit level alone. A per-query z-score asks "is
   * this score unusual among the others?", so three genuine matches in a
   * ten-note corpus hold each other's scores down and none of them stands
   * out — all three rejected. An absolute floor judges each candidate on its
   * own, so all three come back, through a real daemon, with no lexical
   * overlap anywhere to prop the answer up.
   */
  test("on: three genuine matches among ten notes all come back — none of them masks the others", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });

    const genuine = [NOTE_PT, "a barra lateral colapsada", "o drawer oculto do painel"];
    const rest = [
      "rollout do pod no namespace do cluster",
      "a migration do schema no postgres com rollback",
      "o gateway devolveu timeout no socket da requisicao",
      "w0x2 w30x9", "w5x2 w35x9", "w10x2 w40x9", "w15x2 w45x9",
    ];
    for (const title of [...genuine, ...rest]) await human.send({ op: "note", title });
    await human.send({ op: "brain", enable: REGISTERED.name });

    const out = await human.send({ op: "notes", q: QUERY_EN });
    const notes = (out as unknown as { notes: { title: string }[] }).notes;
    expect(notes.map((n) => n.title).sort()).toEqual([...genuine].sort());

    human.close();
  });

  /**
   * A model this build can parse but cannot measure a null distribution over
   * — too little vocabulary — must not get a guessed floor. It degrades to
   * the lexical floor and says so, exactly like a missing file.
   */
  test("a model too small to calibrate degrades to the lexical floor instead of guessing one", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    const path = modelPath(REGISTERED, modelsDir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ dims: 2, vocab: { menu: [1, 0], lateral: [0, 1] } }), "utf8");
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const other = await RawClient.connect(endpoint.address);
    await other.send({ op: "join", name: "OTHER", mission: "m" });

    await human.send({ op: "note", title: NOTE_PT });
    const enabled = await human.send({ op: "brain", enable: REGISTERED.name });
    expect(enabled.ok).toBe(true);
    expect((enabled as unknown as { loaded?: boolean }).loaded).toBe(false);

    // The lexical floor still answers, and the vector channel contributes
    // nothing rather than something invented.
    const out = await human.send({ op: "notes", q: "menu lateral" });
    expect(out.ok).toBe(true);
    expect((out as unknown as { notes: { title: string }[] }).notes.map((n) => n.title)).toEqual([NOTE_PT]);

    human.close();
    other.close();
  });

  test("activating later backfills every note already in state, not just future ones", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });

    // Written *before* the brain is ever turned on.
    await human.send({ op: "note", title: NOTE_PT });
    await human.send({ op: "brain", enable: REGISTERED.name });

    const out = await human.send({ op: "notes", q: QUERY_EN });
    const notes = (out as unknown as { notes: { title: string }[] }).notes;
    expect(notes.map((n) => n.title)).toEqual([NOTE_PT]);
    human.close();
  });

  test("vectors persist beside the journal, so a restart does not need to re-embed", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const journal = join(dir, "journal.ndjson");
    const { endpoint } = await startDaemon(dir, journal, { modelsDir, models: REGISTRY });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    await human.send({ op: "note", title: NOTE_PT });
    await human.send({ op: "brain", enable: REGISTERED.name });
    human.close();

    const persisted = loadVectors(dir, DIMS, FIXTURE_FLOOR);
    expect(persisted).not.toBeNull();
    // Its own vector back, which is cosine 1 against itself and therefore
    // above any valid floor — the round trip kept the geometry.
    const own = persisted!.all()[0]!;
    expect(persisted!.search(own.vec, 5).map((h) => h.id)).toEqual([own.id]);
  });

  test("enabling and disabling announce it to every other front on the bus", async () => {
    const dir = tempRepo();
    const modelsDir = tempRepo();
    plantFixtureModel(modelsDir);
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

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
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

    const human = await RawClient.connect(endpoint.address);
    await human.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    const enabled = await human.send({ op: "brain", enable: REGISTERED.name });
    expect(enabled.ok).toBe(true);

    await human.send({ op: "note", title: NOTE_PT });
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
    const { endpoint } = await startDaemon(dir, join(dir, "journal.ndjson"), { modelsDir, models: REGISTRY });

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
    const first = await startDaemon(dir, journal, { modelsDir, models: REGISTRY });

    const setup = await RawClient.connect(first.endpoint.address);
    await setup.send({ op: "join", name: "Marcus", mission: "m", kind: "human" });
    await setup.send({ op: "brain", enable: REGISTERED.name });
    setup.close();
    await first.daemon.close();

    // The model file disappears between restarts — a person moving
    // machines, or clearing a cache — while the journal still records the
    // decision to have it on.
    rmSync(modelPath(REGISTERED, modelsDir));

    const second = await startDaemon(dir, journal, { modelsDir, models: REGISTRY });
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
