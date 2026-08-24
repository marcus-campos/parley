import { err, ok } from "../protocol/types";
import { matchesPath, normalizeTerritoryPath, readPathList } from "../repo/paths";
import { waves as computeWaves } from "../plan/graph";
import type { PlanTask } from "../plan/parse";
import { staleReason } from "./results";
import {
  actorOf, liveParticipants, pushEvent,
  type ConvEvent, type Ctx, type Outcome, type Participant, type State, type WorkItem,
} from "./types";

/**
 * Who already owns this path, if anyone.
 *
 * Possession is what routes discovered work — no plan, no parent. It buys the
 * first refusal and nothing more: the item is an offer, and the owner may drop
 * it. Otherwise the front that discovered the work would have acquired
 * authority over the front that holds the file, which is the hierarchy this
 * whole system exists to do without.
 *
 * Not the same function as `ownerOfPath` in `territory.ts`, on purpose: that one
 * serves permissions and may lean on the no-overlapping-live-claims invariant
 * `claim` enforces, while this one must still answer correctly when a replayed
 * journal has broken it. Different correctness contracts, so not collapsed.
 *
 * A path that does not exist yet is still a path. `parley work "…" TBD` routes
 * the item at whoever holds `**`, because `matchesPath("**", …)` is true for
 * any string — and that is the tolerance being chosen rather than an accident.
 * Work is published about a file that is about to be created all the time, and
 * nothing here could tell that apart from a placeholder somebody typed. The
 * cost is bounded and clears itself: an offer, exclusive only for
 * `OFFER_TTL_MS`, which its holder may drop. The one string exempted is
 * `openWave`'s "(no declared path)", and it is exempted THERE rather than
 * here, because it is a label parley writes — never something a person typed.
 */
export function ownerForPath(state: State, path: string, exceptId: string): string | null {
  const live = new Set(liveParticipants(state).map((p) => p.id));
  const candidates = state.claims.filter(
    (c) => c.orphanedAtMs === null && c.ownerId !== exceptId && live.has(c.ownerId) && matchesPath(c.pattern, path),
  );
  if (candidates.length === 0) return null;
  // Specific beats broad; on a tie the older claim wins. Deterministic, and the
  // loser is never consulted — this is a routing hint, not a permission.
  const best = candidates.reduce((a, b) => {
    const bySegments = b.pattern.split("/").length - a.pattern.split("/").length;
    if (bySegments !== 0) return bySegments > 0 ? b : a;
    const byWildcard = (a.pattern.includes("*") ? 1 : 0) - (b.pattern.includes("*") ? 1 : 0);
    if (byWildcard !== 0) return byWildcard > 0 ? b : a;
    return a.lastTouchMs <= b.lastTouchMs ? a : b;
  });
  return best.ownerId;
}

/**
 * A front publishes what it found. One item per path, because the unit of
 * territory is the path — which is what lets an owner refuse two files and keep
 * ten, and lets the pool receive exactly what was refused.
 */
export function publishWork(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  if (state.shape === "bus") {
    return { state, response: err("UNKNOWN_OP", "there is no pool in shape bus — parley shape pool"), broadcast: [] };
  }

  const title = typeof frame.title === "string" ? frame.title.trim() : "";
  if (!title) return { state, response: err("UNKNOWN_OP", "a work item needs a title"), broadcast: [] };

  const paths = readPathList(frame.paths);
  if (paths.length === 0) return { state, response: err("UNKNOWN_OP", "a work item needs at least one path"), broadcast: [] };

  const evidenceIds = Array.isArray(frame.evidence)
    ? frame.evidence.filter((e): e is string => typeof e === "string")
    : [];
  const kind = frame.kind === "review" ? "review" : "work";

  const created: WorkItem[] = [];
  for (const path of paths) {
    const ownerId = ownerForPath(state, path, me.id);
    const item: WorkItem = {
      id: ctx.nextId("w"),
      paths: [path],
      title,
      evidenceIds,
      publishedById: me.id,
      publishedByName: me.name,
      kind,
      // NOT read off the frame. `origin` decides whether the item can be
      // refused (see `droppable`), so a front able to set it could publish
      // work its offeree is forbidden to hand back — and this routes the item
      // straight AT the front that already holds the path. That is the
      // hierarchy `ownerForPath` above exists to prevent: the front that
      // discovered the work acquiring authority over the front that holds the
      // file. Only a dispatched plan makes a planned item, and `openWave` is
      // the only place that says so.
      origin: "discovered",
      state: ownerId ? "offered" : "open",
      offeredToId: ownerId,
      offeredAtMs: ownerId ? ctx.nowMs : null,
      takenById: null,
      orphanedAtMs: null,
      reviewOf: typeof frame.reviewOf === "string" ? frame.reviewOf : null,
      at: ctx.now,
      nudgedAtMs: null,
    };
    state.work.push(item);
    created.push(item);
  }
  me.lastSeenMs = ctx.nowMs;

  const broadcast = [pushEvent(state, ctx, {
    kind: "system", from: null, to: null, priority: "normal",
    text: `${me.name} published ${created.length} item(s): ${title}`,
    about: me.id,
  })];

  return {
    state,
    response: ok({
      items: created.map((i) => ({ id: i.id, path: i.paths[0]!, state: i.state, offeredTo: i.offeredToId })),
    }),
    broadcast,
  };
}

