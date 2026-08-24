import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoadable } from "../../src/brain/embed";
import { MODELS } from "../../src/brain/registry";

const BIN = join(import.meta.dir, "..", "..", "dist", "parley");

function expectedModelsDir(home: string): string {
  // Mirrors `defaultModelsDir` in src/brain/download.ts exactly, so this
  // assertion is platform-correct wherever the suite runs, not just on the
  // machine this was written on.
  if (process.platform === "win32") return join(home, "AppData", "Local", "parley", "models");
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "parley", "models");
  return join(home, ".local-state-for-test", "parley", "models");
}

/**
 * A fresh repo and a fresh fake $HOME, so a spawned `dist/parley` cannot land
 * anything in the real machine-local state directory — same discipline as
 * `tests/brain/download.test.ts`, applied here to a spawned process instead
 * of an in-process call. `fn` gets the repo dir and the env to spawn with.
 */
async function withTempRepo(fn: (repo: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "parley-brain-cli-"));
  const home = mkdtempSync(join(tmpdir(), "parley-brain-home-"));
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

// The compiled binary is the real `main()`, not a reimplementation of it —
// this is the only place that can prove the CLI's own ordering (probe, then
// refuse-and-stop, with no download in between) without inventing a seam
// that doesn't exist in production.
describe.if(existsSync(BIN))("parley brain enable, from the compiled binary", () => {
  test("an agent session is refused before a single byte is downloaded", async () => {
    await withTempRepo(async (repo, env) => {
      // The signal is the harness's own session variable. A person's shell does
      // not carry one; every agent harness stamps one in. That is the fact the
      // refusal needs, and unlike the old `kind` check it does not require the
      // caller to have joined anything — which is what used to drag a person
      // into the fronts' namespace and get them refused as an agent.
      const p = Bun.spawn([BIN, "brain", "enable"], {
        cwd: repo,
        env: { ...env, CLAUDE_CODE_SESSION_ID: "a-harness-session" },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
      ]);
      expect(code).not.toBe(0);
      const text = stdout + stderr;
      expect(text).toContain("agent session");
      expect(text).not.toContain("downloading");
      expect(existsSync(expectedModelsDir(env.HOME as string))).toBe(false);
    });
  }, 15_000);

  test("and a person's shell is not — no flag, nothing to join", async () => {
    await withTempRepo(async (repo, env) => {
      // Not run to completion: this would download 54 MB. What is asserted is
      // that it gets past the refusal and reaches the download, which is the
      // whole of what the previous version could not do for a person standing
      // in a repository where an agent was already working.
      const clean = { ...env } as Record<string, string>;
      delete clean.CLAUDE_CODE_SESSION_ID;
      delete clean.CODEX_SESSION_ID;
      delete clean.CURSOR_TRACE_ID;
      const p = Bun.spawn([BIN, "brain", "enable"], {
        cwd: repo, env: clean, stdout: "pipe", stderr: "pipe",
      });
      // Give it long enough to print the size and start, then stop it.
      await new Promise((r) => setTimeout(r, 1500));
      p.kill();
      const text = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
      expect(text).not.toContain("agent session");
      expect(text).toContain("downloading");
    });
  }, 20_000);

  /**
   * The refusal is about the loader, not about the registry's contents.
   *
   * This used to name the one `xlmr` entry the registry listed — and that entry
   * is gone, because a menu whose only row cannot be chosen taught people the
   * feature was broken. What must still hold is the rule underneath it: a
   * tokenizer this build does not carry is refused, and the check is in
   * `isLoadable` rather than in a list that happens to contain an example.
   */
  test("a tokenizer this build cannot load is refused, whatever the registry lists", () => {
    const unloadable = { name: "x", dims: 8, languages: "", bytes: 1, url: "", sha256: "", tokenizer: "xlmr" } as const;
    expect(isLoadable(unloadable)).toBe(false);
    // And the shipped registry offers nothing a person can pick and not use:
    // that is the property whose absence produced a dead end.
    expect(MODELS.filter((m) => !isLoadable(m))).toEqual([]);
    expect(MODELS.length).toBeGreaterThan(0);
  });


  test("with one loadable entry there is nothing to choose, so enable acts", () => {
    // The listing used to be what `enable` with no name produced, and this
    // asserted its shape. It now appears only when there is a choice: asking
    // somebody to name a thing when there is one thing is a menu for the menu's
    // sake, and it is what made a person read a name, type it, and be refused.
    //
    // Asserted on the registry rather than by running the binary, because the
    // action `enable` now takes is a download — the one thing a test must not
    // do for real.
    const loadable = MODELS.filter(isLoadable);
    expect(loadable.length).toBe(1);
    expect(loadable[0]!.name).toBe(MODELS[0]!.name);
  });
});
