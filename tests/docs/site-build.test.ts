import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

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
    const config = readFileSync(join(root, "docs", ".vitepress", "config.ts"), "utf8");
    expect(config).toContain("srcExclude");
    expect(config).toContain("superpowers/**");
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
  // does not fail its build when they point at a page that does not exist
  // (only broken links *inside rendered markdown* fail the build under
  // ignoreDeadLinks: false). Without this test, a sidebar entry can 404 on
  // the published site indefinitely with every other check staying green.
  //
  // Four concept links were named in Task 4 of the docs-site plan (shapes,
  // the work pool, capacity, recall — docs/superpowers/plans/
  // 2026-08-20-docs-site.md). This branch forked before capacity's own
  // feature (src/spawn/birth.ts) existed, so shapes, work-pool and recall
  // are written now — each against only the machinery actually present here
  // — while capacity stays out until the branches converge and there is
  // real code to describe rather than a design doc. It is named here
  // explicitly, not silently skipped, so this stays a real regression test
  // for every link this task and earlier ones are actually responsible for,
  // instead of either failing on work nobody has done yet or skipping the
  // check wholesale.
  const PENDING_TASK_4 = new Set([
    "/concepts/capacity",
  ]);

  test("every sidebar link resolves to a file", () => {
    const config = readFileSync(join(root, "docs", ".vitepress", "config.ts"), "utf8");
    const links = [...config.matchAll(/link:\s*"(\/[^"]+)"/g)].map((m) => m[1]!);
    // The regex above cannot fail to match anything (it would just find zero
    // links), so assert there is a non-trivial number of them first — a test
    // that "passes" over an empty list proves nothing.
    expect(links.length).toBeGreaterThanOrEqual(9);
    for (const link of links) {
      if (link.startsWith("http") || PENDING_TASK_4.has(link)) continue;
      const candidates = [
        join(root, "docs", `${link}.md`),
        join(root, "docs", link, "index.md"),
        join(root, "docs", `${link.replace(/^\//, "")}.md`),
      ];
      expect(candidates.some((c) => existsSync(c))).toBe(true);
    }
  });

  // The exclusion above must not become a place where a genuinely broken
  // link hides forever: once capacity lands, this must actually resolve
  // too, so pin the set instead of letting it silently grow.
  test("exactly capacity is still pending, now that shapes, work-pool and recall are written", () => {
    const config = readFileSync(join(root, "docs", ".vitepress", "config.ts"), "utf8");
    const links = [...config.matchAll(/link:\s*"(\/[^"]+)"/g)].map((m) => m[1]!);
    const missing = links.filter((link) => {
      if (link.startsWith("http")) return false;
      const candidates = [
        join(root, "docs", `${link}.md`),
        join(root, "docs", link, "index.md"),
        join(root, "docs", `${link.replace(/^\//, "")}.md`),
      ];
      return !candidates.some((c) => existsSync(c));
    });
    expect(new Set(missing)).toEqual(PENDING_TASK_4);
  });

  test("the shapes page states that mode and shape are different axes", () => {
    const page = readFileSync(join(root, "docs", "concepts", "shapes.md"), "utf8");
    expect(page).toContain("orthogonal");
    expect(page).toContain("bus");
    expect(page).toContain("pool");
    expect(page).toContain("plan");
  });
});
