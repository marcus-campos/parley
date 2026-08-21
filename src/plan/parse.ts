import { normalizeTerritoryPath } from "../repo/paths";

export interface PlanTask {
  n: number;
  title: string;
  paths: string[];
  /** Set when the Files block was missing or unusable. The task is still returned. */
  parseError: string | null;
}

export interface ParsedPlan {
  goal: string;
  spec: string | null;
  tasks: PlanTask[];
}

// The title group is `.*?` (zero or more), not `.+?`: a heading with nothing
// after the colon — `### Task 1:` — must still register as a task, carrying
// an empty title, rather than silently vanishing or being absorbed into the
// task before it.
const TASK_HEADING = /^###\s+Task\s+(\d+)\s*:\s*(.*?)\s*$/;
const FILES_BLOCK = /^\*\*Files:\*\*\s*$/;
// Leading whitespace before the `-` is tolerated: an indented bullet is still
// a bullet. Anchoring on column 0 here silently truncated every indented
// `**Files:**` block at its first line.
const FILE_LINE = /^\s*-\s*(?:Create|Modify|Test)\s*:\s*`([^`]+)`/i;

/**
 * A superpowers plan already declares, for every task, the exact files it
 * touches. That block is a territory claim written by hand and approved by a
 * person — which is why parallelism here can be computed instead of guessed.
 *
 * Pure: markdown in, data out. No clock, no I/O. "Do two tasks in this plan
 * collide?" is therefore a deterministic unit test.
 */
export function parsePlan(markdown: string): ParsedPlan {
  const lines = markdown.split(/\r?\n/);
  const tasks: PlanTask[] = [];
  let goal = "";
  let spec: string | null = null;

  interface Building extends PlanTask {
    sawFiles: boolean;
    // A bullet matched the Files-line shape but its path threw on
    // normalization (e.g. it escapes the repo root). It must not vanish
    // quietly just because a sibling bullet in the same block succeeded.
    droppedPath: boolean;
  }
  let current: Building | null = null;
  let inFiles = false;

  for (const line of lines) {
    if (!goal) {
      const m = line.match(/^\*\*Goal:\*\*\s*(.+)$/);
      if (m) {
        goal = m[1]!.trim();
        continue;
      }
    }
    if (spec === null) {
      const m = line.match(/^\*\*Spec:\*\*\s*(.+)$/);
      if (m) {
        spec = m[1]!.trim().replace(/^`|`$/g, "");
        continue;
      }
    }

    const heading = line.match(TASK_HEADING);
    if (heading) {
      if (current) tasks.push(finish(current));
      current = {
        n: Number(heading[1]),
        title: heading[2]!.trim(),
        paths: [],
        parseError: null,
        sawFiles: false,
        droppedPath: false,
      };
      inFiles = false;
      continue;
    }
    if (!current) continue;

    if (FILES_BLOCK.test(line.trim())) {
      inFiles = true;
      current.sawFiles = true;
      continue;
    }
    if (inFiles) {
      if (line.trim() === "") continue;
      const file = line.match(FILE_LINE);
      if (file) {
        // `path.py:123-145` names lines. The unit of territory is the file.
        const raw = file[1]!.replace(/:\d+(-\d+)?$/, "");
        try {
          current.paths.push(normalizeTerritoryPath(raw));
        } catch {
          // Not a usable path — e.g. it escapes the repo root. Recorded, not
          // just swallowed: silently dropping it while a sibling bullet in
          // the same block succeeds is exactly the "half its territory"
          // failure this parser exists to avoid.
          current.droppedPath = true;
        }
        continue;
      }
      if (line.trimStart().startsWith("-")) continue; // a bullet that is not a path
      inFiles = false;
    }
  }
  if (current) tasks.push(finish(current));

  return { goal, spec, tasks };
}

function finish(task: PlanTask & { sawFiles: boolean; droppedPath: boolean }): PlanTask {
  const { sawFiles, droppedPath, ...rest } = task;
  if (rest.paths.length > 0 && !droppedPath) return rest;
  if (rest.paths.length > 0 && droppedPath) {
    // Some paths were captured, but at least one bullet that looked like a
    // path could not be normalized and was dropped. Say so rather than
    // returning a clean-looking task that actually holds only part of its
    // territory.
    return {
      ...rest,
      parseError: "**Files:** block has a path that could not be normalized; capture is partial",
    };
  }
  // Two distinct reasons, because they are two distinct mistakes: a plan that
  // forgot the block, and a block that named something that is not a path.
  return {
    ...rest,
    parseError: sawFiles
      ? "**Files:** block present but no usable path inside it"
      : "no **Files:** block",
  };
}
