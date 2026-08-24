#!/usr/bin/env bun
//
// Builds tests/docs/citations.pinned — the ledger of what every `src/…:NN`
// citation on the site actually points at.
//
// WHY A LEDGER AND NOT A LINE-NUMBER CHECK.
//
// The first version of this guard (tests/docs/site-build.test.ts) asserted
// `Number(to ?? from) <= lines`: the cited line has to exist. That is a claim
// about the file being long enough, and a citation is not a claim about
// length — it is a claim about *content*. The two come apart the moment a file
// grows. Adding 49 lines to `src/cli/main.ts` moved seven citations onto
// unrelated code — one of them onto a blank line, five onto help text about
// the work pool — and every one still pointed at a line that existed, so the
// guard stayed green while the site sent readers to the wrong place.
//
// So the pinned thing is the cited *text*, never the line number. That choice
// is what makes the guard usable rather than merely loud:
//
//   - code moves and the citation is corrected → the text at the new numbers
//     is the same text → the ledger does not change and nothing has to be
//     re-blessed;
//   - code moves and the citation is NOT corrected → the text at the old
//     numbers is different → red, and because the ledger still holds the old
//     text this script can find it again and name the line it moved to;
//   - the cited code is genuinely rewritten → red, and re-pinning is the
//     correct response *after* re-reading the sentence that cites it. The diff
//     shows the old and new text side by side, which is the whole point: a
//     re-pin nobody can read is a re-pin nobody checked.
//
// WHAT THIS CANNOT SEE. Three classes, and the third is the one that gets
// read as covered when it is not.
//
//   1. Whether a citation *supports* the sentence citing it. The ledger only
//      says the citation still points at what it pointed at when a human
//      checked. Write-time correctness is human and stays human.
//   2. A citation added to a page that carries none. The per-page floor in
//      tests/docs/citations.test.ts is the guard for that, not this file.
//   3. **Anything outside the cited window.** The ledger pins the bytes
//      between `from` and `to` and nothing else, so a change one line above a
//      cited range is invisible here however completely it inverts what the
//      page claims. Proven with a one-character edit at src/state/work.ts:207
//      (`&&` → `||`, same line count, outside all eighteen ranges cited on
//      that file): 67 docs tests pass, ledger byte-identical. What went red
//      was tests/state, 2 failures — so for *tested* behaviour the product
//      suite is the backstop, and it is a good one.
//
//      The residual is the untested case, and its purest form is already
//      published. `docs/concepts/shapes.md:54` and
//      `docs/concepts/work-pool.md:88` quote `src/state/work.ts:11-15` and
//      `186-191`, which are **comments**. A comment never executes and is
//      never tested, so this ledger pins prose that the implementation can
//      drift away from with nothing anywhere going red. That is not
//      hypothetical on this repository. This branch's own homepage promised
//      that an unreachable daemon "degrades to advisory and says so"; the
//      path that runs while you edit is `src/adapters/hook.ts:92`, which is
//      `return emit({})` — it lets the edit through and says nothing. True of
//      the CLI, false of the hook, and the page said it flat. Fixed at
//      `docs/index.md:22`, which now separates the two.
//
//      (An earlier version of this note named `src/hook.ts` line 89 as the
//      comment that lies. There is no such file — it is `src/adapters/hook.ts`
//      — and the line 89 it meant is a comment that is **right**. A header
//      arguing that prose drifts, sending the reader to a path that does not
//      exist, on a branch whose thesis is "cite the line so the reader can
//      check". `tests/docs/citations.test.ts` now resolves every `src/…:NN`
//      this file writes, so the header is held to the rule it states.)
//
//      Do not read a green ledger as "the pages are right". Read it as "the
//      pages still point where a human once looked".
//
// Run `bun run docs:citations` to re-pin. Nothing here may depend on the
// clock, the environment or filesystem order — the test regenerates and
// compares, so an unstable ledger would turn unrelated work red.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DOCS = join(ROOT, "docs");

/** The ledger this generator owns. */
export const LEDGER_PATH = join(ROOT, "tests", "docs", "citations.pinned");

/**
 * `src/state/work.ts:11` and `src/state/work.ts:11-15`, in backticks.
 *
 * Real paths on purpose: `tests/docs/citations.test.ts` resolves every
 * citation-shaped token in this file, including the ones in its own comments,
 * and an illustrative `src/path/file.ts` would have to be excused from that.
 */
