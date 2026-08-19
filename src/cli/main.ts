#!/usr/bin/env bun
import { ParleyClient, ParleyUnreachable } from "../client/client";
import { ParleyDaemon, journalPathFor } from "../daemon/server";
import { readEndpoint } from "../daemon/endpoint";
import { exportNotes, readExportedNotes } from "../notes/export";
import { DEFAULTS, PROTOCOL_VERSION, type Response } from "../protocol/types";
import { VERSION } from "../version";
import { canonicalizeRepoPath, detectEnv, repoId } from "../repo/canonical";
import { NotARepository, locateRepo, type RepoInfo } from "../repo/locate";
import { detectAddrEnv, resolveAddress, stateDir } from "../transport/address";
import { adapterStatus } from "../adapters/claude-code";
import { flagString, parseArgs, type Parsed } from "./args";
import { sessionFor } from "./session";
import { resolveIdentity } from "./identity";

const COMPILED_CLI = import.meta.url.includes("$bunfs");

const USAGE = `parley — coordination bus for concurrent agent sessions in one repository

  parley update [--check] [--yes]
                             replace this binary with the latest release
  parley mcp                 run as an MCP server over stdio (for Codex, Kimi,
                             Antigravity and anything else that speaks MCP)
  parley init [--yes] [--global]
                             install hooks and skill for detected harnesses.
                             --global installs the Claude Code hooks once for
                             every project — the only way every worktree is
                             covered, since .claude/ is usually gitignored.
  parley uninit              remove what init wrote
  parley doctor              diagnose transport, repo identity and the WSL boundary
  parley status              is a daemon up, and what does it hold
  parley stop                shut the daemon down

  parley whoami              which front you are, and where
  parley join --as NAME [--mission "..."]
  parley rename --as NAME [--mission "..."]
  parley leave
  parley who

  parley say [--to NAME] [--priority high] "text"
  parley question --to NAME "..." [--wait 60] [--ttl 600]
  parley reply <id> "answer"
  parley ack <id> ["got it, doing X"]
  parley questions
  parley drain
  parley history [--limit 200]

  parley claim <paths...> [--intent "..."] [--auto]
  parley release [<paths...>] [--all]

  parley watch [--web] [--port 7717] [--detach] [--stop]
                             live panel: fronts, feed and pending requests.
                             Opens watching; press i (or s on the web) to speak.
                             --detach keeps the web panel up after you close the
                             terminal; --stop shuts that one down.

  parley ask <path> --reason "..." [--ttl 300]
  parley requests [--all]
  parley grant <request> [--scope once|transfer]
  parley deny <request> --reason "..."

  parley note --title "..." [--body "..."] [--tags a,b] [--paths a,b]
  parley decide --title "..." [--body "..."] [--paths a,b]
  parley reverse <id> [--reason "..."]
  parley notes [--tag x] [--path p] [--kind decision] [--export] [--import]

  parley result <key> --status pass|fail [--summary "..."] [--paths a,b]
  parley results [--fresh] [--key "..."]

  parley mode [off|advisory|enforced]

Global flags: --json (machine output), --as NAME, --quiet
              --help, --version
`;

