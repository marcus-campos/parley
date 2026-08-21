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
});