/**
 * Everything the running plan published that is not finished yet — across
 * every wave it has opened, tasks and the reviews their `done` spawned alike,
 * since `finishWork` files those under the same task number.
 *
 * This is the whole of what a second dispatch would have to answer for, and
 * the only thing that distinguishes "a plan is running" from "a plan ran".
 *
 * **Every wave, not only the current one, and that breadth is load-bearing.**
 * The narrow form — the ids of `plan.waves[plan.waveIndex]` alone — was
 * argued once as an equivalent no-op, on the grounds that a wave only advances
 * when every one of its items is `done`, so a plan's unfinished items are
 * always the current wave's. That invariant was reachable-FALSE, and the
 * disagreement was not academic: a repeated `done` on a finished item of an
 * EARLIER wave filed a fresh `offered` review under that earlier task while
 * `waveIndex` had already moved on, and against that state the narrow form
 * answered `ok` and stacked a second plan beside live work nothing tracked —
 * the exact failure the refusal exists to prevent. `finishWork` now refuses
 * the repeat, so nothing reachable produces that state today. This form does
 * not depend on it staying that way, which is the whole reason it is the one
 * kept, and the test builds the state by hand to say so out loud rather than
 * leaving it as an assertion about the future.
 */
function livePlanItems(state: State): WorkItem[] {
  const plan = state.plan;
  if (!plan) return [];
  const ids = new Set(Object.values(plan.itemsByTask).flat());
  return state.work.filter((w) => ids.has(w.id) && w.state !== "done");
}

/**
 * The tasks of a `plan` frame, read rather than cast.
 *
 * This used to be `frame.tasks as PlanTask[]`, and a cast is not a check. A
 * task without `paths` threw inside `openWave` — contained at runtime (the
 * daemon kept serving every other front; only the sender lost that one reply,
 * bounded by the client's own timeout) which is exactly what hid it, because
 * `handleFrame` journals BEFORE applying. The poisoned frame was on disk, and
 * the next start replayed it: the bus never came up at all.
 *
 * `readPathList` next door states the tolerant half of the rule this restores
 * — a frame is whatever a harness on the other end sent, and never a reason
 * for the daemon to throw — and `title` and `parseError` are coerced exactly
 * that way.
 *
 * Two fields are refused instead of coerced, for one shared reason: coercing
 * either makes the daemon assert something the caller never said.
 *
 * `n` is refused rather than invented. It is the only field the plan's
 * arithmetic keys on — `waves()` seats by it, `itemsByTask` is keyed by it,
 * `taskNumberOf` reads it back, and every "task N is waiting" prints it.
 * Supplying a number the caller did not send would be inventing the plan,
 * which is the same fabrication as merging two plans' waves: a number shaped
 * like an answer, standing for nothing.
 *
 * `paths` is refused rather than emptied, which is that same argument one
 * field over — see `readTaskPaths` below for why emptying it was the quieter
 * invention of the two.
 *
 * The shipped CLI cannot send any of this — `parsePlan` always emits
 * well-formed tasks. The wire can: unix transport has no auth, and a
 * version-skewed parley on the same socket is an ordinary thing to have in a
 * checkout running several worktrees.
 */
/**
 * The paths of one task, refused rather than emptied.
 *
 * `paths` is what the collision proof keys on. `waves()` computes the plan's
 * one guarantee — two tasks touching the same file never open in the same wave
 * — from these strings and nothing else, so dropping an element the caller DID
 * send asserts "this task declared nothing", which is as much an invention as
 * supplying an `n`. It was the quieter of the two: a version-skewed front
 * sending `paths: "src/a.ts"`, or `[{path:"src/a.ts"}]` under an
 * object-per-path schema, produced a plan byte-identical to the legitimate
 * declared-nothing plan — same waves, same `(no declared path)` items, no
 * waiting broadcast, no `parseError` in the title. Two tasks over one file
 * opened together and nothing anywhere named the loss. A PARTIAL drop was
 * worse still: `["src/a.ts", {path:"src/b.ts"}]` keeps a real path, so it does
 * not even look like a task that declared nothing, while the b.ts collision it
 * was supposed to be serialised against is gone.
 *
 * So this is the strict sibling of `readPathList`, which is right to be
 * tolerant where it is used: `publishWork` reads ONE item's paths and refuses
 * outright on an empty result, so nothing there can silently mean less than it
 * said. `openWave` is the one place that substitutes a label instead, and what
 * has to stop being reachable is a substitution standing for a path the caller
 * sent.
 *
 * Omitted and `null` are still legitimately empty, which narrows the rule from
 * "present but not an array of strings" on purpose. Neither can hide a file
 * name — they are the two JSON spellings of nothing, so reading them as
 * "declared nothing" discards no declaration and cannot void the proof. What
 * is refused is content that could not be read, INCLUDING an element-wise
 * miss: one lost path voids the serialisation just as completely as all of
 * them, and leaves less trace.
 *
 * A string that is not a repository path is refused rather than skipped for
 * the same reason. `parsePlan` normalises every path it emits, so the shipped
 * CLI cannot reach this, and a caller naming `../outside.ts` has declared a
 * file the plan cannot reason about at all.
 *
 * The offending value is never echoed back into the error: the position is
 * what repairs the frame, and the value is the caller's own unbounded string.
 */
type ReadPaths = { ok: true; paths: string[] } | { ok: false; why: string };

function readTaskPaths(value: unknown): ReadPaths {
  if (value === undefined || value === null) return { ok: true, paths: [] };
  if (!Array.isArray(value)) return { ok: false, why: "declares paths that are not a list" };
  const paths: string[] = [];
  for (const [i, p] of value.entries()) {
    if (typeof p !== "string") {
      return { ok: false, why: `declares a path at position ${i + 1} that is not a string` };
    }
    try {
      paths.push(normalizeTerritoryPath(p));
    } catch {
      return { ok: false, why: `declares a path at position ${i + 1} that is not a repository path` };
    }
  }
  return { ok: true, paths };
}

