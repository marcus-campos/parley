import { describe, expect, test } from "bun:test";
import { withDaemon } from "./harness";

describe("work pool over the wire", () => {
  test("publish, slice, take, done — two real clients", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      const responsivo = await connect("RESPONSIVO");

      await core.send({ v: 1, op: "shape", shape: "pool" });
      await responsivo.send({ v: 1, op: "claim", paths: ["templates/**"] });

      const published = await core.send({
        v: 1, op: "work", title: "label sem for",
        paths: ["templates/a.html", "src/orphan.ts"],
      });
      expect(published.items).toHaveLength(2);

      const mine = (await responsivo.send({ v: 1, op: "works", mine: true })) as unknown as {
        work: { id: string; paths: string[] }[];
      };
      expect(mine.work).toHaveLength(1);
      expect(mine.work[0]!.paths[0]).toBe("templates/a.html");

      const taken = await responsivo.send({ v: 1, op: "take", id: mine.work[0]!.id });
      expect(taken.ok).toBe(true);

      const finished = await responsivo.send({ v: 1, op: "done", id: mine.work[0]!.id, summary: "3 labels" });
      expect(finished.ok).toBe(true);
    });
  });

  test("the pool survives a daemon killed mid-flight", async () => {
    await withDaemon(async (connect, restart) => {
      const core = await connect("CORE");
      await core.send({ v: 1, op: "shape", shape: "pool" });
      const published = (await core.send({ v: 1, op: "work", title: "x", paths: ["a.ts", "b.ts"] })) as unknown as {
        items: { id: string }[];
      };
      const ids = published.items.map((i) => i.id);

      await restart({ hard: true });      // kill -9, not a graceful stop

      const again = await connect("CORE");
      const out = (await again.send({ v: 1, op: "works" })) as unknown as { work: { id: string }[] };
      expect(out.work).toHaveLength(2);
      // The same ids, because replay feeds the journalled frames back through
      // apply with a Ctx rebuilt from the recorded timestamps.
      expect(out.work.map((w) => w.id)).toEqual(ids);
    });
  });
});
