import { describe, expect, test } from "bun:test";
import { workDetailLines, workSummaryLines } from "../../src/cli/watch";
import { PAGE } from "../../src/cli/web-page";

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
});
