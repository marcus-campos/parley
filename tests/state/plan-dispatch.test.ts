import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: `${name} mission` }, at(ms));
  return (out.response as unknown as { id: string }).id;
}
const task = (n: number, paths: string[]) => ({ n, title: `Task ${n}`, paths, parseError: null });

let state: State;
let coord: string;
let worker: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "plan" }, at(0));
  coord = joined(state, "COORD", 10);
  worker = joined(state, "WORKER", 20);
});

describe("dispatching a plan", () => {
  test("only the first wave becomes work; later waves wait", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [task(1, ["a.ts"]), task(2, ["b.ts"]), task(3, ["a.ts"])],
    }, at(100));

    // Task 3 collides with Task 1 on a.ts, so it belongs one wave later.
    // A bare count would also pass an implementation that dispatched all
    // three tasks and happened to produce two items some other way — assert
    // which tasks are actually live, not merely how many there are.
    const live = state.work.filter((w) => w.state !== "done").map((w) => w.title).sort();
    expect(live).toEqual(["Task 1", "Task 2"]);
    expect(state.plan!.waveIndex).toBe(0);
    expect(state.plan!.waves).toHaveLength(2);
  });

  test("planned items are marked planned, which is what makes a task undroppable", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    expect(state.work[0]!.origin).toBe("planned");
  });

  test("a plan never overrides live possession: a held path is not dispatched", () => {
    apply(state, worker, { v: 1, op: "claim", paths: ["a.ts"], intent: "person-directed work" }, at(50));
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["b.ts"])],
    }, at(100));

    const held = state.work.find((w) => w.paths[0] === "a.ts")!;
    expect(held.state).toBe("open");
    expect(held.takenById).toBeNull();
    expect(out.broadcast.some((e) => e.text.includes("waiting"))).toBe(true);

    // Asserting only that the item is open would also pass an implementation
    // that published nothing at all and silently released the worker's claim.
    // The claim itself must still be standing, owned by the same front.
    const claim = state.claims.find((c) => c.pattern === "a.ts");
    expect(claim?.ownerId).toBe(worker);
    expect(claim?.orphanedAtMs).toBeNull();
  });

  /**
   * "A person's front outranks the plan" is scoped to EXPLICIT claims, and the
   * scope is the whole rule. An auto-claim is the footprint of an edit, not a
   * declaration of what a front is doing — `idleFronts` carries the same
   * distinction with a paragraph explaining why. Count auto-claims here and
   * every file any session ever touched announces "task N is waiting", so the
   * dispatch of any plan over a repository that has been worked in becomes a
   * wall of waiting notices about nobody.
   */
  test("an auto-claim is not possession: the plan dispatches over it and says nothing", () => {
    apply(state, worker, { v: 1, op: "claim", paths: ["a.ts"], auto: true }, at(50));
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])],
    }, at(100));

    expect(state.claims.find((c) => c.pattern === "a.ts")?.auto).toBe(true);
    expect(state.work[0]!.state).toBe("open");
    expect(out.broadcast.some((e) => e.text.includes("waiting"))).toBe(false);
  });

  /**
   * A task that declared no files still gets an item — never dropping a task
   * is the rule — but the label standing in for its path is not territory.
   * `matchesPath("**", s)` is true for any string at all, so a front holding a
   * broad explicit claim was announced as holding "(no declared path)": a
   * waiting notice about a file that does not exist, naming a real person, in
   * the one announcement the plan makes about possession.
   */
  test("the placeholder path of a task that declared none is never matched against a claim", () => {
    apply(state, worker, { v: 1, op: "claim", paths: ["**"], intent: "everything" }, at(50));
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [
        { n: 1, title: "Task 1", paths: [], parseError: "no **Files:** block" },
        { n: 2, title: "Task 2", paths: ["a.ts"], parseError: null },
      ],
    }, at(100));

    const waiting = out.broadcast.filter((e) => e.text.includes("waiting"));
    // The control: task 2 declared a real path under the same broad claim, so
    // the announcement must still happen — the fix is "not that string", not
    // "never announce".
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.text).toContain("a.ts");
    expect(waiting[0]!.text).toContain("task 2");
    expect(out.broadcast.some((e) => e.text.includes("(no declared path)"))).toBe(false);
    // And the item still exists, still open, still carrying its reason.
    const orphan = state.work.find((w) => w.title.startsWith("Task 1"))!;
    expect(orphan.state).toBe("open");
    expect(orphan.paths).toEqual(["(no declared path)"]);
  });

  // The same assumption, entered through the other door. `openWave` guarded the
  // placeholder it creates itself — "did this task declare anything" — which
  // says nothing about a client that sends the label string AS a path. The
  // question has to be asked about the path, not about the task.
  test("the placeholder is not territory even when a client sends it as a path", () => {
    apply(state, worker, { v: 1, op: "claim", paths: ["**"], intent: "everything" }, at(50));
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [{ n: 1, title: "Task 1", paths: ["(no declared path)"], parseError: null }],
    }, at(100));

    expect(out.response.ok).toBe(true);
    expect(out.broadcast.some((e) => e.text.includes("waiting"))).toBe(false);
  });

  test("a task that would not parse is published, never dropped", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [{ n: 1, title: "mystery", paths: [], parseError: "no **Files:** block" }],
    }, at(100));
    expect(state.work).toHaveLength(1);
    expect(state.work[0]!.title).toContain("no **Files:** block");
    expect(state.work[0]!.state).toBe("open");
  });

  // `openWave` publishes one item PER DECLARED PATH, so the number of tasks in
  // wave 0 is not the number of items it opened. The CLI prints this number as
  // "N item(s) open now" immediately above a `parley works --state open` that
  // would then list more of them than the line just claimed — and `parley plan`
  // is the first command the README and the skill both tell people to run.
  test("the count the response reports is items opened, not tasks in the wave", () => {
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts", "b.ts", "c.ts"])],
    }, at(100));

    expect(out.response).toMatchObject({ ok: true, waves: 1, opened: 3 });
    expect(state.work.filter((w) => w.state === "open")).toHaveLength(3);
  });

  // Same number for a wave whose tasks declare one path each — so the fix is
  // "count the items", not "multiply by something".
  test("one path per task still reports one item per task", () => {
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["b.ts"])],
    }, at(100));

    expect(out.response).toMatchObject({ ok: true, waves: 1, opened: 2 });
  });

  // Task 1's contract change: paths.length > 0 and parseError !== null can
  // now coexist (a **Files:** block with several bullets, one of which could
  // not be normalized). The title must name THAT reason, not claim the task
  // has no paths — and every real path it does carry must still get dispatched.
  test("a task with real paths and a partial-capture parseError keeps its paths, and its title names the real reason", () => {
    const partial = {
      n: 1,
      title: "Task 1",
      paths: ["a.ts", "b.ts"],
      parseError: "**Files:** block has a path that could not be normalized; capture is partial",
    };
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [partial] }, at(100));

    expect(state.work).toHaveLength(2);
    expect(state.work.map((w) => w.paths[0]).sort()).toEqual(["a.ts", "b.ts"]);
    for (const item of state.work) {
      expect(item.title).toContain("capture is partial");
      expect(item.title.toLowerCase()).not.toContain("no **files:**");
      expect(item.title.toLowerCase()).not.toContain("no usable path");
    }
  });

  test("finishing every item in a wave advances to the next one", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [task(1, ["a.ts"]), task(2, ["a.ts"])],
    }, at(100));
    const first = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: first.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: first.id }, at(300));

    // Task 4 gates the wave on the review the done just spawned, too.
    const review = state.work.find((w) => w.kind === "review" && w.reviewOf === first.id)!;
    apply(state, coord, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, coord, { v: 1, op: "done", id: review.id }, at(500));

    expect(state.plan!.waveIndex).toBe(1);
    const live = state.work.filter((w) => w.state === "open" || w.state === "offered");
    expect(live.map((w) => w.title)).toEqual(["Task 2"]);
  });

  // Pins "every item in the wave, not just one" as the advancement rule.
  // Task 1 and Task 2 share a wave because they do not collide with each
  // other; Task 3 collides with Task 1 on a.ts, so it is pushed to the wave
  // after. A regression that advanced on "some item done" instead of "every
  // item done" would dispatch Task 3 the moment Task 1 alone finished —
  // every existing test's multi-item waves happen to collide down to one
  // item per wave, so none of them would have caught that.
  test("a wave with two non-colliding tasks does not advance until BOTH are done, not just one", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [task(1, ["a.ts"]), task(2, ["b.ts"]), task(3, ["a.ts"])],
    }, at(100));

    const item1 = state.work.find((w) => w.title === "Task 1")!;
    const item2 = state.work.find((w) => w.title === "Task 2")!;

    apply(state, worker, { v: 1, op: "take", id: item1.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item1.id }, at(300));

    // Half the wave is done. The wave must NOT have advanced, and Task 3's
    // item must not exist yet.
    expect(state.plan!.waveIndex).toBe(0);
    expect(state.work.find((w) => w.title === "Task 3")).toBeUndefined();

    apply(state, worker, { v: 1, op: "take", id: item2.id }, at(400));
    apply(state, worker, { v: 1, op: "done", id: item2.id }, at(500));

    // Both tasks are done, but Task 4 gates the wave on their reviews too —
    // the wave must still not have advanced.
    expect(state.plan!.waveIndex).toBe(0);
    expect(state.work.find((w) => w.title === "Task 3")).toBeUndefined();

    const review1 = state.work.find((w) => w.kind === "review" && w.reviewOf === item1.id)!;
    const review2 = state.work.find((w) => w.kind === "review" && w.reviewOf === item2.id)!;
    apply(state, coord, { v: 1, op: "take", id: review1.id }, at(600));
    apply(state, coord, { v: 1, op: "done", id: review1.id }, at(700));

    // The discriminating moment, and the only one in this wave's life where
    // task 1 is entirely finished and task 2 is not: both tasks done, review 1
    // done, review 2 still standing. A gate that read only the FIRST task
    // number of the wave — `wave.taskNumbers.slice(0, 1)` — sees nothing but
    // task 1's two done items here and opens wave 1 early. Every other
    // assertion in this file is taken either with both reviews outstanding or
    // after both are done, where such a gate and the real one agree.
    expect(state.plan!.waveIndex).toBe(0);
    expect(review2.state).toBe("offered");
    expect(state.work.find((w) => w.title === "Task 3")).toBeUndefined();

    apply(state, coord, { v: 1, op: "take", id: review2.id }, at(800));
    apply(state, coord, { v: 1, op: "done", id: review2.id }, at(900));

    // Now the whole wave is done, and only now does Task 3 open.
    expect(state.plan!.waveIndex).toBe(1);
    const task3 = state.work.find((w) => w.title === "Task 3");
    expect(task3?.state).toBe("open");
  });

  test("planning is refused outside shape plan", () => {
    apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(90));
    const out = apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    expect(out.response.ok).toBe(false);
  });

  // `openWave` is called with `tasksByWave[0]!` and `computeWaves([])` returns
  // no waves at all, so without the guard this throws inside the daemon rather
  // than answering. Pointing `parley plan` at a markdown file that has no
  // `### Task` heading in it is the reachable input.
  test("a plan with no tasks is refused, not dispatched into a wave that does not exist", () => {
    const out = apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [] }, at(100));
    expect(out.response).toMatchObject({ ok: false });
    expect(state.plan).toBeNull();
    expect(state.work).toHaveLength(0);
  });
});

