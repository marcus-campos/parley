/**
 * What a front parley bore printed, on its way into a panel's feed.
 *
 * Both panels need this and neither should own it. The daemon serves these
 * lines from `op: "output"` — deliberately *not* from the bus, because bus
 * events are journalled and drained into every other front's context, and a
 * harness printing its answer would cost every agent on the repository the
 * tokens to read it (§7 of the design says *into the panel*, and means it).
 *
 * They are shaped here into the same event a front's `say` produces, so a
 * panel renders them under that front's name with no special case: for a
 * newborn this *is* how it speaks, since there is no session a person can open
 * and read over its shoulder.
 */

export interface TailLine { n: number; name: string; text: string; at: string }

export interface TailEvent {
  seq: number;
  kind: "say";
  from: { name: string; kind: string };
  to: null;
  priority: string;
  text: string;
  at: string;
}

export function tailToFeed(lines: TailLine[]): TailEvent[] {
  return lines.map((line) => ({
    // The bus's sequence numbers are the bus's. These lines never entered it,
    // so they carry none — a panel orders its feed by arrival, and the tail
    // has its own cursor (`n`) for the only thing sequence is needed for.
    seq: 0,
    kind: "say" as const,
    from: { name: line.name, kind: "agent" },
    to: null,
    priority: "normal",
    text: line.text,
    at: line.at,
  }));
}

/** The highest line number in a batch, or the cursor unchanged for an empty one. */
export function tailCursor(lines: TailLine[], current: number): number {
  return lines.reduce((highest, line) => Math.max(highest, line.n), current);
}
