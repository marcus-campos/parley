import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { createDecoder, encodeFrame } from "../protocol/codec";
import { PROTOCOL_VERSION, type Response } from "../protocol/types";
import { readEndpoint, type Endpoint } from "../daemon/endpoint";

export interface ClientOptions {
  gitCommonDir: string;
  /** Spawn a daemon when none answers. Off for `parley status`. */
  autoSpawn?: boolean;
  timeoutMs?: number;
  /** Extra argv for the spawned daemon (tests point it at a temp state dir). */
  daemonArgs?: string[];
}

export type PushHandler = (events: unknown[]) => void;

const COMPILED = import.meta.url.includes("$bunfs");

export class ParleyUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParleyUnreachable";
  }
}

export class ParleyClient {
  private socket: Socket | null = null;
  private readonly decoder = createDecoder();
  private readonly waiting: ((r: Response) => void)[] = [];
  private pushHandler: PushHandler | null = null;

  private constructor(private readonly endpoint: Endpoint) {}

  static async connect(opts: ClientOptions): Promise<ParleyClient> {
    const timeoutMs = opts.timeoutMs ?? 3_000;

    let endpoint = readEndpoint(opts.gitCommonDir);
    if (endpoint) {
      const client = await ParleyClient.tryAttach(endpoint, timeoutMs);
      if (client) return client;
    }

    if (opts.autoSpawn === false) {
      throw new ParleyUnreachable("no parley daemon is listening for this repository");
    }

    // No daemon, or a dead entry left behind. Claim it: every command spawns,
    // none requires a running daemon. Mental model is gpg-agent, not dockerd.
    ParleyClient.spawnDaemon(opts);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      endpoint = readEndpoint(opts.gitCommonDir);
      if (!endpoint) continue;
      const client = await ParleyClient.tryAttach(endpoint, 500);
      if (client) return client;
    }
    throw new ParleyUnreachable("spawned a parley daemon but it never became reachable");
  }

  private static spawnDaemon(opts: ClientOptions): void {
    const args = COMPILED
      ? ["__daemon", opts.gitCommonDir, ...(opts.daemonArgs ?? [])]
      : [process.argv[1] ?? "", "__daemon", opts.gitCommonDir, ...(opts.daemonArgs ?? [])];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  }

  private static tryAttach(endpoint: Endpoint, timeoutMs: number): Promise<ParleyClient | null> {
    return new Promise((resolve) => {
      const client = new ParleyClient(endpoint);
      const socket =
        endpoint.transport === "tcp"
          ? connect({ host: endpoint.address, port: endpoint.port ?? 0 })
          : connect(endpoint.address);

      const fail = () => {
        socket.destroy();
        resolve(null);
      };
      const timer = setTimeout(fail, timeoutMs);
      socket.once("error", () => { clearTimeout(timer); fail(); });
      socket.once("connect", async () => {
        clearTimeout(timer);
        socket.setEncoding("utf8");
        socket.removeAllListeners("error");
        socket.on("error", () => client.fulfilAll());
        socket.on("close", () => client.fulfilAll());
        socket.on("data", (chunk: string) => client.onData(chunk));
        client.socket = socket;

        if (endpoint.token) {
          const auth = await client.request({ op: "auth", token: endpoint.token });
          if (!auth.ok) { socket.destroy(); return resolve(null); }
        }
        resolve(client);
      });
    });
  }

  private onData(chunk: string): void {
    for (const line of this.decoder.push(chunk)) {
      if (!line.ok) continue;
      // Unsolicited frames share the connection with responses; only `push`
      // frames are unsolicited, so anything else answers the oldest request.
      if (line.frame.op === "push") {
        this.pushHandler?.(Array.isArray(line.frame.events) ? line.frame.events : []);
        continue;
      }
      this.waiting.shift()?.(line.frame as unknown as Response);
    }
  }

  private fulfilAll(): void {
    while (this.waiting.length) {
      this.waiting.shift()?.({ ok: false, error: { code: "NOT_JOINED", message: "connection closed" } });
    }
  }

  onPush(handler: PushHandler): void {
    this.pushHandler = handler;
  }

  request(frame: Record<string, unknown>, timeoutMs = 5_000): Promise<Response> {
    if (!this.socket) {
      return Promise.resolve({ ok: false, error: { code: "NOT_JOINED", message: "not connected" } });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(settle);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve({ ok: false, error: { code: "NOT_JOINED", message: "timed out waiting for the daemon" } });
      }, timeoutMs);
      const settle = (r: Response) => { clearTimeout(timer); resolve(r); };
      this.waiting.push(settle);
      this.socket!.write(encodeFrame({ v: PROTOCOL_VERSION, ...frame }));
    });
  }

  info(): Endpoint {
    return this.endpoint;
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
  }
}