/**
 * The rule this whole feature computes is "two tasks touching the same file
 * never open in the same wave", and `waves()` can only prove it over the tasks
 * it was handed. A second dispatch used to overwrite `state.plan` and publish
 * a second set of open items over the same paths that no collision graph ever
 * compared — two open items on one path, takeable concurrently — while the
 * first plan's items stayed in `state.work` tracked by nothing and refused
 * every `drop`.
 */
describe("a second plan while the first is still running", () => {
  test("is refused, and publishes nothing", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["b.ts"])],
    }, at(100));
    const before = state.work.map((w) => w.id);

    const again = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["b.ts"])],
    }, at(200));

    expect(again.response).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    // The failure this guards is two takeable items on one path, so count the
    // path, not the response: an implementation that answered `ok: false` and
    // published anyway would satisfy the line above.
    expect(state.work.filter((w) => w.paths[0] === "a.ts" && w.state !== "done")).toHaveLength(1);
    expect(state.work.map((w) => w.id)).toEqual(before);
    expect(again.broadcast).toHaveLength(0);
    // The wave is stated as the plan's POSITION, never as where the items are:
    // `livePlanItems` spans every wave the plan opened, so "2 item(s) of wave 1"
    // was a claim the refusal could not make.
    const message = (again.response as unknown as { error: { message: string } }).error.message;
    expect(message).toContain("on wave 1 of 1");
    expect(message).toContain("2 item(s) not done");
  });

  test("the refusal names the way through, and it is a command that exists", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const again = apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(200));
    const message = (again.response as unknown as { error: { message: string } }).error.message;

    expect(message).toContain("--replace");
    // And the flag it names really is honoured, rather than being a sentence.
    const replaced = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, replace: true, tasks: [task(1, ["a.ts"])],
    }, at(300));
    expect(replaced.response.ok).toBe(true);
  });

  test("--replace withdraws what the old plan never finished, keeps what it did, and leaves no residue", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["b.ts"])],
    }, at(100));

    // Task 2 runs to completion, review included: that is history, not residue.
    const two = state.work.find((w) => w.title === "Task 2")!;
    apply(state, worker, { v: 1, op: "take", id: two.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: two.id }, at(300));
    const review = state.work.find((w) => w.kind === "review" && w.reviewOf === two.id)!;
    apply(state, coord, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, coord, { v: 1, op: "done", id: review.id }, at(500));

    // Task 1 is in WORKER's hands, unfinished — the hard case, because a
    // planned task is undroppable and nothing else would ever clear it.
    const one = state.work.find((w) => w.title === "Task 1")!;
    apply(state, worker, { v: 1, op: "take", id: one.id }, at(600));

    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g2", spec: null, replace: true, tasks: [task(9, ["c.ts"])],
    }, at(700));

    expect(out.response).toMatchObject({ ok: true, withdrawn: 1, opened: 1 });
    expect(state.work.find((w) => w.id === one.id)).toBeUndefined();
    // Finished work survives: it is what the plan achieved, and nothing about
    // it is still waiting on anyone.
    expect(state.work.filter((w) => w.state === "done").map((w) => w.id).sort())
      .toEqual([two.id, review.id].sort());
    // Nothing unfinished is left over from the old plan at all.
    expect(state.work.filter((w) => w.state !== "done").map((w) => w.paths[0])).toEqual(["c.ts"]);
    expect(state.plan!.waveIndex).toBe(0);
    expect(state.plan!.goal).toBe("g2");
    // The front that lost the item under its hands is told, by name.
    expect(out.broadcast.some((e) => e.text.includes("WORKER") && e.text.includes("withdrawn"))).toBe(true);
  });

  test("a plan whose every item is done is not running, so the next one needs no flag", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const one = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: one.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: one.id }, at(300));
    const review = state.work.find((w) => w.kind === "review")!;
    apply(state, coord, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, coord, { v: 1, op: "done", id: review.id }, at(500));

    const next = apply(state, coord, { v: 1, op: "plan", goal: "g2", spec: null, tasks: [task(1, ["a.ts"])] }, at(600));
    expect(next.response).toMatchObject({ ok: true, withdrawn: 0 });
    expect(state.work.filter((w) => w.state === "open")).toHaveLength(1);
  });
});

