import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

export type Platform = "win32" | "darwin" | "linux";

/**
 * Everything the canonicalizer needs from the outside world. Injected so the
 * whole thing stays a pure function under test — this is the module where the
 * WSL boundary bug lives, so it has to be exercised without a real WSL box.
 */
export interface CanonEnv {
  platform: Platform;
  /** Whether the filesystem holding the repo folds case. */
  caseInsensitive: boolean;
  /** True when running inside WSL. Gates the `/mnt/<drive>` reduction. */
  isWSL: boolean;
  /** Resolve symlinks. Injected; may be identity in tests. */
  realpath: (p: string) => string;
}

const WINDOWS_DRIVE = /^([A-Za-z]):\/(.*)$/;
const WSL_MOUNT = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/;

/**
 * Reduce a repository path to the one canonical string that both sides of the
 * WSL boundary agree on.
 *
 * `C:\dev\proj` (Windows) and `/mnt/c/dev/proj` (WSL) are the same directory on
 * the same disk, so they MUST produce the same string — otherwise they become
 * two buses that never see each other, which is the silent failure class.
 */
export function canonicalizeRepoPath(input: string, env: CanonEnv): string {
  let p = env.realpath(input);

  // 1. separators to POSIX
  p = p.replace(/\\/g, "/");

  // 2. reduce Windows drives to `c/dev/proj`, from BOTH sides of the boundary
  let onWindowsDrive = false;
  const drive = WINDOWS_DRIVE.exec(p);
  if (drive) {
    onWindowsDrive = true;
    p = `${drive[1]!.toLowerCase()}/${drive[2]!}`;
  } else if (env.isWSL) {
    // Only under WSL. A plain Linux box may legitimately have a real /mnt/c.
    const mnt = WSL_MOUNT.exec(p);
    if (mnt) {
      onWindowsDrive = true;
      p = `${mnt[1]!.toLowerCase()}/${mnt[2] ?? ""}`;
    }
  }

  // 3. collapse redundant and trailing separators
  p = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");

  // 4. case-fold only where the filesystem is case-insensitive.
  //    A Windows drive is case-insensitive no matter which OS is reading it —
  //    under WSL `env.caseInsensitive` describes the Linux root, not /mnt/c.
  if (env.caseInsensitive || onWindowsDrive) p = p.toLowerCase();

  return p;
}

/** sha256 of the canonical path, truncated to 16 lowercase hex characters. */
export function repoId(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath, "utf8").digest("hex").slice(0, 16);
}

/** Detect the ambient environment. Separated so canonicalize stays testable. */
export function detectEnv(): CanonEnv {
  const platform: Platform =
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  let isWSL = false;
  if (platform === "linux") {
    if (process.env.WSL_DISTRO_NAME) isWSL = true;
    else {
      try {
        isWSL = require("node:fs")
          .readFileSync("/proc/sys/kernel/osrelease", "utf8")
          .toLowerCase()
          .includes("microsoft");
      } catch {
        isWSL = false;
      }
    }
  }
  return {
    platform,
    caseInsensitive: platform === "win32" || platform === "darwin",
    isWSL,
    realpath: (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
  };
}
