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
import { ensureModel } from "../brain/download";
import { isLoadable } from "../brain/embed";
import {
  BENCHMARK_SIZE, findModel, isEncoder, LEXICAL_FLOOR_SCORE, MODELS, RECOMMENDED,
} from "../brain/registry";
import { bunAvailable, installEncoder } from "../brain/sidecar";
import { parsePlan } from "../plan/parse";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSelfReview } from "../state/work";
import type { WorkItem } from "../state/types";
import { flagBool, flagString, parseArgs, type Parsed } from "./args";
import { sessionFor } from "./session";
import { joinFrame, personIdentity, personSession, resolveIdentity, wakeAddress } from "./identity";

const COMPILED_CLI = import.meta.url.includes("$bunfs");

const USAGE = `parley — coordination bus for concurrent agent sessions in one repository

  parley update [--check] [--yes]
                             replace this binary with the latest release
  parley buses               every bus on this machine, which one is busy, and
                             where its panel is
  parley adapters            every project set up, and whether its skill is
                             current with this binary
  parley mcp                 run as an MCP server over stdio (for Codex, Kimi,
                             Antigravity and anything else that speaks MCP)
  parley init --workspace     make this directory one bus for every repository
                             inside it (VS Code multi-root workspaces)
  parley init [--yes] [--global]
                             install hooks and skill for detected harnesses.
                             --global installs the Claude Code hooks once for
                             every project — the only way every worktree is
                             covered, since .claude/ is usually gitignored.
  parley uninit [--global]   remove what init wrote, --global included
  parley doctor              diagnose transport, repo identity and the WSL boundary
  parley status              is a daemon up, and what does it hold
  parley stop                shut the daemon down

  parley whoami              which front you are, and where
  parley join --as NAME [--mission "..."]
                             announce yourself on the bus; the hooks already do
                             this for you
  parley rename --as NAME [--mission "..."]
                             change the name and mission everyone else sees
  parley leave               step off the bus, releasing every path you hold
  parley who                 everyone here: name, mission, branch, idle time
                             and what each one holds

  parley say [--to NAME] [--priority high] "text"
                             tell everyone, or one front with --to
  parley question --to NAME "..." [--wait 60] [--ttl 600]
                             ask when you need an answer back: they cannot go
                             idle while it is open
  parley reply <id> "answer" [--text "..."]
                             answer a question somebody is blocked on
  parley ack <id> ["got it, doing X"]
                             close the loop, so the front that answered knows
                             it landed
  parley nudged <id>         record that you woke them, so parley stops asking
  parley questions           what you owe an answer to, and what you are
                             waiting on
  parley drain               your unread messages, and only the unread ones
  parley history [--limit 200]
                             re-read the backlog without moving your read
                             cursor

  parley claim <paths...> [--intent "..."] [--auto]
                             take files or globs; the answer carries the notes
                             and the recent edits on them
  parley release [<paths...>] [--all]
                             give them back — letting go is the answer to
                             whoever was waiting

  parley watch [--web] [--port N] [--detach] [--stop] [--no-open]
                             live panel: fronts, feed and pending requests.
                             Opens watching; press i (or s on the web) to speak.
                             --detach keeps the web panel up after you close the
                             terminal; --stop shuts that one down; --no-open
                             leaves your browser alone. Each repository gets its
                             own port, so panels for several projects run side
                             by side.

  parley ask <path> --reason "..." [--ttl 300]
                             ask the owner for a path that is theirs; silence
                             until the ttl grants it, and says so by name
  parley requests [--all]    permission requests waiting, with the clock on each
  parley grant <request> [--scope once|transfer]
                             hand over a path you own
  parley deny <request> --reason "..."
                             refuse, with a reason the requester sees

  parley note --title "..." [--body "..."] [--tags a,b] [--paths a,b]
                             write down what the code does not say about
                             itself; --paths is what hands it to whoever edits
                             those files next
  parley decide --title "..." [--body "..."] [--tags a,b] [--paths a,b]
                             record something binding: announced to everyone,
                             and it stands until reversed
  parley reverse <id> [--reason "..."]
                             un-bind a decision, keeping it on the record
  parley notes [--tag x] [--path p] [--kind decision] [--active] [--export]
                             [--import] [--query "..." [--k N]]
                             read them back; --active drops anything reversed,
                             note or decision, --query ranks by relevance

  parley result <key> --status pass|fail [--summary "..."] [--paths a,b]
                             record what a command produced, and the paths it
                             depends on
  parley results [--fresh] [--key "..."] [--query "..." [--k N]]
                             what is already known, and whether it still holds;
                             --fresh hides anything a later edit invalidated

  parley mode [off|advisory|enforced]
                             how strict territory is; it belongs to the
                             repository, not to a session
  parley shape [bus|pool|plan]
                             where work comes from; read it back with no
                             argument

  parley brain               is semantic recall on, and with which model
  parley brain enable [<model>]
                             human-only. With no model named, lists the
                             registry ranked by measured score, with the disk
                             each costs, so you can weigh it before anything
                             downloads.
  parley brain disable

  parley plan <path-to-plan.md> [--replace]
                             read a superpowers plan and dispatch its first
                             wave onto the pool — parley shape plan first
  parley work "<title>" <path...> [--evidence <id,...>] [--kind review --review-of <id>]
                             publish discovered work, one item per path,
                             offered first to whoever already holds it
  parley works [--state open|offered|taken|done] [--mine]
                             what is in the pool: id, state, paths and title.
                             The state is the only holder information it shows
  parley take <id>           take an open item or an offer made to you; the
                             answer carries the evidence already gathered
  parley drop <id> [--reason "..."]
                             hand it back to the pool, free
  parley done <id> [--summary "..."]
                             mark it finished

Global flags: --json (machine output), --as NAME, --quiet
              --human (you are a person watching, not an agent)
              --help, --version
`;

