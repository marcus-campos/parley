import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sitePages } from "../../scripts/gen-citations";

const root = join(import.meta.dir, "..", "..");
const docs = join(root, "docs");
const guide = join(docs, "guide");
const readme = readFileSync(join(root, "README.md"), "utf8");

function guidePages(): string[] {
  return readdirSync(guide).filter((f) => f.endsWith(".md"));
}

/**
 * Every markdown file the site actually publishes.
 *
 * This describe block is called "the site never becomes a second copy" and the
 * duplication checks only ever walked `docs/guide/`. Six concept pages and two
 * reference pages were outside it: an entire README region appended verbatim to
 * `docs/concepts/presence.md` passed the whole suite and built clean.
 *
 * This *was* a second implementation of the walker, sitting beside the
 * generator's and agreeing with it only by coincidence — the same shape of
 * defect the block is named after. It is now the generator's, which is the one
 * `docs:citations` and the flag scan already use, tied to `srcExclude` by a
 * test in tests/docs/site-build.test.ts. The generator returns repo-relative
 * paths (`docs/guide/panel.md`), so pages are read from `root`, not `docs`.
 */
const pagesOfSite = (): string[] => sitePages(docs);

function paragraphs(t: string): string[] {
  return t
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 200);
}

// Word-shingle overlap: catches a paragraph copied from the README with a
// handful of words changed, reordered, or re-punctuated — the kind of near
// -copy that an exact-string comparison misses entirely because it never
// produces a byte-for-byte match. Two independently written paragraphs about
// the same tool will share plenty of vocabulary (`parley`, `front`, `hook`,
// `worktree`) but essentially never share long *runs* of consecutive words,
// so this stays quiet on real prose while still catching a lightly-edited
// copy of the same passage.
function shingles(text: string, size = 8): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) {
    out.add(words.slice(i, i + size).join(" "));
  }
  return out;
}

function shingleOverlap(a: string, b: string): number {
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const s of sa) if (sb.has(s)) shared++;
  return shared / Math.min(sa.size, sb.size);
}

describe("the site never becomes a second copy", () => {
  test("every guide page exists", () => {
    expect(guidePages().sort()).toEqual([
      "for-agents.md", "getting-started.md", "install.md", "panel.md",
      "setup.md", "what-it-is.md", "where-it-fits.md", "workspaces.md",
    ]);
  });

  test("pages that restate the README include it instead", () => {
    for (const page of ["what-it-is.md", "where-it-fits.md", "install.md"]) {
      const text = readFileSync(join(guide, page), "utf8");
      expect(text).toContain("@include:");
    }
  });

  test("the README carries the regions the site includes from", () => {
    for (const region of ["what-it-is", "where-it-fits", "install"]) {
      expect(readme).toContain(`<!-- #region ${region} -->`);
      expect(readme).toContain(`<!-- #endregion ${region} -->`);
    }
  });

  // The test above only proves each region exists *somewhere* in the README —
  // it stays green even if #install and #where-it-fits were swapped between
  // pages, since both regions would still exist. These two tests tie each
  // page to the specific region it must resolve to, so a swap fails loudly
  // instead of silently serving one page's content on another's URL.
  test("each page's @include: names its own region, not a swapped one", () => {
    const expectedRegions: Record<string, string[]> = {
      "what-it-is.md": ["what-it-is", "one-rule"],
      "where-it-fits.md": ["where-it-fits"],
      "install.md": ["install"],
    };
    for (const [page, regions] of Object.entries(expectedRegions)) {
      const text = readFileSync(join(guide, page), "utf8");
      const included = [...text.matchAll(/<!--@include:\s*\.\.\/\.\.\/README\.md#([a-z0-9-]+)\s*-->/g)].map(
        (m) => m[1]!,
      );
      expect(included).toEqual(regions);
    }
  });

  test("the named region actually contains the content its page claims", () => {
    // Guards a failure the mapping test above cannot: the #region/#endregion
    // markers themselves swapped in the README, so the right region *name*
    // resolves to the wrong text even though the include reference is correct.
    function regionContent(name: string): string {
      const match = readme.match(
        new RegExp(`<!-- #region ${name} -->([\\s\\S]*?)<!-- #endregion ${name} -->`),
      );
      if (!match) throw new Error(`region not found in README: ${name}`);
      return match[1]!;
    }

    const distinctivePhrase: Record<string, string> = {
      "what-it-is": "coordination bus for concurrent agent sessions",
      "one-rule": "A broken parley must never stop the work",
      "where-it-fits": "Orchestration assumes a hierarchy",
      install: "curl -fsSL",
    };
    for (const [region, phrase] of Object.entries(distinctivePhrase)) {
      expect(regionContent(region)).toContain(phrase);
    }
  });

  test("the walker actually reaches the pages outside docs/guide/", () => {
    // The check below is a loop over this list. If the walker ever stopped
    // finding the concept and reference pages, every duplication assertion
    // would keep passing over a shrinking set and say nothing about it.
    const pages = pagesOfSite();
    expect(pages.length).toBeGreaterThanOrEqual(14);
    for (const expected of [
      "docs/index.md",
      "docs/guide/what-it-is.md",
      "docs/concepts/presence.md",
      "docs/concepts/territory.md",
      "docs/reference/commands.md",
      "docs/reference/compatibility.md",
      "docs/ARCHITECTURE.md",
      "docs/PROTOCOL.md",
    ]) {
      expect(pages).toContain(expected);
    }
  });

  test("no long paragraph appears in both the README and a page of the site", () => {
    const readmeParas = new Set(paragraphs(readme));
    for (const page of pagesOfSite()) {
      const text = readFileSync(join(root, page), "utf8");
      for (const para of paragraphs(text)) {
        expect(readmeParas.has(para)).toBe(false);
      }
    }
  });

  test("no page of the site is a lightly-edited copy of a README paragraph", () => {
    // This is deliberately a *different* check from the exact-match test
    // above: it would still fire on a paragraph copied from the README with
    // one word swapped, a comma moved, or a sentence dropped — drift that
    // looks intentional precisely because it is not byte-identical.
    const readmeParas = paragraphs(readme);
    expect(readmeParas.length).toBeGreaterThanOrEqual(20);
    let compared = 0;
    for (const page of pagesOfSite()) {
      const text = readFileSync(join(root, page), "utf8");
      for (const sitePara of paragraphs(text)) {
        for (const readmePara of readmeParas) {
          const overlap = shingleOverlap(sitePara, readmePara);
          if (overlap >= 0.5) {
            throw new Error(
              `${page} carries a paragraph ${Math.round(overlap * 100)}% shared with the README. ` +
                `Include the region instead of copying it.`,
            );
          }
          compared++;
        }
      }
    }
    // A walker returning nothing, or pages with no long paragraphs, would make
    // the loop above vacuous while reporting success.
    expect(compared).toBeGreaterThanOrEqual(500);
  });

  test("the README's own relative links still point at files that exist", () => {
    const links = [...readme.matchAll(/\]\((docs\/[^)]+\.md)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(readFileSync(join(root, link), "utf8").length).toBeGreaterThan(0);
    }
  });
});
