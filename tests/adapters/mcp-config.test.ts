import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentsFilePlan, codexPlan, projectMcpPlan, removeCodex, removeProjectMcp,
} from "../../src/adapters/mcp-config";

const temp = () => mkdtempSync(join(tmpdir(), "parley-mcp-"));

describe("project .mcp.json", () => {
  test("creates the file when there is none", () => {
    const dir = temp();
    try {
      const path = join(dir, ".mcp.json");
      const parsed = JSON.parse(projectMcpPlan(path).after);
      expect(parsed.mcpServers.parley).toEqual({ command: "parley", args: ["mcp"] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("keeps servers that were already configured", () => {
    const dir = temp();
    try {
      const path = join(dir, ".mcp.json");
      writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf8");
      const parsed = JSON.parse(projectMcpPlan(path).after);
      expect(parsed.mcpServers.other).toEqual({ command: "x" });
      expect(parsed.mcpServers.parley).toBeDefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("removing takes ours out and leaves theirs", () => {
    const dir = temp();
    try {
      const path = join(dir, ".mcp.json");
      writeFileSync(path, JSON.stringify({
        mcpServers: { other: { command: "x" }, parley: { command: "parley" } },
      }), "utf8");
      expect(removeProjectMcp(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.mcpServers.parley).toBeUndefined();
      expect(parsed.mcpServers.other).toBeDefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("codex config.toml", () => {
  test("appends without disturbing what is already there", () => {
    const dir = temp();
    try {
      const path = join(dir, "config.toml");
      const original = '[projects."/repo"]\ntrust_level = "trusted"\n';
      writeFileSync(path, original, "utf8");
      const after = codexPlan(path).after;
      expect(after).toContain('[projects."/repo"]');
      expect(after).toContain("[mcp_servers.parley]");
      expect(after).toContain('args = ["mcp"]');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("running init twice does not duplicate the block", () => {
    const dir = temp();
    try {
      const path = join(dir, "config.toml");
      writeFileSync(path, codexPlan(path).after, "utf8");
      writeFileSync(path, codexPlan(path).after, "utf8");
      const occurrences = readFileSync(path, "utf8").split("[mcp_servers.parley]").length - 1;
      expect(occurrences).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("removing takes out only our block", () => {
    const dir = temp();
    try {
      const path = join(dir, "config.toml");
      writeFileSync(path, '[projects."/repo"]\ntrust_level = "trusted"\n', "utf8");
      writeFileSync(path, codexPlan(path).after, "utf8");
      expect(removeCodex(path)).toBe(true);
      const left = readFileSync(path, "utf8");
      expect(left).toContain('trust_level = "trusted"');
      expect(left).not.toContain("mcp_servers.parley");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("removing from a file that never had it is a no-op", () => {
    const dir = temp();
    try {
      const path = join(dir, "config.toml");
      writeFileSync(path, "[other]\nx = 1\n", "utf8");
      expect(removeCodex(path)).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("[other]\nx = 1\n");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("AGENTS.md", () => {
  test("appends the section, keeping what the user wrote", () => {
    const dir = temp();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# My rules\n\nDo not use tabs.\n", "utf8");
      const plan = agentsFilePlan(dir);
      expect(plan.already).toBe(false);
      expect(plan.after).toContain("Do not use tabs.");
      expect(plan.after).toContain("## parley — other agents may be in this repository");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a second run recognises its own section and adds nothing", () => {
    const dir = temp();
    try {
      writeFileSync(join(dir, "AGENTS.md"), agentsFilePlan(dir).after, "utf8");
      const plan = agentsFilePlan(dir);
      expect(plan.already).toBe(true);
      expect(plan.after).toBe(plan.before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
