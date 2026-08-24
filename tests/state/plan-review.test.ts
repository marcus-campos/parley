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
/** `parley watch` and the web panel both join exactly like this. */
function joinedAsHuman(state: State, name: string, ms: number): string {
  const out = apply(state, null, {
    v: 1, op: "join", name, mission: "watching", harness: "panel", kind: "human", connected: true,
  }, at(ms));
  return (out.response as unknown as { id: string }).id;
}
const task = (n: number, paths: string[]) => ({ n, title: `Task ${n}`, paths, parseError: null });

let state: State;
let coord: string;
let worker: string;
let auditor: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  apply(state, null, { v: 1, op: "shape", shape: "plan" }, at(0));
  coord = joined(state, "COORD", 10);
  worker = joined(state, "WORKER", 20);
  auditor = joined(state, "AUDITOR", 30);
});

describe("review after every task", () => {
  test("finishing a planned task creates a review item for it", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    expect(review).toBeDefined();
    expect(review.reviewOf).toBe(item.id);
    expect(review.paths).toEqual(item.paths);
  });

  test("the front that did the work is never offered its own review", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    expect(review.offeredToId).not.toBe(worker);
  });

  test("a wave is not finished until its reviews are", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["a.ts"])],
    }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));
    expect(state.plan!.waveIndex).toBe(0);

    // Whoever it landed on — the rule says only "not the author," never a
    // specific front — closes it out, and only then does the wave move.
    // Captured before `take`, which mutates `offeredToId` back to null on
    // the same object.
    const review = state.work.find((w) => w.kind === "review")!;
    const reviewer = review.offeredToId!;
    apply(state, reviewer, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, reviewer, { v: 1, op: "done", id: review.id, summary: "validated and committed" }, at(500));
    expect(state.plan!.waveIndex).toBe(1);
  });

  test("in shape pool a review item is published by hand, and behaves the same", () => {
    apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(600));
    const out = apply(state, worker, {
      v: 1, op: "work", title: "check my responsive pass", paths: ["b.ts"], kind: "review",
    }, at(700));
    expect(out.response.ok).toBe(true);
    expect(state.work.find((w) => w.paths[0] === "b.ts")!.kind).toBe("review");
  });

  test("no review is created in shape pool automatically — nobody agreed to one", () => {
    apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(600));
    apply(state, worker, { v: 1, op: "work", title: "x", paths: ["c.ts"] }, at(700));
    const item = state.work.find((w) => w.paths[0] === "c.ts")!;
    apply(state, auditor, { v: 1, op: "take", id: item.id }, at(800));
    apply(state, auditor, { v: 1, op: "done", id: item.id }, at(900));
    expect(state.work.filter((w) => w.kind === "review" && w.reviewOf === item.id)).toHaveLength(0);
  });

  // Scarcity: the rule says "never fall back to the author," not merely
  // "prefer someone else." With only one live front, that front is both the
  // author and the only candidate — an implementation that fell back to it
  // when the candidate pool is empty would still pass every other test here,
  // since all of them join at least two agents.
  test("with no other front available, the review is published open — never to the author", () => {
    const solo = initialState("advisory");
    apply(solo, null, { v: 1, op: "shape", shape: "plan" }, at(1000));
    const only = joined(solo, "ONLY", 1010);
    apply(solo, only, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["z.ts"])] }, at(1100));
    const item = solo.work[0]!;
    apply(solo, only, { v: 1, op: "take", id: item.id }, at(1200));
    apply(solo, only, { v: 1, op: "done", id: item.id }, at(1300));

    const review = solo.work.find((w) => w.kind === "review" && w.reviewOf === item.id)!;
    expect(review.state).toBe("open");
    expect(review.offeredToId).toBeNull();
  });

  /**
   * The reviewer is picked from live AGENTS, and the filter is load-bearing in
   * the ordinary setup rather than in a corner: `parley watch` and the web
   * panel both join `kind: "human"`, so a person following along is a live
   * participant on every bus somebody is actually watching.
   *
   * Offer them a review and it stalls the wave for `OFFER_TTL_MS` — the offer
   * is exclusive, the panel has no way to take it, and every agent that tries
   * is refused until `tick`'s rule 5 lets go five minutes later. A person
   * watching their own plan run would be the thing that stopped it.
   */
  test("a review is never offered to a person watching the panel, even when they joined first", () => {
    const watched = initialState("advisory");
    apply(watched, null, { v: 1, op: "shape", shape: "plan" }, at(1000));
    // Joined before the agent on purpose: participant order is join order, so
    // a selection that only skipped the author would land on the panel here.
    const panel = joinedAsHuman(watched, "PANEL", 1010);
    const hand = joined(watched, "HAND", 1020);
    const other = joined(watched, "OTHER", 1030);

    apply(watched, hand, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(1100));
    const item = watched.work[0]!;
    apply(watched, hand, { v: 1, op: "take", id: item.id }, at(1200));
    apply(watched, hand, { v: 1, op: "done", id: item.id }, at(1300));

    const review = watched.work.find((w) => w.kind === "review")!;
    expect(watched.participants[panel]!.kind).toBe("human");
    expect(review.offeredToId).toBe(other);
  });

  test("with nobody live but a person, the review is open — an offer they cannot answer is worse than none", () => {
    const watched = initialState("advisory");
    apply(watched, null, { v: 1, op: "shape", shape: "plan" }, at(1000));
    const panel = joinedAsHuman(watched, "PANEL", 1010);
    const hand = joined(watched, "HAND", 1020);

    apply(watched, hand, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(1100));
    const item = watched.work[0]!;
    apply(watched, hand, { v: 1, op: "take", id: item.id }, at(1200));
    const out = apply(watched, hand, { v: 1, op: "done", id: item.id }, at(1300));

    const review = watched.work.find((w) => w.kind === "review")!;
    expect(watched.participants[panel]!.kind).toBe("human");
    expect(review.state).toBe("open");
    expect(review.offeredToId).toBeNull();
    // And the announcement says so, rather than naming a front nobody can act as.
    expect(out.broadcast.some((e) => e.text.includes("review needed") && e.text.includes("open"))).toBe(true);
    expect(out.broadcast.some((e) => e.text.includes("PANEL"))).toBe(false);
  });

  // C1: a review is `origin: "planned"`, and `drop` used to refuse every
  // planned item — while `poolFooterFor` named this one in the offeree's
  // footer with `parley drop <id>` appended, so the footer advertised a
  // command that could only ever fail. A review really is an offer: it is made
  // to one named front, and the offer buys first refusal, not obedience. `tick`
  // already returns it to the pool when OFFER_TTL_MS runs out, so refusing the
  // drop never kept the review — it only made the front wait for the timeout.
  test("a review offered to a front can be handed back, and goes to the pool", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    const offeree = review.offeredToId!;
    const dropped = apply(state, offeree, { v: 1, op: "drop", id: review.id, reason: "not my depth" }, at(400));

    expect(dropped.response.ok).toBe(true);
    expect(review.state).toBe("open");
    expect(review.offeredToId).toBeNull();

    // The hand-back is only worth anything if somebody else can then pick it
    // up — the wave still does not advance until this review is done.
    const other = [coord, auditor].find((p) => p !== offeree)!;
    expect(apply(state, other, { v: 1, op: "take", id: review.id }, at(500)).response.ok).toBe(true);
    expect(state.plan!.waveIndex).toBe(0);
  });

  // The other half of the same rule: a planned TASK is a dispatch, and stays
  // one. Only `kind: "review"` earns the refusal exemption, so a fix that
  // simply deleted the planned check would fail here.
  test("a planned task is still refused, taken or offered", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));

    const dropped = apply(state, worker, { v: 1, op: "drop", id: item.id }, at(300));
    expect(dropped.response).toMatchObject({ ok: false, error: { code: "NOT_OWNER" } });
    expect(item.state).toBe("taken");
  });

  // Two different refusals, and the caller has to be able to tell them apart:
  // "the plan put this here" is a rule, "that is not yours" is a typo. The
  // ownership check used to sit AFTER the planned check, so a front dropping
  // an id it never held was told about dispatch authority instead.
  test("a front dropping a planned task it never held is told that, not the dispatch rule", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));

    const wrong = apply(state, auditor, { v: 1, op: "drop", id: item.id }, at(300));
    expect(wrong.response).toMatchObject({ ok: false, error: { code: "NOT_TAKEN" } });
    expect((wrong.response as unknown as { error: { message: string } }).error.message)
      .toContain("not offered to you");
    expect(item.state).toBe("taken");
    expect(item.takenById).toBe(worker);
  });

  // I1: `WorkItem.evidenceIds` is documented as ids of a Note and a
  // CommandResult, and `evidenceFor` resolves strictly against `state.notes`
  // and `state.results` — a `w_*` id is neither, so putting the reviewed
  // item's id there made a reference that can never resolve. `openWave`
  // carries a comment refusing exactly that for `plan.spec`. What the reviewer
  // needs is the item under review, and `reviewOf` already holds it.
  test("a review names no evidence id that cannot resolve; take returns the item under review", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    expect(review.evidenceIds).not.toContain(item.id);
    for (const id of review.evidenceIds) expect(id.startsWith("w_")).toBe(false);

    const took = apply(state, review.offeredToId!, { v: 1, op: "take", id: review.id }, at(400));
    const d = took.response as unknown as { reviewing: { id: string; title: string; takenById: string } | null };
    expect(d.reviewing?.id).toBe(item.id);
    expect(d.reviewing?.title).toBe(item.title);
    expect(d.reviewing?.takenById).toBe(worker);
  });

  // The key is always present, so a consumer never has to tell "no review
  // here" apart from "this build does not send it".
  test("taking something that is not a review reports no item under review", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    const took = apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    expect((took.response as unknown as { reviewing: unknown }).reviewing).toBeNull();
  });

  // Part 1. `take` is not gated on "never your own review" — an offer buys
  // first refusal, not obedience, and a gate would deadlock the single-front
  // case, where the review can only ever be open to its author. The fact is
  // disclosed instead, which is the whole enforcement mechanism once
  // compulsion is off the table: without it every surface reports a completed,
  // reviewed wave and nothing anywhere says the review was self-administered.
  test("a front taking the review of its own work is told so, and so is the bus", () => {
    const solo = initialState("advisory");
    apply(solo, null, { v: 1, op: "shape", shape: "plan" }, at(2000));
    const only = joined(solo, "ONLY", 2010);
    apply(solo, only, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["z.ts"])] }, at(2100));
    const item = solo.work[0]!;
    apply(solo, only, { v: 1, op: "take", id: item.id }, at(2200));
    apply(solo, only, { v: 1, op: "done", id: item.id }, at(2300));

    const review = solo.work.find((w) => w.kind === "review")!;
    expect(review.state).toBe("open");   // the only path a single front has

    const took = apply(solo, only, { v: 1, op: "take", id: review.id }, at(2400));
    expect((took.response as unknown as { selfReview: boolean }).selfReview).toBe(true);
    expect(took.broadcast.map((e) => e.text).join("\n")).toContain("self-review");
  });

  test("a review taken by anyone else is not reported as one", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    const took = apply(state, review.offeredToId!, { v: 1, op: "take", id: review.id }, at(400));
    expect((took.response as unknown as { selfReview: boolean }).selfReview).toBe(false);
    expect(took.broadcast.map((e) => e.text).join("\n")).not.toContain("self-review");
  });

  // The two-command shortcut a reviewer found: the offeree hands the review
  // back, it goes to the pool open, and the author takes it. Nothing refuses
  // that — so it has to be the case that says so, not only the solo one.
  test("the author taking a review handed back to the pool is still reported as self-review", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    apply(state, review.offeredToId!, { v: 1, op: "drop", id: review.id }, at(400));
    const took = apply(state, worker, { v: 1, op: "take", id: review.id }, at(500));
    expect(took.response.ok).toBe(true);
    expect((took.response as unknown as { selfReview: boolean }).selfReview).toBe(true);
  });

  // `kind` is half the predicate and the half a "publishedById === me" fix
  // would drop. Taking back work you published yourself is ordinary — it is
  // not a review of anything, and calling it one would be a false disclosure.
  test("taking back work you published yourself is not a self-review", () => {
    apply(state, null, { v: 1, op: "shape", shape: "pool" }, at(600));
    apply(state, worker, { v: 1, op: "work", title: "x", paths: ["d.ts"] }, at(700));
    const item = state.work.find((w) => w.paths[0] === "d.ts")!;
    const took = apply(state, worker, { v: 1, op: "take", id: item.id }, at(800));
    expect((took.response as unknown as { selfReview: boolean }).selfReview).toBe(false);
  });

  // The key is always present for the same reason `reviewing` is: a consumer
  // must never have to tell "not a self-review" apart from "this build does
  // not send it".
  test("every take answers the question, including the ones that are not reviews", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const took = apply(state, worker, { v: 1, op: "take", id: state.work[0]!.id }, at(200));
    expect((took.response as unknown as { selfReview: unknown }).selfReview).toBe(false);
  });

  // A review is `kind: "review"`, never `kind: "work"` — the guard in
  // finishWork checks exactly that. Without it, closing a review under
  // shape plan would spawn a review of the review, and so on forever.
  test("finishing a review creates no review of the review", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));

    const review = state.work.find((w) => w.kind === "review")!;
    const reviewer = review.offeredToId!;
    apply(state, reviewer, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, reviewer, { v: 1, op: "done", id: review.id, summary: "looks good" }, at(500));

    expect(state.work.filter((w) => w.kind === "review" && w.reviewOf === review.id)).toHaveLength(0);
  });
});