type ReadTasks = { ok: true; tasks: PlanTask[] } | { ok: false; why: string };

function readPlanTasks(value: unknown): ReadTasks {
  if (!Array.isArray(value)) return { ok: true, tasks: [] };
  const tasks: PlanTask[] = [];
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, why: `task at position ${i + 1} is not an object` };
    }
    const t = raw as Record<string, unknown>;
    if (typeof t.n !== "number" || !Number.isFinite(t.n)) {
      return { ok: false, why: `task at position ${i + 1} has no task number` };
    }
    const paths = readTaskPaths(t.paths);
    if (!paths.ok) return { ok: false, why: `task at position ${i + 1} ${paths.why}` };
    tasks.push({
      n: t.n,
      title: typeof t.title === "string" ? t.title : "",
      paths: paths.paths,
      parseError: typeof t.parseError === "string" ? t.parseError : null,
    });
  }
  return { ok: true, tasks };
}

/**
 * A superpowers plan is dispatched one wave at a time: only the first wave's
 * tasks become work now, and every later wave waits for `finishWork` to open
 * it once its predecessor is entirely done.
 *
 * The waves are computed here, once, from the paths every task declares —
 * `waves()` is a proof those tasks cannot collide, not a guess that they
 * probably do not.
 *
 * **One plan runs at a time, and a second dispatch is refused.** The whole
 * feature computes one rule — two tasks touching the same file never open in
 * the same wave — and `waves()` can only prove it over the tasks it was
 * handed. Stacking a second plan on top publishes a second set of open items
 * over the same paths that no collision graph ever compared, which is the
 * exact failure the graph exists to make impossible: two fronts editing one
 * file, concurrently, each holding a legitimately-taken item. `state.plan`
 * holding only the newest plan makes it worse rather than better — the older
 * plan's items stay in `state.work` with nothing left tracking them, so their
 * wave can never advance and `droppable` refuses every hand-back.
 *
 * Merging is not on offer either: the second plan's waves would have to be
 * recomputed against tasks that are already taken or done, and a wave index
 * means nothing across two orderings.
 *
 * `replace` is the deliberate way through, and it is what the README's
 * "re-sequence" names. It withdraws what the running plan published and has
 * not finished — including items a front is holding, announced by name — and
 * dispatches the new plan from wave 0. A plan whose every item is done is not
 * running, so a fresh dispatch after it needs no flag.
 *
 * **`replace` is not gated on who dispatched the plan, and that is a ruling
 * rather than an inherited default.** It does not get to borrow `take`'s
 * argument for being ungated — that one was "this is non-destructive", and
 * withdrawing work another front is holding is not. Its own argument is that
 * the gate would put the release valve behind the participant most likely to
 * be gone. A front that dispatched a plan and then died leaves items nothing
 * can clear: `droppable` refuses every hand-back, no wave will advance, and
 * restarting the daemon replays the same journal into the same state. So the
 * gate would re-create, in exactly the case that matters most, the wedge this
 * flag exists to open. It is paid for the way parley pays for everything else
 * it declines to police — the withdrawal is broadcast at `priority: "high"`,
 * naming who re-sequenced and every front that was holding something.
 */
export function dispatchPlan(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  if (state.shape !== "plan") {
    return { state, response: err("UNKNOWN_OP", "plans are dispatched in shape plan — parley shape plan"), broadcast: [] };
  }
  // Both of these refuse BEFORE anything is withdrawn, which is the whole
  // reason they sit above the `running` check: `parley plan typo.md --replace`
  // must not destroy the running plan on its way to saying no.
  const read = readPlanTasks(frame.tasks);
  if (!read.ok) return { state, response: err("UNKNOWN_OP", `malformed plan: ${read.why}`), broadcast: [] };
  const tasks = read.tasks;
  // Load-bearing, not defensive: `openWave` is called with `tasksByWave[0]!`
  // below, and `computeWaves([])` returns no waves at all — so without this a
  // markdown file with no `### Task` heading in it throws inside the daemon.
  // Pointing `parley plan` at the wrong file is the reachable input.
  if (tasks.length === 0) return { state, response: err("UNKNOWN_OP", "a plan needs tasks"), broadcast: [] };

  const running = livePlanItems(state);
  if (running.length > 0 && frame.replace !== true) {
    const held = [...new Set(running.map((w) => w.takenById).filter((id): id is string => id !== null))]
      .map((id) => state.participants[id]?.name ?? id);
    // The count is about the PLAN, not about one wave — `livePlanItems` spans
    // every wave the plan has opened, on purpose. Naming the wave beside the
    // count read as "N items of that wave", which is a claim this refusal is
    // not entitled to make; the position is stated separately, and only while
    // the plan still has a wave to be on.
    const plan = state.plan!;
    const where = plan.waves[plan.waveIndex] ? ` (on wave ${plan.waveIndex + 1} of ${plan.waves.length})` : "";
    return {
      state,
      response: err(
        "CONFLICT",
        `a plan is already running${where}: ${running.length} item(s) not done` +
          `${held.length > 0 ? ` (${held.join(", ")} holding)` : ""}` +
          " — finish it, or re-sequence with parley plan <file> --replace",
      ),
      broadcast: [],
    };
  }

  const computed = computeWaves(tasks);
  me.lastSeenMs = ctx.nowMs;

  const broadcast: ConvEvent[] = [];
  if (running.length > 0) {
    // Withdrawn, not left behind: an item whose plan is gone is tracked by
    // nothing, advances no wave, and — being `planned` and `work` — cannot be
    // dropped by the front holding it either. Leaving it in the pool would be
    // the residue this refusal exists to prevent, one flag later.
    const withdrawn = new Set(running.map((w) => w.id));
    state.work = state.work.filter((w) => !withdrawn.has(w.id));
    const held = [...new Set(running.map((w) => w.takenById).filter((id): id is string => id !== null))]
      .map((id) => state.participants[id]?.name ?? id);
    broadcast.push(pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "high",
      text: `${me.name} re-sequenced the plan: ${running.length} unfinished item(s) withdrawn` +
        `${held.length > 0 ? ` — ${held.join(", ")} were holding some of them; stop and read the new wave` : ""}`,
      about: me.id,
    }));
  }

  state.plan = {
    goal: typeof frame.goal === "string" ? frame.goal : "",
    spec: typeof frame.spec === "string" ? frame.spec : null,
    waves: computed.map((w) => ({ taskNumbers: w.tasks.map((t) => t.n) })),
    waveIndex: 0,
    itemsByTask: {},
    tasksByWave: computed.map((w) => w.tasks),
  };

  broadcast.push(pushEvent(state, ctx, {
    kind: "system", from: null, to: null, priority: "high",
    text: `${me.name} dispatched a plan: ${tasks.length} task(s) in ${computed.length} wave(s) — the waves are computed from the paths each task declares`,
    about: me.id,
  }));

  // `opened` comes back from `openWave` rather than being recomputed from the
  // wave's task list: one task opens one item PER DECLARED PATH, so a task
  // count is not an item count, and the caller prints this as "N item(s) open
  // now" right above a `parley works --state open` that would then list more.
  const wave0 = openWave(state, state.plan.tasksByWave[0]!, ctx);
  broadcast.push(...wave0.events);

  return {
    state,
    response: ok({ waves: computed.length, opened: wave0.opened, withdrawn: running.length }),
    broadcast,
  };
}

