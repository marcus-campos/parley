import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const guide = join(root, "docs", "guide");
const readme = readFileSync(join(root, "README.md"), "utf8");

function pages(): string[] {
  return readdirSync(guide).filter((f) => f.endsWith(".md"));
}

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
    expect(pages().sort()).toEqual([
      "install.md", "panel.md", "setup.md", "what-it-is.md", "where-it-fits.md",
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

  test("no long paragraph appears in both the README and a guide page", () => {
    const readmeParas = new Set(paragraphs(readme));
    for (const page of pages()) {
      const text = readFileSync(join(guide, page), "utf8");
      for (const para of paragraphs(text)) {
        expect(readmeParas.has(para)).toBe(false);
      }
    }
  });

  test("no guide paragraph is a lightly-edited copy of a README paragraph", () => {
    // This is deliberately a *different* check from the exact-match test
    // above: it would still fire on a paragraph copied from the README with
    // one word swapped, a comma moved, or a sentence dropped — drift that
    // looks intentional precisely because it is not byte-identical.
    const readmeParas = paragraphs(readme);
    for (const page of pages()) {
      const text = readFileSync(join(guide, page), "utf8");
      for (const guidePara of paragraphs(text)) {
        for (const readmePara of readmeParas) {
          const overlap = shingleOverlap(guidePara, readmePara);
          expect(overlap).toBeLessThan(0.5);
        }
      }
    }
  });

  test("the README's own relative links still point at files that exist", () => {
    const links = [...readme.matchAll(/\]\((docs\/[^)]+\.md)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(readFileSync(join(root, link), "utf8").length).toBeGreaterThan(0);
    }
  });
});
