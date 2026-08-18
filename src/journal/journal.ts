import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  at: string;
  actorId: string | null;
  frame: Record<string, unknown>;
}

export interface ReplayResult {
  entries: JournalEntry[];
  /** Lines that could not be parsed. A truncated tail is expected after kill -9. */
  discarded: { line: number; raw: string }[];
}

/**
 * Append-only NDJSON log. Every accepted event is written here BEFORE the
 * response goes back to the agent, so `kill -9` costs neither territory nor
 * history — the next spawn rebuilds from this file.
 */
export class Journal {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: JournalEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * Read the log back. A partially written last line is dropped with a warning
   * rather than refusing to start: a bus that will not boot because of one torn
   * line is worse than a bus missing its final event.
   */
  replay(): ReplayResult {
    const entries: JournalEntry[] = [];
    const discarded: { line: number; raw: string }[] = [];
    if (!existsSync(this.path)) return { entries, discarded };

    const lines = readFileSync(this.path, "utf8").split("\n");
    lines.forEach((raw, index) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as JournalEntry;
        if (parsed && typeof parsed === "object" && typeof parsed.frame === "object") entries.push(parsed);
        else discarded.push({ line: index + 1, raw: trimmed });
      } catch {
        discarded.push({ line: index + 1, raw: trimmed });
      }
    });
    return { entries, discarded };
  }

  /** Rewrite the log from a known-good set of entries (used after compaction). */
  rewrite(entries: JournalEntry[]): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, entries.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
    renameSync(tmp, this.path);
  }
}