/** What stands in for `paths[0]` on a task that declared no files. Not a path. */
const NO_DECLARED_PATH = "(no declared path)";

/**
 * Publish every item of one wave.
 *
 * A task is never dropped: a `**Files:**` block that failed to parse still
 * gets an item, titled with the real reason parse.ts gave — never a
 * made-up one, and never "no paths" for a task that has some — so a plan
 * can never look fully dispatched while one of its tasks quietly never
 * happened.
 *
 * Dispatch authority covers fronts working the plan; it never covers a front
 * a person is directing by hand. A path already held under an explicit claim
 * is still published here, open, rather than taken from its holder — the
 * wait is announced instead of silently skipped.
 */
function openWave(state: State, waveTasks: PlanTask[], ctx: Ctx): { events: ConvEvent[]; opened: number } {
  const plan = state.plan!;
  const events: ConvEvent[] = [];
  let opened = 0;
  for (const task of waveTasks) {
    const label = task.title || `task ${task.n}`;
    const title = task.parseError ? `${label} — ${task.parseError}` : label;
    // A task that declared nothing still gets an item — never dropping a task
    // is the rule — but it holds no territory, so `paths[0]` is a label rather
    // than a path. Parenthesised and spaced so no reader mistakes it for one.
    const paths = task.paths.length > 0 ? task.paths : [NO_DECLARED_PATH];
    for (const path of paths) {
      // The label is never matched against a claim, and the test is on the
      // PATH rather than on how this task got here: `matchesPath("**", …)` is
      // true for any string, so looking it up would announce a real person as
      // waiting on a file that does not exist. Asking "did this task declare
      // anything" instead let a client that sent the label itself as a path
      // walk straight back into that.
      //
      // Ruling: dispatch authority covers fronts working the plan, never a
      // front a person is directing by hand — so a held path is published
      // open and announced as waiting, not taken from its owner.
      const holder = path === NO_DECLARED_PATH
        ? undefined
        : state.claims.find((c) => c.orphanedAtMs === null && !c.auto && matchesPath(c.pattern, path));
      const item: WorkItem = {
        id: ctx.nextId("w"),
        paths: [path],
        title,
        // NOT `plan.spec`: `evidenceIds` is documented (see WorkItem) as ids
        // of a Note or a CommandResult, and `evidenceFor` resolves strictly
        // against those two — a spec path is neither, and would sit here as
        // a reference that can never resolve. The honest state for "no
        // resolvable evidence yet" is an empty array, not a made-up id.
        evidenceIds: [],
        publishedById: "",
        publishedByName: "the plan",
        kind: "work",
        origin: "planned",
        state: "open",
        offeredToId: null,
        offeredAtMs: null,
        takenById: null,
        orphanedAtMs: null,
        nudgedAtMs: null,
        reviewOf: null,
        at: ctx.now,
      };
      state.work.push(item);
      opened += 1;
      (plan.itemsByTask[task.n] ??= []).push(item.id);
      if (holder) {
        const owner = state.participants[holder.ownerId];
        events.push(pushEvent(state, ctx, {
          kind: "system", from: null, to: null, priority: "normal",
          text: `task ${task.n} is waiting: ${path} is held by ${owner?.name ?? "someone"} — the plan does not take it`,
        }));
      }
    }
  }
  return { events, opened };
}

/**
 * A wave is not over until every item it dispatched — across every task the
 * wave holds — is done. Checked after every `done`, not only ones known in
 * advance to belong to a plan: the ids in `itemsByTask` can only ever be
 * items `openWave` created, so the check is a no-op whenever there is
 * nothing left to advance.
 */
