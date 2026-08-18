import { join } from "node:path";
import type { Platform } from "../repo/canonical";

export type TransportKind = "unix" | "pipe" | "tcp";

export interface Address {
  kind: TransportKind;
  /** Socket path, pipe name, or host for tcp. */
  address: string;
  /** Only for tcp: 0 asks the OS for an ephemeral port. */
  port?: number;
}

export interface AddrEnv {
  platform: Platform;
  isWSL: boolean;
  /** True when the repository lives on a Windows drive seen from WSL. */
  onWindowsDrive: boolean;
  xdgRuntimeDir?: string | undefined;
  xdgStateHome?: string | undefined;
  localAppData?: string | undefined;
  home: string;
  tmp: string;
}

/**
 * sockaddr_un.sun_path is 104 bytes on macOS and 108 on Linux — a long username
 * plus a long application-support path overruns it and bind() fails with a
 * message that names none of this. We check and fall back.
 */
export const MAX_UNIX_SOCKET_BYTES = 100;

export function resolveAddress(repoId: string, env: AddrEnv): Address {
  if (env.platform === "win32") {
    return { kind: "pipe", address: `\\\\.\\pipe\\parley-${repoId}` };
  }

  // WSL and native Windows are two operating systems on one machine and do not
  // share a pipe namespace. Authenticated loopback is the only bridge.
  if (env.isWSL && env.onWindowsDrive) {
    return { kind: "tcp", address: "127.0.0.1", port: 0 };
  }

  const preferred =
    env.platform === "darwin"
      ? join(env.home, "Library", "Application Support", "parley", "run")
      : env.xdgRuntimeDir
        ? join(env.xdgRuntimeDir, "parley")
        : join(env.home, ".local", "state", "parley", "run");

  const candidate = join(preferred, `${repoId}.sock`);
  if (Buffer.byteLength(candidate, "utf8") <= MAX_UNIX_SOCKET_BYTES) {
    return { kind: "unix", address: candidate };
  }
  return { kind: "unix", address: join(env.tmp, "parley", `${repoId}.sock`) };
}

/** Where the journal and other durable state live. Never inside the repository. */
export function stateDir(repoId: string, env: AddrEnv): string {
  if (env.platform === "win32") {
    return join(env.localAppData ?? join(env.home, "AppData", "Local"), "parley", repoId);
  }
  if (env.platform === "darwin") {
    return join(env.home, "Library", "Application Support", "parley", "state", repoId);
  }
  return join(env.xdgStateHome ?? join(env.home, ".local", "state"), "parley", repoId);
}

export function detectAddrEnv(canonicalRepoPath: string): AddrEnv {
  const platform: Platform =
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const isWSL =
    platform === "linux" &&
    (!!process.env.WSL_DISTRO_NAME ||
      (() => {
        try {
          return require("node:fs")
            .readFileSync("/proc/sys/kernel/osrelease", "utf8")
            .toLowerCase()
            .includes("microsoft");
        } catch {
          return false;
        }
      })());
  return {
    platform,
    isWSL,
    onWindowsDrive: /^[a-z]\//.test(canonicalRepoPath),
    xdgRuntimeDir: process.env.XDG_RUNTIME_DIR,
    xdgStateHome: process.env.XDG_STATE_HOME,
    localAppData: process.env.LOCALAPPDATA,
    home: process.env.HOME ?? process.env.USERPROFILE ?? ".",
    tmp: process.env.TMPDIR ?? "/tmp",
  };
}
