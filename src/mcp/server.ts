import { ParleyClient, ParleyUnreachable } from "../client/client";
import { createDecoder } from "../protocol/codec";
import { locateRepo, type RepoInfo } from "../repo/locate";
import { resolveIdentity } from "../cli/identity";
import { VERSION } from "../version";

/**
 * `parley mcp` — the bus as MCP tools, over stdio.
 *
 * This is what makes parley work outside Claude Code. Codex, Antigravity and
 * Kimi have no pre-tool gate, so nothing can happen behind the agent's back
 * there; the deal is different and has to be honest about it:
 *
 *   - the agent joins on its first tool call rather than at session start;
 *   - territory is manual, because nobody can claim on its behalf;
 *   - and **every tool response carries the pending inbox in its footer**, so
 *     an agent that never thinks to read messages still reads them whenever it
 *     interacts. That does not fix everything, but it turns "never" into
 *     "whenever it touches parley at all", which is the difference that
 *     matters.
 */

const PROTOCOL = "2024-11-05";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The parley frame to send. */
  frame: (args: Record<string, unknown>) => Record<string, unknown>;
  /** How to render the answer for a reader that is a language model. */
  render: (response: Record<string, unknown>) => string;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string")
  : typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const TOOLS: Tool[] = [
  {
    name: "parley_who",
    description:
      "Who else is working in this repository right now: names, what each one is doing, how long they have been idle, and which files each one currently holds. Run this before any broad change.",
    inputSchema: { type: "object", properties: {} },
    frame: () => ({ op: "who" }),
    render: (r) => {
      const d = r as unknown as { mode: string; participants: { name: string; mission: string; harness: string; idle_s: number; claims: string[] }[] };
      if (!d.participants?.length) return `Nobody else is on the bus (mode: ${d.mode}).`;
      const rows = d.participants.map(
        (p) => `- ${p.name} — ${p.mission || "no mission declared"} (${p.harness}, idle ${p.idle_s}s)` +
          (p.claims.length ? `\n  holds: ${p.claims.join(", ")}` : "\n  holds nothing"),
      );
      return `Fronts on this repository (mode: ${d.mode}):\n${rows.join("\n")}`;
    },
  },
  {
    name: "parley_say",
    description:
      "Tell the other agent sessions something. Use it to announce intent BEFORE a broad change, so nobody starts the same work. Omit `to` to reach everyone.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What you want them to know." },
        to: { type: "string", description: "A front's name, to speak to just that one." },
      },
      required: ["text"],
    },
    frame: (a) => ({ op: "say", text: str(a.text), to: str(a.to) || null }),
    render: () => "Sent.",
  },
  {
    name: "parley_drain",
    description:
      "Read messages from the other sessions that you have not seen yet. Incremental: it only ever returns what is new to you.",
    inputSchema: { type: "object", properties: {} },
    frame: () => ({ op: "drain" }),
    render: (r) => {
      const events = (r as unknown as { events: { from: { name: string; kind: string } | null; text: string; priority: string }[] }).events;
      if (!events?.length) return "Nothing new.";
      return events
        .map((e) => `${e.priority === "high" ? "[!] " : ""}${e.from ? `${e.from.name}${e.from.kind === "human" ? " (human)" : ""}` : "parley"}: ${e.text}`)
        .join("\n");
    },
  },
  {
    name: "parley_claim",
    description:
      "Take the files you are about to work on, so the other sessions do not edit them under you. Accepts paths or globs. The answer tells you what is already known about those paths and who touched them recently — read it before you start.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Paths or globs, relative to the repository root." },
        intent: { type: "string", description: "What you are going to do with them." },
      },
      required: ["paths"],
    },
    frame: (a) => ({ op: "claim", paths: list(a.paths), intent: str(a.intent) }),
    render: (r) => {
      const d = r as unknown as {
        claimed?: string[];
        notes?: { title: string; body: string; kind: string; authorName: string }[];
        recent?: { byName: string; intent: string; at: string }[];
      };
      const parts: string[] = [];
      parts.push(d.claimed?.length ? `Claimed: ${d.claimed.join(", ")}` : "Already yours.");
      if (d.notes?.length) {
        parts.push(
          `What other fronts wrote down about these paths:\n${d.notes
            .map((n) => `- [${n.kind === "decision" ? "DECISION" : "note"}] ${n.title}${n.body ? `\n  ${n.body}` : ""} (${n.authorName})`)
            .join("\n")}`,
        );
      }
      if (d.recent?.length) {
        parts.push(
          `Recently edited by someone else — read before assuming what is in it:\n${d.recent
            .map((t) => `- ${t.byName} at ${t.at.slice(11, 16)}${t.intent ? ` — ${t.intent}` : ""}`)
            .join("\n")}`,
        );
      }
      return parts.join("\n\n");
    },
  },
  {
    name: "parley_release",
    description:
      "Give paths back the moment you stop needing them, not at the end of your session. If another front is waiting on one, releasing hands it straight to them.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
        all: { type: "boolean", description: "Release everything you hold." },
      },
    },
    frame: (a) => ({ op: "release", paths: list(a.paths), all: a.all === true }),
    render: (r) => {
      const released = (r as unknown as { released: string[] }).released;
      return released?.length ? `Released: ${released.join(", ")}` : "Nothing to release.";
    },
  },
  {
    name: "parley_ask",
    description:
      "Ask the owner for a path that belongs to another front. Only needed when someone actually holds it — asking for a free file is granted instantly. If nobody answers within the deadline it is granted to you and announced.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        reason: { type: "string", description: "Why you need it. The owner sees this." },
      },
      required: ["path", "reason"],
    },
    frame: (a) => ({ op: "ask", path: str(a.path), reason: str(a.reason) }),
    render: (r) => {
      const d = r as unknown as { state: string; owner?: string; request?: string; expires_at?: string };
      return d.state === "pending"
        ? `Asked ${d.owner} (request ${d.request}). Unanswered by ${d.expires_at} means it is granted to you.`
        : `It is yours (${d.state}).`;
    },
  },
  {
    name: "parley_grant",
    description: "Hand a path you own to the front that asked for it.",
    inputSchema: {
      type: "object",
      properties: {
        request: { type: "string" },
        scope: { type: "string", enum: ["once", "transfer"] },
      },
      required: ["request"],
    },
    frame: (a) => ({ op: "grant", request: str(a.request), scope: str(a.scope, "once") }),
    render: () => "Granted.",
  },
  {
    name: "parley_deny",
    description: "Refuse a request for a path you own, with a reason the requester will see.",
    inputSchema: {
      type: "object",
      properties: { request: { type: "string" }, reason: { type: "string" } },
      required: ["request", "reason"],
    },
    frame: (a) => ({ op: "deny", request: str(a.request), reason: str(a.reason) }),
    render: () => "Denied.",
  },
  {
    name: "parley_requests",
    description: "Permission requests waiting for an answer, with how long is left on each.",
    inputSchema: { type: "object", properties: {} },
    frame: () => ({ op: "requests" }),
    render: (r) => {
      const rs = (r as unknown as { requests: { id: string; requester: string; path: string; owner: string; reason: string; seconds_left: number }[] }).requests;
      if (!rs?.length) return "Nothing pending.";
      return rs
        .map((q) => `- ${q.id}: ${q.requester} wants ${q.path} from ${q.owner} (${q.seconds_left}s left) — ${q.reason || "no reason given"}`)
        .join("\n");
    },
  },
  {
    name: "parley_note",
    description:
      "Write down something the code does not say about itself — a hidden coupling, a trap, why the obvious change is wrong. Anchor it with `paths` and it will be handed automatically to whoever edits those files next. Write one whenever you learn something the hard way.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        paths: { type: "array", items: { type: "string" }, description: "Files this is about. This is what makes it find its reader." },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
    frame: (a) => ({ op: "note", title: str(a.title), body: str(a.body), paths: list(a.paths), tags: list(a.tags) }),
    render: () => "Noted. It will reach whoever edits those paths.",
  },
  {
    name: "parley_decide",
    description:
      "Record a decision that should stay decided, so the next session does not relitigate it. It is announced to every front and binds until someone reverses it on purpose.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, body: { type: "string" }, paths: { type: "array", items: { type: "string" } } },
      required: ["title"],
    },
    frame: (a) => ({ op: "note", kind: "decision", title: str(a.title), body: str(a.body), paths: list(a.paths) }),
    render: () => "Decision recorded and announced. It binds until reversed.",
  },
  {
    name: "parley_notes",
    description: "Durable knowledge left by every front, present and past. Filter by `path` to get only what is about a file you are touching.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        tag: { type: "string" },
        kind: { type: "string", enum: ["note", "decision"] },
      },
    },
    frame: (a) => ({ op: "notes", path: str(a.path) || undefined, tag: str(a.tag) || undefined, kind: str(a.kind) || undefined, active: true }),
    render: (r) => {
      const notes = (r as unknown as { notes: { id: string; title: string; body: string; kind: string; paths: string[]; authorName: string }[] }).notes;
      if (!notes?.length) return "Nothing written down yet.";
      return notes
        .map((n) => `- ${n.id} [${n.kind === "decision" ? "DECISION" : "note"}] ${n.title}${n.paths.length ? ` (${n.paths.join(", ")})` : ""}${n.body ? `\n  ${n.body}` : ""}`)
        .join("\n");
    },
  },
  {
    name: "parley_results",
    description:
      "What another front already ran, and whether the answer still holds. Check this BEFORE running a long suite: if nothing it depends on has been touched since, running it again costs minutes and buys nothing.",
    inputSchema: { type: "object", properties: { key: { type: "string" } } },
    frame: (a) => ({ op: "results", key: str(a.key) || undefined }),
    render: (r) => {
      const rs = (r as unknown as { results: { key: string; status: string; summary: string; byName: string; staleBecause: string | null }[] }).results;
      if (!rs?.length) return "Nothing recorded yet.";
      return rs
        .map((x) => `- ${x.key}: ${x.status.toUpperCase()} — ${x.summary || "(no summary)"} (${x.byName})\n  ${x.staleBecause ? `STALE: ${x.staleBecause}` : "still valid, do not re-run"}`)
        .join("\n");
    },
  },
  {
    name: "parley_result",
    description: "Record what a command produced, with the paths it depends on, so nobody runs it again for nothing.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: 'The command, e.g. "bun test".' },
        status: { type: "string", enum: ["pass", "fail", "unknown"] },
        summary: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["key", "status"],
    },
    frame: (a) => ({ op: "result", key: str(a.key), status: str(a.status), summary: str(a.summary), paths: list(a.paths) }),
    render: () => "Recorded.",
  },
  {
    name: "parley_rename",
    description: "Tell the bus who you are and what you are working on. Do this once, early — the name you joined with was derived from the branch.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, mission: { type: "string" } },
    },
    frame: (a) => ({ op: "rename", name: str(a.name), mission: str(a.mission) }),
    render: (r) => `You are ${(r as unknown as { name: string }).name}.`,
  },
];

