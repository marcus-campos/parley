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

const TASK_HEADING = /^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/;
const FILES_BLOCK = /^\*\*Files:\*\*\s*$/;
const FILE_LINE = /^-\s*(?:Create|Modify|Test)\s*:\s*`([^`]+)`/i;

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
          /* not a usable path */
        }
        continue;
      }
      if (line.startsWith("-")) continue; // a bullet that is not a path
      inFiles = false;
    }
  }
  if (current) tasks.push(finish(current));

  return { goal, spec, tasks };
}

function finish(task: PlanTask & { sawFiles: boolean }): PlanTask {
  const { sawFiles, ...rest } = task;
  if (rest.paths.length > 0) return rest;
  // Two distinct reasons, because they are two distinct mistakes: a plan that
  // forgot the block, and a block that named something that is not a path.
  return {
    ...rest,
    parseError: sawFiles
      ? "**Files:** block present but no usable path inside it"
      : "no **Files:** block",
  };
}
