import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { sitePages } from "../../scripts/gen-citations";

const root = join(import.meta.dir, "..", "..");

/** The exclusion list VitePress is actually given, read out of the config. */
function srcExclude(): string[] {
  const config = readFileSync(join(root, "docs", ".vitepress", "config.ts"), "utf8");
  const literal = config.match(/srcExclude:\s*\[([^\]]*)\]/);
  if (!literal) throw new Error("docs/.vitepress/config.ts declares no srcExclude");
  return [...literal[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("the documentation site", () => {
  test("it has a config that actually defines the VitePress site", () => {
    const configPath = join(root, "docs", ".vitepress", "config.ts");
    expect(existsSync(configPath)).toBe(true);
    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("defineConfig");
    expect(config).toContain('title: "parley"');
  });

  test("it has a non-empty landing page with a hero", () => {
    const indexPath = join(root, "docs", "index.md");
    expect(existsSync(indexPath)).toBe(true);
    const index = readFileSync(indexPath, "utf8");
    expect(index).toContain("layout: home");
    expect(index).toContain("hero:");
  });

  test("the base path is the project page, not the root of a domain", () => {
    const config = readFileSync(join(root, "docs", ".vitepress", "config.ts"), "utf8");
    expect(config).toContain('base: "/parley/"');
  });

  test("specs and plans are excluded from the build — they are working documents", () => {
    expect(srcExclude()).toEqual(["superpowers/**", "**/README.md"]);
  });

  test("the set the scanners walk is the set the site publishes", () => {
    // `srcExclude` had two independent implementations — `sitePages` in
    // scripts/gen-citations.ts and a copy in tests/docs/no-duplication.test.ts
    // — and the only test on either asserted that the config *string*
    // contained "srcExclude" and "superpowers/**". Nothing checked that any of
    // the three agreed. The copy is gone; this is what holds the survivor to
    // the config.
    //
    // The direction that matters is narrowing, not widening. `sitePages`
    // recurses, so a new page or subdirectory under docs/ is scanned the day
    // it lands — that is the safe default and it is why this was never urgent.
    // The blind spot has to be *created*: drop `superpowers/**` from
    // `srcExclude` to publish the plans and seven working documents go live
    // carrying `--as`, `--evidence`, `--kind`, `--query`, `--review-of`,
    // `--summary`, `--permission-mode` and more, none of which the CLI reads —
    // and neither the flag scan nor the citation ledger sees one of them,
    // because both walk a list that hardcodes the skip. That is the `--speak`
    // mechanism one level of indirection up, and this round is what made
    // `sitePages` the source of truth for both scans.
    const patterns = srcExclude();

    // A glob translator for the two forms VitePress is actually given. Five
    // lines, because the alternative — writing "skip superpowers/" down a
    // third time — is the defect being closed.
    const matches = (pattern: string, page: string): boolean => {
      const rx = pattern
        .split("**")
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join(".*");
      return new RegExp(`^${rx}$`).test(page);
    };

    // Every markdown file under docs/, including the ones srcExclude hides.
    // `.vitepress` is skipped here and in `sitePages` and is *not* in
    // srcExclude, which is correct rather than a mismatch: it holds the site's
    // own config and its build output, which VitePress never treats as
    // content, so there is nothing for srcExclude to exclude. Walking it would
    // make this test depend on whether `docs:build` had been run.
    const all = (dir: string, found: string[] = []): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== ".vitepress") all(full, found);
        } else if (entry.name.endsWith(".md")) {
          found.push(relative(join(root, "docs"), full).split(sep).join("/"));
        }
      }
      return found;
    };

    const every = all(join(root, "docs"));
    const published = every.filter((page) => !patterns.some((pat) => matches(pat, page)));
    // Vacuity: if nothing were excluded the two sets would agree trivially.
    expect(every.length).toBeGreaterThan(published.length);
    expect(published.map((p) => `docs/${p}`).sort()).toEqual(sitePages(join(root, "docs")).sort());
  });

  test("vitepress is a devDependency and never a runtime one", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.devDependencies.vitepress).toBeTruthy();
    expect(pkg.dependencies?.vitepress).toBeUndefined();
  });

  test("the build scripts actually invoke vitepress against the docs directory", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["docs:dev"]).toBe("vitepress dev docs");
    expect(pkg.scripts["docs:build"]).toBe("vitepress build docs");
    expect(pkg.scripts["docs:preview"]).toBe("vitepress preview docs");
  });

  test("the built site and its cache are not committed", () => {
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gitignore).toContain(".vitepress/dist");
    expect(gitignore).toContain(".vitepress/cache");
  });

  // The nav and sidebar in config.ts are declared config, not proof: VitePress
  // does not fail its build when they point at a page that does not exist.
  // `ignoreDeadLinks: false` only validates links *inside rendered markdown* —
  // proven by mutation both ways: a dead in-page link fails `docs:build`, and a
  // dead sidebar entry does not. So a sidebar link can 404 on every page of the
  // published site indefinitely with the build, the typecheck and every other
  // test staying green. This test is the only thing standing there.
  //
  // It walks the *imported config object*, not the source text. A regex over
  // the file would keep passing the day someone builds the sidebar from a
  // variable, a helper, or a nested group — and it would read a link the
  // config no longer uses.
  async function loadConfig(): Promise<Record<string, unknown>> {
    const mod = await import(join(root, "docs", ".vitepress", "config.ts"));
    return (mod as { default: Record<string, unknown> }).default;
  }

  /** Every `link:` anywhere in the config, however deeply nested. */
  function linksIn(node: unknown, found: string[] = []): string[] {
    if (Array.isArray(node)) {
      for (const item of node) linksIn(item, found);
      return found;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "link" && typeof value === "string") found.push(value);
        else linksIn(value, found);
      }
    }
    return found;
  }

  function resolvesToAPage(link: string): boolean {
    const clean = link.split("#")[0]!.split("?")[0]!.replace(/^\//, "");
    if (clean === "") return existsSync(join(root, "docs", "index.md"));
    return [
      join(root, "docs", `${clean}.md`),
      join(root, "docs", clean, "index.md"),
      join(root, "docs", clean.replace(/\/$/, "") + ".md"),
    ].some((c) => existsSync(c));
  }

  test("every nav and sidebar link resolves to a page that exists", async () => {
    const config = await loadConfig();
    const links = linksIn(config);
    // A walker that found nothing would make the loop below vacuous, and this
    // test is the whole guard — it may not be allowed to pass over an empty
    // list. Four nav entries plus fifteen sidebar entries today.
    expect(links.length).toBeGreaterThanOrEqual(18);

    const internal = links.filter((l) => !/^(https?:|mailto:)/.test(l));
    expect(internal.length).toBeGreaterThanOrEqual(15);

    const dead = internal.filter((l) => !resolvesToAPage(l));
    // Named rather than counted: the failure message has to say *which* link
    // 404s, or the next person reads "expected 1 to be 0" and learns nothing.
    expect(dead).toEqual([]);
  });

  test("the external links are the only ones the check above skips", async () => {
    // Guards the skip itself. If someone writes an internal link the filter
    // happens to treat as external, the test above goes quiet about it.
    const config = await loadConfig();
    const external = linksIn(config).filter((l) => /^(https?:|mailto:)/.test(l));
    expect(external).toEqual(["https://github.com/marcus-campos/parley"]);
  });

  // Two independent ways to switch the dead-link gate off silently, both
  // reproduced by the reviewer with all 37 tests staying green. Each gets one
  // assertion, because a gate nothing pins is a gate nobody has.
  test("dead links inside pages fail the build, and nothing has switched that off", async () => {
    const config = await loadConfig();
    // Read as a value, not as text: `ignoreDeadLinks: true` is the standard
    // way somebody unblocks a red build, and it makes `docs:build` pass with
    // a dead link present.
    expect(config.ignoreDeadLinks).toBe(false);
  });

  test("CI builds the docs site, so a dead link reproves the pull request", () => {
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    // The whole step was deletable with every test green. Pin the name, the
    // command and the guard — a typo in the guard skips it on all three
    // operating systems and looks exactly like a passing build.
    expect(ci).toMatch(
      /- name: Build the docs site\n\s*if: matrix\.os == 'ubuntu-latest'\n\s*run: bun run docs:build/,
    );
  });

  // The concept pages are 570 lines of prose that no assertion reached: the
  // only content test checked shapes.md for four words, and a five-line stub
  // containing exactly those four words passed it. These two are written to
  // fail on that stub.
  const CONCEPT_PAGES = [
    "permission.md", "presence.md", "recall.md", "shapes.md", "territory.md", "work-pool.md",
  ];

  test("every concept page still argues its case and ends in how it fails", () => {
    for (const page of CONCEPT_PAGES) {
      const text = readFileSync(join(root, "docs", "concepts", page), "utf8");
      // The plan's contract for these pages: every one of them *ends* on
      // degradation, because that is the promise the project makes. Asserted
      // as the last section rather than merely present, so a page cannot keep
      // the heading and bury it in the middle.
      const sections = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
      expect(sections.length).toBeGreaterThanOrEqual(2);
      expect(sections.at(-1)).toBe("What happens when it fails");
      expect(text.split(/\s+/).length).toBeGreaterThan(400);
    }
  });

  /**
   * `recall.md` is the one concept page with no `## Why it is built this way`,
   * and it is named here for the same reason the absent `capacity` sidebar
   * entry is named in the config: an exemption written down is a decision, and
   * an exemption left implicit is a hole. Its three body sections argue the
   * design as they go — the floor, reaching it, and why the brain is designed
   * but not operable on this branch — rather than gathering the argument under
   * one heading.
   *
   * If a page ever loses the heading, this fails; if `recall.md` grows one,
   * the second assertion fails and the exemption comes out. Both directions,
   * so the list cannot quietly grow to cover a page that simply stopped
   * arguing its case.
   */
  const NO_WHY_SECTION = ["recall.md"];

  test("every concept page but the one named argues why it is built that way", () => {
    const missing = CONCEPT_PAGES.filter(
      (page) =>
        !readFileSync(join(root, "docs", "concepts", page), "utf8").includes(
          "\n## Why it is built this way\n",
        ),
    );
    expect(missing).toEqual(NO_WHY_SECTION);
  });

  test("no page promises a warning the hook path never emits", () => {
    // `docs/concepts/territory.md` gets this right and the landing page got it
    // wrong, so the site asserted it twice and refuted it once. An unreachable
    // daemon is loud on the CLI path (`src/cli/main.ts`, "continuing without
    // coordination") and silent on the hook path — which is the one that runs
    // while somebody is actually editing.
    const hook = readFileSync(join(root, "src", "adapters", "hook.ts"), "utf8");
    // Pinned against the source, not against a memory of it: if the hook ever
    // starts warning, this test should be the thing that says so.
    expect(hook).toContain("return emit({})");

    // The page list was three names written by hand, which is how a fourth
    // page states it wrong: `docs/PROTOCOL.md:657` said the degradation came
    // "with a loud warning" while `README.md#one-rule`, published two sidebar
    // entries away at /guide/what-it-is, said silence. Both this branch's
    // output, both in the sidebar — spec against spec, not spec against code.
    // So the list is now every page the site publishes, plus the README the
    // site includes from.
    const pages = ["README.md", ...sitePages(join(root, "docs"))];
    expect(pages.length).toBeGreaterThanOrEqual(15);
    for (const page of pages) {
      const text = readFileSync(join(root, page), "utf8");
      expect({ page, saysSo: /degrades to .?advisory.? and says so/i.test(text) }).toEqual({
        page,
        saysSo: false,
      });
    }
    // And the negative alone is whack-a-mole — "with a loud warning" is a
    // different sentence with the same defect, and it survived a whole-branch
    // review and four fix rounds. So the requirement is positive: wherever a
    // page describes the degradation at all, it has to say what the *hook*
    // does, because the hook is the half that is silent and the half that runs
    // while somebody is editing. Describing only the CLI path is the failure.
    let described = 0;
    for (const page of pages) {
      const text = readFileSync(join(root, page), "utf8");
      for (const m of text.matchAll(/degrades to \*{0,2}`?advisory`?/gi)) {
        described++;
        // Windowed to the sentence, not to a fixed 400 characters: a table row
        // ends at the next `\n|` and a paragraph at the next blank line, and
        // without that the row below ("Hook slow | …") lends this one the word
        // "hook" it failed to say for itself.
        const rest = text.slice(m.index);
        const stops = [rest.indexOf("\n\n"), rest.indexOf("\n|")].filter((i) => i > 0);
        const window = rest.slice(0, Math.min(...stops, 400));
        expect({
          page,
          names: /hook/i.test(window),
          silent: /nothing|silen|quiet/i.test(window),
        }).toEqual({ page, names: true, silent: true });
      }
    }
    // A regex that stopped matching would make the loop vacuous and green.
    expect(described).toBeGreaterThanOrEqual(1);
    // And the correction has to actually say what happens instead.
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("unclaimed");
  });

  // Citations used to be checked here, with `Number(to ?? from) <= lines`.
  // That is a claim about a file being long enough, and a citation is a claim
  // about content: `src/cli/main.ts` grew by 49 lines, seven citations slid
  // onto unrelated code, and every one still pointed at a line that existed.
  // The real guard is tests/docs/citations.test.ts, which pins the cited text.
});
