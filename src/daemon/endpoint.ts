import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROTOCOL_VERSION } from "../protocol/types";
import type { TransportKind } from "../transport/address";

export interface Endpoint {
  protocol: number;
  pid: number;
  transport: TransportKind;
  address: string;
  port?: number;
  os: string;
  /** Random secret, non-null only in loopback mode. */
  token: string | null;
  started_at: string;
}

/**
 * The rendezvous point is the repository itself. Every worktree of a repo shares
 * one git-common-dir, and `C:\dev\proj\.git` and `/mnt/c/dev/proj/.git` are the
 * same bytes on the same disk — so one discovery mechanism covers every case,
 * including both sides of the WSL boundary.
 */
export function endpointPath(gitCommonDir: string): string {
  return join(gitCommonDir, "parley", "endpoint.json");
}

export function writeEndpoint(gitCommonDir: string, endpoint: Endpoint): void {
  const path = endpointPath(gitCommonDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(endpoint, null, 2)}\n`, "utf8");
}

export function readEndpoint(gitCommonDir: string): Endpoint | null {
  const path = endpointPath(gitCommonDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Endpoint;
    if (typeof parsed?.address !== "string" || typeof parsed?.protocol !== "number") return null;
    return parsed;
  } catch {
    // A torn endpoint file is the same as no endpoint: the next spawn claims it.
    return null;
  }
}

export function removeEndpoint(gitCommonDir: string): void {
  try {
    rmSync(endpointPath(gitCommonDir), { force: true });
  } catch {
    /* nothing to clean up */
  }
}

export function newEndpoint(fields: Omit<Endpoint, "protocol">): Endpoint {
  return { protocol: PROTOCOL_VERSION, ...fields };
}
