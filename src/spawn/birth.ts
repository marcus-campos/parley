import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnConfig } from "../cli/spawn-config";
import type { BirthIntent } from "../state/machine";
import { addWorktree } from "./worktree";

export interface BornFront {
  name: string;
  pid: number;
  worktree: string;
  mode: "panel" | "terminal";
  /**
   * Stops reading the newborn's output, when there is any to read. The daemon
   * calls it on `close()`: a pipe still being read holds the event loop open,
   * and a test that closes a daemon would otherwise never finish.
   */
  stopOutput?: () => void;
}

type SpawnFn = typeof nodeSpawn;

/**
 * Opens a real terminal running `bin args` in `cwd`, with `env` — the newborn's
 * identity only, never the daemon's environment. Returns its pid, or throws.
 */
type OpenTerminalFn = (cwd: string, bin: string, args: string[], env: Record<string, string>) => number;

/**
 * What a newborn front is told.
 *
 * Note what is missing: any instruction about which item to do. parley
 * provides capacity, not assignments — that is the entire distinction from an
 * orchestrator, which decides *and* dispatches. The front joins the bus, reads
 * the pool with the map as it is right now, not as it was when this intent
 * was raised, and chooses for itself.
 *
 * `parley leave` is named here and not only in the retirement notice. A
 * newborn that empties the pool and stops exactly as instructed used to depend
 * entirely on `SessionEnd` firing to say goodbye — and a harness that does not
 * fire it, or a window closed by hand, left a full checkout and a branch
 * behind. The daemon now collects on death as well (§4.4), so this is no
 * longer the only thing standing between a finished newborn and its worktree;
 * it is still the difference between going home in seconds and going home a
 * lease later.
 */
function openingPrompt(reason: string): string {
  return [
    `You were started by parley because ${reason}.`,
    `Nobody has assigned you anything.`,
    `Run \`parley works --state open\` to see what is in the pool, take what you can do with \`parley take <id>\`,`,
    `and \`parley done <id>\` when it is finished. Taking an item returns the evidence the front that found it left`,
    `behind — read it before you re-derive anything.`,
    `When the pool is empty and you hold nothing, say so, run \`parley leave\`, and stop.`,
  ].join(" ");
}

function harnessCommand(harness: string | undefined): { bin: string; args: string[] } {
  switch (harness) {
    case "codex":
      return { bin: "codex", args: ["exec"] };
    case "claude-code":
    default:
      return { bin: "claude", args: ["-p", "--permission-mode", "acceptEdits"] };
  }
}

/**
 * The binary a harness resolves to on PATH. Exported so the daemon can name it
 * when a front it started never reaches the bus — `claude-code` is the config
 * word, `claude` is what the person's shell has to be able to find.
 */