export const CITATION = /`(src\/[A-Za-z0-9_./-]+\.ts):(\d+)(?:-(\d+))?`/g;

export type Citation = {
  /** Repo-relative path of the page doing the citing. */
  page: string;
  /** Repo-relative path of the source file cited. */
  file: string;
  from: number;
  to: number;
  /** The cited lines, trailing whitespace stripped, joined with \n. */
  text: string;
};

/**
 * Every markdown file the site publishes, matching `srcExclude` in
 * docs/.vitepress/config.ts. A new page with citations is covered the day it
 * lands, without anybody remembering to add it to a list.
 */
export function sitePages(dir = DOCS, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "superpowers" || entry.name === ".vitepress") continue;
      sitePages(full, found);
    } else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
      found.push(`docs/${relative(DOCS, full).split(sep).join("/")}`);
    }
  }
  return found;
}

/** Trailing whitespace is not content; a reformat should not read as a rewrite. */
const normalise = (lines: string[]): string => lines.map((l) => l.replace(/\s+$/, "")).join("\n");

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * Reads every citation on the site and resolves it against the source tree.
 * Throws on a citation that cannot be resolved at all — a missing file or a
 * line past the end — because those are the cases with no text to pin.
 *
 * Raw markdown, deliberately: this reads what is on disk and never expands
 * `<!--@include: ../../README.md#region-->`. Latent today, because the five
 * included README regions carry no `src/…:NN` citations at all — but a
 * citation written inside one would render on the site and be invisible here.
 * If that day comes, expand the includes; do not add the citation to the page
 * twice to make it visible.
 */
export function collectCitations(root = ROOT): Citation[] {
  const sources = new Map<string, string[]>();
  const out: Citation[] = [];

  for (const page of sitePages(join(root, "docs"))) {
    const text = readFileSync(join(root, page), "utf8");
    for (const m of text.matchAll(CITATION)) {
      const [, file, fromRaw, toRaw] = m;
      let lines = sources.get(file!);
      if (!lines) {
        let raw: string;
        try {
          raw = readFileSync(join(root, file!), "utf8");
        } catch {
          throw new Error(`${page} cites \`${file}\`, which does not exist.`);
        }
        lines = raw.split("\n");
        sources.set(file!, lines);
      }
      const from = Number(fromRaw);
      const to = Number(toRaw ?? fromRaw);
      if (from < 1 || to < from || to > lines.length) {
        throw new Error(
          `${page} cites \`${file}:${fromRaw}${toRaw ? `-${toRaw}` : ""}\` but that file has ` +
            `${lines.length} lines. A citation nobody can open is decoration.`,
        );
      }
      out.push({ page, file: file!, from, to, text: normalise(lines.slice(from - 1, to)) });
    }
  }

  // Grouped by page, and inside a page kept in the order the citations appear
  // in it. `sitePages` sorts, and `matchAll` walks a page top to bottom, so
  // this is still a function of content alone and never of filesystem order.
  //
  // Ordering by the cited *text* was the obvious choice and it was wrong. It
  // made the ledger blind to a transposition: swap which lines two citations
  // on one page point at and every (page, file) bucket holds the same blocks,
  // so the ledger comes out byte-identical while both citations now send the
  // reader to the other one's evidence. Appearance order pairs each block with
  // its position on the page, which is the thing that changed.
  return out.map((c, i) => ({ c, i })).sort((a, b) => a.c.page.localeCompare(b.c.page) || a.i - b.i).map(({ c }) => c);
}

const HEADER = [
  "# generated by scripts/gen-citations.ts — run `bun run docs:citations`",
  "#",
  "# What every `src/…:NN` citation on the site points at. Line numbers are",
  "# deliberately NOT pinned: a citation corrected after the code moved pins the",
  "# same text and changes nothing here. A citation left behind when the code",
  "# moved does change it, and that is the failure this ledger exists to show.",
  "#",
  "# Read a diff here as a question about the sentence doing the citing, not as",
  "# a chore. If the text under a page changed, go and re-read that page.",
  "#",
  "# Entries are grouped by page and kept in the order the citations appear on",
  "# it, so two citations swapping which lines they point at moves blocks here.",
];