function advancePlanIfWaveDone(state: State, ctx: Ctx): ConvEvent[] {
  const plan = state.plan;
  if (!plan) return [];
  const wave = plan.waves[plan.waveIndex];
  if (!wave) return [];
  const ids = wave.taskNumbers.flatMap((n) => plan.itemsByTask[n] ?? []);
  // Unreachable today, and kept deliberately rather than by oversight:
  // `openWave` publishes at least one item for every task of the wave it is
  // given (a task with no declared path still gets one), so a wave that has
  // been opened always has ids. What it guards is the shape of the line
  // below — `[].every(...)` is vacuously TRUE, so an empty list would advance
  // a wave that dispatched nothing, silently, and go on to open the next one.
  // A guard against a failure that loud is worth a line that never runs.
  if (ids.length === 0) return [];
  if (!ids.every((id) => state.work.find((w) => w.id === id)?.state === "done")) return [];

  plan.waveIndex += 1;
  const nextTasks = plan.tasksByWave[plan.waveIndex];
  if (!nextTasks) return [];
  return openWave(state, nextTasks, ctx).events;
}

/** Which task an item belongs to, or null for work published outside a plan. */
function taskNumberOf(state: State, itemId: string): number | null {
  if (!state.plan) return null;
  for (const [n, ids] of Object.entries(state.plan.itemsByTask)) {
    if (ids.includes(itemId)) return Number(n);
  }
  return null;
}

export function listWork(state: State, actorId: string | null, frame: Record<string, unknown>): Outcome {
  let work = state.work;
  const wanted = frame.state;
  if (wanted === "open" || wanted === "offered" || wanted === "taken" || wanted === "done") {
    work = work.filter((w) => w.state === wanted);
  }
  if (frame.mine === true && actorId) {
    work = work.filter((w) => w.offeredToId === actorId || w.takenById === actorId);
  }
  return { state, response: ok({ work }), broadcast: [] };
}

function findItem(state: State, frame: Record<string, unknown>) {
  return state.work.find((w) => w.id === String(frame.id ?? ""));
}

/**
 * Notes and results named by an item, resolved once so the taker never
 * rediscovers. A note carries its own truth (`reversedBy` travels with it
 * verbatim), but a `CommandResult` does not: staleness is a read-time
 * function of `(state, result)`, never stamped on the stored object, which
 * always claims `staleBecause: null`. Handing the raw record over would let
 * the taker trust a green result that an intervening touch already
 * invalidated — so it is recomputed here, the same way `listResults` does.
 */
function evidenceFor(state: State, item: { evidenceIds: string[] }) {
  return {
    notes: state.notes.filter((n) => item.evidenceIds.includes(n.id)),
    results: Object.values(state.results)
      .filter((r) => item.evidenceIds.includes(r.key))
      .map((r) => ({ ...r, staleBecause: staleReason(state, r) })),
  };
}

/**
 * A review being taken by the front that published it.
 *
 * That is the whole of what this answers, and the claim is deliberately no
 * wider, because the two paths that create a review differ in what the
 * publisher *is*:
 *
 * - `finishWork` stamps `publishedById` with the front that finished the
 *   reviewed item, so on the plan path the publisher IS the author. This is
 *   enforced, not assumed: no frame reaches that field.
 * - `parley work --kind review` stamps whoever ran the command. It is meant
 *   to be a front asking for a check of its own pass, and that is what the
 *   skill and the README tell it to do — but it is intent, not a constraint.
 *   A front can publish a review of somebody else's work and then take it,
 *   and this returns true for it.
 *
 * So the disclosure means "this review is yours to begin with", which is a
 * self-review on the path that matters — the one the plan drives, where the
 * wave is not over until the review is done and nothing else states who did
 * it. The alternative was to gate on `origin === "planned"` and disclose
 * nothing at all on the hand-published path, which trades a rare overstatement
 * for a silence in the case a front deliberately went looking for a check.
 *
 * One field on one record answers it — no join, no clock, no I/O — and that is
 * what lets every surface ask it. `parley take`, the take event, `parley
 * works`, `parley watch` and the web panel all call this one function, so none
 * of them can disagree about it: the same discipline `droppable` gives `drop`
 * and the footer.
 *
 * The rule is that the front that did the work is never *offered* its own
 * review, and `take` is deliberately not gated on this. An offer buys first
 * refusal, not obedience; and with one live front the review can only ever be
 * open to its author, so a hard block would stall the plan at wave 0 forever —
 * `advancePlanIfWaveDone` waits for every review to be done, and `tick`
 * reclaims only a *taken* item whose holder died. parley states the fact and
 * the reader decides. It is stated flatly on purpose: in a single-front
 * repository self-review is the only path there is, so wording that implied
 * wrongdoing would be wrong as often as it was right.
 *
 * `publishedById: ""` — the stamp `openWave` puts on a dispatched task — needs
 * no guard of its own: such a record is always `kind: "work"`, and no caller
 * passes "" as `frontId` (it is either `me.id` or an item's `takenById`, which
 * is a real id or null).
 */
export function isSelfReview(
  item: { kind: string; publishedById: string },
  frontId: string | null,
): boolean {
  return item.kind === "review" && item.publishedById === frontId;
}

/**
 * Resolving the evidence here, on take, is why the front that picks the item
 * up does not repay the discovery. An item whose evidence does not travel is
 * a chat message that moved house.
 */
