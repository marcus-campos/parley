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
  // Four concept links document features from Task 4 of the docs-site plan
  // (shapes, the work pool, capacity, recall — docs/superpowers/plans/
  // 2026-08-20-docs-site.md) and are written once those features' own plans
  // land, which Task 3 does not do. They are named here explicitly, not
  // silently skipped, so this stays a real regression test for every link
  // Task 3 (and earlier tasks) are actually responsible for, instead of
  // either failing on work this task does not own or skipping the check
  // wholesale.
  const PENDING_TASK_4 = new Set([
    "/concepts/shapes",
    "/concepts/work-pool",
    "/concepts/capacity",
    "/concepts/recall",
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
  // link hides forever: once Task 4 lands, every one of these must actually
  // resolve, so pin the count instead of letting the set silently grow.
  test("exactly the four Task 4 concept pages are still pending", () => {
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
});
