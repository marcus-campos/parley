import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnConfig } from "../cli/spawn-config";
import type { BirthIntent } from "../state/machine";
import { addWorktree } from "./worktree";

export interface BornFront {
  name: string;
  pid: number;
  worktree: string;
  mode: "panel" | "terminal";
}

type SpawnFn = typeof nodeSpawn;

/** Opens a real terminal running `bin args` in `cwd`, told `env`. Returns its pid, or throws. */
type OpenTerminalFn = (cwd: string, bin: string, args: string[], env: Record<string, string>) => number;

/**
 * What a newborn front is told.
 *
 * Note what is missing: any instruction about which item to do. parley
 * provides capacity, not assignments — that is the entire distinction from an
 * orchestrator, which decides *and* dispatches. The front joins the bus, reads
 * the pool with the map as it is right now, not as it was when this intent
 * was raised, and chooses for itself.
 */
function openingPrompt(reason: string): string {
  return [
    `You were started by parley because ${reason}.`,
    `Nobody has assigned you anything.`,
    `Run \`parley works --state open\` to see what is in the pool, take what you can do with \`parley take <id>\`,`,
    `and \`parley done <id>\` when it is finished. Taking an item returns the evidence the front that found it left`,
    `behind — read it before you re-derive anything.`,
    `When the pool is empty and you hold nothing, say so and stop.`,
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The one thing `spawnFn` alone cannot give a terminal-mode front: a headless
 * child inherits `env` for free, a brand-new terminal window does not — it
 * starts its own login shell with its own environment. So identity
 * (PARLEY_NAME, PARLEY_BORN, PARLEY_MISSION) is exported inside the command
 * line itself, the one thing every terminal on every platform runs verbatim.
 *
 * This is the default used in production — the daemon never injects
 * `openTerminalFn` of its own — so it is built on the same `spawnFn` a test
 * can fake, never on `node:child_process` directly.
 */
function defaultOpenTerminal(spawnFn: SpawnFn): OpenTerminalFn {
  return (cwd, bin, args, env) => {
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join(" && ");
    const inner = [bin, ...args].map(shellQuote).join(" ");
    const command = [exports, `cd ${shellQuote(cwd)}`, inner].filter(Boolean).join(" && ");

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
}): BornFront | null {
  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const name = `POOL-${opts.index}`;

  try {
    const worktree = addWorktree(opts.repoRoot, name.toLowerCase());
    const command = harnessCommand(opts.config.harness);
    const args = [...command.args, openingPrompt(opts.intent.reason)];
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PARLEY_NAME: name,
      PARLEY_MISSION: `pool: ${opts.intent.reason}`,
      PARLEY_BORN: "parley",
    };

    if (opts.config.mode === "terminal") {
      const openTerminal = opts.openTerminalFn ?? defaultOpenTerminal(spawnFn);
      try {
        const pid = openTerminal(worktree.path, command.bin, args, env);
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
    return { name, pid: child.pid ?? -1, worktree: worktree.path, mode: "panel" };
  } catch {
    return null;
  }
}
