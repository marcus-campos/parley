import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CITATION,
  LEDGER_PATH,
  collectCitations,
  describeChanges,
  diffLedger,
  digest,
  locate,
  needsAcceptance,
  parseLedger,
  renderLedger,
  sitePages,
} from "../../scripts/gen-citations";

const root = join(import.meta.dir, "..", "..");

/**
 * A citation is a claim about content, not about a file being long enough.
 *
 * The guard this replaces asserted `Number(to ?? from) <= lines` — the cited
 * line has to exist. `src/cli/main.ts` then grew by 49 lines and seven
 * citations across five pages slid onto unrelated code (one onto a blank line,
 * five onto help text about the work pool), and every one of them still
 * pointed at a line that existed. The guard could not see it, and the whole
 * method of this site is "cite the line so the reader can check".
 *
 * So what is pinned is the cited text. See scripts/gen-citations.ts for why
 * that particular choice is the one that stays maintainable.
 */
describe("what the site cites", () => {
  test("every citation resolves to a line that exists", () => {
    // collectCitations throws by name on a missing file or a line past the
    // end, so this is the old check, kept, with a better failure message.
    expect(() => collectCitations(root)).not.toThrow();
  });

  test("the ledger is what the pages actually point at right now", () => {
    expect(existsSync(LEDGER_PATH)).toBe(true);
    const pinned = parseLedger(readFileSync(LEDGER_PATH, "utf8"));
    const current = collectCitations(root);

    // Vacuity: if the regex or the walker ever finds nothing, every
    // comparison below passes over an empty set.
    expect(pinned.length).toBeGreaterThanOrEqual(90);
    expect(current.length).toBeGreaterThanOrEqual(90);

    // Compared per (page, source file) so the report can say which page went
    // stale and against which file, rather than diffing 1000 lines.
    const key = (c: { page: string; file: string }) => `${c.page} → ${c.file}`;
    const bucket = <T extends { page: string; file: string }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const c of list) m.set(key(c), [...(m.get(key(c)) ?? []), c]);
      return m;
    };
    const was = bucket(pinned);
    const now = bucket(current);

    const problems: string[] = [];
    for (const k of new Set([...was.keys(), ...now.keys()])) {
      const before = was.get(k) ?? [];
      const after = now.get(k) ?? [];
      const afterDigests = after.map((c) => digest(c.text));
      const beforeDigests = before.map((c) => digest(c.text));

      // A pinned block nobody cites any more. If the block still exists in the
      // source somewhere else, the citation was left behind when the code
      // moved — name the line it moved to, so the fix is the line number and
      // never a blind re-pin.
      for (const b of before) {
        const d = digest(b.text);
        if (afterDigests.includes(d)) {
          afterDigests.splice(afterDigests.indexOf(d), 1);
          continue;
        }
        const file = b.file;
        const lines = existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8").split("\n") : [];
        const at = locate(lines, b.text);
        const head = b.text.split("\n").find((l) => l.trim()) ?? "(blank)";
        problems.push(
          at
            ? `${k}: the pinned code moved to ${file}:${at.from}${at.to > at.from ? `-${at.to}` : ""} ` +
              `and the page still cites the old line — "${head.trim()}"`
            : `${k}: the pinned code is gone from ${file} — "${head.trim()}". Re-read the sentence ` +
              `that cites it, then re-pin with \`bun run docs:citations\`.`,
        );
      }

      // A citation that now points at something the ledger never recorded.
      for (const a of after) {
        const d = digest(a.text);
        if (beforeDigests.includes(d)) {
          beforeDigests.splice(beforeDigests.indexOf(d), 1);
          continue;
        }
        const head = a.text.split("\n").find((l) => l.trim()) ?? "(blank line)";
        problems.push(
          `${k}: ${a.file}:${a.from}${a.to > a.from ? `-${a.to}` : ""} now reads "${head.trim()}", ` +
            `which is not in the ledger. If that is right, \`bun run docs:citations\`.`,
        );
      }
    }
    expect(problems).toEqual([]);

    // Order, which the buckets above cannot see. They compare multisets, so
    // two citations on one page swapping which lines they point at leaves
    // every bucket identical — both still resolve, both now send the reader to
    // the other one's evidence. Proven: transposing work-pool.md:14 and :26
    // passed all eight tests here with the ledger byte-identical.
    //
    // Only checked once the comparison above is clean, because an added or
    // dropped citation shifts every position after it and the report for that
    // is the list of blocks, not an index.
    if (problems.length === 0) {
      const seq = (list: { page: string; file: string; text: string }[]) =>
        list.map((c) => `${c.page} ${c.file} ${digest(c.text)}`);
      const before = seq(pinned);
      const after = seq(current);
      const at = before.findIndex((line, i) => line !== after[i]);
      expect(
        at < 0
          ? null
          : `the ledger pins the same blocks in a different order, starting at entry ${at + 1}: ` +
            `${before[at]} is now ${after[at]}. Nothing was added or dropped, so this is two ` +
            `citations on one page swapping which lines they point at. Open the page.`,
      ).toBeNull();
    }

    // Byte-for-byte too, so a hand-edited or half-regenerated ledger is a
    // failure rather than a thing the comparison above happens to tolerate.
    expect(readFileSync(LEDGER_PATH, "utf8")).toBe(renderLedger(current));
  });

  test("the ledger round-trips, so a green comparison is not an empty one", () => {
    // parseLedger is the only thing standing between the pinned file and the
    // comparison above. If it silently dropped blocks, the test would compare
    // a shrinking set against a shrinking set and stay green forever.
    const current = collectCitations(root);
    const round = parseLedger(renderLedger(current));
    expect(round.length).toBe(current.length);
    expect(round.map((c) => digest(c.text))).toEqual(current.map((c) => digest(c.text)));
    // Including a block with an interior blank line, which is where a naive
    // `|`-prefix parser loses data.
    const withBlank = current.find((c) => c.text.includes("\n\n"));
    expect(withBlank).toBeDefined();
    expect(round.find((c) => digest(c.text) === digest(withBlank!.text))).toBeDefined();
  });

  test("every concept page carries its own citations, not the site's average", () => {
    // The count this replaces was global: `checked >= 50` across eight pages
    // carrying 94 citations. One page could lose every citation it has and the
    // number stayed far above the floor — proven by replacing `shapes.md` with
    // 705 words of shuffled vocabulary and zero citations, which passed.
    const pages = sitePages(join(root, "docs")).filter((p) => p.startsWith("docs/concepts/"));
    expect(pages.length).toBe(6);
    // The thinnest concept page carries 8. Six is a floor with room for prose
    // to consolidate, and nowhere near room for a page to stop showing its
    // work. Reported as a list so the failure names the page and its count.
    const thin = pages
      .map((page) => ({ page, cites: [...readFileSync(join(root, page), "utf8").matchAll(CITATION)].length }))
      .filter((p) => p.cites < 6);
    expect(thin).toEqual([]);
  });
});