/** `@ page file` followed by the cited lines, each prefixed `|`. */
export function renderLedger(citations: Citation[]): string {
  const out = [...HEADER, ""];
  for (const c of citations) {
    out.push(`@ ${c.page} ${c.file} ${digest(c.text)}`);
    for (const line of c.text.split("\n")) out.push(line ? `| ${line}` : "|");
  }
  return `${out.join("\n")}\n`;
}

export function parseLedger(text: string): { page: string; file: string; text: string }[] {
  const out: { page: string; file: string; text: string }[] = [];
  let current: { page: string; file: string; lines: string[] } | null = null;
  const flush = () => {
    if (current) out.push({ page: current.page, file: current.file, text: current.lines.join("\n") });
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("#") || line === "") continue;
    if (line.startsWith("@ ")) {
      flush();
      const [page, file] = line.slice(2).split(" ");
      current = { page: page!, file: file!, lines: [] };
    } else if (line.startsWith("|")) {
      current?.lines.push(line === "|" ? "" : line.slice(2));
    }
  }
  flush();
  return out;
}

/**
 * Where a pinned block sits in the file now, 1-based, or null if it is gone.
 * This is what turns "something changed" into "your citation is 45 lines
 * behind; the code you meant is at 165-171".
 */
export function locate(sourceLines: string[], text: string): { from: number; to: number } | null {
  const want = text.split("\n");
  for (let i = 0; i + want.length <= sourceLines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (sourceLines[i + j]!.replace(/\s+$/, "") !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return { from: i + 1, to: i + want.length };
  }
  return null;
}

/** One thing a re-pin would do to the ledger, in the shape a person can check. */
export interface LedgerChange {
  /** `changed` is the only kind that needs a sentence re-read. */
  kind: "changed" | "added" | "dropped" | "reordered";
  page: string;
  /** Empty for `reordered`, which is a property of the page, not of one file. */
  file: string;
  was?: string;
  now?: string;
}

const WIDTH = 96;
const clip = (line: string): string => (line.length > WIDTH ? `${line.slice(0, WIDTH - 1)}…` : line);

/** First line with something on it — what a person recognises a block by. */
const head = (text: string): string => clip((text.split("\n").find((l) => l.trim()) ?? "(blank)").trim());

/**
 * The first line that is actually different, not the first line there is.
 *
 * Printing the head of both sides reads as `was | } catch (e) {` /
 * `now | } catch (e) {` whenever the edit is anywhere below the first line,
 * which is most edits. A report that shows two identical lines is worse than
 * no report: it looks like it checked.
 */
export function firstDifference(was: string, now: string): { at: number; of: number; was: string; now: string } {
  const a = was.split("\n");
  const b = now.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? "") === (b[i] ?? "")) continue;
    if (a[i] === undefined) return { at: i + 1, of: a.length, was: "(nothing — the block got longer)", now: clip(b[i]!.trim()) };
    if (b[i] === undefined) return { at: i + 1, of: a.length, was: clip(a[i]!.trim()), now: "(nothing — the block got shorter)" };
    return { at: i + 1, of: a.length, ...sideBySide(a[i]!, b[i]!) };
  }
  return { at: 1, of: a.length, was: head(was), now: head(now) };
}

/** Spaces and tabs, made visible. A gap is not a difference a reader can see. */
const showSpace = (line: string): string => line.replace(/ /g, "·").replace(/\t/g, "→");

/** Whether a rendered pair is leaning on `·`/`→`, and so needs the key. */
const usesSpaceMarks = (was: string, now: string): boolean => /[·→]/.test(was + now);

/**
 * The two lines, shown so that what differs about them is on the screen.
 *
 * `9fce699` fixed the report pointing at the wrong *line*; both of the
 * operations that used to render it could still erase the difference on the
 * right one, printing the two identical lines that commit exists to end:
 *
 *   - `.trim()` erases a difference that IS the leading whitespace, and
 *     re-indentation is among the commonest ways cited code changes — a block
 *     moved into a new `if`/`try`, a `case` wrapped in braces, a formatter
 *     pass. (`normalise` strips *trailing* whitespace before pinning, so a
 *     trailing-only edit never reaches the ledger at all. Leading does.)
 *   - clipping from the head hides any difference past column 95.
 *
 * So: trim only when trimming changes nothing that matters, and window both
 * sides identically around the first column that actually differs.
 */