export function takeWork(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  const item = findItem(state, frame);
  if (!item) return { state, response: err("UNKNOWN_OP", "no work item with that id"), broadcast: [] };
  if (item.state === "taken" || item.state === "done") {
    return { state, response: err("CONFLICT", `already ${item.state}`), broadcast: [] };
  }
  // A right of first refusal, not a notification: while the offer stands,
  // only the offeree may take it. Letting anyone else grab it would hand them
  // work whose file they may not even be able to edit under an enforced
  // claim, and would leave Task 5's offer expiry with nothing to expire.
  if (item.state === "offered" && item.offeredToId !== me.id) {
    const holder = state.participants[item.offeredToId ?? ""];
    return {
      state,
      response: {
        ...err("CONFLICT", "offered elsewhere — it is not open yet"),
        offeredTo: { id: item.offeredToId, name: holder?.name ?? "(gone)", mission: holder?.mission ?? "" },
      },
      broadcast: [],
    };
  }

  // The item under review, resolved here for the same reason the evidence is:
  // so the reviewer does not have to go and look it up. It travels on its own
  // key rather than through `evidenceIds`, which is typed and documented as
  // note and result ids — a `WorkItem` in there would resolve to nothing and
  // widening `evidenceFor` would push one into a field both its consumers read
  // as `{notes, results}`. Always present, `null` for anything but a review.
  const reviewing = item.reviewOf ? state.work.find((w) => w.id === item.reviewOf) ?? null : null;

  // Refusing to compel AND not stating the fact would not soften the
  // never-your-own-review rule, it would delete it: every surface would report
  // a reviewed wave and nothing would ever say who reviewed it. Always
  // present, so `false` can never be confused with a build that does not send
  // it. See `isSelfReview` for why this is a disclosure and not a gate.
  const selfReview = isSelfReview(item, me.id);

  item.state = "taken";
  item.takenById = me.id;
  item.offeredToId = null;
  item.offeredAtMs = null;
  item.orphanedAtMs = null;
  me.lastSeenMs = ctx.nowMs;

  return {
    state,
    response: ok({
      id: item.id, title: item.title, paths: item.paths,
      evidence: evidenceFor(state, item), reviewing, selfReview,
    }),
    broadcast: [pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "normal",
      text: `${me.name} took ${item.paths[0]} — ${item.title}${selfReview ? " — self-review: its own work" : ""}`,
      about: me.id,
    })],
  };
}

/**
 * Whether `drop` can be accepted for this item at all, independently of who is
 * asking. Asked here and by `poolFooterFor`, so the footer can never name a
 * command the reducer refuses.
 *
 * A planned **task** is a dispatch: the plan put it there and it stays there.
 * A planned **review** is not. It is offered to one named front, exactly like
 * a discovered item offered to the owner of a path, and the offer buys first
 * refusal, not obedience — a front that cannot review this work has to be able
 * to hand it back so it returns to the pool for somebody else. `tick` already
 * does that for it when `OFFER_TTL_MS` runs out (machine.ts rule 5), so
 * refusing the drop never kept the review; it only delayed it.
 */
function droppable(item: WorkItem): boolean {
  return !(item.origin === "planned" && item.kind === "work");
}

/**
 * Possession bought the owner the first refusal, not obedience. If the owner
 * could not refuse, the front that discovered the work would have acquired
 * authority over the front that holds the file — the exact hierarchy this
 * system exists to do without.
 */
export function dropWork(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  const item = findItem(state, frame);
  if (!item) return { state, response: err("UNKNOWN_OP", "no work item with that id"), broadcast: [] };
  // Whether this item is yours is asked BEFORE what kind of item it is, so the
  // refusal names the caller's actual problem. Asked the other way round, a
  // front dropping an id that was never theirs was told "a planned task is
  // dispatched, not offered" — an answer about someone else's item, and one
  // that reads as a rule when the truth is a typo.
  if (item.offeredToId !== me.id && item.takenById !== me.id) {
    return { state, response: err("NOT_TAKEN", "not offered to you and not taken by you"), broadcast: [] };
  }
  // done is terminal, same as takeWork and tick already treat it — a finisher
  // still holds takenById, so without this an already-delivered item could be
  // dropped and redone by someone else.
  if (item.state === "done") {
    return { state, response: err("NOT_TAKEN", "already done"), broadcast: [] };
  }
  // Dispatch is not an offer. A planned task stays where the plan put it — a
  // planned review does not, because a review was offered to a named front.
  if (!droppable(item)) {
    return { state, response: err("NOT_OWNER", "a planned task is dispatched, not offered — it cannot be dropped"), broadcast: [] };
  }

  item.state = "open";
  item.offeredToId = null;
  item.offeredAtMs = null;
  item.takenById = null;
  // A front handing work back is a new stale episode, not a continuation of
  // whichever one earned the last nudge — drop is supposed to be free, and it
  // would quietly stop being free if the pool remembered past the hand-back.
  item.nudgedAtMs = null;
  me.lastSeenMs = ctx.nowMs;
  const reason = typeof frame.reason === "string" ? frame.reason : "";

  return {
    state,
    response: ok({ id: item.id, state: item.state }),
    broadcast: [pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "normal",
      text: `${me.name} passed on ${item.paths[0]}${reason ? ` — ${reason}` : ""}; it is in the pool`,
      about: me.id,
    })],
  };
}

/**
 * Is this front spare capacity right now?
 *
 * One definition, because there were two and they disagreed: `idleFronts`
 * treated a non-auto, non-orphaned claim as busy, and `shouldRetire` ignored
 * claims entirely — so a parley-born front that had claimed `src/api/**` with
 * a declared intent, provably mid-edit, was simultaneously "busy, do not ring
 * it" and "idle, retire it". Whichever of the two is right, they cannot both
 * be, and a front cannot be too busy to be offered work and idle enough to be
 * sent home in the same tick.
 *
 * A human watching the panel is filtered out: they are not a front to
 * dispatch to, and counting them as idle capacity would ring the bell at
 * someone who was never going to pick the item up.
 *
 * An auto-claim does not count as busy either: it is the footprint of an
 * edit, not a declaration of what a front is doing — a session that swept
 * the repository would otherwise look permanently occupied.
 */
