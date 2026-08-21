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

// The compiled binary is the real `main()`, not a reimplementation of it —
// this is the only place that can prove the CLI's own ordering (probe, then
// refuse-and-stop, with no download in between) without inventing a seam
// that doesn't exist in production.
describe.if(existsSync(BIN))("parley brain enable, from the compiled binary", () => {
  test("an agent is refused before a single byte is downloaded", async () => {
    const repo = mkdtempSync(join(tmpdir(), "parley-brain-cli-"));
    const home = mkdtempSync(join(tmpdir(), "parley-brain-home-"));
    // Redirect every machine-local path the CLI could resolve to, so this
    // test cannot land anything in the real machine-local state directory —
    // same discipline as tests/brain/download.test.ts, applied here to a
    // spawned process instead of an in-process call.
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
      expect(existsSync(expectedModelsDir(home))).toBe(false);

      Bun.spawnSync([BIN, "stop"], { cwd: repo, env });
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 15_000);
});
