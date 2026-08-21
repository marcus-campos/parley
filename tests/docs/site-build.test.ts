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
});