export function sideBySide(was: string, now: string): { was: string; now: string } {
  // Whitespace-only *anywhere*, not merely leading. The predicate was
  // `was.trim() === now.trim()`, which caught a block moved into a `try` and
  // missed `const a\t= 1;` against `const a = 1;` — trimmed, those differ, so
  // the pair took the ordinary path and printed two lines that are identical
  // on any terminal that renders a tab as spaces. That is this function's own
  // failure mode, one column to the right of where it was fixed. Unreachable
  // on this tree today (no tab appears anywhere in src/ or scripts/) and the
  // weaker reachable form is a collapsed double space, legible only by length.
  // "Nobody has typed a tab" is not a property of the code.
  //
  // When the difference IS whitespace, every space is a candidate, so all of
  // it is shown rather than the indent alone: a reader cannot tell which gap
  // moved from a rendering that reveals only some of them.
  const whitespaceOnly = was.replace(/\s/g, "") === now.replace(/\s/g, "");
  const a = whitespaceOnly ? showSpace(was) : was.trim();
  const b = whitespaceOnly ? showSpace(now) : now.trim();
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  // One start for both sides, or the two lines stop being comparable by eye.
  const start = at < WIDTH - 1 ? 0 : Math.max(0, Math.min(at - 24, Math.max(a.length, b.length) - WIDTH + 2));
  const cut = (s: string): string => {
    const lead = start > 0 ? "…" : "";
    const body = s.slice(start, start + WIDTH - lead.length - 1);
    return `${lead}${body}${start + body.length < s.length ? "…" : ""}`;
  };
  return { was: cut(a), now: cut(b) };
}

/**
 * What re-pinning would do, compared against the ledger already on disk.
 *
 * Bucketed by (page, source file) and compared as multisets, the same way the
 * test does it, so a block that merely moved inside its file is not reported —
 * the ledger pins text, and that text did not change.
 *
 * `reordered` is the exception, and it is the one case the multisets cannot
 * see: two citations on one page swapping which lines they point at leaves
 * every bucket identical while sending both readers to the other one's
 * evidence.
 */
export function diffLedger(
  before: { page: string; file: string; text: string }[],
  after: { page: string; file: string; text: string }[],
): LedgerChange[] {
  const changes: LedgerChange[] = [];
  const bucket = (list: { page: string; file: string; text: string }[]) => {
    const m = new Map<string, string[]>();
    for (const c of list) m.set(`${c.page} ${c.file}`, [...(m.get(`${c.page} ${c.file}`) ?? []), c.text]);
    return m;
  };
  const was = bucket(before);
  const now = bucket(after);

  for (const k of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const gone = [...(was.get(k) ?? [])];
    const fresh = [...(now.get(k) ?? [])];
    for (const t of [...fresh]) {
      const i = gone.indexOf(t);
      if (i < 0) continue;
      gone.splice(i, 1);
      fresh.splice(fresh.indexOf(t), 1);
    }
    const [page = "", file = ""] = k.split(" ");
    const paired = Math.min(gone.length, fresh.length);
    for (let i = 0; i < paired; i++) changes.push({ kind: "changed", page, file, was: gone[i], now: fresh[i] });
    for (const t of gone.slice(paired)) changes.push({ kind: "dropped", page, file, was: t });
    for (const t of fresh.slice(paired)) changes.push({ kind: "added", page, file, now: t });
  }

  const perPage = (list: { page: string; file: string; text: string }[]) => {
    const m = new Map<string, string[]>();
    for (const c of list) m.set(c.page, [...(m.get(c.page) ?? []), `${c.file} ${digest(c.text)}`]);
    return m;
  };
  const seqWas = perPage(before);
  const seqNow = perPage(after);
  for (const page of [...new Set([...seqWas.keys(), ...seqNow.keys()])].sort()) {
    const a = seqWas.get(page) ?? [];
    const b = seqNow.get(page) ?? [];
    if (a.join("\n") === b.join("\n")) continue;
    // Only a *pure* permutation is reported here. When entries were added or
    // dropped the order shifts for a reason already on the report above, and
    // gating that would fire on every ordinary docs edit.
    if ([...a].sort().join("\n") !== [...b].sort().join("\n")) continue;
    changes.push({ kind: "reordered", page, file: "" });
  }

  return changes;
}

