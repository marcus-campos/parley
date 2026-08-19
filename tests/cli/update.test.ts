import { describe, expect, test } from "bun:test";
import { compareVersions, targetForThisMachine } from "../../src/cli/update";

describe("compareVersions", () => {
  test("orders releases the obvious way", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("a leading v is not part of the version", () => {
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("v1.0.0", "v0.9.9")).toBeGreaterThan(0);
  });

  test("10 is newer than 9, which string comparison gets backwards", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
  });

  test("missing components count as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });
});

describe("targetForThisMachine", () => {
  test("names an asset that the release workflow actually publishes", () => {
    // These five, and only these five, are built by .github/workflows/release.yml.
    const published = new Set([
      "parley-linux-x64", "parley-linux-arm64",
      "parley-darwin-x64", "parley-darwin-arm64",
      "parley-windows-x64.exe",
    ]);
    const target = targetForThisMachine();
    expect("error" in target || published.has(target.asset)).toBe(true);
  });
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapterStatus, refreshAdapter } from "../../src/adapters/claude-code";

function repoWithAdapter(skill: string, hooks: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "parley-adapter-"));
  mkdirSync(join(dir, ".claude", "skills", "parley"), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", "parley", "SKILL.md"), skill, "utf8");
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks }, null, 2), "utf8");
  return dir;
}

describe("adapterStatus", () => {
  test("a repository with nothing installed reports so", () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-adapter-"));
    try {
      expect(adapterStatus(dir).installed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a skill written by an older version is spotted as outdated", () => {
    const dir = repoWithAdapter("---\nname: parley\n---\n\nold text\n", {
      SessionStart: [{ hooks: [{ type: "command", command: "parley hook SessionStart", timeout: 5 }] }],
    });
    try {
      const status = adapterStatus(dir);
      expect(status.installed).toBe(true);
      expect(status.skillCurrent).toBe(false);
      expect(status.skillEdited).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refreshAdapter", () => {
  test("rewrites the skill and the hooks to what this version ships", async () => {
    const dir = repoWithAdapter("stale", { SessionStart: [{ hooks: [{ type: "command", command: "parley hook SessionStart" }] }] });
    try {
      const changed = await refreshAdapter(dir, { assumeYes: true, json: true });
      expect(changed).toBe(true);

      const after = adapterStatus(dir);
      expect(after.skillCurrent).toBe(true);
      expect(after.hooksCurrent).toBe(true);

      // The instructions the agent reads are the point of the refresh.
      const skill = readFileSync(join(dir, ".claude", "skills", "parley", "SKILL.md"), "utf8");
      expect(skill).toContain("Release the moment you are done");
      expect(skill).toContain("parley notes --import");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("it does nothing when there is nothing installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-adapter-"));
    try {
      expect(await refreshAdapter(dir, { assumeYes: true, json: true })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an already-current adapter is left alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "parley-adapter-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "settings.json"), "{}", "utf8");
      await refreshAdapter(dir, { assumeYes: true, json: true });   // installs nothing: not installed
      // Install it properly, then a second refresh must be a no-op.
      const first = repoWithAdapter("stale", {});
      await refreshAdapter(first, { assumeYes: true, json: true });
      expect(await refreshAdapter(first, { assumeYes: true, json: true })).toBe(false);
      rmSync(first, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the generated hooks", () => {
  test("PreToolUse also matches Bash, which is how CLI calls get attributed", async () => {
    // Not cosmetic: Bash is the tool the agent runs `parley` through. Firing
    // the hook just before it refreshes which session owns this worktree,
    // microseconds before the CLI call reads it. Dropping Bash from this
    // matcher silently reintroduces two sessions sharing one identity.
    const dir = repoWithAdapter("stale", {});
    try {
      await refreshAdapter(dir, { assumeYes: true, json: true });
      const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
      const pre = settings.hooks.PreToolUse[0];
      expect(pre.matcher).toContain("Bash");
      expect(pre.matcher).toContain("Edit");
      expect(pre.matcher).toContain("Write");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the skill tells the agent to announce its name to the person", async () => {
    const dir = repoWithAdapter("stale", {});
    try {
      await refreshAdapter(dir, { assumeYes: true, json: true });
      const skill = readFileSync(join(dir, ".claude", "skills", "parley", "SKILL.md"), "utf8");
      expect(skill).toContain("Say who you are, out loud");
      expect(skill).toContain("parley whoami");
      expect(skill).toContain("which of their windows you are");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
