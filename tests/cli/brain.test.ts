import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  test("an agent is refused before a single byte is downloaded", async () => {
    await withTempRepo(async (repo, env) => {
      // No --human: this is an agent. The registry name is real, so a bug
      // that downloads before checking `may_enable` would actually reach
      // the network — this proves it never gets that far.
      const p = Bun.spawn([BIN, "brain", "enable", "potion-multilingual-128M-int8"], {
        cwd: repo, env, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);

      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain("somebody's disk and somebody's money");
      // The download line only prints after the probe passes — its absence
      // is direct evidence `ensureModel` was never reached, not just that
      // the command happened to exit non-zero for some other reason.
      expect(stdout + stderr).not.toContain("downloading");
      expect(existsSync(expectedModelsDir(env.HOME as string))).toBe(false);
    });
  }, 15_000);

  /**
   * Same harm as the agent case, from a different direction (the ruling on
   * Task 7's review): the one real registry entry declares `tokenizer:
   * "xlmr"`, and this build's loader (`src/brain/embed.ts`) understands only
   * `wordlevel`. Without this refusal, a human would agree to the size, wait
   * for the whole download, and end up with a brain that can never load —
   * exactly the harm the agent-refusal test above already proves this CLI
   * avoids, arriving here through a model instead of through an actor.
   */
  test("a human is refused before a single byte is downloaded — this build cannot load the xlmr tokenizer", async () => {
    await withTempRepo(async (repo, env) => {
      const p = Bun.spawn([BIN, "brain", "enable", "potion-multilingual-128M-int8", "--human"], {
        cwd: repo, env, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);

      expect(code).not.toBe(0);
      const text = stdout + stderr;
      // Named honestly: a limitation of this build, not a bad download or a
      // broken model.
      expect(text).toContain("xlmr");
      expect(text).not.toContain("downloading");
      expect(existsSync(expectedModelsDir(env.HOME as string))).toBe(false);
    });
  }, 15_000);

  test("the listing marks which entries this build can actually load", async () => {
    await withTempRepo(async (repo, env) => {
      const p = Bun.spawn([BIN, "brain", "enable", "--human", "--json"], {
        cwd: repo, env, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      expect(code).toBe(0);

      const payload = JSON.parse(stdout) as { models: { name: string; tokenizer?: string; loadable: boolean }[] };
      const entry = payload.models.find((m) => m.name === "potion-multilingual-128M-int8");
      expect(entry).toBeDefined();
      expect(entry!.loadable).toBe(false);
    });
  }, 15_000);
});