/**
 * The report `docs:citations` prints before it writes anything.
 *
 * This exists because of a real mistake, made by the author of the ledger, an
 * hour after building it: help text was edited, six citations went stale,
 * `docs:citations` was run reflexively, and the suite went green over six
 * wrong citations. It was caught by `git diff --stat` — that is, by a second
 * command nobody is obliged to run. The generator itself said nothing.
 *
 * A re-pin lands in a reviewable diff, but a diff only pushes back if somebody
 * volunteers to read it, and the person most likely not to is the one who just
 * re-pinned by reflex. So the pushback goes here, at the moment of the
 * mistake, in the same terminal.
 */
export function describeChanges(changes: LedgerChange[]): string {
  if (changes.length === 0) return "";
  const of = (kind: LedgerChange["kind"]) => changes.filter((c) => c.kind === kind);
  const lines: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const counts: string[] = [];
  if (of("changed").length > 0) counts.push(`re-pinned ${plural(of("changed").length, "entry", "entries")}`);
  if (of("added").length > 0) counts.push(`added ${plural(of("added").length, "entry", "entries")}`);
  if (of("dropped").length > 0) counts.push(`dropped ${plural(of("dropped").length, "entry", "entries")}`);
  if (of("reordered").length > 0) counts.push(`reordered ${plural(of("reordered").length, "page", "pages")}`);
  lines.push(`docs:citations — ${counts.join(", ")}`);

  if (of("changed").length > 0) {
    lines.push("");
    lines.push("re-pinned — the code under these citations was rewritten. Each one is a");
    lines.push("question about the sentence that cites it, not a chore:");
    let marked = false;
    for (const c of of("changed")) {
      const d = firstDifference(c.was!, c.now!);
      marked ||= usesSpaceMarks(d.was, d.now);
      lines.push(`  ${c.page} → ${c.file}  (first change at line ${d.at} of ${d.of})`);
      lines.push(`    was | ${d.was}`);
      lines.push(`    now | ${d.now}`);
    }
    // Only when a pair actually leans on them. Obvious in the pair, not obvious
    // to somebody skimming one line of a re-pin report — and a legend printed
    // over every report nobody needed it for is how legends stop being read.
    if (marked) lines.push("  (· is a space and → a tab, shown because the difference is the whitespace)");
  }
  for (const c of of("reordered")) {
    lines.push("");
    lines.push(`reordered — ${c.page} pins the same blocks in a different order, with nothing`);
    lines.push("added or dropped. That is two citations on the page swapping which lines they");
    lines.push("point at: both still resolve, both now send the reader to the other one's");
    lines.push("evidence, and no bucket in the ledger changes. Open the page.");
  }
  const light = [...of("added"), ...of("dropped")];
  if (light.length > 0) {
    lines.push("");
    for (const c of light) {
      lines.push(`  ${c.kind === "added" ? "+" : "-"} ${c.page} → ${c.file}  ${head((c.now ?? c.was)!)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Changes that must be typed for, rather than happening because a command was run. */
export const needsAcceptance = (changes: LedgerChange[]): LedgerChange[] =>
  changes.filter((c) => c.kind === "changed" || c.kind === "reordered");

if (import.meta.main) {
  // Render first, write second: a run that throws leaves the ledger alone
  // rather than truncating the only record of what the pages used to cite.
  const current = collectCitations();
  const text = renderLedger(current);

  let changes: LedgerChange[] = [];
  try {
    changes = diffLedger(parseLedger(readFileSync(LEDGER_PATH, "utf8")), current);
  } catch {
    // No ledger yet — the first run pins everything and there is nothing to
    // compare against. Reporting 95 additions would be noise, not a signal.
  }
  if (changes.length > 0) process.stderr.write(describeChanges(changes));

  if (!process.argv.includes("--write")) {
    process.stdout.write(text);
  } else if (needsAcceptance(changes).length > 0 && !process.argv.includes("--accept-changes")) {
    // Adding and dropping citations is free. Changing what an existing one
    // pins is the case where a person has to have read something, so it is the
    // case that has to be typed rather than merely run.
    process.stderr.write(
      "\nNothing was written. If every line above is a rewrite you have opened the citing\n" +
        "page for, re-run:  bun run scripts/gen-citations.ts --write --accept-changes\n",
    );
    process.exit(1);
  } else {
    writeFileSync(LEDGER_PATH, text);
  }
}