export async function runMcpServer(): Promise<void> {
  let repo: RepoInfo | null = null;
  try { repo = locateRepo(); } catch { repo = null; }

  let client: ParleyClient | null = null;
  let joined = false;

  async function ensure(): Promise<ParleyClient | null> {
    if (!repo) return null;
    if (client) return client;
    try {
      client = await ParleyClient.connect({ gitCommonDir: repo.gitCommonDir });
    } catch (e) {
      if (e instanceof ParleyUnreachable) return null;
      throw e;
    }
    if (!joined) {
      const identity = resolveIdentity(repo.root, repo.root);
      let response = await client.request({
        op: "join", name: identity.name, mission: identity.mission,
        harness: identity.harness, cwd: repo.root, kind: "agent", branch: identity.branch,
        connected: true, session: process.env.PARLEY_SESSION ?? `mcp-${process.pid}`,
      });
      if (!response.ok && response.error.code === "NAME_TAKEN" && "suggestion" in response.error) {
        response = await client.request({
          op: "join", name: String(response.error.suggestion), mission: identity.mission,
          harness: identity.harness, cwd: repo.root, kind: "agent", branch: identity.branch,
          connected: true, session: process.env.PARLEY_SESSION ?? `mcp-${process.pid}`,
        });
      }
      joined = response.ok;
    }
    return client;
  }

  /**
   * Pending messages ride on every tool response. An agent with no pre-tool
   * gate will not go looking for its inbox, so the inbox goes to it.
   */
  async function footer(connection: ParleyClient): Promise<string> {
    const drained = await connection.request({ op: "drain" });
    if (!drained.ok) return "";
    const events = (drained as unknown as { events: { from: { name: string; kind: string } | null; text: string; priority: string }[] }).events;
    if (!events.length) return "";
    const lines = events.map(
      (e) => `${e.priority === "high" ? "[!] " : ""}${e.from ? `${e.from.name}${e.from.kind === "human" ? " (human)" : ""}` : "parley"}: ${e.text}`,
    );
    return `\n\n---\nMessages from the other sessions working in this repository:\n${lines.join("\n")}`;
  }

  function send(message: unknown): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function reply(id: unknown, result: unknown): void {
    send({ jsonrpc: "2.0", id, result });
  }

  function replyError(id: unknown, code: number, message: string): void {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function handle(message: Record<string, unknown>): Promise<void> {
    const { id, method, params } = message as { id?: unknown; method?: string; params?: Record<string, unknown> };

    if (method === "initialize") {
      return reply(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "parley", version: VERSION },
      });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    if (method === "ping") return reply(id, {});

    if (method === "tools/list") {
      return reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    }

    if (method === "tools/call") {
      const name = str(params?.name);
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return replyError(id, -32602, `unknown tool: ${name}`);

      if (!repo) {
        return reply(id, {
          content: [{ type: "text", text: "parley: not inside a git repository, so there is no bus here." }],
          isError: true,
        });
      }

      const connection = await ensure();
      if (!connection) {
        // A broken parley must never stop the work.
        return reply(id, {
          content: [{ type: "text", text: "parley: no daemon reachable; continuing without coordination." }],
        });
      }

      const args = (params?.arguments as Record<string, unknown>) ?? {};
      const response = await connection.request(tool.frame(args));

      if (!response.ok) {
        const conflicts = (response as unknown as { conflicts?: { path: string; owner: { name: string; mission: string }; since: string }[] }).conflicts;
        const detail = conflicts?.length
          ? `\n${conflicts.map((c) => `- ${c.path} is held by ${c.owner.name} (${c.owner.mission || "no mission"}) since ${c.since}. Ask for it with parley_ask.`).join("\n")}`
          : "";
        return reply(id, {
          content: [{ type: "text", text: `parley: ${response.error.code}${response.error.message ? ` — ${response.error.message}` : ""}${detail}` }],
          isError: true,
        });
      }

      const text = tool.render(response as unknown as Record<string, unknown>);
      const tail = name === "parley_drain" ? "" : await footer(connection);
      return reply(id, { content: [{ type: "text", text: text + tail }] });
    }

    if (id !== undefined) replyError(id, -32601, `unknown method: ${String(method)}`);
  }

  const decoder = createDecoder();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      if (!line.ok) continue;
      void handle(line.frame).catch((e: Error) => {
        process.stderr.write(`parley mcp: ${e.message}\n`);
      });
    }
  });

  const goodbye = () => {
    if (client && joined) void client.request({ op: "leave" }).finally(() => process.exit(0));
    else process.exit(0);
  };
  process.stdin.on("end", goodbye);
  process.on("SIGINT", goodbye);
  process.on("SIGTERM", goodbye);

  await new Promise(() => { /* serve until stdin closes */ });
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);