function out(parsed: Parsed, human: string, payload: unknown): void {
  if (flagBool(parsed.flags, "json")) process.stdout.write(`${JSON.stringify(payload)}\n`);
  else if (!flagBool(parsed.flags, "quiet")) process.stdout.write(`${human}\n`);
}

function fail(parsed: Parsed, message: string, code = 1): never {
  if (flagBool(parsed.flags, "json")) process.stdout.write(`${JSON.stringify({ ok: false, error: { message } })}\n`);
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
    client = await ParleyClient.connect({ gitCommonDir: repo.discoveryDir, busKey: repo.gitCommonDir });
  } catch (e) {
    // parley broken must never stop the work: say so, exit clean for hooks.
    if (e instanceof ParleyUnreachable) {
      if (flagBool(parsed.flags, "json")) process.stdout.write(`${JSON.stringify({ ok: false, degraded: true, error: { message: e.message } })}\n`);
      else process.stderr.write(`parley: ${e.message} — continuing without coordination\n`);
      process.exit(0);
    }
    throw e;
  }

  // A person is not a front, and should never have been in the fronts'
  // namespace. Identity for an agent is derived from the branch or worktree —
  // which is right for a front, and wrong for the human watching several of
  // them: every session on a branch derives the same name, and the session key
  // falls back to one recalled from the working directory. So a person opening
  // a shell where an agent is working does not merely collide with it, they
  // *are* it: the same participant, reattached, and `--human` is then read and
  // discarded because reattaching does not change what somebody already is.
  //
  // That is how `parley brain enable --human` refused the only person allowed
  // to run it, with a message telling them to ask a human.
  //
  // A person gets their own name and their own session key instead, scoped to
  // the machine's user rather than to the repository's shape. They cannot
  // collide with a front, because they are not in that space at all.
  const asPerson = flagBool(parsed.flags, "human");
  const identity = asPerson
    ? personIdentity(flagString(parsed.flags, "as"))
    : resolveIdentity(repo.cwd, repo.cwd, flagString(parsed.flags, "as"));
  const join = (name?: string) => joinFrame(identity, {
    mission: flagString(parsed.flags, "mission", identity.mission),
    cwd: repo.cwd,
    // `name` is set only by the NAME_TAKEN retry below. It used to force
    // "agent", which silently demoted the one participant whose kind is
    // load-bearing: a person running `--human` in a repository where agents are
    // already on the bus collides on the derived name, comes back as an agent,
    // and is then refused by `brain enable` with a message telling them to ask
    // a human. The retry is about the name; it was never about who is asking.
    kind: flagBool(parsed.flags, "human") ? "human" : "agent",
    wake: wakeAddress(),
    session: asPerson ? personSession() : sessionFor(repo.discoveryDir, repo.cwd),
    ...(name ? { name } : {}),
  });
  let response = await client.request(join());

  // A derived name that collides takes the suggestion rather than failing: the
  // hook path has no human to retype it.
  if (!response.ok && response.error.code === "NAME_TAKEN" && identity.provisional && "suggestion" in response.error) {
    response = await client.request(join(String(response.error.suggestion)));
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
    let here: { gitCommonDir: string; root: string } | null = null;
    try {
      const found = locateRepo();
      here = { gitCommonDir: found.gitCommonDir, root: found.root };
    } catch { /* run from outside a repository is fine */ }
    // Deliberately `argv.includes` and not `flagBool`, which is the one
    // accessor everywhere else in this file. This branch runs before
    // `parseArgs` and reads raw argv, and it is not a command a person types:
    // src/cli/update.ts spawns it with bare `--yes` / `--json` and nothing
    // else. So the exact-match assumption that `--detach=true` broke cannot be
    // reached here — there is no spelling to get wrong. A reader converging on
    // "one accessor" will find these two survivors; they are on purpose.
    return refreshAllAdapters({
      assumeYes: argv.includes("--yes"),
      json: argv.includes("--json"),
      here,
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
      // For a repository this is <git-common-dir>/parley; for a workspace it is
      // <workspace>/.parley. The spawner passes the resolved directory.
      gitCommonDir: argv[2] ?? join(gitCommonDir, "parley"),
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
  if (argv.length === 0 || ["help", "--help", "-h"].includes(parsed.command) || flagBool(parsed.flags, "help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (["version", "--version", "-v"].includes(parsed.command) || flagBool(parsed.flags, "version")) {
    process.stdout.write(`parley ${VERSION} (protocol v${PROTOCOL_VERSION})\n`);
    return;
  }

  // Marking a workspace happens before repository lookup, because the whole
  // point is that the directory is not itself a repository.
  //
  // Presence, not truth. `--workspace` is the one hybrid in this file: bare it
  // means "find the workspace file here", with a value it names the file. Read
  // through `flagBool`, `parley init --workspace off` — `off` being a
  // perfectly ordinary filename — reads as *not given*, skips this branch and
  // falls through to a normal `runInit` that writes adapter files into the
  // current repository. Before, it entered here and failed loudly on a file it
  // could not read, which is the right answer. A valued flag must never be
  // routed through the boolean accessor; the value is read at `flagString`
  // below.
  if (parsed.command === "init" && "workspace" in parsed.flags) {
    const {
      findWorkspaceRoot, markAsWorkspace, membersOf, readWorkspaceFile, workspaceFilesIn,
    } = await import("../repo/workspace");
    const here = process.cwd();

    // A .code-workspace names its folders, and the directory holding them
    // usually holds a dozen others that have nothing to do with it. Reading the
    // file is the difference between "these seven projects" and "everything on
    // this disk".
    const given = flagString(parsed.flags, "workspace");
    const candidates = given && given !== "true" ? [given] : workspaceFilesIn(here);

    let root = here;
    let members: string[] = [];
    let file: string | null = null;

    if (candidates.length > 1 && !given) {
      return fail(
        parsed,
        `several workspace files here — say which:\n` +
          candidates.map((c) => `  parley init --workspace ${c.split("/").pop()}`).join("\n"),
      );
    }
    if (candidates.length === 1) {
      const read = readWorkspaceFile(candidates[0]!);
      if (!read) return fail(parsed, `could not read any folders from ${candidates[0]}`);
      file = candidates[0]!;
      root = read.root;
      members = read.members;
    } else {
      // No workspace file: fall back to every repository directly inside.
      members = membersOf(here).map((m) => `${here}/${m}`);
      if (members.length === 0) {
        return fail(parsed, `no .code-workspace file and no git repositories directly inside ${here}.`);
      }
    }

    const already = findWorkspaceRoot(root);
    if (already && already !== root) {
      return fail(parsed, `${already} is already a parley workspace, and this is inside it.`);
    }

    markAsWorkspace(root, { file, members, at: new Date().toISOString() });
    const shown = members.map((m) => m.replace(`${root}/`, ""));
    return out(
      parsed,
      `parley: ${root} is now one bus, covering ${members.length} folder(s)` +
        `${file ? ` from ${file.split("/").pop()}` : ""}:\n` +
        shown.map((m) => `        ${m}`).join("\n") +
        `\n\n        Territory here reads like ${shown[0]}/src/app.ts, and a session opened\n` +
        `        in any of these joins this bus. Anything else under ${root.split("/").pop()}\n` +
        `        keeps its own.\n\n` +
        `        Next, two commands:\n` +
        `          parley init --global   the hooks, once for every project. In a workspace\n` +
        `                                 this is the reliable way: .claude/ lives inside each\n` +
        `                                 folder and is usually gitignored, so per-folder hooks\n` +
        `                                 go missing exactly where you did not look.\n` +
        `          parley init            the skill in each of these folders, and the marker\n` +
        `                                 that lets the global hooks act here.`,
      { ok: true, workspace: root, file, members },
    );
  }

  // Updating does not need a repository — you may well be fixing an install
  // from your home directory.
  if (parsed.command === "update") {
    const { runUpdate } = await import("./update");
    let gitCommonDir: string | null = null;
    let repoRoot: string | null = null;
    let discoveryDir: string | null = null;
    try {
      const found = locateRepo();
      gitCommonDir = found.gitCommonDir;
      repoRoot = found.root;
      discoveryDir = found.discoveryDir;
    } catch { /* updating from anywhere is fine */ }
    return runUpdate({
      checkOnly: flagBool(parsed.flags, "check"),
      assumeYes: flagBool(parsed.flags, "yes"),
      json: flagBool(parsed.flags, "json"),
      gitCommonDir,
      repoRoot,
      discoveryDir,
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
        assumeYes: flagBool(parsed.flags, "yes"),
        json: flagBool(parsed.flags, "json"),
        global: flagBool(parsed.flags, "global"),
      });
    }
    case "uninit": {
      const { runUninit } = await import("../adapters/install");
      return runUninit(repo, { json: flagBool(parsed.flags, "json"), global: flagBool(parsed.flags, "global") });
    }

    case "buses": {
      const { summariseBuses } = await import("./buses");
      const buses = summariseBuses();
      if (buses.length === 0) {
        return out(parsed, "parley: no project has been set up yet (run: parley init)", { ok: true, buses: [] });
      }
      const rows = buses.map((b) => {
        const when = b.lastActivity ? b.lastActivity.slice(11, 16) : "never";
        const state = b.live ? "up" : "idle";
        return `  ${b.says > 0 ? "*" : " "} ${b.root}\n` +
          `      ${b.scope} · ${state} · ${b.says} message(s) · last activity ${when}` +
          (b.panel ? `\n      panel: ${b.panel}` : "");
      });
      const busiest = buses.find((b) => b.says > 0 && !b.panel);
      return out(
        parsed,
        rows.join("\n") +
          (busiest
            ? `\n\n  The conversation is in ${busiest.root.split("/").pop()}, and it has no panel open.\n` +
              `  cd ${busiest.root} && parley watch --web --detach`
            : ""),
        { ok: true, buses },
      );
    }

    case "adapters": {
      const { pruneRegistry } = await import("../adapters/registry");
      const { readWorkspaceMarker } = await import("../repo/workspace");

      // A workspace stands for its member folders, which is where the skills
      // live — Claude Code reads them from the folder a session was opened in.
      // Listing the root instead reports "not installed" for a setup that is
      // perfectly fine, and lists it twice when it is registered twice.
      const seen = new Set<string>();
      const repos = pruneRegistry().flatMap((r) => {
        const marker = readWorkspaceMarker(r.root);
        const roots = marker ? marker.members : [r.root];
        return roots.filter((root) => !seen.has(root) && seen.add(root)).map((root) => ({ ...r, root }));
      });
      if (repos.length === 0) {
        return out(parsed, "parley: no project has been set up yet (run: parley init)", { ok: true, repos: [] });
      }
      const rows = repos.map((r) => {
        const a = adapterStatus(r.root);
        const state = !a.installed
          ? "not installed"
          : a.skillCurrent && a.hooksCurrent
            ? `current (skill v${a.skillVersion ?? VERSION})`
            : `OUTDATED (skill v${a.skillVersion ?? "?"}, binary v${VERSION})`;
        return { root: r.root, state, current: a.installed && a.skillCurrent && a.hooksCurrent };
      });
      const stale = rows.filter((r) => !r.current).length;
      return out(
        parsed,
        `${rows.map((r) => `  ${r.current ? " " : "!"} ${r.root}\n      ${r.state}`).join("\n")}` +
          (stale ? `\n\n  ${stale} project(s) out of date — run: parley update` : "\n\n  all current"),
        { ok: true, binary: VERSION, repos: rows },
      );
    }

    case "doctor": {
      const address = resolveAddress(repo.repoId, env);
      const endpoint = readEndpoint(repo.discoveryDir);
      const report = {
        version: VERSION,
        scope: repo.scope === "workspace" ? `workspace (${repo.root})` : "repository",
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
          if (a.skillCurrent && a.hooksCurrent) return `current — skill v${a.skillVersion ?? VERSION}`;
          const had = a.skillVersion ? `skill v${a.skillVersion}` : "skill from an unknown version";
          return `OUTDATED — ${had}, this binary is v${VERSION}. Run: parley update`;
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
      const endpoint = readEndpoint(repo.discoveryDir);
      if (!endpoint) return out(parsed, "parley: no daemon running for this repository", { ok: true, running: false });
      const client = await ParleyClient.connect({ gitCommonDir: repo.discoveryDir, busKey: repo.gitCommonDir, autoSpawn: false }).catch(() => null);
      if (!client) return out(parsed, "parley: endpoint present but no daemon answering (stale)", { ok: true, running: false, stale: true });
      const response = await client.request({ op: "status" });
      client.close();
      const s = response as unknown as Record<string, unknown>;
      const { readRunningPanel } = await import("./web");
      const panel = readRunningPanel(repo.gitCommonDir);
      return out(
        parsed,
        `parley up  pid ${endpoint.pid}  mode ${s.mode}  shape ${s.shape}  ${s.participants} front(s)  ${s.claims} claim(s)  ${s.pending_requests} pending` +
          (panel ? `\n  web panel: ${panel.url}` : ""),
        { ...(response as object), panel: panel?.url ?? null },
      );
    }

    case "stop": {
      const endpoint = readEndpoint(repo.discoveryDir);
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
    if (flagBool(parsed.flags, "web")) {
      const { clearRunningPanel, defaultPortFor, readRunningPanel, runWebPanel } = await import("./web");
      const explicitPort = flagString(parsed.flags, "port");
      const port = explicitPort ? Number(explicitPort) : defaultPortFor(repo.repoId);
      const running = readRunningPanel(repo.gitCommonDir);

      if (flagBool(parsed.flags, "stop")) {
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

      if (flagBool(parsed.flags, "detach")) {
        const { spawn } = await import("node:child_process");
        // Every spelling of the flag, not just the bare one. `--detach=true` left
        // in the child's argv makes the child detach too, and the one after it:
        // no generation ever reaches runWebPanel, so the panel never starts.
        const args = process.argv.slice(1).filter((a) => a !== "--detach" && !a.startsWith("--detach="));
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

      // `--no-open` is the spelling the help text offers, and `flagBool` is
      // what reads it — as it now reads every boolean flag here. The old
      // `parsed.flags.open !== false` was true for every input, and
      // `parsed.flags["no-open"] !== true` was still true for `--no-open=true`
      // and `--no-open true`, which parseArgs stores as the string `"true"`.
      return runWebPanel(repo, panelName, port, !flagBool(parsed.flags, "no-open"), explicitPort !== "");
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
            `    reaches ${String(x.reach)}`,
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

        const body = r as unknown as {
          reach?: string;
          wake?: { address: string; why: string; how: string } | null;
        };
        if (wait <= 0) {
          const lines = [`parley: asked ${to} (${id}).`, `  ${body.reach ?? ""}`];
          if (body.wake) {
            lines.push(`  ${body.wake.why}.`);
            lines.push(`  To wake it now: ${body.wake.address} — ${body.wake.how}.`);
          } else {
            lines.push("  They cannot finish their turn without answering you.");
          }
          return out(p, lines.join("\n"), r);
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

      case "nudged": {
        const id = p.positional[0];
        if (!id) fail(p, "nudged needs a question id");
        const r = await send({ op: "nudged", id });
        if (!r.ok) fail(p, describeError(r));
        return out(p, "parley: noted — it will stop reminding you about that one", r);
      }

      case "questions": {
        const r = await send({ op: "questions" });
        if (!r.ok) fail(p, describeError(r));
        const d = r as unknown as {
          owed: { id: string; from: string; text: string; seconds_left: number }[];
          waiting: { id: string; to: string; text: string; seconds_left: number }[];
          need_nudge: { id: string; to: string; wake: string | null; idle_s: number }[];
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
        if (d.need_nudge?.length) {
          lines.push("  THEY ARE ASLEEP — ring the doorbell, nothing else can:");
          for (const q of d.need_nudge) {
            lines.push(`    ${q.id}  ${q.to} idle ${Math.round(q.idle_s / 60)}m at ${q.wake}`);
            lines.push(`          then: parley nudged ${q.id}`);
          }
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
        const r = await send({ op: "claim", paths: p.positional, intent: flagString(p.flags, "intent"), auto: flagBool(p.flags, "auto") });
        if (!r.ok) {
          const conflicts = (r as unknown as { conflicts?: { path: string; owner: { name: string; mission: string }; since: string }[] }).conflicts ?? [];
          const detail = conflicts.map((c) => `  ${c.path} held by ${c.owner.name} (${c.owner.mission || "no mission"}) since ${c.since}`).join("\n");
          if (flagBool(p.flags, "json")) { process.stdout.write(`${JSON.stringify(r)}\n`); process.exit(1); }
          process.stderr.write(`parley: CONFLICT\n${detail}\nAsk for it:  parley ask ${conflicts[0]?.path ?? p.positional[0]} --reason "..."\n`);
          process.exit(1);
        }
        const claimed = (r as unknown as { claimed: string[] }).claimed;
        return out(p, claimed.length ? `parley: claimed ${claimed.join(", ")}` : "parley: already yours", r);
      }

      case "release": {
        const r = await send({ op: "release", paths: p.positional, all: flagBool(p.flags, "all") });
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
        const r = await send({ op: "requests", all: flagBool(p.flags, "all") });
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
        const query = flagString(p.flags, "query") || undefined;
        const r = await send({
          op: "results",
          key: flagString(p.flags, "key") || undefined,
          fresh: flagBool(p.flags, "fresh"),
          q: query,
          k: query ? Number(flagString(p.flags, "k", "5")) : undefined,
          // A query is the front asking for recall — spec §5.1's activation
          // flow only fires on this flag, so an actual `--query` call is what
          // has to set it, not just the daemon's own optional field existing.
          semantic: query ? true : undefined,
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
        if (flagBool(p.flags, "import")) {
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
        const query = flagString(p.flags, "query") || undefined;
        const r = await send({
          op: "notes",
          tag: flagString(p.flags, "tag") || undefined,
          path: flagString(p.flags, "path") || undefined,
          kind: flagString(p.flags, "kind") || undefined,
          active: flagBool(p.flags, "active"),
          q: query,
          k: query ? Number(flagString(p.flags, "k", "5")) : undefined,
          // Same reasoning as `results` above: asking is what should surface
          // the brain's existence to the panel, once — never a bare listing.
          semantic: query ? true : undefined,
        });
        if (!r.ok) fail(p, describeError(r));
        const notes = (r as unknown as { notes: Parameters<typeof exportNotes>[0] }).notes;
        if (flagBool(p.flags, "export")) {
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

      case "shape": {
        const wanted = p.positional[0];
        const r = await send(wanted ? { op: "shape", shape: wanted } : { op: "shape" });
        if (!r.ok) fail(p, describeError(r));
        return out(p, `parley: shape ${(r as unknown as { shape: string }).shape}`, r);
      }

      case "brain": {
        const sub = p.positional[0];

        if (sub === "disable") {
          const r = await send({ op: "brain", disable: true });
          if (!r.ok) fail(p, describeError(r));
          return out(p, "parley: brain disabled", r);
        }

        if (sub === "enable") {
          // An agent running this is what the refusal is for, and the honest
          // signal is the environment it runs in — not who it is on the bus.
          // A harness stamps its session into the environment; a person's shell
          // does not. That fact is here, before anything downloads, and it does
          // not require anybody to join anything.
          const harness =
            process.env.CLAUDE_CODE_SESSION_ID?.trim() ||
            process.env.CODEX_SESSION_ID?.trim() ||
            process.env.CURSOR_TRACE_ID?.trim();
          if (harness && !flagBool(parsed.flags, "human")) {
            fail(
              p,
              "brain enable/disable spends somebody's disk and somebody's money, so it is theirs to run: " +
                "this looks like an agent session. Ask the person to run it in their own shell " +
                "(or pass --human if you are the person and this is your terminal).",
            );
          }

          const name = p.positional[1];
          if (!name) {
            // The listing is not a formality. Somebody agreeing to spend disk
            // should know what they are agreeing to, and the previous version
            // skipped straight to downloading whenever there was one loadable
            // entry — so a person typed `enable` and received 54 MB of a thing
            // whose name told them nothing.
            // Ranked, best first. Every column is measured on this machine's
            // kind of hardware and none of it is an adjective: a person
            // choosing here is spending their own disk and their own memory,
            // and the previous listing asked them to interpret prose instead.
            const ranked = [...MODELS].sort((a, b) => b.score - a.score);
            const w = Math.max(...ranked.map((m) => m.name.length));
            const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);
            const cols = (a: string, b: string, c: string, d: string, e: string, f: string): string =>
              `  ${a.padEnd(w)}  ${b.padStart(5)}  ${c.padStart(7)}  ${d.padStart(7)}` +
              `  ${e.padStart(6)}  ${f.padStart(10)}`;
            const header =
              cols("", "score", "gain", "RAM", "disk", "per note") +
              `\n${cols("─".repeat(w), "─────", "───────", "───────", "──────", "──────────")}`;
            // The floor's own score, first and unindented from the models: it
            // is what every row below is measured against, and without it "14
            // of 20" is a number nobody can place.
            const baseline = cols("no model at all", `${LEXICAL_FLOOR_SCORE}/${BENCHMARK_SIZE}`, "—", "—", "—", "—");
            const rows = ranked.map((m) => {
              const gain = m.score - LEXICAL_FLOOR_SCORE;
              const mark = m.name === RECOMMENDED ? "  ← recommended" : "";
              // A static model embeds faster than this clock can honestly
              // measure, so a number there would be false precision. What
              // matters about it is the other thing: nothing to install.
              const speed = isEncoder(m) ? `${m.msPerNote} ms` : "no runtime";
              return (
                cols(m.name, `${m.score}/${BENCHMARK_SIZE}`, gain > 0 ? `+${gain}` : "nothing",
                     mb(m.ramMB), mb(Math.round(m.bytes / 1048576)), speed) + mark
              );
            });
            return out(
              p,
              `parley: semantic recall runs a model on this machine — no network after the\n` +
                `download, nothing leaves the repository.\n\n` +
                `Score is ${BENCHMARK_SIZE} questions, each with exactly one note that answers it and\n` +
                `almost no words in common: how many times that note came back as the answer.\n` +
                `"gain" is what the model adds — parley already answers without one.\n\n` +
                `${header}\n${baseline}\n${rows.join("\n")}\n\n` +
                `  parley brain enable ${RECOMMENDED}\n\n` +
                `Time per note is background work — nothing waits on it; it only sets how\n` +
                `long a first activation takes. A model with one installs a local runtime\n` +
                `once, which enable does for you.\n` +
                `The lexical floor answers either way; the model is what finds a note that\n` +
                `shares no words with the question.`,
              {
                ok: true,
                recommended: RECOMMENDED,
                models: ranked.map((m) => ({
                  name: m.name, score: m.score, of: BENCHMARK_SIZE,
                  gainOverFloor: m.score - LEXICAL_FLOOR_SCORE,
                  bytes: m.bytes, dims: m.dims, ramMB: m.ramMB, msPerNote: m.msPerNote,
                  kind: m.kind, needsRuntime: isEncoder(m),
                  available: isEncoder(m) ? bunAvailable() : isLoadable(m),
                  recommended: m.name === RECOMMENDED,
                })),
              },
            );
          }

          const model = findModel(name);
          if (!model) fail(p, `no such model in the registry: ${name} (run "parley brain enable" to list them)`);

          // The size is shown before anything is downloaded, unconditionally —
          // even under --json, since this goes to stderr and never touches the
          // JSON on stdout. A person agreeing to spend that much of their own
          // disk should see the number first, since that is the entire reason
          // this is theirs to decide.
          process.stderr.write(
            `parley: downloading ${model.name} (~${Math.round(model.bytes / (1024 * 1024))} MB)...\n`,
          );

          if (isEncoder(model)) {
            // Refuse before a single byte moves, for the same reason the
            // tokenizer check below refuses: this one cannot end well and the
            // person should not pay a download to find that out.
            if (!bunAvailable()) {
              fail(
                p,
                `${model.name} runs as a local process and needs bun to run it, which is not on PATH. ` +
                  `Install it with "curl -fsSL https://bun.sh/install | bash", or pick a model listed as ` +
                  `"no runtime" — run "parley brain enable" to see them.`,
              );
            }
            const installed = installEncoder(undefined, model);
            if (!installed.ok) {
              fail(p, `${model.name} could not be installed: ${installed.error ?? "unknown"} — the brain stays off`);
            }
          } else {
            // The registry knows about `xlmr` models; this build's static
            // loader (`src/brain/embed.ts`) only understands `wordlevel`.
            // Downloading first and finding that out after would spend
            // somebody's disk and time on an outcome that was already certain.
            if (!isLoadable(model)) {
              fail(
                p,
                `${model.name} needs the ${model.tokenizer} tokenizer, which this build does not carry — only ` +
                  `wordlevel loads today. That is a limitation of this build, not a bad download or a broken ` +
                  `model; it stays listed because the model is real. Run "parley brain enable" to see which ` +
                  `entries are loadable.`,
              );
            }
            const path = await ensureModel(model);
            if (!path) fail(p, "download or checksum verification failed — the brain stays off");
          }

          const r = await send({ op: "brain", enable: model.name });
          if (!r.ok) fail(p, describeError(r));
          return out(p, `parley: brain enabled — ${model.name}`, r);
        }

        const r = await send({ op: "brain" });
        if (!r.ok) fail(p, describeError(r));
        const d = r as unknown as { active: boolean; model: string | null };
        return out(p, d.active ? `parley: brain is on — ${d.model}` : "parley: brain is off", r);
      }
      case "plan": {
        const file = p.positional[0];
        if (!file) fail(p, "plan needs a path, e.g. parley plan docs/superpowers/plans/2026-08-20-shape-plan.md");
        let markdown: string;
        try {
          markdown = readFileSync(file, "utf8");
        } catch (e) {
          fail(p, `could not read ${file}: ${(e as Error).message}`);
        }
        // The daemon never touches the filesystem: parsing happens here, and
        // only the parsed tasks cross the wire.
        const parsed = parsePlan(markdown);
        const r = await send({
          op: "plan", goal: parsed.goal, spec: parsed.spec, tasks: parsed.tasks,
          // One plan runs at a time. `--replace` is what the README calls
          // re-sequencing: it withdraws what the running plan has not
          // finished — including items a front is holding — and starts over.
          replace: flagBool(p.flags, "replace"),
        });
        if (!r.ok) fail(p, describeError(r));
        const d = r as unknown as { waves: number; opened: number; withdrawn: number };
        return out(
          p,
          `parley: ${parsed.tasks.length} task(s) in ${d.waves} wave(s) — ${d.opened} item(s) open now\n` +
            (d.withdrawn > 0 ? `  ${d.withdrawn} unfinished item(s) of the previous plan were withdrawn\n` : "") +
            `  parley works --state open`,
          r,
        );
      }

      case "work": {
        const title = p.positional[0];
        const paths = p.positional.slice(1);
        if (!title) fail(p, `work needs a title, e.g. parley work "label sem for" templates/a.html`);
        if (paths.length === 0) fail(p, "work needs at least one path");
        const r = await send({
          op: "work",
          title,
          paths,
          evidence: flagString(p.flags, "evidence").split(",").map((t) => t.trim()).filter(Boolean),
          kind: p.flags.kind === "review" ? "review" : undefined,
          reviewOf: flagString(p.flags, "review-of") || undefined,
        });
        if (!r.ok) fail(p, describeError(r));
        const items = (r as unknown as { items: { id: string; path: string; state: string; offeredTo: string | null }[] }).items;
        return out(
          p,
          `parley: published ${items.length} item(s)\n` +
            items.map((i) => `  ${i.id}  ${i.path}  (${i.state})`).join("\n"),
          r,
        );
      }

      case "works": {
        const stateFilter = flagString(p.flags, "state");
        const r = await send({
          op: "works",
          state: ["open", "offered", "taken", "done"].includes(stateFilter) ? stateFilter : undefined,
          mine: flagBool(p.flags, "mine"),
        });
        if (!r.ok) fail(p, describeError(r));
        const work = (r as unknown as { work: WorkItem[] }).work;
        if (work.length === 0) return out(p, "parley: nothing in the pool", r);
        // The listing is where a finished wave is read back, and a done review
        // keeps `takenById` — so this is the surface on which a wave that was
        // reviewed by its own author would otherwise look exactly like one
        // that was not. Same predicate `take` answers with.
        const rows = work.map((w) =>
          `  ${w.id}  ${w.state.padEnd(7)} ${w.paths.join(", ")} — ${w.title}` +
          (isSelfReview(w, w.takenById) ? "  (self-review)" : ""));
        return out(p, rows.join("\n"), r);
      }

      case "take": {
        const id = p.positional[0];
        if (!id) fail(p, "take needs a work item id");
        const r = await send({ op: "take", id });
        if (!r.ok) {
          const offered = (r as unknown as { offeredTo?: { name: string; mission: string } }).offeredTo;
          fail(p, offered ? `${describeError(r)} — held by ${offered.name} (${offered.mission || "no mission"})` : describeError(r));
        }
        // `reviewing` is the whole reviewed `WorkItem` (see `takeWork`), not
        // the two fields this line prints — structural typing made the narrow
        // shape safe but it understated what a consumer may read.
        const d = r as unknown as {
          title: string; paths: string[]; evidence: { notes: unknown[]; results: unknown[] };
          reviewing: WorkItem | null; selfReview: boolean;
        };
        const evCount = d.evidence.notes.length + d.evidence.results.length;
        return out(
          p,
          `parley: took ${d.paths[0]} — ${d.title}` +
            // A review names what it is a review OF. Without this the pointer
            // exists only in --json, and the skill tells fronts to take items
            // in plain text.
            (d.reviewing ? `\n  reviewing ${d.reviewing.id} — ${d.reviewing.title}` : "") +
            // And it names whose work that is when it is yours. parley does not
            // refuse this take — with one front it is the only path — so saying
            // so plainly is the only thing that keeps the rule from being a
            // rule nobody can observe being kept.
            (d.selfReview ? `\n  self-review — this review is of your own work` : "") +
            (evCount ? `\n  ${evCount} piece(s) of evidence came with it — read --json, do not re-discover it` : ""),
          r,
        );
      }

      case "drop": {
        const id = p.positional[0];
        if (!id) fail(p, "drop needs a work item id");
        const r = await send({ op: "drop", id, reason: flagString(p.flags, "reason") });
        if (!r.ok) fail(p, describeError(r));
        return out(p, "parley: dropped — back in the pool for someone else", r);
      }

      case "done": {
        const id = p.positional[0];
        if (!id) fail(p, "done needs a work item id");
        const r = await send({ op: "done", id, summary: flagString(p.flags, "summary") });
        if (!r.ok) fail(p, describeError(r));
        return out(p, "parley: marked done", r);
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
