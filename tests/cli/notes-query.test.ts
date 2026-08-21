import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "..", "dist", "parley");

/**
 * Same discipline as `tests/cli/brain.test.ts`: a fresh repo and a fresh fake
 * $HOME, so a spawned `dist/parley` cannot touch the real machine-local state
 * directory.
 */
async function withTempRepo(fn: (repo: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "parley-notes-query-cli-"));
  const home = mkdtempSync(join(tmpdir(), "parley-notes-query-home-"));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_STATE_HOME: join(home, ".local-state-for-test"),
  };
  try {
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "."], { cwd: repo });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "x"], {
      cwd: repo,
      env: {
        ...env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    await fn(repo, env);
    Bun.spawnSync([BIN, "stop"], { cwd: repo, env });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

function run(args: string[], repo: string, env: NodeJS.ProcessEnv): { stdout: string; code: number } {
  const p = Bun.spawnSync([BIN, ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  return { stdout: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr), code: p.exitCode };
}

/**
 * The review's Important-2 finding, confirmed end to end: `grep -rn
 * "semantic" src/` found only the implementation, comments and a help
 * string — never the CLI, never MCP, never the hook — so spec §5.1's
 * activation flow (a front asks, the panel is told once) could never fire.
 * Reproduces the review's own check: four notes and two `notes --query`
 * calls against a real daemon, then `parley history`.
 */
describe.if(existsSync(BIN))("parley notes/results --query sets semantic: true, from the compiled binary", () => {
  test("a --query call nudges the panel that the brain is off, once — a plain listing never does", async () => {
    await withTempRepo(async (repo, env) => {
      for (let i = 0; i < 4; i++) run(["note", "--title", `note ${i}`], repo, env);

      // A plain listing (no --query) must not touch `semantic` at all.
      const plain = run(["notes", "--json"], repo, env);
      expect(plain.code).toBe(0);

      const first = run(["notes", "--query", "note", "--json"], repo, env);
      expect(first.code).toBe(0);
      const second = run(["results", "--query", "anything", "--json"], repo, env);
      expect(second.code).toBe(0);

      const history = run(["history", "--json"], repo, env);
      expect(history.code).toBe(0);
      const events = (JSON.parse(history.stdout) as { events: { text: string }[] }).events;
      const nudge = events.find((e) => e.text.includes("asked for semantic recall"));
      expect(nudge).toBeDefined();

      // Nudged once — a second (and third) --query call must not repeat it.
      expect(events.filter((e) => e.text.includes("asked for semantic recall"))).toHaveLength(1);
    });
  }, 20_000);
});
