import { ParleyClient } from "../client/client";
import type { RepoInfo } from "../repo/locate";

/**
 * `parley watch` — the panel.
 *
 * Live fronts, the conversation stream, and pending permission requests in
 * focus with the clock running.
 *
 * It opens **watching**: no input line, no buttons. The fronts settle territory
 * and permission among themselves; a stalled request must never quietly become
 * a request for a person's attention, and a panel with a prompt sitting in it
 * invites exactly that.
 *
 * Pressing `i` opens a composer, `Esc` closes it again. A human does have a
 * voice — what is sent from here reaches every front marked as human and at
 * high priority — it just is not what the interface offers you first.
 *
 * The panel is a convenience, never a dependency: `parley who`, `parley
 * requests` and `parley drain` from a terminal do the same job.
 */

interface Front {
  name: string; mission: string; harness: string; kind: string;
  connected: boolean; idle_s: number; claims: string[];
}

interface PendingRequest {
  id: string; path: string; requester: string; owner: string;
  reason: string; seconds_left: number;
}

interface FeedEvent {
  seq: number;
  kind: "say" | "system";
  from: { name: string; kind: string } | null;
  to: string | null;
  priority: string;
  text: string;
  at: string;
}

const UNICODE = (() => {
  const vars = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG].join(" ").toLowerCase();
  if (process.platform === "win32") return process.env.WT_SESSION !== undefined;
  return vars.includes("utf-8") || vars.includes("utf8");
})();

const G = UNICODE
  ? { h: "─", bullet: "•", bang: "!", dot: "·", arrow: "›" }
  : { h: "-", bullet: "*", bang: "!", dot: "-", arrow: ">" };

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const red = (s: string) => `${ESC}31m${s}${ESC}0m`;
const yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;

function width(): number { return Math.max(40, process.stdout.columns ?? 80); }
function height(): number { return Math.max(12, process.stdout.rows ?? 24); }