function isIdleFront(state: State, p: Participant): boolean {
  if (p.kind !== "agent") return false;
  if (state.claims.some((c) => c.ownerId === p.id && !c.auto && c.orphanedAtMs === null)) return false;
  if (state.work.some((w) => w.state === "taken" && w.takenById === p.id)) return false;
  return true;
}

/**
 * A front parley created, idle, with an empty pool, has no reason to exist —
 * and every minute it stays is money. A front a person opened is never
 * retired, however idle it is: their session is theirs.
 *
 * `graceMs` is what stops a newborn being named on its very first tool call.
 * It is spawned because the pool was stale; between the intent and its first
 * `parley works` another front may well have emptied the pool, and without a
 * grace period the answer to "you were born ten seconds ago" would be "go
 * home" before it had any chance to read what it was born for.
 */
export function shouldRetire(state: State, p: Participant, ctx: Ctx, graceMs: number): boolean {
  if (p.born !== "parley" || p.gone) return false;
  if (!isIdleFront(state, p)) return false;
  const joinedMs = Date.parse(p.joinedAt);
  // A timestamp that will not parse is read as "just arrived", never as
  // "arrived long ago". Unreachable today — `joinedAt` is written by the
  // daemon's own clock — but the two directions are not equally wrong: one
  // costs a front one more grace period, the other retires it on sight.
  if (Number.isNaN(joinedMs) || ctx.nowMs - joinedMs < graceMs) return false;
  if (state.work.some((w) => w.state === "open" || w.state === "offered")) return false;
  return true;
}

/**
 * Alive fronts that are spare capacity — what the doorbell may address.
 *
 * In practice this only ever names a front holding a live connection.
 * `ORPHAN_POOL_MS` is longer than `LEASE_TTL_MS` on purpose: a front that has
 * gone this long without renewing its lease is not idle capacity waiting to
 * be pinged, it is a session waiting for a person to type — the same "on its
 * next tool call, possibly not soon" front `tick`'s rule 1 already declares
 * gone before the doorbell would get the chance to ring for it.
 */
export function idleFronts(state: State): Participant[] {
  return liveParticipants(state).filter((p) => isIdleFront(state, p));
}

const MAX_NAMED_OFFERS = 3;

/**
 * What this front needs to know about the pool, in the fewest lines that can
 * carry it.
 *
 * Named offers, then a count. Dumping the pool into every tool call would cost
 * more tokens than the pool saves — the whole point of ranking anything is that
 * the footer carries the top of it, never the corpus.
 */
export function poolFooterFor(state: State, participantId: string): string {
  if (state.shape === "bus") return "";

  const mine = state.work.filter((w) => w.state === "offered" && w.offeredToId === participantId);
  const open = state.work.filter((w) => w.state === "open");
  if (mine.length === 0 && open.length === 0) return "";

  const lines: string[] = [];
  for (const item of mine.slice(0, MAX_NAMED_OFFERS)) {
    // The `drop` half is offered only where `drop` would be accepted. A footer
    // that names a command the reducer then refuses is worse than a footer
    // that says less: the front runs it, gets an error, and reads parley as
    // broken.
    const how = droppable(item)
      ? `parley take ${item.id}, or parley drop ${item.id}`
      : `parley take ${item.id}`;
    lines.push(`  ${item.paths[0]} — ${item.title} (${how})`);
  }
  if (mine.length > MAX_NAMED_OFFERS) {
    lines.push(`  ${mine.length - MAX_NAMED_OFFERS} more offered to you — parley works --mine`);
  }
  if (open.length > 0) {
    lines.push(`  ${open.length} open in the pool, owned by nobody — parley works --state open`);
  }
  return `parley pool:\n${lines.join("\n")}`;
}

/**
 * A front asking outright for a hand, distinct from the tick-driven birth
 * intent: this one is spoken, not inferred from a stale pool. Same ceiling,
 * same cooldown stamp — a summon that lands under the ceiling still costs a
 * window, so a person spamming the command cannot bypass the rule that
 * governs the automatic path.
 */