/**
 * The generator has to push back at the moment of the mistake.
 *
 * This suite exists because of a disclosed incident: the author of the ledger
 * edited help text, went stale on six citations, ran `docs:citations` by
 * reflex and watched the suite go green over six wrong citations. What caught
 * it was `git diff --stat` — a second command nobody is obliged to run. The
 * re-pin does land in a reviewable diff, but a diff only pushes back if
 * somebody volunteers to read it, and the person least likely to is the one
 * who just re-pinned by reflex.
 */
describe("re-pinning has to be read, not merely run", () => {
  const entry = (page: string, file: string, text: string) => ({ page, file, text });

  test("a rewritten block is reported with the page, the file and both texts", () => {
    const before = [entry("docs/concepts/shapes.md", "src/state/work.ts", "const a = 1;\nconst b = 2;")];
    const after = [entry("docs/concepts/shapes.md", "src/state/work.ts", "const a = 9;\nconst b = 2;")];
    const changes = diffLedger(before, after);
    expect(changes).toEqual([
      {
        kind: "changed",
        page: "docs/concepts/shapes.md",
        file: "src/state/work.ts",
        was: "const a = 1;\nconst b = 2;",
        now: "const a = 9;\nconst b = 2;",
      },
    ]);
    const report = describeChanges(changes);
    expect(report).toContain("docs/concepts/shapes.md → src/state/work.ts");
    expect(report).toContain("was | const a = 1;");
    expect(report).toContain("now | const a = 9;");
  });

  test("a transposition is reported, which is the case the buckets cannot see", () => {
    // Same page, same file, same two blocks — only which citation points at
    // which changed. Every multiset is identical, so nothing but the order
    // says anything happened.
    const a = entry("docs/concepts/work-pool.md", "src/state/work.ts", "first block");
    const b = entry("docs/concepts/work-pool.md", "src/state/work.ts", "second block");
    const changes = diffLedger([a, b], [b, a]);
    expect(changes.map((c) => c.kind)).toEqual(["reordered"]);
    expect(changes[0]!.page).toBe("docs/concepts/work-pool.md");
    expect(describeChanges(changes)).toContain("swapping which lines they");
  });

  test("adding and dropping citations costs nothing, so the gate is not in the way", () => {
    const kept = entry("docs/guide/panel.md", "src/cli/web.ts", "kept");
    const changes = diffLedger(
      [kept, entry("docs/guide/panel.md", "src/cli/web.ts", "gone")],
      [kept, entry("docs/guide/setup.md", "src/cli/main.ts", "new")],
    );
    expect(changes.map((c) => c.kind).sort()).toEqual(["added", "dropped"]);
    // The whole point of pinning text and not line numbers is that ordinary
    // docs work is free. Only a rewrite has to be typed for.
    expect(needsAcceptance(changes)).toEqual([]);
  });

  test("a block that only moved inside its file is not a change at all", () => {
    // The ledger pins text. Code moving is exactly the case it was built to
    // absorb without a re-bless, so it must not trip the gate either.
    const same = entry("docs/concepts/territory.md", "src/cli/main.ts", "} catch (e) {");
    expect(diffLedger([same], [same])).toEqual([]);
    expect(describeChanges([])).toBe("");
  });

  test("only rewrites and transpositions need to be accepted", () => {
    const changes = diffLedger(
      [entry("p.md", "s.ts", "old"), entry("p.md", "s.ts", "kept")],
      [entry("p.md", "s.ts", "new"), entry("p.md", "s.ts", "kept"), entry("q.md", "s.ts", "extra")],
    );
    expect(needsAcceptance(changes).map((c) => c.kind)).toEqual(["changed"]);
  });

  test("the script everybody runs cannot carry the flag that defeats the gate", () => {
    // `bun run docs:citations` is the reflex. If it accepted changes for you,
    // the gate would be decoration.
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["docs:citations"]).not.toContain("--accept-changes");
  });

  test("the generator refuses to write a rewrite, and says what it would have written", () => {
    const source = readFileSync(join(root, "scripts", "gen-citations.ts"), "utf8");
    // Report to stderr, never stdout: stdout is the ledger when --write is
    // absent, and a report mixed into it would be pinned as a citation.
    expect(source).toContain("process.stderr.write(describeChanges(changes))");
    expect(source).not.toMatch(/process\.stdout\.write\(describeChanges/);
    expect(source).toContain("process.exit(1)");
  });
});

