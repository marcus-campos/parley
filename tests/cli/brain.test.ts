import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoadable } from "../../src/brain/embed";
import { BENCHMARK_SIZE, isStatic, MODELS, RECOMMENDED } from "../../src/brain/registry";

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

  test("and a person's shell gets the menu, ranked by what each model scored", async () => {
    await withTempRepo(async (repo, env) => {
      // Not a formality. An earlier version skipped the listing whenever there
      // was one loadable entry, so a person typed `enable` and received 54 MB
      // of something whose name told them nothing. The listing is where they
      // find out what they are agreeing to.
      const clean = { ...env } as Record<string, string>;
      delete clean.CLAUDE_CODE_SESSION_ID;
      delete clean.CODEX_SESSION_ID;
      delete clean.CURSOR_TRACE_ID;
      const p = Bun.spawn([BIN, "brain", "enable", "--json"], {
        cwd: repo, env: clean, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      expect(code).toBe(0);
      const payload = JSON.parse(stdout) as {
        recommended: string;
        models: {
          name: string; score: number; of: number; bytes: number; dims: number;
          needsRuntime: boolean; recommended: boolean;
        }[];
      };
      expect(payload.models.length).toBeGreaterThan(1);
      // Every row carries a measured score and what it costs. The listing used
      // to describe models in prose ("English and Portuguese — the one to take
      // unless the disk hurts"), which asked a person to interpret adjectives
      // written by whoever added the entry. A number they can rank on is the
      // thing that lets them choose.
      for (const m of payload.models) {
        expect(m.score).toBeGreaterThan(0);
        expect(m.score).toBeLessThanOrEqual(m.of);
        expect(m.bytes).toBeGreaterThan(0);
        expect(m.dims).toBeGreaterThan(0);
      }
      // Ranked, best first — a menu is only a ranking if it is ordered.
      const scores = payload.models.map((m) => m.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
      // Exactly one is recommended, and it is a model that exists.
      expect(payload.models.filter((m) => m.recommended)).toHaveLength(1);
      expect(payload.models.map((m) => m.name)).toContain(payload.recommended);
      // The recommendation is the top of the ranking, not a separate opinion.
      expect(payload.models[0]!.name).toBe(payload.recommended);
      // And nothing was downloaded to show a menu.
      expect(existsSync(expectedModelsDir(clean.HOME as string))).toBe(false);
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
    const unloadable = {
      name: "x", kind: "static", dims: 8, score: 1, ramMB: 1, msPerNote: 1, bytes: 1, url: "", sha256: "", tokenizer: "xlmr",
    } as const;
    expect(isLoadable(unloadable)).toBe(false);
    // And the shipped registry offers nothing a person can pick and not use:
    // that is the property whose absence produced a dead end.
    expect(MODELS.filter(isStatic).filter((m) => !isLoadable(m))).toEqual([]);
    expect(MODELS.length).toBeGreaterThan(0);
  });


  test("the recommendation is measured, and every listed model can be loaded", () => {
    // `RECOMMENDED` is not a preference. It is the model that returned 19 of 20
    // correct answers past the floor on a bilingual benchmark of the task
    // parley performs, against 15 for the next one down. What this pins is that
    // it names something real and loadable — the measurement lives in the
    // registry's comment, where the next person changing it will read it.
    expect(MODELS.map((m) => m.name)).toContain(RECOMMENDED);
    expect(MODELS.filter(isStatic).filter((m) => !isLoadable(m))).toEqual([]);
    expect(MODELS.length).toBeGreaterThan(1);
  });
});
