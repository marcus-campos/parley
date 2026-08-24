import { describe, expect, test } from "bun:test";
import { type Front, withDaemon } from "./harness";

const task = (n: number, title: string, paths: string[]) => ({ n, title, paths, parseError: null });

interface Item {
  id: string; kind: string; state: string; paths: string[];
  offeredToId: string | null; takenById: string | null; publishedById: string;
}
const items = (r: Record<string, unknown>) => (r as unknown as { work: Item[] }).work;

describe("a plan, over the wire", () => {
  test("three tasks, two waves, two fronts, reviews included", async () => {
    await withDaemon(async (connect) => {
      const coord = await connect("COORD");
      const worker = await connect("WORKER");
      const auditor = await connect("AUDITOR");
      const fronts: Record<string, Front> = { COORD: coord, WORKER: worker, AUDITOR: auditor };

      await coord.send({ v: 1, op: "shape", shape: "plan" });
      const dispatched = await coord.send({
        v: 1, op: "plan", goal: "g", spec: null,
        tasks: [task(1, "A", ["a.ts"]), task(2, "B", ["b.ts"]), task(3, "C", ["a.ts"])],
      });
      // `opened`, not `dispatched`: the count is items, and a task with three
      // declared paths opens three of them. Here one path each, so it happens
      // to equal the task count — which is why `waves` is asserted too.
      expect(dispatched.waves).toBe(2);
      expect(dispatched.opened).toBe(2);

      const wave1 = items(await worker.send({ v: 1, op: "works", state: "open" }));
      expect(wave1).toHaveLength(2);          // task 3 collides with task 1

      for (const item of wave1) {
        await worker.send({ v: 1, op: "take", id: item.id });
        await worker.send({ v: 1, op: "done", id: item.id });
      }

      // A wave is not over until its reviews are. Both tasks are done and
      // nothing from wave 1 has opened — without this the reviews below could
      // be closed out against a plan that had already moved on regardless.
      expect(items(await worker.send({ v: 1, op: "works", state: "open" }))).toHaveLength(0);

      // The rule: never the author. It says nothing about WHICH other front,
      // and `finishWork` picks the first live one — so the test asks who holds
      // them rather than assuming, and only checks what the rule promises.
      const reviews = items(await coord.send({ v: 1, op: "works", state: "offered" }));
      expect(reviews).toHaveLength(2);
      expect(reviews.every((w) => w.kind === "review")).toBe(true);
      expect(reviews.every((w) => w.offeredToId !== null && w.offeredToId !== w.publishedById)).toBe(true);

      // Taking as anyone but the offeree is refused while the offer stands —
      // the reason this loop cannot be run by whichever front is convenient.
      const stolen = await worker.send({ v: 1, op: "take", id: reviews[0]!.id });
      expect(stolen.ok).toBe(false);

      const roster = (await coord.send({ v: 1, op: "who" })) as unknown as {
        participants: { id: string; name: string }[];
      };
      const nameOf = (id: string | null) => roster.participants.find((p) => p.id === id)?.name ?? "";
      for (const r of reviews) {
        const offeree = fronts[nameOf(r.offeredToId)]!;
        expect(offeree).toBeDefined();
        expect((await offeree.send({ v: 1, op: "take", id: r.id })).ok).toBe(true);
        await offeree.send({ v: 1, op: "done", id: r.id, summary: "ok" });
      }

      const wave2 = items(await worker.send({ v: 1, op: "works", state: "open" }));
      expect(wave2).toHaveLength(1);
      expect(wave2[0]!.paths[0]).toBe("a.ts");
    });
  });

  test("a plan does not take a file a person's front is holding", async () => {
    await withDaemon(async (connect) => {
      const coord = await connect("COORD");
      const person = await connect("RESPONSIVO");
      await coord.send({ v: 1, op: "shape", shape: "plan" });
      await person.send({ v: 1, op: "claim", paths: ["a.ts"], intent: "mine" });
      await coord.send({
        v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, "A", ["a.ts"])],
      });

      const who = (await person.send({ v: 1, op: "who" })) as unknown as {
        participants: { name: string; claims: string[] }[];
      };
      const theirs = who.participants.find((p) => p.name === "RESPONSIVO")!;
      expect(theirs.claims).toContain("a.ts");   // still theirs

      // And the task was published anyway rather than skipped: the wait is
      // announced, never silent. `open`, owned by nobody — not taken from the
      // holder, and not withheld from the pool either.
      const work = items(await coord.send({ v: 1, op: "works" }));
      expect(work).toHaveLength(1);
      expect(work[0]!.state).toBe("open");
      expect(work[0]!.takenById).toBeNull();
    });
  });

  test("one front, its own review, and the plan still moves", async () => {
    await withDaemon(async (connect) => {
      const only = await connect("ONLY");
      await only.send({ v: 1, op: "shape", shape: "plan" });
      await only.send({
        v: 1, op: "plan", goal: "g", spec: null,
        // Both on a.ts, so they are two waves: wave 1 can only open once the
        // review of wave 0 is done, which is what makes this the whole path.
        tasks: [task(1, "A", ["a.ts"]), task(2, "B", ["a.ts"])],
      });

      const [first] = items(await only.send({ v: 1, op: "works", state: "open" })) as [Item];
      const tookTask = await only.send({ v: 1, op: "take", id: first.id });
      expect(tookTask.selfReview).toBe(false);          // a task is not a review
      await only.send({ v: 1, op: "done", id: first.id });

      // Nobody else is live, so the review is published open rather than
      // falling back to the author — and the author is then the only front
      // that can ever take it. Exactly one item, because wave 1 must not have
      // opened yet: its predecessor is not done until this review is.
      const pending = items(await only.send({ v: 1, op: "works", state: "open" }));
      expect(pending).toHaveLength(1);
      const [review] = pending as [Item];
      expect(review.kind).toBe("review");
      expect(review.offeredToId).toBeNull();

      const took = await only.send({ v: 1, op: "take", id: review.id });
      expect(took.ok).toBe(true);
      // The disclosure, over a real socket, on the path a real single-front
      // repository takes. Blocking this take would leave the plan stuck here
      // with no TTL and no tick rule to rescue it, which is why the fact is
      // stated instead — and this is where the statement has to survive.
      expect(took.selfReview).toBe(true);

      await only.send({ v: 1, op: "done", id: review.id, summary: "ok" });

      const wave2 = items(await only.send({ v: 1, op: "works", state: "open" }));
      expect(wave2).toHaveLength(1);
      expect(wave2[0]!.kind).toBe("work");
    });
  });

  /**
   * The guarantee `parley plan` exists to compute is "two tasks touching the
   * same file never open in the same wave", and it is a proof over the tasks
   * one dispatch was handed. A second dispatch used to publish a second set of
   * open items over the same paths — two takeable items on `a.ts`, taken by
   * two fronts at once — while the first plan's items stayed in the pool with
   * nothing tracking them and `drop` refusing every hand-back.
   */
  test("a second plan is refused while the first is running, and --replace clears it", async () => {
    await withDaemon(async (connect) => {
      const coord = await connect("COORD");
      const worker = await connect("WORKER");
      await coord.send({ v: 1, op: "shape", shape: "plan" });

      const plan = { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, "A", ["a.ts"]), task(2, "B", ["b.ts"])] };
      await coord.send(plan);
      const held = items(await worker.send({ v: 1, op: "works", state: "open" }))
        .find((w) => w.paths[0] === "a.ts")!;
      await worker.send({ v: 1, op: "take", id: held.id });

      const again = await coord.send(plan);
      expect(again.ok).toBe(false);
      expect((again as unknown as { error: { code: string } }).error.code).toBe("CONFLICT");
      // The count is what matters, not the code: one path, one live item.
      const live = items(await coord.send({ v: 1, op: "works" })).filter((w) => w.state !== "done");
      expect(live.filter((w) => w.paths[0] === "a.ts")).toHaveLength(1);
      expect(live).toHaveLength(2);

      const replaced = await coord.send({ ...plan, replace: true, tasks: [task(9, "Z", ["z.ts"])] });
      expect(replaced.ok).toBe(true);
      expect(replaced.withdrawn).toBe(2);

      // WORKER's item is gone rather than stranded: a planned task cannot be
      // dropped, so if it survived here nothing would ever clear it.
      const orphaned = await worker.send({ v: 1, op: "done", id: held.id });
      expect(orphaned.ok).toBe(false);
      const after = items(await coord.send({ v: 1, op: "works" }));
      expect(after.map((w) => w.paths[0])).toEqual(["z.ts"]);
    });
  });

  /**
   * `--replace` keeps what the old plan FINISHED, on purpose: it is history
   * and nothing waits on it. A kept `done` item still carries `takenById`,
   * so its holder could send `done` again — and the review that fired was
   * filed under a task number the new plan does not track, which made it live
   * work no `livePlanItems` could see and no later `--replace` could withdraw.
   * The residue accumulated one item per repeat.
   */
  test("--replace leaves nothing behind, including through a repeated done", async () => {
    await withDaemon(async (connect) => {
      const coord = await connect("COORD");
      const worker = await connect("WORKER");
      await coord.send({ v: 1, op: "shape", shape: "plan" });
      await coord.send({
        v: 1, op: "plan", goal: "g", spec: null,
        tasks: [task(1, "A", ["a.ts"]), task(2, "B", ["b.ts"])],
      });

      const a = items(await worker.send({ v: 1, op: "works", state: "open" }))
        .find((w) => w.paths[0] === "a.ts")!;
      await worker.send({ v: 1, op: "take", id: a.id });
      await worker.send({ v: 1, op: "done", id: a.id });
      const [review] = items(await coord.send({ v: 1, op: "works", state: "offered" })) as [Item];
      await coord.send({ v: 1, op: "take", id: review.id });
      await coord.send({ v: 1, op: "done", id: review.id });

      // `a.ts` is done and kept; `b.ts` is withdrawn.
      const replaced = await coord.send({
        v: 1, op: "plan", goal: "g2", spec: null, replace: true, tasks: [task(9, "Z", ["z.ts"])],
      });
      expect(replaced.withdrawn).toBe(1);

      const repeat = await worker.send({ v: 1, op: "done", id: a.id });
      expect(repeat.ok).toBe(false);

      const live = items(await coord.send({ v: 1, op: "works" })).filter((w) => w.state !== "done");
      expect(live.map((w) => w.paths[0])).toEqual(["z.ts"]);

      // And the next re-sequence really does clear everything it left: an
      // untracked item would survive here, which is how the residue showed.
      await coord.send({
        v: 1, op: "plan", goal: "g3", spec: null, replace: true, tasks: [task(9, "Y", ["y.ts"])],
      });
      const after = items(await coord.send({ v: 1, op: "works" })).filter((w) => w.state !== "done");
      expect(after.map((w) => w.paths[0])).toEqual(["y.ts"]);
    });
  });

  /**
   * The frame is journaled BEFORE it is applied — deliberately, that ordering
   * is the whole crash story — so a frame that throws inside the daemon is on
   * disk before anyone learns it is poison, and `restore` replays it on the
   * next start. One `{op:"plan", tasks:[{}]}` used to leave the repository
   * with a bus that never came up again: the runtime throw was contained, and
   * that is exactly what hid it.
   */
  test("a malformed plan frame is refused, and the next boot is unharmed", async () => {
    await withDaemon(async (connect, restart) => {
      const coord = await connect("COORD");
      await coord.send({ v: 1, op: "shape", shape: "plan" });

      const bad = await coord.send({ v: 1, op: "plan", goal: "g", spec: null, tasks: [{}] });
      expect(bad.ok).toBe(false);
      // Answered at all, which is the runtime half: the sender used to get
      // nothing back until its own timeout gave up.
      expect((bad as unknown as { error: { code: string } }).error.code).toBe("UNKNOWN_OP");

      // A good plan on the same bus, so the restart has something to prove.
      await coord.send({ v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, "A", ["a.ts"])] });

      await restart({ hard: true });

      const after = await connect("AGAIN");
      expect((await after.send({ v: 1, op: "status" })).ok).toBe(true);
      expect(items(await after.send({ v: 1, op: "works" })).map((w) => w.paths[0])).toEqual(["a.ts"]);
    });
  });

  test("the bus is told, not only the front that took it", async () => {
    await withDaemon(async (connect) => {
      const coord = await connect("COORD");
      const worker = await connect("WORKER");
      await coord.send({ v: 1, op: "shape", shape: "plan" });
      await coord.send({
        v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, "A", ["a.ts"])],
      });

      const [item] = items(await worker.send({ v: 1, op: "works", state: "open" })) as [Item];
      await worker.send({ v: 1, op: "take", id: item.id });
      await worker.send({ v: 1, op: "done", id: item.id });

      // The two-command path: the offeree hands the review back and the author
      // takes it. Nothing refuses that, so the take event is the only thing
      // that tells anyone watching the bus what just happened.
      const [review] = items(await coord.send({ v: 1, op: "works", state: "offered" })) as [Item];
      await coord.send({ v: 1, op: "drop", id: review.id });
      await worker.send({ v: 1, op: "take", id: review.id });

      // A round trip on COORD's own socket: the push was written before this
      // request could be read, and a socket delivers in order.
      const before = coord.pushes.length;
      await coord.send({ v: 1, op: "who" });
      expect(coord.pushes.length).toBeGreaterThanOrEqual(before);

      const texts = coord.pushes.flatMap(
        (p) => ((p as { events?: { text: string }[] }).events ?? []).map((e) => e.text),
      );
      const takes = texts.filter((t) => t.includes("WORKER took"));
      expect(takes).toHaveLength(2);
      // The task WORKER took was somebody's to hand out; the review was its
      // own. One of those two events has to say so, and the other must not.
      expect(takes.filter((t) => t.includes("self-review"))).toHaveLength(1);
    });
  });
});
