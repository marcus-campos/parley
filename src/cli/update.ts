import { chmodSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { VERSION } from "../version";
import { readEndpoint } from "../daemon/endpoint";

/**
 * `parley update` — replace this binary with the latest release.
 *
 * Exists because the alternative is a three-step ritual nobody remembers:
 * re-download, move it onto the PATH, and then `parley stop`, because a daemon
 * that is already running keeps serving the version it started with. Forgetting
 * the last step is the one that produces a confusing bug report.
 */

const REPO = "marcus-campos/parley";

export interface UpdateOptions {
  checkOnly: boolean;
  assumeYes: boolean;
  json: boolean;
  gitCommonDir: string | null;
  /** Worktree root, when the command was run inside a repository. */
  repoRoot: string | null;
  /**
   * Where endpoint.json actually lives. For a repository that is under the git
   * dir; for a workspace it is `<root>/.parley`. Using the bus key here meant
   * the daemon was never found in a workspace — so the update replaced the
   * binary and left the old daemon serving, which is the confusing half-state
   * this whole step exists to prevent.
   */
  discoveryDir: string | null;
}

interface Target { asset: string; label: string }

export function targetForThisMachine(): Target | { error: string } {
  const platform = process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
  if (!arch) return { error: `no prebuilt binary for ${process.arch}` };

  if (platform === "win32") {
    if (arch !== "x64") {
      return { error: "Windows on arm64 has no prebuilt binary yet; build from source" };
    }
    return { asset: "parley-windows-x64.exe", label: "windows-x64" };
  }
  if (platform === "darwin") return { asset: `parley-darwin-${arch}`, label: `darwin-${arch}` };
  if (platform === "linux") return { asset: `parley-linux-${arch}`, label: `linux-${arch}` };
  return { error: `no prebuilt binary for ${platform}` };
}

/** Compare `1.2.3`-shaped versions. Returns >0 when `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.\-+]/).map((p) => Number.parseInt(p, 10));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = Number.isFinite(left[i]!) ? left[i]! : 0;
    const r = Number.isFinite(right[i]!) ? right[i]! : 0;
    if (l !== r) return l - r;
  }
  return 0;
}

async function latestTag(): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": `parley/${VERSION}` },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} asking for the latest release`);
  const body = (await response.json()) as { tag_name?: string };
  if (!body.tag_name) throw new Error("the latest release has no tag");
  return body.tag_name;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": `parley/${VERSION}` } });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function say(opts: UpdateOptions, human: string, payload: unknown): void {
  if (opts.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else process.stdout.write(`${human}\n`);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function runUpdate(opts: UpdateOptions): Promise<void> {
  const target = targetForThisMachine();
  if ("error" in target) {
    say(opts, `parley: ${target.error}`, { ok: false, error: target.error });
    process.exit(1);
  }

  // Running from source has no binary to replace, and silently doing nothing
  // would be worse than saying so.
  const binary = process.execPath;
  const compiled = import.meta.url.includes("$bunfs");
  if (!compiled) {
    const message =
      "running from source, not from a release binary. Update with `git pull && bun run build`.";
    say(opts, `parley: ${message}`, { ok: false, error: message });
    process.exit(1);
  }

  let tag: string;
  try {
    tag = await latestTag();
  } catch (e) {
    const message = (e as Error).message;
    say(opts, `parley: could not reach GitHub — ${message}`, { ok: false, error: message });
    process.exit(1);
  }

  const latest = tag.replace(/^v/, "");
  const behind = compareVersions(latest, VERSION) > 0;

  if (!behind) {
    say(
      opts,
      `parley ${VERSION} is the latest release${compareVersions(VERSION, latest) > 0 ? ` (ahead of ${latest})` : ""}.`,
      { ok: true, current: VERSION, latest, update_available: false },
    );
    // Up to date does not mean installed-and-up-to-date: someone who updated
    // the binary by hand still has the old skill sitting in the repository.
    // Already the latest binary, so this process *is* the current version and
    // can write the adapters itself.
    if (!opts.checkOnly) {
      const { refreshAllAdapters } = await import("../adapters/install");
      await refreshAllAdapters({
        assumeYes: opts.assumeYes, json: opts.json,
        here: opts.repoRoot && opts.gitCommonDir
          ? { root: opts.repoRoot, gitCommonDir: opts.gitCommonDir }
          : null,
      });
    }
    return;
  }

  if (opts.checkOnly) {
    say(
      opts,
      `parley ${latest} is available; you have ${VERSION}. Run \`parley update\` to install it.`,
      { ok: true, current: VERSION, latest, update_available: true },
    );
    return;
  }

  if (!opts.json) {
    process.stdout.write(`parley: ${VERSION} -> ${latest} (${target.label})\n`);
    process.stdout.write(`        will replace ${binary}\n`);
  }
  if (!opts.assumeYes && !(await confirm("Download and install it?"))) {
    say(opts, "parley: aborted, nothing changed.", { ok: false, aborted: true });
    return;
  }

  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  let bytes: Uint8Array;
  try {
    bytes = await download(`${base}/${target.asset}`);
  } catch (e) {
    say(opts, `parley: ${(e as Error).message}`, { ok: false, error: (e as Error).message });
    process.exit(1);
  }

  // Fetched over the same channel as the binary, so this is not a security
  // boundary — it catches a truncated or corrupted download, which is the
  // failure that actually happens.
  try {
    const published = new TextDecoder().decode(await download(`${base}/${target.asset}.sha256`));
    const expected = published.trim().split(/\s+/)[0]?.toLowerCase();
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (expected && expected !== actual) {
      const message = "checksum mismatch — refusing to install a corrupted binary";
      say(opts, `parley: ${message}`, { ok: false, error: message });
      process.exit(1);
    }
    if (!opts.json && expected) process.stdout.write("parley: checksum ok\n");
  } catch {
    if (!opts.json) process.stdout.write("parley: no published checksum, skipping verification\n");
  }

  const staged = join(tmpdir(), `parley-update-${process.pid}`);
  try {
    writeFileSync(staged, bytes);
    chmodSync(staged, 0o755);

    // On Windows a running executable cannot be overwritten, but it can be
    // renamed out of the way; the leftover is cleaned up on the next run.
    if (process.platform === "win32") {
      const parked = `${binary}.old`;
      if (existsSync(parked)) { try { rmSync(parked, { force: true }); } catch { /* still locked */ } }
      renameSync(binary, parked);
      renameSync(staged, binary);
    } else {
      // Same filesystem keeps this a rename, which is atomic: no window in
      // which the binary on the PATH is half-written.
      const beside = join(dirname(binary), `.parley-update-${process.pid}`);
      writeFileSync(beside, bytes);
      chmodSync(beside, 0o755);
      renameSync(beside, binary);
      rmSync(staged, { force: true });
    }
  } catch (e) {
    rmSync(staged, { force: true });
    const err = e as NodeJS.ErrnoException;
    const denied = err.code === "EACCES" || err.code === "EPERM";
    const message = denied
      ? `no permission to replace ${binary}. Try: sudo parley update`
      : `could not replace ${binary}: ${err.message}`;
    say(opts, `parley: ${message}`, { ok: false, error: message });
    process.exit(1);
  }

  // A daemon that is already running keeps serving the version it started with,
  // so the update is not really applied until it exits. The next command spawns
  // a fresh one automatically.
  let stopped = false;
  if (opts.gitCommonDir) {
    const endpoint = readEndpoint(opts.discoveryDir ?? opts.gitCommonDir);
    if (endpoint) {
      try { process.kill(endpoint.pid, "SIGTERM"); stopped = true; } catch { /* already gone */ }
    }
  }

  say(
    opts,
    `parley: updated ${VERSION} -> ${latest}.${stopped ? " Stopped the running daemon so the new version is picked up." : ""}`,
    { ok: true, from: VERSION, to: latest, daemon_stopped: stopped },
  );

  // The binary is only half the install: the hooks and the skill were written
  // by whatever version ran `init`, and the skill is what the agent reads.
  //
  // Handing this to a fresh process is not tidiness. This process still holds
  // the *previous* version's skill text in memory — writing it from here put
  // last version's instructions on disk, and only a second `parley update`
  // fixed them. One run should be enough.
  await new Promise<void>((resolve) => {
    const child = spawn(
      binary,
      ["__refresh-adapters", ...(opts.assumeYes ? ["--yes"] : []), ...(opts.json ? ["--json"] : [])],
      // Run it from the repository we are in, so the new process picks the same
      // one up as "here" even when it was never registered.
      { stdio: "inherit", cwd: opts.repoRoot ?? process.cwd() },
    );
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

export function binaryMtime(): string | null {
  try {
    return statSync(process.execPath).mtime.toISOString();
  } catch {
    return null;
  }
}
