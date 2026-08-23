import { describe, expect, test } from "bun:test";
import { workDetailLines, workSummaryLines } from "../../src/cli/watch";
import { PAGE } from "../../src/cli/web-page";
import { tailCursor, tailToFeed } from "../../src/cli/panel-tail";

interface Row {
  id: string; paths: string[]; title: string; state: string;
  offeredToId: string | null; takenById: string | null;
}

const front = (id: string, name: string) => ({ id, name });

function offeredTo(idPrefix: string, ownerId: string, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}_${i}`, paths: [`${idPrefix}/${i}.ts`], title: `item ${idPrefix}${i}`,
    state: "offered", offeredToId: ownerId, takenById: null,
  }));
}

describe("the WORK section of the panel", () => {
  test("the header names the total, and the summary line is grouped by owner", () => {
    const work: Row[] = [
      ...offeredTo("resp", "p_resp", 10),
      ...offeredTo("core", "p_core", 2),
      { id: "w_open", paths: ["open/1.ts"], title: "orphan", state: "open", offeredToId: null, takenById: null },
    ];
    const fronts = [front("p_core", "CORE"), front("p_resp", "RESPONSIVO")];

    const [header, summary] = workSummaryLines(work, fronts);
    expect(header).toContain("WORK (13)");
    expect(header).toContain("w to expand");
    expect(summary).toContain("RESPONSIVO");
    expect(summary).toContain("10 offered");
    expect(summary).toContain("CORE");
    expect(summary).toContain("2 offered");
    expect(summary).toContain("pool");
    expect(summary).toContain("1 open");

    // The whole point of grouping is that the collapsed line carries the top,
    // never the corpus — an implementation that dumped every item would pass
    // the assertions above too, so this is what actually discriminates it.
    expect(summary).not.toContain("resp/0.ts");
    expect(summary).not.toContain("open/1.ts");
    expect(summary).not.toContain("orphan");
  });

  test("done items count toward neither the total nor any group", () => {
    const work: Row[] = [
      { id: "w_1", paths: ["a.ts"], title: "x", state: "offered", offeredToId: "p_resp", takenById: null },
      { id: "w_2", paths: ["b.ts"], title: "y", state: "done", offeredToId: null, takenById: "p_resp" },
    ];
    const [header, summary] = workSummaryLines(work, [front("p_resp", "RESPONSIVO")]);
    expect(header).toContain("WORK (1)");
    expect(summary).not.toContain("2 ");
  });

  test("offered and taken are named as what they are, not merged into one count", () => {
    const work: Row[] = [
      { id: "w_1", paths: ["a.ts"], title: "x", state: "offered", offeredToId: "p_resp", takenById: null },
      { id: "w_2", paths: ["b.ts"], title: "y", state: "taken", offeredToId: null, takenById: "p_resp" },
    ];
    const [, summary] = workSummaryLines(work, [front("p_resp", "RESPONSIVO")]);
    expect(summary).toContain("1 offered");
    expect(summary).toContain("1 taken");
  });

  test("a name unresolved against the current front list falls back to the id, not to silence", () => {
    const work: Row[] = [
      { id: "w_1", paths: ["a.ts"], title: "x", state: "offered", offeredToId: "p_gone", takenById: null },
    ];
    const [, summary] = workSummaryLines(work, []);
    expect(summary).toContain("p_gone");
  });

  test("an empty pool produces no groups at all", () => {
    const [header, summary] = workSummaryLines([], []);
    expect(header).toContain("WORK (0)");
    expect(summary.trim()).toBe("");
  });

  test("the expanded view names each item by path and owner — what the collapsed line deliberately omits", () => {
    const work: Row[] = [
      { id: "w_1", paths: ["a.ts"], title: "fix the thing", state: "offered", offeredToId: "p_resp", takenById: null },
      { id: "w_2", paths: ["b.ts"], title: "finished", state: "done", offeredToId: null, takenById: "p_resp" },
    ];
    const lines = workDetailLines(work, [front("p_resp", "RESPONSIVO")]);
    expect(lines.some((l) => l.includes("a.ts") && l.includes("RESPONSIVO"))).toBe(true);
    // Done work is finished; it has nothing left to hand anyone.
    expect(lines.some((l) => l.includes("b.ts"))).toBe(false);
  });
});

describe("the WORK section of the web panel", () => {
  test("it sits directly below Pending permission, collapsed by default", () => {
    const pending = PAGE.indexOf("Pending permission");
    const work = PAGE.indexOf('id="work"');
    const notes = PAGE.indexOf(">Notes<");
    expect(pending).toBeGreaterThan(-1);
    expect(work).toBeGreaterThan(pending);
    expect(notes).toBeGreaterThan(work);
    // <details> with no `open` attribute is collapsed until a person clicks it.
    expect(PAGE).toContain('<details id="work"');
    expect(PAGE).not.toContain('<details id="work" open');
  });

  test("the page groups by owner client-side rather than shipping one row per item", () => {
    expect(PAGE).toContain("workGroupsFrom");
  });

  test("pressing w toggles WORK open, the same key the terminal panel answers to", () => {
    // Scoped to the keydown handler itself, not just anywhere in the page —
    // "w" and "workGroupsFrom" both contain the letter, and a looser
    // assertion would pass whether or not a handler actually existed.
    const start = PAGE.indexOf('document.addEventListener("keydown"');
    const end = PAGE.indexOf("});", start);
    expect(start).toBeGreaterThan(-1);
    const handler = PAGE.slice(start, end);
    expect(handler).toContain('!speaking && (e.key === "w" || e.key === "W")');
    expect(handler).toContain('$("work").open = !$("work").open');
  });
});

describe("a newborn's output in the panel feed", () => {
  test("it arrives under the front's name, as something that front said", () => {
    // Not as a system event and not as parley speaking: for a front parley
    // bore this is how it speaks, because there is no session a person can
    // open and read over its shoulder.
    const [one, two] = tailToFeed([
      { n: 1, name: "POOL-1", text: "reading the pool", at: "2026-08-20T12:00:00.000Z" },
      { n: 2, name: "POOL-2", text: "taking w_1", at: "2026-08-20T12:00:01.000Z" },
    ]);
    expect(one!.from.name).toBe("POOL-1");
    expect(one!.kind).toBe("say");
    expect(one!.text).toBe("reading the pool");
    expect(one!.to).toBeNull();
    expect(two!.from.name).toBe("POOL-2");
  });

  test("the cursor only ever moves forward, and an empty batch does not move it", () => {
    expect(tailCursor([{ n: 7, name: "POOL-1", text: "x", at: "" }], 3)).toBe(7);
    // Out of order, because a batch is what the daemon had, not what it sent.
    expect(tailCursor([{ n: 9, name: "P", text: "x", at: "" }, { n: 4, name: "P", text: "y", at: "" }], 0)).toBe(9);
    expect(tailCursor([], 12)).toBe(12);
  });
});

describe("the spending switch, in both panels", () => {
  test("the web page has a control that says what it is switching", () => {
    // §4.7: the one thing on this bus a person decides and no front does. The
    // page carries the ceiling and how much of it is in use, because a switch
    // whose label is only "off" tells nobody whether it matters yet.
    expect(PAGE).toContain('id="births"');
    expect(PAGE).toContain("births off");
    expect(PAGE).toContain('post("/births"');
    expect(PAGE).toContain("b.live");
    expect(PAGE).toContain("b.max");
  });

  test("pressing b toggles it, the same key the terminal panel answers to", () => {
    expect(PAGE).toContain('e.key === "b" || e.key === "B"');
    expect(PAGE).toContain('$("births").click()');
  });

  test("and it still refuses to be a route for grant, deny or mode", () => {
    // The page grew a control that acts. That is exactly the moment to check
    // it did not grow the ones that were left out on purpose.
    expect(PAGE).not.toContain('post("/grant"');
    expect(PAGE).not.toContain('post("/deny"');
    expect(PAGE).not.toContain('post("/mode"');
  });
});