export function harnessBin(harness: string | undefined): string {
  return harnessCommand(harness).bin;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The command a terminal window is handed — and the only place a newborn's
 * identity enters it.
 *
 * `spawnFn` alone cannot deliver it: a headless child inherits `env` for free,
 * a brand-new terminal window does not — it starts its own shell with its own
 * environment. So identity travels inside the command line, the one thing
 * every terminal on every platform runs verbatim.
 *
 * What it must never do is outlive the agent. `export PARLEY_BORN=parley && cd
 * <worktree> && claude -p …` is typed into a **persistent interactive** shell
 * — `do script` on macOS, `cmd /k` on Windows — so the moment `claude -p`
 * exits, the window is back at a prompt still carrying `PARLEY_BORN=parley`
 * and still sitting in the newborn's worktree. A person who then works in that
 * window joins the bus as a parley-born front whose cwd is under
 * `.parley/worktrees/`, which is exactly the pair `collectWorktree` deletes a
 * directory for. They would be told "parley is retiring you" in their own
 * session and lose the checkout on SessionEnd; the commits survive on the
 * branch, the working tree does not.
 *
 * So nothing is exported and nothing is `cd`-ed. It is one `sh -c`: the
 * variables are handed to the single process that needs them (`env K=V …
 * claude`), and the working directory is that child's, not the window's. The
 * shell left behind is exactly as it was.
 *
 * Two consequences worth naming:
 *
 *  - only the three `PARLEY_*` variables travel, not the daemon's whole
 *    environment. A fresh window already has the person's own PATH and shell
 *    configuration, and overwriting them with the daemon's was never wanted —
 *    it was just what `{...process.env}` did on the way past.
 *  - the old form was POSIX (`export`) even in the `cmd.exe` branch, which cmd
 *    cannot run at all. A single `sh -c '…'` word is at least the shape cmd
 *    hands straight to the `sh` that Git for Windows installs. Untested there;
 *    it can only be less broken than `export`.
 */
export function terminalCommand(
  cwd: string, bin: string, args: string[], env: Record<string, string>,
): string {
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const command = [...assignments, ...[bin, ...args].map(shellQuote)].join(" ");
  return `sh -c ${shellQuote(`cd ${shellQuote(cwd)} && exec env ${command}`)}`;
}

/**
 * This is the default used in production — the daemon never injects
 * `openTerminalFn` of its own — so it is built on the same `spawnFn` a test
 * can fake, never on `node:child_process` directly.
 */
function defaultOpenTerminal(spawnFn: SpawnFn): OpenTerminalFn {
  return (cwd, bin, args, env) => {
    const command = terminalCommand(cwd, bin, args, env);

    const launch =
      process.platform === "darwin"
        ? { bin: "osascript", args: ["-e", `tell application "Terminal" to do script ${appleScriptString(command)}`] }
        : process.platform === "win32"
          ? { bin: "cmd.exe", args: ["/c", "start", "", "cmd.exe", "/k", command] }
          : { bin: process.env.TERMINAL ?? "x-terminal-emulator", args: ["-e", "sh", "-c", command] };

    const child = spawnFn(launch.bin, launch.args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    if (child.pid === undefined) throw new Error("terminal did not report a pid");
    return child.pid;
  };
}

/**
 * The intent becomes a process. `tick` (Task 2) only ever decides that
 * capacity is missing — this is the other half, and the only half allowed to
 * touch a filesystem or a clock.
 *
 * Returns `null` on any failure — worktree, spawn, anything — and never
 * throws. A birth that fails leaves the pool orphaned; the cooldown in `tick`
 * passes and the next tick asks again. That is what makes this self-healing
 * instead of something that needs to be caught above it.
 */
export function bearFront(opts: {
  repoRoot: string;
  config: SpawnConfig;
  intent: BirthIntent;
  index: number;
  spawnFn?: SpawnFn;
  /** Test seam. Production never sets this — see `defaultOpenTerminal`. */
  openTerminalFn?: OpenTerminalFn;
  /**
   * Called once per line the newborn prints, stdout and stderr alike, in
   * `panel` mode. This is what makes the panel the newborn's window rather
   * than a black box (§7) — and it is also the only thing draining those
   * pipes. `stdio` has always been `["ignore", "pipe", "pipe"]`, and a pipe
   * nobody reads fills at 64KB and blocks the child on its next `write`
   * forever, which is a newborn wedged mid-turn with no sign of why.
   */
  onOutput?: (line: string) => void;
}): BornFront | null {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const name = `POOL-${opts.index}`;

  try {
    const worktree = addWorktree(opts.repoRoot, name.toLowerCase());
    const command = harnessCommand(opts.config.harness);
    const args = [...command.args, openingPrompt(opts.intent.reason)];
    // Who the newborn is. A headless child gets this on top of the daemon's
    // own environment; a terminal window gets only this, and keeps the
    // person's shell otherwise untouched (see `terminalCommand`).
    const identity: Record<string, string> = {
      PARLEY_NAME: name,
      PARLEY_MISSION: `pool: ${opts.intent.reason}`,
      PARLEY_BORN: "parley",
    };
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...identity };

    if (opts.config.mode === "terminal") {
      const openTerminal = opts.openTerminalFn ?? defaultOpenTerminal(spawnFn);
      try {
        const pid = openTerminal(worktree.path, command.bin, args, identity);
        return { name, pid, worktree: worktree.path, mode: "terminal" };
      } catch {
        // A terminal that will not open must not stop the front being born.
        // Degrade to the same headless spawn `panel` mode already uses below
        // — the same discipline as `enforced` degrading to `advisory`. This
        // function only degrades; it does not announce anything itself — the
        // returned `mode: "panel"` differing from the requested `config.mode`
        // is the signal `src/daemon/server.ts`'s `bearFrontFor` compares
        // against to push the "degraded to panel" system event.
      }
    }

    // Reached either because `config.mode` was `panel` all along, or because
    // `terminal` just degraded to it. Either way, spawn headless and stream
    // into the panel that already exists.
    const child = spawnFn(command.bin, args, {
      cwd: worktree.path,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.unref();
    const stopOutput = opts.onOutput ? readLines(child, opts.onOutput) : undefined;
    return { name, pid: child.pid ?? -1, worktree: worktree.path, mode: "panel", stopOutput };
  } catch {
    return null;
  }
}

/**
 * Both pipes, one line at a time, with the tail of a chunk held back until the
 * newline that completes it arrives. Returns the way to stop.
 *
 * Truncation belongs to the caller, not here: what a line is worth keeping at
 * is a panel's question, and this end only has to make sure a line is a line.
 */
function readLines(
  child: { stdout: NodeJS.ReadableStream | null; stderr: NodeJS.ReadableStream | null },
  onLine: (line: string) => void,
): () => void {
  const streams = [child.stdout, child.stderr].filter((s): s is NodeJS.ReadableStream => s !== null);
  for (const stream of streams) {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) onLine(line.replace(/\r$/, ""));
    });
    // A last line with no newline behind it is still something somebody
    // printed, and for a process that dies mid-sentence it is usually the
    // most interesting line there is.
    stream.on("end", () => { if (rest) { onLine(rest); rest = ""; } });
    stream.on("error", () => { /* a pipe that broke has nothing more to say */ });
  }
  return () => {
    for (const stream of streams) {
      stream.removeAllListeners("data");
      (stream as unknown as { destroy?: () => void }).destroy?.();
    }
  };
}
