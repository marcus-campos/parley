import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
  at: string;
  actorId: string | null;
  frame: Record<string, unknown>;
}

/**
 * The one thing in this log that no client ever sent.
 *
 * Everything else here is a frame that arrived on the wire. This is the
 * daemon's own record that it spent a birth window — `tick` stamps
 * `state.lastBirthMs` and `tick` is never journalled, so the cooldown came
 * back `null` after every restart while `state.birthsAllowed`, one field
 * above it and journalled on purpose, came back intact. A restart ten seconds
 * into a five-minute cooldown bore again immediately, and a restart loop spent
 * real agent sessions in seconds — a birth that never joins costs no ceiling,
 * so the ceiling does not bound that loop either.
 *
 * Deliberately not an entry in `OPS` and not in `PROTOCOL.md`'s op table: it
 * is not part of the wire contract, nothing may send it, and `apply` does not
 * know it. `restore()` is its only reader.
 */
export const BIRTH_STAMP_OP = "parley:birth";

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