/**
 * `op: "plan"` is the only operation on this branch that takes an array of
 * structured objects off the wire, and it used to CAST rather than read them.
 * The shipped CLI cannot send anything malformed — `parsePlan` always emits
 * well-formed tasks — but the unix socket has no auth and no version gate, so
 * "the CLI is fine" is not a property of the wire.
 *
 * Every frame here threw inside the daemon before this was read instead of
 * cast, and the frame is journaled BEFORE it is applied, so each of them also
 * left the next start unable to boot at all.
 */
describe("a plan frame is read, not cast", () => {
  test("a task with no paths is refused work, not a throw", () => {
    const out = apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [{}] }, at(100));
    expect(out.response.ok).toBe(false);
    expect(out.response).toMatchObject({ error: { code: "UNKNOWN_OP" } });
    expect(state.plan).toBeNull();
    expect(state.work).toHaveLength(0);
  });

  test("a task missing only its paths still dispatches — the number is what cannot be invented", () => {
    const out = apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [{ n: 1, title: "A" }] }, at(100));
    expect(out.response).toMatchObject({ ok: true, opened: 1 });
    // One item, holding the placeholder rather than a path — the same answer
    // `parsePlan` produces for a task whose **Files:** block is missing.
    expect(state.work).toHaveLength(1);
    expect(state.work[0]!.paths).toEqual(["(no declared path)"]);
  });

  test("paths that are not a list of paths open no items at all", () => {
    // `paths: "nope"` used to be iterated as a STRING: four items, one per
    // character, each holding a one-letter path.
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [{ n: 1, title: "A", paths: "nope" }],
    }, at(100));
    expect(state.work).toHaveLength(1);
    expect(state.work[0]!.paths).toEqual(["(no declared path)"]);
  });

  test("one malformed task refuses the whole frame, without dispatching the well-formed ones", () => {
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), { paths: ["b.ts"] }],
    }, at(100));
    expect(out.response.ok).toBe(false);
    expect(state.work).toHaveLength(0);
  });

  test("a task that is not an object at all is named by position", () => {
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), null],
    }, at(100));
    expect(out.response).toMatchObject({ error: { code: "UNKNOWN_OP" } });
    expect((out.response as unknown as { error: { message: string } }).error.message).toContain("position 2");
  });

  // Not reachable over the wire — JSON has no NaN literal — but `apply` is the
  // reducer boundary, and any in-process caller reaches it directly. A task
  // number that is not a number is the whole of what this refusal is for:
  // `waves()` would sort by it and `itemsByTask` would key on the string "NaN".
  test("NaN is not a task number", () => {
    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [{ n: Number.NaN, title: "A", paths: ["a.ts"] }],
    }, at(100));
    expect(out.response.ok).toBe(false);
    expect(state.plan).toBeNull();
  });

  // The guard sits above the `running` check for the same reason the
  // empty-plan guard does: refusing must never cost the running plan.
  test("a malformed --replace refuses without withdrawing anything", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const one = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: one.id }, at(200));

    const out = apply(state, coord, {
      v: 1, op: "plan", goal: "g2", spec: null, replace: true, tasks: [{ n: 9 }, "not a task"],
    }, at(300));
    expect(out.response.ok).toBe(false);
    expect(state.work.find((w) => w.id === one.id)?.state).toBe("taken");
    expect(state.plan!.goal).toBe("g");
  });

  // Reading rather than casting must be the identity on everything the CLI
  // actually sends, or the fix would be a behaviour change wearing a guard.
  test("a well-formed task survives the read untouched", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null,
      tasks: [{ n: 4, title: "Refactor", paths: ["src/a.ts", "src/b.ts"], parseError: "capture is partial" }],
    }, at(100));
    expect(state.plan!.tasksByWave[0]![0]).toEqual({
      n: 4, title: "Refactor", paths: ["src/a.ts", "src/b.ts"], parseError: "capture is partial",
    });
    expect(state.work.map((w) => w.paths[0])).toEqual(["src/a.ts", "src/b.ts"]);
    expect(state.work[0]!.title).toBe("Refactor — capture is partial");
  });
});