/**
 * A retried `done` — the front sent it, the answer was lost, it sent it again.
 * `done` never clears `takenById`, so the finisher is the ONLY front that can
 * reach the branch at all: there is no third party to protect here, only the
 * duplicate to refuse.
 */
describe("done is terminal: a second done files no second review", () => {
  test("the retry is refused, not absorbed", () => {
    apply(state, coord, { v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"])] }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    expect(apply(state, worker, { v: 1, op: "done", id: item.id }, at(300)).response.ok).toBe(true);

    const again = apply(state, worker, { v: 1, op: "done", id: item.id }, at(400));
    expect(again.response.ok).toBe(false);
    expect(again.response).toMatchObject({ error: { code: "NOT_TAKEN" } });
    expect(state.work.filter((w) => w.kind === "review" && w.reviewOf === item.id)).toHaveLength(1);
    expect(again.broadcast).toHaveLength(0);
  });

  // The expensive half. A second review under the same task is a review the
  // wave gate then waits for and nobody asked for, so the next wave never
  // opens — a plan wedged by a retry, with every response `ok`.
  test("a retried done does not wedge the next wave", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["a.ts"])],
    }, at(100));
    const item = state.work[0]!;
    apply(state, worker, { v: 1, op: "take", id: item.id }, at(200));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(300));
    apply(state, worker, { v: 1, op: "done", id: item.id }, at(310));

    const reviews = state.work.filter((w) => w.kind === "review" && w.reviewOf === item.id);
    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    const reviewer = review.offeredToId!;
    apply(state, reviewer, { v: 1, op: "take", id: review.id }, at(400));
    apply(state, reviewer, { v: 1, op: "done", id: review.id }, at(500));

    expect(state.plan!.waveIndex).toBe(1);
    expect(state.work.some((w) => w.title === "Task 2" && w.state === "open")).toBe(true);
  });

  // The control, so the refusal cannot be mistaken for "done never answers
  // twice about anything": a DIFFERENT item the same front holds still closes.
  test("it refuses the duplicate, not the front", () => {
    apply(state, coord, {
      v: 1, op: "plan", goal: "g", spec: null, tasks: [task(1, ["a.ts"]), task(2, ["b.ts"])],
    }, at(100));
    const [one, two] = [state.work[0]!, state.work[1]!];
    apply(state, worker, { v: 1, op: "take", id: one.id }, at(200));
    apply(state, worker, { v: 1, op: "take", id: two.id }, at(210));
    apply(state, worker, { v: 1, op: "done", id: one.id }, at(300));
    apply(state, worker, { v: 1, op: "done", id: one.id }, at(310));

    const second = apply(state, worker, { v: 1, op: "done", id: two.id }, at(400));
    expect(second.response.ok).toBe(true);
    expect(two.state).toBe("done");
  });
});
