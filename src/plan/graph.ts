import { patternsOverlap } from "../repo/paths";
import type { PlanTask } from "./parse";

export interface Wave {
  tasks: PlanTask[];
}

/** Do these two tasks claim any path in common, exactly or maybe? */
function tasksCollide(a: PlanTask, b: PlanTask): boolean {
  return a.paths.some((pa) => b.paths.some((pb) => patternsOverlap(pa, pb)));
}

/**
 * Which tasks cannot run at the same time.
 *
 * `patternsOverlap` answers "maybe" as conflict on purpose: a false conflict
 * costs one wave of latency, a false clear costs two agents editing the same
 * file and finding out from CI. This function inherits that bias rather than
 * re-deciding it — every pairwise check is a direct call to `patternsOverlap`.
 *
 * Every orchestrator on the market asks a human whether the tasks are
 * independent. This is the same question, answered from the paths the plan
 * already declares.
 *
 * Read by tests and kept as the named thing the design spec argues from; the
 * shipped dispatcher calls `waves` below, which asks `tasksCollide` directly
 * rather than going through this Map. So this has no production caller today —
 * it is the graph, in the shape a response would carry if one ever reported
 * it, and the place the collision rule is stated on its own rather than folded
 * into a seating loop.
 *
 * A plan is expected to give every task a distinct number, since that number
 * is the key this Map is returned under. Task 1's parser reads what is
 * written and does not enforce uniqueness; a plan that still repeats a
 * number is malformed, and this function must not throw on malformed input.
 * When two or more tasks share a number, their entry is the union of every
 * collision found for ANY of them: never fewer collisions than the plan
 * actually contains, the same "maybe is a conflict" bias applied one level
 * up. A number never collides with itself, whether that reflexivity comes
 * from one task or from two sharing a label — that is not information the
 * caller of this Map could act on.
 */
export function collisions(tasks: PlanTask[]): Map<number, number[]> {
  const map = new Map<number, Set<number>>();
  for (const t of tasks) if (!map.has(t.n)) map.set(t.n, new Set());

  for (const a of tasks) {
    for (const b of tasks) {
      if (a.n === b.n) continue;
      if (!tasksCollide(a, b)) continue;
      map.get(a.n)!.add(b.n);
    }
  }

  const out = new Map<number, number[]>();
  for (const [n, set] of map) out.set(n, [...set].sort((x, y) => x - y));
  return out;
}

/**
 * Greedy by plan order, but not first-fit: a task is seated no earlier than
 * one wave past the highest wave already holding a task it collides with.
 * First-fit alone is unsound the moment a task carries more than one path —
 * the normal shape of a `**Files:**` block. Given t1{x,y}, t2{y,z}, t3{z,w},
 * t3 shares no path with t1 and so passes t1's wave clean, even though t3
 * collides with t2, which was pushed out of that same wave by t1. First-fit
 * would seat t3 with t1, a wave before t2 — running t3's edit to z.ts before
 * t2's, silently out of the plan's declared order. Seating by "one past the
 * latest colliding predecessor" instead means every wave this function
 * assigns already reflects every earlier collision that forced it there, so
 * no later re-check of that wave is needed: a task never appears before a
 * lower-numbered task it collides with, directly or through the chain of
 * waves that task's own collisions already pushed it into.
 *
 * Ties (including two tasks sharing a number, see `collisions` above) fall
 * back to original list order — plan order is the only ordering a
 * malformed, duplicate-numbered plan still has.
 */
export function waves(tasks: PlanTask[]): Wave[] {
  const ordered = tasks
    .map((task, index) => ({ task, index }))
    .sort((x, y) => x.task.n - y.task.n || x.index - y.index)
    .map(({ task }) => task);

  const out: Wave[] = [];
  const placed: { task: PlanTask; wave: number }[] = [];
  for (const task of ordered) {
    let minWave = 0;
    for (const p of placed) {
      if (tasksCollide(task, p.task)) minWave = Math.max(minWave, p.wave + 1);
    }
    while (out.length <= minWave) out.push({ tasks: [] });
    out[minWave]!.tasks.push(task);
    placed.push({ task, wave: minWave });
  }
  return out;
}
