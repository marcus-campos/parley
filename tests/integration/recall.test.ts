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

  test("kind-blind ranking does not starve notes or results of their own top-k", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      // Both results below outrank both notes on the whole-corpus BM25 score
      // for "select2 hidden" — verified against LexicalIndex directly before
      // writing this test. If the daemon resolves `ids` from one corpus-wide
      // top-k instead of over-fetching and filtering by kind, `notes --query`
      // spends its k on results it can only filter away, and can come back
      // emptier than a real note match would justify.
      await core.send({ v: 1, op: "note", title: "the select2 trap", body: "a for pointing at a hidden element" });
      await core.send({
        v: 1, op: "note", title: "select2 dropdown hidden case",
        body: "another select2 hidden filler filler filler details",
      });
      await core.send({ v: 1, op: "note", title: "menu lateral", body: "37px de alvo em tablet deitado" });
      await core.send({ v: 1, op: "note", title: "padding one", body: "nothing relevant here at all" });
      await core.send({
        v: 1, op: "result", key: "select2 hidden widget test",
        status: "pass", summary: "covers the hidden select2 click trap",
      });
      await core.send({
        v: 1, op: "result", key: "select2 test hidden case two",
        status: "pass", summary: "hidden select2 again",
      });
      await core.send({ v: 1, op: "result", key: "bun run typecheck", status: "pass", summary: "nothing to do with anything" });
      await core.send({ v: 1, op: "result", key: "bun test suite", status: "pass", summary: "padding filler content two" });

      const notesTop1 = await core.send({ v: 1, op: "notes", q: "select2 hidden", k: 1 });
      expect(notesTop1.notes).toHaveLength(1);
      expect((notesTop1.notes as { title: string }[])[0]!.title).toBe("select2 dropdown hidden case");

      const resultsTop1 = await core.send({ v: 1, op: "results", q: "select2 hidden", k: 1 });
      expect(resultsTop1.results).toHaveLength(1);
      expect((resultsTop1.results as { key: string }[])[0]!.key).toBe("select2 test hidden case two");

      const notesTop2 = await core.send({ v: 1, op: "notes", q: "select2 hidden", k: 2 });
      expect(notesTop2.notes).toHaveLength(2);
      expect((notesTop2.notes as { title: string }[]).map((n) => n.title)).toEqual([
        "select2 dropdown hidden case", "the select2 trap",
      ]);

      const resultsTop2 = await core.send({ v: 1, op: "results", q: "select2 hidden", k: 2 });
      expect(resultsTop2.results).toHaveLength(2);
      expect((resultsTop2.results as { key: string }[]).map((r) => r.key)).toEqual([
        "select2 test hidden case two", "select2 hidden widget test",
      ]);
    });
  });
});