/**
 * `livePlanItems` looks at every wave the plan has opened, not only the
 * current one. That breadth used to be defended as an inert no-op — a wave
 * advances only when all of its items are `done`, so an unfinished item is
 * always the current wave's — and a line documented as inert is a line the
 * next person deletes.
 *
 * It is not inert. The state below was REACHABLE until `finishWork` learned to
 * refuse a repeated `done`: a second `done` on a finished item of an earlier
 * wave filed a fresh review under that earlier task after `waveIndex` had
 * moved on. It is built by hand here for the same reason `work-footer.test.ts`
 * hand-builds an offered planned task — the pairing is what has to be pinned,
 * not the route that used to produce it.
 */
describe("a second dispatch answers for every wave, not only the current one", () => {
  test("an unfinished item of an earlier wave still refuses the next plan", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["a.ts"])],
    }, at(100));

    // Both waves, all the way through, reviews included. `waveIndex` ends up
    // past the last wave, so the CURRENT wave holds nothing at all — which is
    // what makes this discriminating: a current-wave-only form sees an empty
    // list here and says the plan is over.
    let ms = 200;
    for (const n of [1, 2]) {
      const item = state.work.find((w) => w.title === `Task ${n}` && w.state === "open")!;
      apply(state, worker, { v: 1, op: "take", id: item.id }, at(ms += 10));
      apply(state, worker, { v: 1, op: "done", id: item.id }, at(ms += 10));
      const review = state.work.find((w) => w.kind === "review" && w.reviewOf === item.id)!;
      apply(state, coord, { v: 1, op: "take", id: review.id }, at(ms += 10));
      apply(state, coord, { v: 1, op: "done", id: review.id }, at(ms += 10));
    }
    expect(state.plan!.waveIndex).toBe(2);
    expect(state.plan!.waves[state.plan!.waveIndex]).toBeUndefined();

    // A live review under TASK 1 — wave 0's task — after the plan has moved
    // past every wave it had.
    state.work.push({
      id: "w_hand", paths: ["a.ts"], title: "review: Task 1", evidenceIds: [],
      publishedById: worker, publishedByName: "WORKER", kind: "review", origin: "planned",
      state: "offered", offeredToId: coord, offeredAtMs: T0 + 600,
      takenById: null, orphanedAtMs: null, nudgedAtMs: null, reviewOf: null,
      at: new Date(T0 + 600).toISOString(),
    });
    state.plan!.itemsByTask[1]!.push("w_hand");

    const next = apply(state, coord, { v: 1, op: "plan", goal: "g2", spec: null, tasks: [task(9, ["z.ts"])] }, at(700));
    expect(next.response.ok).toBe(false);
    expect(next.response).toMatchObject({ error: { code: "CONFLICT" } });
    // No wave is named here: the plan is past its last one, and "wave 3 of 2"
    // is the kind of number that looks like an answer and is not one.
    expect((next.response as unknown as { error: { message: string } }).error.message)
      .not.toContain("wave");
    // And it is withdrawn by `--replace`, which is the point of seeing it at
    // all: an item no dispatch can see is an item no dispatch can clear.
    const replaced = apply(state, coord, {
      v: 1, op: "plan", goal: "g2", spec: null, replace: true, tasks: [task(9, ["z.ts"])],
    }, at(800));
    expect(replaced.response).toMatchObject({ ok: true, withdrawn: 1 });
    expect(state.work.find((w) => w.id === "w_hand")).toBeUndefined();
  });
});