export function summonCapacity(
  state: State,
  actorId: string | null,
  frame: Record<string, unknown>,
  ctx: Ctx,
  maxFronts: number,
): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const live = liveParticipants(state).filter((p) => p.kind === "agent").length;

  // The human's voice on spending (§4.7). `allow` present is a different frame
  // from `summon` without it — one settles whether parley may spend at all,
  // the other asks it to spend now — and only one of them is a person's.
  //
  // This carries its own `kind` check rather than joining a general observer
  // guard, because there is no general guard left to join: `feat/human-vote`
  // deleted the one that refused `grant`/`deny`, on the argument that
  // ownership decides who may answer, not kind. Spending somebody's money is
  // the one decision that runs the other way — it blocks an agent and lets
  // only a person through, which is the shape `brain` uses on that branch for
  // exactly the same reason.
  if (frame.allow !== undefined) {
    if (me.kind !== "human") {
      return {
        state,
        response: err(
          "OBSERVER_ONLY",
          "whether parley may start more fronts is the person's call, not a front's — it is somebody's money",
        ),
        broadcast: [],
      };
    }
    const allowed = frame.allow !== false;
    const changed = state.birthsAllowed !== allowed;
    state.birthsAllowed = allowed;
    return {
      state,
      response: ok({ birthsAllowed: allowed, maxFronts, live }),
      // Said once, on the change. Re-affirming a veto that is already in place
      // is not a louder veto.
      broadcast: changed
        ? [pushEvent(state, ctx, {
            kind: "system", from: null, to: null, priority: "high",
            text: allowed
              ? `${me.name} allowed parley to start fronts again`
              : `${me.name} stopped parley starting any more fronts — the pool stays open and the fronts already here keep working`,
            about: me.id,
          })]
        : [],
    };
  }

  // A front asking for a hand cannot spend past a person who said no. The
  // automatic path is refused in `canBearFront`; this is the same refusal on
  // the path somebody asks for by name, and it has to be here too, or the
  // veto would only hold for as long as nobody asked.
  if (!state.birthsAllowed) {
    return { state, response: err("NO_CAPACITY", "a person has stopped parley starting fronts"), broadcast: [] };
  }
  if (live >= maxFronts) {
    return { state, response: err("NO_CAPACITY", `already at ${maxFronts} front(s)`), broadcast: [] };
  }
  state.lastBirthMs = ctx.nowMs;
  const reason = typeof frame.reason === "string" && frame.reason ? frame.reason : "asked for";
  return {
    state,
    response: ok({ summoned: true, reason }),
    broadcast: [pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "high",
      text: `${me.name} asked for a front — ${reason}`,
      about: me.id,
    })],
  };
}

export function finishWork(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };
  const item = findItem(state, frame);
  if (!item) return { state, response: err("UNKNOWN_OP", "no work item with that id"), broadcast: [] };
  if (item.takenById !== me.id) {
    return { state, response: err("NOT_TAKEN", "you are not holding this item"), broadcast: [] };
  }
  // done is terminal here too, and `done` never clears `takenById` — so without
  // this the finisher, and only the finisher, can send `done` again and get a
  // second review filed under the same task. Two ways that hurts, both
  // reproduced: while the plan runs, the wave gate then waits for a review
  // nobody asked for and the next wave never opens; after `--replace`, the
  // second review is filed under a task number the new plan no longer tracks,
  // so it is live work that `livePlanItems` cannot see and no future
  // `--replace` can withdraw. Retry-after-timeout is the reachable input:
  // nothing else can reach this line.
  //
  // Refused rather than absorbed as a no-op. The silent `ok` is what let this
  // live: it told a retrying front that a second `done` had landed when what
  // had landed was a duplicate review. `takeWork` and `dropWork` both already
  // refuse a done item; this is the third of three, worded exactly like
  // `dropWork`'s so the closed list in docs/PROTOCOL.md stays one rule.
  if (item.state === "done") {
    return { state, response: err("NOT_TAKEN", "already done"), broadcast: [] };
  }

  item.state = "done";
  me.lastSeenMs = ctx.nowMs;
  const summary = typeof frame.summary === "string" ? frame.summary : "";

  const broadcast = [pushEvent(state, ctx, {
    kind: "system", from: null, to: null, priority: "normal",
    text: `${me.name} finished ${item.paths[0]}${summary ? ` — ${summary}` : ""}`,
    about: me.id,
  })];

  // superpowers already requires a review after every task. Making it an item
  // is what turns the reviewing front people run by agreement into a state the
  // bus can see: who asked, who took it, and whether the verdict was applied.
  // Only under shape plan, and only for planned work — shape pool already lets
  // a front publish a review by hand, and that stays a choice, not a side effect.
  if (state.shape === "plan" && item.origin === "planned" && item.kind === "work") {
    // The front that did the work is never offered its own review — that
    // would just be the old convention wearing a state field. If nobody
    // else is live, the review goes to the pool open rather than falling
    // back to the author.
    const reviewer = liveParticipants(state).find((p) => p.id !== me.id && p.kind === "agent");
    const review: WorkItem = {
      id: ctx.nextId("w"),
      paths: [...item.paths],
      title: `review: ${item.title}`,
      // NOT `item.id`: `evidenceIds` is documented (see WorkItem) as ids of a
      // Note or a CommandResult, and `evidenceFor` resolves strictly against
      // those two — a `w_*` id is neither, so it would sit here as a reference
      // that can never resolve. That is the same defect `openWave` refuses
      // above. What the reviewer actually needs is the item under review, and
      // `reviewOf` already carries it: `takeWork` resolves it on its own key.
      evidenceIds: [...item.evidenceIds],
      publishedById: me.id,
      publishedByName: me.name,
      kind: "review",
      origin: "planned",
      state: reviewer ? "offered" : "open",
      offeredToId: reviewer?.id ?? null,
      offeredAtMs: reviewer ? ctx.nowMs : null,
      takenById: null,
      orphanedAtMs: null,
      nudgedAtMs: null,
      reviewOf: item.id,
      at: ctx.now,
    };
    state.work.push(review);
    const taskN = taskNumberOf(state, item.id);
    if (taskN !== null) (state.plan!.itemsByTask[taskN] ??= []).push(review.id);
    broadcast.push(pushEvent(state, ctx, {
      kind: "system", from: null, to: null, priority: "normal",
      text: reviewer
        ? `review needed: ${item.paths[0]} — ${item.title}, offered to ${reviewer.name}`
        : `review needed: ${item.paths[0]} — ${item.title}, open — nobody else is live`,
      about: me.id,
    }));
  }

  broadcast.push(...advancePlanIfWaveDone(state, ctx));

  return {
    state,
    response: ok({ id: item.id, state: item.state }),
    broadcast,
  };
}
