import { describe, expect, test } from "bun:test";
import { withDaemon } from "./harness";

describe("recall over the wire", () => {
  test("a query returns ranked notes, top-k only", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      await core.send({ v: 1, op: "note", title: "the select2 trap", body: "a for pointing at a hidden element" });
      await core.send({ v: 1, op: "note", title: "menu lateral", body: "37px de alvo em tablet deitado" });
      await core.send({ v: 1, op: "note", title: "unrelated", body: "nothing to do with anything" });

      const out = await core.send({ v: 1, op: "notes", q: "select2 hidden", k: 1 });
      expect(out.notes).toHaveLength(1);
      expect((out.notes as { title: string }[])[0]!.title).toBe("the select2 trap");
      expect(out.ranked).toBe(true);
    });
  });

  test("a query with no good match returns nothing", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      await core.send({ v: 1, op: "note", title: "the select2 trap", body: "..." });
      const out = await core.send({ v: 1, op: "notes", q: "kubernetes helm", k: 3 });
      expect(out.notes).toEqual([]);
    });
  });

  test("listing without a query is unchanged", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      await core.send({ v: 1, op: "note", title: "a", body: "" });
      await core.send({ v: 1, op: "note", title: "b", body: "" });
      const out = await core.send({ v: 1, op: "notes" });
      expect(out.notes).toHaveLength(2);
      expect(out.ranked).toBeUndefined();
    });
  });

  test("a reversed decision leaves the index", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      const made = await core.send({ v: 1, op: "note", title: "routes end with a slash", kind: "decision" });
      await core.send({ v: 1, op: "reverse", id: made.id });
      const out = await core.send({ v: 1, op: "notes", q: "routes slash", k: 3 });
      expect(out.notes).toEqual([]);
    });
  });

  test("the index survives a daemon restart, because state does", async () => {
    await withDaemon(async (connect, restart) => {
      const core = await connect("CORE");
      await core.send({ v: 1, op: "note", title: "the select2 trap", body: "hidden element" });

      await restart();

      const again = await connect("CORE");
      const out = await again.send({ v: 1, op: "notes", q: "select2", k: 3 });
      expect(out.notes).toHaveLength(1);
      // The journal rebuilt state, and indexFromState rebuilt the index from it.
      // Nothing about the index is itself persisted.
    });
  });

  test("a query ranks results too, not just notes", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      await core.send({
        v: 1, op: "result", key: "bun test select2 widget",
        status: "pass", summary: "covers the hidden-element click trap",
      });
      await core.send({
        v: 1, op: "result", key: "bun run typecheck",
        status: "pass", summary: "nothing to do with anything",
      });

      const out = await core.send({ v: 1, op: "results", q: "select2 hidden", k: 1 });
      expect(out.results).toHaveLength(1);
      expect((out.results as { key: string }[])[0]!.key).toBe("bun test select2 widget");
      expect(out.ranked).toBe(true);
    });
  });
});
