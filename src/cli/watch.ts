import { ParleyClient } from "../client/client";
import type { RepoInfo } from "../repo/locate";
import { readPanelConfig, sanitiseName, writePanelConfig } from "./panel-config";

/**
 * `parley watch` — the panel.
 *
 * It opens **watching**: no input line, no buttons. A stalled request must
 * never quietly become a request for a person's attention — a dispute that
 * is not the human's own is for the fronts to settle among themselves — and
 * a panel with a prompt sitting in it invites exactly that.
 *
 * Three screens: the bus, the note list, and one note full screen. Everything
 * that writes is something you open on purpose — `i` to say, `m` to set your
 * name. The protocol lets a human answer for whatever territory is theirs,
 * same as any front; the panel just never puts a button on it.
 */

interface Front {
  id: string; name: string; mission: string; harness: string; kind: string;
  branch: string; worktree: string; tag: string;
  connected: boolean; idle_s: number; claims: string[];
}

interface WorkRow {
  id: string; paths: string[]; title: string; state: string;
  offeredToId: string | null; takenById: string | null;
}

interface Note {
  id: string; title: string; body: string; tags: string[];
  authorName: string; at: string;
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
  ? { h: "─", bullet: "•", bang: "!", dot: "·", arrow: "›", sel: "▸" }
  : { h: "-", bullet: "*", bang: "!", dot: "-", arrow: ">", sel: ">" };

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const red = (s: string) => `${ESC}31m${s}${ESC}0m`;
const yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const invert = (s: string) => `${ESC}7m${s}${ESC}0m`;

const width = () => Math.max(40, process.stdout.columns ?? 80);
const height = () => Math.max(12, process.stdout.rows ?? 24);
const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function truncate(s: string, max: number): string {
  return visLen(s) <= max ? s : `${s.slice(0, Math.max(0, max - 1))}${UNICODE ? "…" : "~"}`;
}

/** Pad to a visible width. `String.padEnd` counts escape bytes and misaligns. */
function padVis(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - visLen(s)));
}

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function stamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${clock(iso)}`;
}

function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface WorkGroup { label: string; count: number; kind: string }

/**
 * One entry per owner-and-state, not one per item — the panel is a person
 * glancing over, and thirteen individual rows is the corpus this whole
 * feature exists to avoid dumping in front of them.
 */
function workGroups(work: WorkRow[], nameFor: (id: string) => string): WorkGroup[] {
  const byOffered = new Map<string, number>();
  const byTaken = new Map<string, number>();
  let open = 0;
  for (const w of work) {
    if (w.state === "offered" && w.offeredToId) {
      byOffered.set(w.offeredToId, (byOffered.get(w.offeredToId) ?? 0) + 1);
    } else if (w.state === "taken" && w.takenById) {
      byTaken.set(w.takenById, (byTaken.get(w.takenById) ?? 0) + 1);
    } else if (w.state === "open") {
      open++;
    }
  }
  const groups: WorkGroup[] = [];
  for (const [id, count] of byOffered) groups.push({ label: nameFor(id), count, kind: "offered" });
  for (const [id, count] of byTaken) groups.push({ label: nameFor(id), count, kind: "taken" });
  if (open > 0) groups.push({ label: "pool", count: open, kind: "open" });
  return groups;
}

/**
 * The header and the collapsed, grouped-by-owner line — the two lines worth
 * showing before anyone presses `w`. Exported bare, with no ANSI colour codes,
 * so a test can assert the text without stripping escape sequences first.
 */
export function workSummaryLines(work: WorkRow[], fronts: { id: string; name: string }[]): [string, string] {
  const live = work.filter((w) => w.state !== "done");
  const nameFor = (id: string) => fronts.find((f) => f.id === id)?.name ?? id;
  const groups = workGroups(live, nameFor);
  const summary = groups.map((g) => `${g.label}   ${g.count} ${g.kind}`).join("      ");
  return [`  WORK (${live.length})  ${G.dot}  w to expand`, `  ${summary}`];
}

/** One line per item, only rendered once a person asks to see it. */
export function workDetailLines(work: WorkRow[], fronts: { id: string; name: string }[]): string[] {
  const nameFor = (id: string | null) => (id ? fronts.find((f) => f.id === id)?.name ?? id : "pool");
  return work
    .filter((w) => w.state !== "done")
    .map((w) => {
      const owner = w.state === "offered" ? nameFor(w.offeredToId) : w.state === "taken" ? nameFor(w.takenById) : "pool";
      return `    ${owner}  ${w.state}  ${w.paths[0]} — ${w.title}`;
    });
}

/** Wrap on word boundaries, preserving the blank lines that shape a note. */
function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") { out.push(""); continue; }
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

type View = "bus" | "notes" | "reader";
type Composer = "none" | "say" | "name";

export async function runWatch(repo: RepoInfo, name: string): Promise<void> {
  const client = await ParleyClient.connect({ gitCommonDir: repo.discoveryDir, busKey: repo.gitCommonDir });

  const joined = await client.request({
    op: "join", name, mission: "watching", harness: "panel",
    cwd: repo.cwd, kind: "human", connected: true,
  });
  if (!joined.ok) {
    client.close();
    process.stderr.write(`parley: could not join as ${name}: ${joined.error.code}\n`);
    process.exit(1);
  }
  const me = joined as unknown as { name: string; mode: string };

  let fronts: Front[] = [];
  let pending: PendingRequest[] = [];
  let notes: Note[] = [];
  let work: WorkRow[] = [];
  let mode = me.mode;
  let myName = me.name;
  const feed: FeedEvent[] = [];

  let view: View = "bus";
  let composer: Composer = "none";
  let input = "";
  let status = "";
  let selected = 0;
  let scroll = 0;
  let closing = false;
  let workExpanded = false;

  const pushFeed = (events: FeedEvent[]) => {
    for (const e of events) {
      feed.push(e);
    }
    while (feed.length > 500) feed.shift();
  };

  client.onPush((events) => { pushFeed(events as FeedEvent[]); render(); });

  async function seed(): Promise<void> {
    const past = await client.request({ op: "history", limit: 200 });
    if (past.ok) pushFeed((past as unknown as { events: FeedEvent[] }).events);
  }

  async function refresh(): Promise<void> {
    const [whoR, reqR, notesR, drainR, worksR] = await Promise.all([
      client.request({ op: "who" }),
      client.request({ op: "requests" }),
      client.request({ op: "notes" }),
      client.request({ op: "drain" }),
      client.request({ op: "works" }),
    ]);
    if (whoR.ok) {
      const d = whoR as unknown as { mode: string; participants: Front[] };
      mode = d.mode;
      fronts = d.participants.filter((p) => p.name !== myName);
    }
    if (reqR.ok) pending = (reqR as unknown as { requests: PendingRequest[] }).requests;
    if (notesR.ok) {
      notes = (notesR as unknown as { notes: Note[] }).notes;
      if (selected >= notes.length) selected = Math.max(0, notes.length - 1);
    }
    if (drainR.ok) pushFeed((drainR as unknown as { events: FeedEvent[] }).events);
    if (worksR.ok) work = (worksR as unknown as { work: WorkRow[] }).work;
    render();
  }

  function header(right: string): string[] {
    const w = width();
    const colour = mode === "enforced" ? red : mode === "off" ? dim : green;
    const title = `parley ${G.dot} ${colour(mode)} ${G.dot} ${repo.root.split("/").slice(-1)[0]}`;
    const pad = Math.max(1, w - visLen(title) - visLen(right));
    return [bold(title) + " ".repeat(pad) + right, dim(G.h.repeat(w))];
  }

  function paint(lines: string[]): void {
    process.stdout.write(`${ESC}H${ESC}J${lines.slice(0, height()).join("\n")}`);
  }

  function renderBus(): void {
    const w = width();
    const h = height();
    const lines = header(
      `${fronts.length} front${fronts.length === 1 ? "" : "s"} ${G.dot} you are ${cyan(myName)}`,
    );

    if (fronts.length === 0) lines.push(dim("  nobody else on the bus yet"));
    for (const f of fronts) {
      const presence = f.connected ? green(G.bullet) : f.idle_s > 240 ? red(G.bullet) : yellow(G.bullet);
      const claims = f.claims.length
        ? dim(`${f.claims.length} claim${f.claims.length === 1 ? "" : "s"}`)
        : dim("no claims");
      const mission = f.mission ? truncate(f.mission, 34) : dim("no mission");
      lines.push(
        `  ${presence} ${padVis(bold(f.name), 22)} ${dim(f.tag)}  ${padVis(mission, 34)} ${dim(`${f.idle_s}s`.padStart(5))}  ${claims}`,
      );
      // On a shared branch the name is not enough to tell two fronts apart;
      // where they are working is what a person actually recognises.
      const place = [f.branch && `on ${f.branch}`, f.worktree && `in ${f.worktree}`, f.harness]
        .filter(Boolean).join(" ${G.dot} ");
      lines.push(dim(`      ${truncate(place.replace(/\$\{G\.dot\}/g, G.dot), w - 8)}`));
      if (f.claims.length) lines.push(dim(`      ${truncate(f.claims.join(", "), w - 8)}`));
    }

    if (pending.length) {
      lines.push("");
      lines.push(yellow(`  PENDING PERMISSION (${pending.length})`));
      for (const r of pending) {
        const timer = (r.seconds_left < 60 ? red : yellow)(`${countdown(r.seconds_left)} left`);
        lines.push(`  ${red(G.bang)} ${bold(r.requester)} wants ${cyan(truncate(r.path, 44))} from ${bold(r.owner)}  ${timer}`);
        lines.push(dim(`      ${truncate(r.reason || "no reason given", w - 10)}`));
        lines.push(dim(`      ${r.owner} settles this; unanswered, it is granted to ${r.requester} and announced`));
      }
    }

    if (work.some((w) => w.state !== "done")) {
      lines.push("");
      const [head, summary] = workSummaryLines(work, fronts);
      lines.push(yellow(head));
      lines.push(summary);
      if (workExpanded) {
        for (const line of workDetailLines(work, fronts)) lines.push(dim(line));
      }
    }

    if (notes.length) {
      lines.push("");
      lines.push(dim(`  NOTES (${notes.length}) ${G.dot} ${bold("n")}${dim(" to browse and read them")}`));
      for (const note of notes.slice(-3)) {
        lines.push(dim(`  ${G.dot} ${truncate(note.title, w - 12)}`));
      }
    }

    lines.push(dim(G.h.repeat(w)));

    const room = Math.max(3, h - (lines.length + 3));
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

    lines.push(dim(G.h.repeat(w)));
    if (composer === "none") {
      const workHint = work.some((w) => w.state !== "done")
        ? ` ${G.dot} ${bold("w")}${dim(workExpanded ? " collapse work" : " expand work")}`
        : "";
      lines.push(
        dim(`  watching ${G.dot} ${bold("i")}${dim(" say")} ${G.dot} ${bold("n")}${dim(" notes")}${workHint} ${G.dot} ${bold("m")}${dim(" your name")} ${G.dot} ${bold("q")}${dim(" leave")}${status ? `  ${status}` : ""}`),
      );
    } else {
      const label = composer === "name" ? dim("your name: ") : "";
      lines.push(`${label}${bold(`${G.arrow} `)}${input}${dim("_")}${status ? `  ${dim(status)}` : ""}`);
    }
    paint(lines);
  }

  function renderNotes(): void {
    const w = width();
    const h = height();
    const lines = header(`${notes.length} note${notes.length === 1 ? "" : "s"} ${G.dot} ${dim("durable knowledge")}`);

    if (notes.length === 0) {
      lines.push("");
      lines.push(dim("  No notes yet. A front writes one with:"));
      lines.push(dim(`    parley note --title "..." --body "..." --tags a,b`));
    }

    const room = Math.max(3, h - 5);
    const first = Math.max(0, Math.min(selected - Math.floor(room / 2), notes.length - room));
    const window = notes.slice(Math.max(0, first), Math.max(0, first) + room);

    window.forEach((note, i) => {
      const index = Math.max(0, first) + i;
      const chosen = index === selected;
      const tags = note.tags.length ? dim(`  [${note.tags.join(", ")}]`) : "";
      const line = ` ${chosen ? G.sel : " "} ${truncate(note.title, w - 34)}${tags}`;
      const meta = dim(padVis("", 0) + `${note.authorName} ${G.dot} ${stamp(note.at)}`);
      lines.push(chosen ? invert(padVis(line, w)) : line);
      if (chosen) lines.push(`     ${meta}`);
    });

    while (lines.length < h - 1) lines.push("");
    lines.push(dim(G.h.repeat(w)));
    lines.push(
      dim(`  ${bold("j/k")}${dim(" or arrows move")} ${G.dot} ${bold("enter")}${dim(" read")} ${G.dot} ${bold("esc")}${dim(" back to the bus")}`),
    );
    paint(lines);
  }

  function renderReader(): void {
    const w = width();
    const h = height();
    const note = notes[selected];
    if (!note) { view = "notes"; return renderNotes(); }

    const lines = header(dim(`note ${selected + 1} of ${notes.length}`));
    const body = wrap(note.body || "(no body)", Math.min(w - 4, 96));
    const room = Math.max(3, h - 8);
    const maxScroll = Math.max(0, body.length - room);
    if (scroll > maxScroll) scroll = maxScroll;

    lines.push("");
    lines.push(`  ${bold(truncate(note.title, w - 4))}`);
    lines.push(dim(`  ${note.authorName} ${G.dot} ${stamp(note.at)}${note.tags.length ? `  [${note.tags.join(", ")}]` : ""}`));
    lines.push("");
    for (const line of body.slice(scroll, scroll + room)) lines.push(`  ${line}`);

    while (lines.length < h - 1) lines.push("");
    lines.push(dim(G.h.repeat(w)));
    const more = maxScroll > 0 ? ` ${G.dot} ${dim(`${scroll + 1}-${Math.min(scroll + room, body.length)} of ${body.length} lines`)}` : "";
    lines.push(
      dim(`  ${bold("j/k")}${dim(" scroll")} ${G.dot} ${bold("n/p")}${dim(" next / previous note")} ${G.dot} ${bold("esc")}${dim(" back")}${more}`),
    );
    paint(lines);
  }

  function render(): void {
    if (closing) return;
    if (view === "notes") return renderNotes();
    if (view === "reader") return renderReader();
    renderBus();
  }

  async function submit(kind: Composer, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (kind === "name") {
      const wanted = sanitiseName(trimmed);
      if (!wanted) { status = "that name has nothing usable in it"; return render(); }
      const r = await client.request({ op: "rename", name: wanted });
      if (r.ok) {
        myName = (r as unknown as { name: string }).name;
        writePanelConfig(repo.gitCommonDir, { ...readPanelConfig(repo.gitCommonDir), name: myName });
        status = `you are ${myName} from now on, here and next time`;
      } else {
        status = `could not rename: ${r.error.code}${"suggestion" in r.error ? ` (try ${String(r.error.suggestion)})` : ""}`;
      }
      return render();
    }

    // Voice only. A human does not grant, deny or arbitrate from here.
    const directed = /^@(\S+)\s+([\s\S]+)$/.exec(trimmed);
    const r = await client.request(
      directed ? { op: "say", to: directed[1], text: directed[2] } : { op: "say", text: trimmed },
    );
    if (r.ok) {
      const sent = (r as unknown as { event?: FeedEvent }).event;
      if (sent) feed.push(sent);
      status = "";
    } else {
      status = `not sent: ${r.error.code}`;
    }
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

  function onKey(ch: string, code: number, seq: string): boolean {
    // Arrow keys arrive as an escape sequence, so they are matched whole.
    const up = seq === `${ESC}A`;
    const down = seq === `${ESC}B`;

    if (view === "reader") {
      if (down || ch === "j") { scroll++; return true; }
      if (up || ch === "k") { scroll = Math.max(0, scroll - 1); return true; }
      if (ch === "n") { selected = Math.min(notes.length - 1, selected + 1); scroll = 0; return true; }
      if (ch === "p") { selected = Math.max(0, selected - 1); scroll = 0; return true; }
      if (code === 27 && seq === "\x1b") { view = "notes"; return true; }
      if (ch === "q") { view = "notes"; return true; }
      return false;
    }

    if (view === "notes") {
      if (down || ch === "j") { selected = Math.min(notes.length - 1, selected + 1); return true; }
      if (up || ch === "k") { selected = Math.max(0, selected - 1); return true; }
      if (code === 13 || code === 10) { if (notes.length) { view = "reader"; scroll = 0; } return true; }
      if (code === 27 && seq === "\x1b") { view = "bus"; return true; }
      if (ch === "q") { view = "bus"; return true; }
      return false;
    }

    if (composer === "none") {
      if (ch === "i" || ch === "I") { composer = "say"; input = ""; status = ""; return true; }
      if (ch === "m" || ch === "M") { composer = "name"; input = ""; status = ""; return true; }
      if (ch === "n" || ch === "N") { view = "notes"; selected = Math.max(0, notes.length - 1); return true; }
      if (ch === "w" || ch === "W") { workExpanded = !workExpanded; return true; }
      if (ch === "q" || ch === "Q") { shutdown(); return false; }
      return false;
    }

    if (code === 27) { composer = "none"; input = ""; return true; }
    if (code === 13 || code === 10) {
      const text = input;
      const kind = composer;
      input = "";
      composer = "none";
      void submit(kind, text);
      return true;
    }
    if (code === 127 || code === 8) { input = input.slice(0, -1); return true; }
    if (code === 21) { input = ""; return true; }
    if (code < 32) return false;
    input += ch;
    return true;
  }

  // Alternate screen buffer, so quitting gives the user their scrollback back.
  process.stdout.write(`${ESC}?1049h${ESC}?25l`);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.on("resize", render);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      // Ctrl+C and Ctrl+D end the panel from any screen.
      if (chunk.includes("\x03") || chunk.includes("\x04")) return void shutdown();
      let dirty = false;
      if (chunk.startsWith(ESC) && chunk.length > 1) {
        dirty = onKey("", 27, chunk);
      } else {
        for (const ch of chunk) dirty = onKey(ch, ch.charCodeAt(0), ch) || dirty;
      }
      if (dirty) render();
    });
  }

  const timer = setInterval(() => void refresh(), 1000);
  await seed();
  await refresh();
}