/** Visible length, ignoring ANSI sequences. */
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncate(s: string, max: number): string {
  return visLen(s) <= max ? s : `${s.slice(0, Math.max(0, max - 1))}${UNICODE ? "…" : "~"}`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function countdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export async function runWatch(repo: RepoInfo, name: string): Promise<void> {
  const client = await ParleyClient.connect({ gitCommonDir: repo.gitCommonDir });

  const joined = await client.request({
    op: "join", name, mission: "watching", harness: "panel",
    cwd: repo.root, kind: "human", connected: true,
  });
  if (!joined.ok) {
    client.close();
    process.stderr.write(`parley: could not join as ${name}: ${joined.error.code}\n`);
    process.exit(1);
  }
  const me = joined as unknown as { name: string; mode: string };

  let fronts: Front[] = [];
  let pending: PendingRequest[] = [];
  let mode = me.mode;
  const feed: FeedEvent[] = [];
  let input = "";
  let status = "";
  let closing = false;
  let speaking = false;

  const pushFeed = (events: FeedEvent[]) => {
    for (const e of events) {
      // The panel's own join/leave is noise about the observer, not about the
      // work. Dropping it keeps an idle bus looking idle.
      if (e.kind === "system" && e.text.startsWith(`${me.name} `)) continue;
      feed.push(e);
    }
    while (feed.length > 500) feed.shift();
  };

  client.onPush((events) => { pushFeed(events as FeedEvent[]); render(); });

  async function refresh(): Promise<void> {
    const [whoR, reqR, drainR] = await Promise.all([
      client.request({ op: "who" }),
      client.request({ op: "requests" }),
      client.request({ op: "drain" }),
    ]);
    if (whoR.ok) {
      const d = whoR as unknown as { mode: string; participants: Front[] };
      mode = d.mode;
      fronts = d.participants.filter((p) => p.name !== me.name);
    }
    if (reqR.ok) pending = (reqR as unknown as { requests: PendingRequest[] }).requests;
    if (drainR.ok) pushFeed((drainR as unknown as { events: FeedEvent[] }).events);
    render();
  }

  function render(): void {
    if (closing) return;
    const w = width();
    const h = height();
    const lines: string[] = [];
    const rule = G.h.repeat(w);

    const modeColour = mode === "enforced" ? red : mode === "off" ? dim : green;
    const title = `parley ${G.dot} ${modeColour(mode)} ${G.dot} ${repo.root.split("/").slice(-1)[0]}`;
    const right = `${fronts.length} front${fronts.length === 1 ? "" : "s"} ${G.dot} you are ${cyan(me.name)}`;
    const pad = Math.max(1, w - visLen(title) - visLen(right));
    lines.push(bold(title) + " ".repeat(pad) + right);
    lines.push(dim(rule));

    if (fronts.length === 0) {
      lines.push(dim("  nobody else on the bus yet"));
    } else {
      for (const f of fronts) {
        const presence = f.connected ? green(G.bullet) : f.idle_s > 240 ? red(G.bullet) : yellow(G.bullet);
        const claims = f.claims.length ? dim(`${f.claims.length} claim${f.claims.length === 1 ? "" : "s"}`) : dim("no claims");
        const head = `  ${presence} ${bold(f.name.padEnd(14))} ${truncate(f.mission || dim("no mission"), 30).padEnd(30)}`;
        lines.push(`${head} ${dim(f.harness.padEnd(12))} ${dim(`${f.idle_s}s`.padStart(5))}  ${claims}`);
        if (f.claims.length) lines.push(dim(`      ${truncate(f.claims.join(", "), w - 8)}`));
      }
    }

    if (pending.length) {
      lines.push("");
      lines.push(yellow(`  PENDING PERMISSION (${pending.length})`));
      for (const r of pending) {
        const late = r.seconds_left < 60;
        const timer = (late ? red : yellow)(`${countdown(r.seconds_left)} left`);
        lines.push(`  ${red(G.bang)} ${bold(r.requester)} wants ${cyan(truncate(r.path, 44))} from ${bold(r.owner)}  ${timer}`);
        lines.push(dim(`      ${truncate(r.reason || "no reason given", w - 10)}`));
        lines.push(dim(`      ${r.owner} settles this; unanswered, it is granted to ${r.requester} and announced`));
      }
    }

    lines.push(dim(rule));

    // Feed fills whatever vertical space is left, newest at the bottom.
    const reserved = lines.length + 3;
    const room = Math.max(3, h - reserved);
    const recent = feed.slice(-room);
    for (const e of recent) {
      const time = dim(clock(e.at));
      if (e.kind === "system" || !e.from) {
        lines.push(`${time} ${dim(truncate(`${G.dot} ${e.text}`, w - 7))}`);
        continue;
      }
      const who = e.from.kind === "human" ? cyan(e.from.name) : bold(e.from.name);
      const mark = e.priority === "high" ? red(`${G.bang} `) : "  ";
      const dest = e.to ? dim(`${G.arrow}${e.to} `) : "";
      lines.push(`${time} ${mark}${who} ${dest}${truncate(e.text, w - visLen(who) - 14)}`);
    }
    for (let i = recent.length; i < room; i++) lines.push("");

    lines.push(dim(rule));
    lines.push(
      speaking
        ? `${status ? `${dim(status)}  ` : ""}${bold(`${G.arrow} `)}${input}${dim("_")}`
        : dim(`  watching ${G.dot} ${bold("i")}${dim(" to say something")} ${G.dot} Ctrl+C to leave`),
    );

    // Redraw in one write: clear, home, print. Avoids the tearing you get from
    // clearing and printing as two syscalls on a slow terminal.
    process.stdout.write(`${ESC}H${ESC}J${lines.join("\n")}`);
  }

  async function submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Voice only. A human does not grant, deny or arbitrate from here — the
    // fronts resolve territory among themselves, by design.
    const directed = /^@(\S+)\s+([\s\S]+)$/.exec(trimmed);
    const frame = directed
      ? { op: "say", to: directed[1], text: directed[2] }
      : { op: "say", text: trimmed };
    const r = await client.request(frame);
    status = r.ok ? "" : `not sent: ${r.error.code}`;
    render();
  }

  function shutdown(): void {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    void client.request({ op: "leave" }).finally(() => {
      client.close();
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write(`${ESC}?25h${ESC}?1049l`);
      process.stdout.write("parley: panel closed\n");
      process.exit(0);
    });
  }

  // Alternate screen buffer, so quitting gives the user their scrollback back.
  process.stdout.write(`${ESC}?1049h${ESC}?25l`);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.on("resize", render);

  // Raw mode is on from the start even while watching, because that is how the
  // panel hears the one key that opens the composer.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 3 || code === 4) return void shutdown();  // Ctrl+C / Ctrl+D

        if (!speaking) {
          if (ch === "i" || ch === "I") { speaking = true; input = ""; status = ""; }
          else if (ch === "q") return void shutdown();
          continue;
        }

        if (code === 27) { speaking = false; input = ""; continue; }        // Esc
        if (code === 13 || code === 10) {
          const text = input;
          input = "";
          speaking = false;
          void submit(text);
          continue;
        }
        if (code === 127 || code === 8) { input = input.slice(0, -1); continue; }
        if (code === 21) { input = ""; continue; }                          // Ctrl+U
        if (code < 32) continue;
        input += ch;
      }
      render();
    });
  }

  const timer = setInterval(() => void refresh(), 1000);
  status = "";
  await refresh();
}
