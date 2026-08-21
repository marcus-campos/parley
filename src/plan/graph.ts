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
 * Greedy by plan order: a task joins the first wave that holds nothing it
 * collides with. Ties (including two tasks sharing a number, see
 * `collisions` above) fall back to original list order — plan order is the
 * only ordering a malformed, duplicate-numbered plan still has.
 */
export function waves(tasks: PlanTask[]): Wave[] {
  const ordered = tasks
    .map((task, index) => ({ task, index }))
    .sort((x, y) => x.task.n - y.task.n || x.index - y.index)
    .map(({ task }) => task);

  const out: Wave[] = [];
  for (const task of ordered) {
    const wave = out.find((w) => !w.tasks.some((other) => tasksCollide(task, other)));
    if (wave) wave.tasks.push(task);
    else out.push({ tasks: [task] });
  }
  return out;
}