describe("the wiring that keeps the ledger honest", () => {
  test("package.json re-pins the file the test above compares against", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["docs:citations"]).toBe("bun run scripts/gen-citations.ts --write");
    // A shell redirect would truncate the ledger before bun starts, losing the
    // only record of what the pages used to cite — which is the one thing that
    // makes "the code moved to line N" possible.
    expect(pkg.scripts["docs:citations"]).not.toContain(">");
  });

  test("a failed run leaves the ledger alone instead of emptying it", () => {
    const generator = readFileSync(join(root, "scripts", "gen-citations.ts"), "utf8");
    const render = generator.indexOf("const text = renderLedger(current);");
    const write = generator.indexOf("writeFileSync(LEDGER_PATH, text)");
    expect(render).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(render);
  });

  test("nothing in the generator can vary between runs", () => {
    // The test regenerates and compares byte for byte, so an unstable ledger
    // would turn unrelated pull requests red.
    const source = readFileSync(join(root, "scripts", "gen-citations.ts"), "utf8");
    expect(source).not.toMatch(/new Date|Date\.now|Math\.random|toISOString/);
    expect(source).toContain(".sort(");
  });

  test("the deploy workflow refuses to publish citations it has not checked", () => {
    // docs.yml triggers on push to main with no dependency on ci.yml, so a
    // commit that reached main by a route which skipped CI would publish pages
    // pointing at whatever happens to be on those lines now.
    const docs = readFileSync(join(root, ".github", "workflows", "docs.yml"), "utf8");
    expect(docs).toContain("bun test tests/docs/citations.test.ts");
    expect(docs.indexOf("bun test tests/docs/citations.test.ts")).toBeLessThan(docs.indexOf("bun run docs:build"));
  });
});
