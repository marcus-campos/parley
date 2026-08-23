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

/** `src/path/file.ts:12` and `src/path/file.ts:12-34`, in backticks. */
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

  // Sorted so the ledger is a function of content alone, never of walk order.
  return out.sort((a, b) => a.page.localeCompare(b.page) || a.file.localeCompare(b.file) || a.text.localeCompare(b.text));
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

if (import.meta.main) {
  // Render first, write second: a run that throws leaves the ledger alone
  // rather than truncating the only record of what the pages used to cite.
  const text = renderLedger(collectCitations());
  if (process.argv.includes("--write")) writeFileSync(LEDGER_PATH, text);
  else process.stdout.write(text);
}
