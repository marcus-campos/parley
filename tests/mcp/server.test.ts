import { describe, expect, test } from "bun:test";
import { TOOLS } from "../../src/mcp/server";

function tool(name: string) {
  const t = TOOLS.find((t) => t.name === name);
  if (!t) throw new Error(`no such tool: ${name}`);
  return t;
}

/**
 * The review's Important-3 finding: `parley_notes` and `parley_results` had
 * no query parameter at all, so an agent's only options were filtering by
 * path (the push channel that already worked) or reading every note — the
 * exact problem spec §1 names this branch as solving. §6 says both gain `q`
 * and `k`.
 */
describe("parley_notes and parley_results can ask, not just list", () => {
  test("both tools declare `query` and `k` in their input schema", () => {
    for (const name of ["parley_notes", "parley_results"]) {
      const schema = tool(name).inputSchema as { properties: Record<string, unknown> };
      expect(schema.properties.query).toBeDefined();
      expect(schema.properties.k).toBeDefined();
    }
  });

  test("a query is passed through as q/k plus semantic: true", () => {
    const notesFrame = tool("parley_notes").frame({ query: "select2 hidden", k: 3 });
    expect(notesFrame).toMatchObject({ op: "notes", q: "select2 hidden", k: 3, semantic: true });

    const resultsFrame = tool("parley_results").frame({ query: "bun test", k: 2 });
    expect(resultsFrame).toMatchObject({ op: "results", q: "bun test", k: 2, semantic: true });
  });

  test("no query means no semantic flag — a plain listing must not touch activation", () => {
    expect(tool("parley_notes").frame({}).semantic).toBeUndefined();
    expect(tool("parley_results").frame({}).semantic).toBeUndefined();
    expect(tool("parley_notes").frame({}).q).toBeUndefined();
    expect(tool("parley_results").frame({}).q).toBeUndefined();
  });

  test("render says when the answer is ranked, for both tools", () => {
    const rankedNotes = tool("parley_notes").render(
      { notes: [{ id: "n_1", title: "t", body: "", kind: "note", paths: [], authorName: "CORE" }], ranked: true },
      {},
    );
    expect(rankedNotes).toContain("Ranked by relevance");

    const plainNotes = tool("parley_notes").render(
      { notes: [{ id: "n_1", title: "t", body: "", kind: "note", paths: [], authorName: "CORE" }] },
      {},
    );
    expect(plainNotes).not.toContain("Ranked by relevance");

    const rankedResults = tool("parley_results").render(
      { results: [{ key: "bun test", status: "pass", summary: "", byName: "CORE", staleBecause: null }], ranked: true },
      {},
    );
    expect(rankedResults).toContain("Ranked by relevance");
  });
});