function out(parsed: Parsed, human: string, payload: unknown): void {
  if (parsed.flags.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else if (!parsed.flags.quiet) process.stdout.write(`${human}\n`);
}

function fail(parsed: Parsed, message: string, code = 1): never {
  if (parsed.flags.json) process.stdout.write(`${JSON.stringify({ ok: false, error: { message } })}\n`);
  else process.stderr.write(`parley: ${message}\n`);
  process.exit(code);
}

function describeError(response: Response): string {
  if (response.ok) return "";
  const e = response.error;
  const extra = "suggestion" in e ? ` (try ${String(e.suggestion)})` : "";
  return `${e.code}${e.message ? `: ${e.message}` : ""}${extra}`;
}

async function withSession(
  parsed: Parsed,
  repo: RepoInfo,
  run: (client: ParleyClient, id: string) => Promise<void>,
): Promise<void> {
  let client: ParleyClient;
  try {
    client = await ParleyClient.connect({ gitCommonDir: repo.gitCommonDir });
  } catch (e) {
    // parley broken must never stop the work: say so, exit clean for hooks.
    if (e instanceof ParleyUnreachable) {
      if (parsed.flags.json) process.stdout.write(`${JSON.stringify({ ok: false, degraded: true, error: { message: e.message } })}\n`);
      else process.stderr.write(`parley: ${e.message} — continuing without coordination\n`);
      process.exit(0);
    }
    throw e;
  }

  const identity = resolveIdentity(repo.root, process.cwd(), flagString(parsed.flags, "as"));
  let response = await client.request({
    op: "join",
    name: identity.name,
    mission: flagString(parsed.flags, "mission", identity.mission),
    harness: identity.harness,
    cwd: repo.root,
    kind: parsed.flags.human ? "human" : "agent",
    branch: identity.branch,
    session: sessionFor(repo.gitCommonDir, repo.root),
  });

  // A derived name that collides takes the suggestion rather than failing: the
  // hook path has no human to retype it.
  if (!response.ok && response.error.code === "NAME_TAKEN" && identity.provisional && "suggestion" in response.error) {
    response = await client.request({
      op: "join",
      name: String(response.error.suggestion),
      mission: flagString(parsed.flags, "mission", identity.mission),
      harness: identity.harness,
      cwd: repo.root,
      kind: "agent",
      branch: identity.branch,
      session: sessionFor(repo.gitCommonDir, repo.root),
    });
  }
  if (!response.ok) {
    client.close();
    fail(parsed, describeError(response));
  }

  try {
    await run(client, (response as unknown as { id: string }).id);
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Hidden: run by `parley update` after it has replaced the binary, so the
  // adapters are written by the NEW code. The process doing the update still
  // has the old skill text in memory — refreshing from there wrote last
  // version's instructions, which is why an update used to need running twice.
  if (argv[0] === "__refresh-adapters") {
    const { refreshAllAdapters } = await import("../adapters/install");
    return refreshAllAdapters({
      assumeYes: argv.includes("--yes"),
      json: argv.includes("--json"),
    });
  }

  // The MCP server: stdio JSON-RPC, for every harness without a pre-tool gate.
  if (argv[0] === "mcp") {
    const { runMcpServer } = await import("../mcp/server");
    return runMcpServer();
  }

  // The Claude Code hook runner: JSON in, JSON out, never a shell one-liner.
  if (argv[0] === "hook") {
    const { runHook } = await import("../adapters/hook");
    return runHook(argv[1] ?? "");
  }

  // Hidden: the auto-spawn target. Never invoked by a human.
  if (argv[0] === "__daemon") {
    const gitCommonDir = argv[1];
    if (!gitCommonDir) process.exit(2);
    // The daemon derives the bus identity from the path alone. Calling git here
    // would fail: `git rev-parse --show-toplevel` does not work with the .git
    // directory itself as cwd, and the daemon never needs a worktree anyway.
    const canonical = canonicalizeRepoPath(gitCommonDir, detectEnv());
    const id = repoId(canonical);
    const env = detectAddrEnv(canonical);
    const daemon = new ParleyDaemon({
      gitCommonDir,
      address: resolveAddress(id, env),
      journalPath: journalPathFor(stateDir(id, env)),
    });
    try {
      await daemon.listen();
    } catch (e) {
      // Losing the race is the normal outcome when several hooks fire at once.
      // Exit quietly; the client will find the daemon that won.
      if ((e as Error).name === "DaemonAlreadyRunning") process.exit(0);
      throw e;
    }
    const shutdown = () => { void daemon.close().then(() => process.exit(0)); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  const parsed = parseArgs(argv);

  // `--help` and `--version` are consumed as the command name by the parser, so
  // they are matched here explicitly. Both must work outside a git repository.
  if (argv.length === 0 || ["help", "--help", "-h"].includes(parsed.command) || parsed.flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (["version", "--version", "-v"].includes(parsed.command) || parsed.flags.version) {
    process.stdout.write(`parley ${VERSION} (protocol v${PROTOCOL_VERSION})\n`);
    return;
  }

  // Updating does not need a repository — you may well be fixing an install
  // from your home directory.
  if (parsed.command === "update") {
    const { runUpdate } = await import("./update");
    let gitCommonDir: string | null = null;
    let repoRoot: string | null = null;
    try {
      const found = locateRepo();
      gitCommonDir = found.gitCommonDir;
      repoRoot = found.root;
    } catch { /* updating from anywhere is fine */ }
    return runUpdate({
      checkOnly: parsed.flags.check === true,
      assumeYes: parsed.flags.yes === true,
      json: parsed.flags.json === true,
      gitCommonDir,
      repoRoot,
    });
  }

  let repo: RepoInfo;
  try {
    repo = locateRepo();
  } catch (e) {
    if (e instanceof NotARepository) fail(parsed, e.message, 2);
    throw e;
  }

  const env = detectAddrEnv(repo.canonical);

  switch (parsed.command) {
    case "init": {
      const { runInit } = await import("../adapters/install");
      return runInit(repo, {
        assumeYes: parsed.flags.yes === true,
        json: parsed.flags.json === true,
        global: parsed.flags.global === true,
      });
    }
    case "uninit": {
      const { runUninit } = await import("../adapters/install");
      return runUninit(repo, { json: parsed.flags.json === true, global: parsed.flags.global === true });
    }

    case "doctor": {
      const address = resolveAddress(repo.repoId, env);
      const endpoint = readEndpoint(repo.gitCommonDir);
      const report = {
        version: VERSION,
        repo_root: repo.root,
        git_common_dir: repo.gitCommonDir,
        canonical: repo.canonical,
        repo_id: repo.repoId,
        platform: env.platform,
        wsl: env.isWSL,
        on_windows_drive: env.onWindowsDrive,
        boundary_mode: env.isWSL && env.onWindowsDrive,
        transport: address.kind,
        address: address.address,
        state_dir: stateDir(repo.repoId, env),
        endpoint: endpoint ? "present" : "absent",
        daemon_pid: endpoint?.pid ?? null,
        adapter: (() => {
          const a = adapterStatus(repo.root);
          if (!a.installed) return "not installed (run: parley init)";
          if (a.skillCurrent && a.hooksCurrent) return `current (${VERSION})`;
          return "OUTDATED — run: parley update";
        })(),
      };
      const lines = Object.entries(report).map(([k, v]) => `  ${k.padEnd(18)} ${String(v)}`);
      if (report.boundary_mode) {
        lines.push(
          "",
          "  WSL <-> Windows boundary detected. The daemon is hosted on the Linux side",
          "  because under WSL2 NAT, Windows reaches WSL on localhost but not the other",
          "  way round. With networkingMode=mirrored both directions work.",
        );
      }
      return out(parsed, `parley doctor\n${lines.join("\n")}`, report);
    }

    case "status": {
      const endpoint = readEndpoint(repo.gitCommonDir);
      if (!endpoint) return out(parsed, "parley: no daemon running for this repository", { ok: true, running: false });
      const client = await ParleyClient.connect({ gitCommonDir: repo.gitCommonDir, autoSpawn: false }).catch(() => null);
      if (!client) return out(parsed, "parley: endpoint present but no daemon answering (stale)", { ok: true, running: false, stale: true });
      const response = await client.request({ op: "status" });
      client.close();
      const s = response as unknown as Record<string, unknown>;
      return out(
        parsed,
        `parley up  pid ${endpoint.pid}  mode ${s.mode}  ${s.participants} front(s)  ${s.claims} claim(s)  ${s.pending_requests} pending`,
        response,
      );
    }

    case "stop": {
      const endpoint = readEndpoint(repo.gitCommonDir);
      if (!endpoint) return out(parsed, "parley: nothing to stop", { ok: true, stopped: false });
      try { process.kill(endpoint.pid, "SIGTERM"); } catch { /* already gone */ }
      return out(parsed, `parley: signalled daemon ${endpoint.pid}`, { ok: true, stopped: true, pid: endpoint.pid });
    }
  }

  if (parsed.command === "watch") {
    const { runWatch } = await import("./watch");
    const { readPanelConfig } = await import("./panel-config");
    const panelName =
      flagString(parsed.flags, "as") ||
      process.env.PARLEY_PANEL_NAME ||
      readPanelConfig(repo.gitCommonDir).name ||
      "PANEL";
    if (parsed.flags.web) {
      const { clearRunningPanel, readRunningPanel, runWebPanel } = await import("./web");
      const port = Number(flagString(parsed.flags, "port", "7717"));
      const running = readRunningPanel(repo.gitCommonDir);

      if (parsed.flags.stop) {
        if (!running) return out(parsed, "parley: no web panel running for this repository", { ok: true, stopped: false });
        try { process.kill(running.pid, "SIGTERM"); } catch { /* already gone */ }
        clearRunningPanel(repo.gitCommonDir);
        return out(parsed, `parley: stopped the web panel (pid ${running.pid})`, { ok: true, stopped: true });
      }

      // A panel is a long-lived thing you glance at, so a second launch should
      // hand you the one that is already up rather than opening a rival on
      // another port with a different token.
      if (running) {
        return out(parsed, `parley: web panel already running on ${running.url}`, { ok: true, url: running.url, reused: true });
      }

      if (parsed.flags.detach) {
        const { spawn } = await import("node:child_process");
        const args = process.argv.slice(1).filter((a) => a !== "--detach");
        const child = spawn(process.execPath, COMPILED_CLI ? args.slice(1) : args, {
          detached: true, stdio: "ignore", windowsHide: true,
        });
        child.unref();
        // Wait for it to record itself, so we can print the URL it chose.
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 50));
          const up = readRunningPanel(repo.gitCommonDir);
          if (up) {
            return out(
              parsed,
              `parley: web panel on ${up.url}\nparley: it keeps running after you close this terminal. Stop it with: parley watch --web --stop`,
              { ok: true, url: up.url, pid: up.pid, detached: true },
            );
          }
        }
        return fail(parsed, "started the web panel but it never came up");
      }

      return runWebPanel(repo, panelName, port, parsed.flags.open !== false);
    }
    return runWatch(repo, panelName);
  }

  // Everything below needs a session on the bus.
  await withSession(parsed, repo, async (client, myId) => {
    const p = parsed;
    const send = (frame: Record<string, unknown>) => client.request(frame);

    switch (p.command) {
      case "join":
        return out(p, "parley: joined", { ok: true });

      case "rename": {
        const r = await send({ op: "rename", name: flagString(p.flags, "as"), mission: flagString(p.flags, "mission") });
        if (!r.ok) fail(p, describeError(r));
        return out(p, `parley: now ${(r as unknown as { name: string }).name}`, r);
      }

      case "leave": {
        const r = await send({ op: "leave" });
        return out(p, "parley: left", r);
      }

      case "whoami": {
        const r = await send({ op: "who" });
        if (!r.ok) fail(p, describeError(r));
        const me = (r as unknown as { participants: { id: string }[] }).participants
          .find((x) => x.id === myId);
        if (!me) return out(p, "parley: not on the bus", { ok: false });
        const d = me as unknown as {
          name: string; tag: string; mission: string; branch: string; worktree: string; claims: string[];
        };
        return out(
          p,
          `You are ${d.name} (${d.tag}) on the parley bus${d.mission ? `, on: ${d.mission}` : ""}.\n` +
            `  ${[d.branch && `branch ${d.branch}`, d.worktree && `worktree ${d.worktree}`].filter(Boolean).join(" · ")}\n` +
            `  holding ${d.claims.length} path(s)${d.claims.length ? `: ${d.claims.join(", ")}` : ""}\n` +
            `Tell the person this name — it is how they know which window you are.`,
          { ok: true, ...d },
        );
      }

      case "who": {
        const r = await send({ op: "who" });
        if (!r.ok) fail(p, describeError(r));
        const data = r as unknown as { mode: string; participants: Record<string, unknown>[] };
        if (data.participants.length === 0) return out(p, `parley (${data.mode}): nobody on the bus`, r);
        const rows = data.participants.flatMap((x) => {
          const claims = (x.claims as string[]) ?? [];
          const place = [x.branch && `on ${x.branch}`, x.worktree && `in ${x.worktree}`, x.harness]
            .filter(Boolean).join(" · ");
          return [
            `  ${String(x.name).padEnd(24)} ${String(x.tag)}  ${String(x.mission || "-").padEnd(30)} ${String(x.idle_s)}s idle  ${claims.length} claim(s)`,
            `    ${place}`,
          ];
        });
        return out(p, `parley (${data.mode})\n${rows.join("\n")}`, r);
      }

      case "question": {
        const to = flagString(p.flags, "to");
        if (!to) fail(p, `question needs --to NAME`);
        const text = p.positional.join(" ");
        if (!text) fail(p, "question needs something to ask");
        const wait = Number(flagString(p.flags, "wait", "0"));
        const r = await send({ op: "question", to, text, ttl_s: Number(flagString(p.flags, "ttl", "600")) });
        if (!r.ok) fail(p, describeError(r));
        const id = (r as unknown as { question: string }).question;

        if (wait <= 0) {
          return out(p, `parley: asked ${to} (${id}). They will be interrupted before going idle.`, r);
        }

        // Poll rather than hold the socket open: the daemon answers in
        // microseconds and the asker is a short-lived process either way.
        const deadline = Date.now() + wait * 1000;
        while (Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 1000));
          const status = await send({ op: "question_status", id });
          if (!status.ok) break;
          const d = status as unknown as { answered: boolean; answer: string | null; expired: boolean };
          if (d.answered) return out(p, `${to}: ${d.answer}`, status);
          if (d.expired) break;
        }
        return out(
          p,
          `parley: ${to} has not answered ${id} yet. It stays open — you will get the answer in your inbox.`,
          { ok: true, question: id, answered: false },
        );
      }

      case "ack": {
        const id = p.positional[0];
        if (!id) fail(p, "ack needs a question id");
        const r = await send({ op: "ack", id, text: p.positional.slice(1).join(" ") });
        if (!r.ok) fail(p, describeError(r));
        return out(p, "parley: acknowledged", r);
      }

      case "reply": {
        const id = p.positional[0];
        if (!id) fail(p, "reply needs a question id");
        const text = p.positional.slice(1).join(" ") || flagString(p.flags, "text");
        if (!text) fail(p, "reply needs an answer");
        const r = await send({ op: "reply", id, text });
        if (!r.ok) fail(p, describeError(r));
        return out(p, "parley: answered", r);
      }

      case "questions": {
        const r = await send({ op: "questions" });
        if (!r.ok) fail(p, describeError(r));
        const d = r as unknown as {
          owed: { id: string; from: string; text: string; seconds_left: number }[];
          waiting: { id: string; to: string; text: string; seconds_left: number }[];
        };
        const lines: string[] = [];
        if (d.owed.length) {
          lines.push("  YOU OWE AN ANSWER:");
          for (const q of d.owed) lines.push(`    ${q.id}  ${q.from} asks: ${q.text}  (${q.seconds_left}s left)`);
        }
        if (d.waiting.length) {
          lines.push("  YOU ARE WAITING ON:");
          for (const q of d.waiting) lines.push(`    ${q.id}  you asked ${q.to}: ${q.text}  (${q.seconds_left}s left)`);
        }
        return out(p, lines.join("\n") || "parley: no open questions", r);
      }

      case "say": {
        const text = p.positional.join(" ");
        if (!text) fail(p, "nothing to say");
        const r = await send({
          op: "say", text,
          to: flagString(p.flags, "to") || null,
          priority: p.flags.priority === "high" ? "high" : "normal",
        });
        if (!r.ok) fail(p, describeError(r));
        return out(p, "parley: sent", r);
      }

      case "drain": {
        const r = await send({ op: "drain" });
        if (!r.ok) fail(p, describeError(r));
        const events = (r as unknown as { events: { from: { name: string } | null; text: string; priority: string }[] }).events;
        if (events.length === 0) return out(p, "", r);
        const rows = events.map((e) => `  ${e.priority === "high" ? "!" : " "} ${e.from ? `${e.from.name}:` : "*"} ${e.text}`);
        return out(p, rows.join("\n"), r);
      }

      case "history": {
        const r = await send({ op: "history", limit: Number(flagString(p.flags, "limit", "200")) });
        if (!r.ok) fail(p, describeError(r));
        const events = (r as unknown as { events: { at: string; from: { name: string } | null; text: string; priority: string }[] }).events;
        if (events.length === 0) return out(p, "parley: nothing has happened yet", r);
        const rows = events.map((e) => `  ${e.at.slice(11, 16)} ${e.priority === "high" ? "!" : " "} ${e.from ? `${e.from.name}:` : "*"} ${e.text}`);
        return out(p, rows.join("\n"), r);
      }

      case "claim": {
        if (p.positional.length === 0) fail(p, "claim needs at least one path");
        const r = await send({ op: "claim", paths: p.positional, intent: flagString(p.flags, "intent"), auto: p.flags.auto === true });
        if (!r.ok) {
          const conflicts = (r as unknown as { conflicts?: { path: string; owner: { name: string; mission: string }; since: string }[] }).conflicts ?? [];
          const detail = conflicts.map((c) => `  ${c.path} held by ${c.owner.name} (${c.owner.mission || "no mission"}) since ${c.since}`).join("\n");
          if (p.flags.json) { process.stdout.write(`${JSON.stringify(r)}\n`); process.exit(1); }
          process.stderr.write(`parley: CONFLICT\n${detail}\nAsk for it:  parley ask ${conflicts[0]?.path ?? p.positional[0]} --reason "..."\n`);
          process.exit(1);
        }
        const claimed = (r as unknown as { claimed: string[] }).claimed;
        return out(p, claimed.length ? `parley: claimed ${claimed.join(", ")}` : "parley: already yours", r);
      }

      case "release": {
        const r = await send({ op: "release", paths: p.positional, all: p.flags.all === true });
        if (!r.ok) fail(p, describeError(r));
        const released = (r as unknown as { released: string[] }).released;
        return out(p, released.length ? `parley: released ${released.join(", ")}` : "parley: nothing to release", r);
      }

      case "ask": {
        const path = p.positional[0];
        if (!path) fail(p, "ask needs a path");
        const ttl = Number(flagString(p.flags, "ttl", String(DEFAULTS.PERMISSION_TTL_MS / 1000)));
        const r = await send({ op: "ask", path, reason: flagString(p.flags, "reason"), ttl_s: ttl });
        if (!r.ok) fail(p, describeError(r));
        const data = r as unknown as { state: string; request?: string; owner?: string };
        return out(
          p,
          data.state === "pending"
            ? `parley: asked ${data.owner} for ${path} (request ${data.request}); unanswered in ${ttl}s means granted`
            : `parley: ${path} is yours (${data.state})`,
          r,
        );
      }

      case "requests": {
        const r = await send({ op: "requests", all: p.flags.all === true });
        if (!r.ok) fail(p, describeError(r));
        const list = (r as unknown as { requests: { id: string; requester: string; path: string; owner: string; reason: string; seconds_left: number }[] }).requests;
        if (list.length === 0) return out(p, "parley: nothing pending", r);
        const rows = list.map((q) => `  ${q.id}  ${q.requester} wants ${q.path} from ${q.owner}  (${q.seconds_left}s left)\n        ${q.reason || "no reason given"}`);
        return out(p, rows.join("\n"), r);
      }

      case "grant": {
        const id = p.positional[0];
        if (!id) fail(p, "grant needs a request id");
        const r = await send({ op: "grant", request: id, scope: flagString(p.flags, "scope", "once") });
        if (!r.ok) fail(p, describeError(r));
        return out(p, "parley: granted", r);
      }

      case "deny": {
        const id = p.positional[0];
        if (!id) fail(p, "deny needs a request id");
        const r = await send({ op: "deny", request: id, reason: flagString(p.flags, "reason") });
        if (!r.ok) fail(p, describeError(r));
        return out(p, "parley: denied", r);
      }

      case "note":
      case "decide": {
        const r = await send({
          op: "note",
          kind: p.command === "decide" ? "decision" : "note",
          title: flagString(p.flags, "title") || p.positional.join(" "),
          body: flagString(p.flags, "body"),
          tags: flagString(p.flags, "tags").split(",").map((t) => t.trim()).filter(Boolean),
          paths: flagString(p.flags, "paths").split(",").map((t) => t.trim()).filter(Boolean),
        });
        if (!r.ok) fail(p, describeError(r));
        return out(p, p.command === "decide" ? "parley: decision recorded and announced" : "parley: noted", r);
      }

      case "reverse": {
        const id = p.positional[0];
        if (!id) fail(p, "reverse needs the id of a note or decision");
        const r = await send({ op: "reverse", id, reason: flagString(p.flags, "reason") });
        if (!r.ok) fail(p, describeError(r));
        return out(p, "parley: reversed; it no longer binds", r);
      }

      case "result": {
        const key = p.positional.join(" ");
        if (!key) fail(p, `result needs a key, e.g. parley result "bun test" --status pass`);
        const r = await send({
          op: "result", key,
          status: flagString(p.flags, "status", "unknown"),
          summary: flagString(p.flags, "summary"),
          paths: flagString(p.flags, "paths").split(",").map((t) => t.trim()).filter(Boolean),
        });
        if (!r.ok) fail(p, describeError(r));
        return out(p, `parley: recorded "${key}"`, r);
      }

      case "results": {
        const r = await send({
          op: "results",
          key: flagString(p.flags, "key") || undefined,
          fresh: p.flags.fresh === true,
        });
        if (!r.ok) fail(p, describeError(r));
        const list = (r as unknown as {
          results: { key: string; status: string; summary: string; byName: string; at: string; staleBecause: string | null }[];
        }).results;
        if (list.length === 0) return out(p, "parley: nothing recorded yet", r);
        const rows = list.map((x) => {
          const state = x.staleBecause ? `STALE (${x.staleBecause})` : "still valid";
          return `  ${x.status.toUpperCase().padEnd(7)} ${x.key}\n        ${x.summary || "(no summary)"}\n        ${x.byName} at ${x.at.slice(11, 16)} — ${state}`;
        });
        return out(p, rows.join("\n"), r);
      }

      case "notes": {
        if (p.flags.import) {
          const fromDisk = readExportedNotes(repo.root);
          if (fromDisk.length === 0) {
            return out(p, "parley: nothing to import — no .parley/notes.md in this repository", { ok: true, imported: 0 });
          }
          const current = await send({ op: "notes" });
          const known = new Set(
            current.ok ? (current as unknown as { notes: { title: string }[] }).notes.map((n) => n.title) : [],
          );
          let imported = 0;
          for (const note of fromDisk) {
            if (known.has(note.title)) continue;
            const r = await send({
              op: "note", title: note.title, body: note.body,
              tags: note.tags, paths: note.paths, kind: note.kind,
            });
            if (r.ok) imported++;
          }
          return out(
            p,
            `parley: imported ${imported} note(s) from .parley/notes.md (${fromDisk.length - imported} already on the bus)`,
            { ok: true, imported, found: fromDisk.length },
          );
        }
        const r = await send({
          op: "notes",
          tag: flagString(p.flags, "tag") || undefined,
          path: flagString(p.flags, "path") || undefined,
          kind: flagString(p.flags, "kind") || undefined,
          active: p.flags.active === true,
        });
        if (!r.ok) fail(p, describeError(r));
        const notes = (r as unknown as { notes: Parameters<typeof exportNotes>[0] }).notes;
        if (p.flags.export) {
          const written = exportNotes(notes, repo.root);
          return out(p, `parley: wrote ${written} (${notes.length} note(s)) — commit it when you are ready`, { ok: true, path: written });
        }
        return out(
          p,
          notes
            .map((n) => {
              const mark = n.kind === "decision" ? (n.reversedBy ? "[reversed] " : "[DECISION] ") : "";
              const where = n.paths.length ? `  ${n.paths.join(", ")}` : "";
              const tags = n.tags.length ? `  [${n.tags.join(", ")}]` : "";
              return `  ${n.id}  ${mark}${n.title}${tags}${where}`;
            })
            .join("\n") || "parley: no notes yet",
          r,
        );
      }

      case "mode": {
        const wanted = p.positional[0];
        const r = await send(wanted ? { op: "mode", mode: wanted } : { op: "mode" });
        if (!r.ok) fail(p, describeError(r));
        return out(p, `parley: mode ${(r as unknown as { mode: string }).mode}`, r);
      }


      default:
        process.stdout.write(USAGE);
        process.exit(2);
    }
  });
}

main().catch((e: Error) => {
  process.stderr.write(`parley: ${e.message}\n`);
  process.exit(1);
});
