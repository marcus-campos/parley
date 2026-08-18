import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Note } from "../state/types";

/**
 * Notes are exported to `.parley/notes.md`, versioned in git: they cross
 * machines, reach a colleague, and outlive the project. This is the part of the
 * old markdown board that was worth keeping.
 *
 * No automatic commit. A human or an agent commits it, on purpose.
 */
export function exportNotes(notes: Note[], repoRoot: string): string {
  const dir = join(repoRoot, ".parley");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "notes.md");

  const body = notes.length
    ? notes
        .map((n) => {
          const meta: string[] = [];
          if (n.tags.length) meta.push(`**Tags:** ${n.tags.map((t) => `\`${t}\``).join(", ")}`);
          if (n.paths.length) meta.push(`**Paths:** ${n.paths.map((t) => `\`${t}\``).join(", ")}`);
          const head = n.kind === "decision"
            ? `## ${n.reversedBy ? "[reversed] " : "[decision] "}${n.title}`
            : `## ${n.title}`;
          const block = meta.length ? `\n\n${meta.join("  ")}` : "";
          return `${head}\n\n_${n.authorName} · ${n.at}_${block}\n\n${n.body}`.trimEnd();
        })
        .join("\n\n---\n\n")
    : "_No notes yet._";

  writeFileSync(
    path,
    `# parley notes\n\nDurable knowledge for every front working in this repository, present and\nfuture, including sessions that do not exist yet.\n\nWritten by parley whenever a note is added, and by \`parley notes --export\`.\nDo not edit by hand — write through \`parley note\`, or your change is lost on\nthe next one. \`parley notes --import\` reads this file back onto the bus, which\nis how a fresh clone picks up what the team already knows.\n\nCommitting this file is a decision you make: parley never commits.\n\n---\n\n${body}\n`,
    "utf8",
  );
  return path;
}

export interface ImportedNote {
  title: string;
  body: string;
  tags: string[];
  paths: string[];
  kind: "note" | "decision";
}

/**
 * Read `.parley/notes.md` back.
 *
 * The export was one-way, which made the versioned file a dead end: a fresh
 * clone, or a daemon whose state was lost, could see the team's knowledge in
 * git and had no way to put it back on the bus. This closes that loop.
 */
export function parseNotes(markdown: string): ImportedNote[] {
  const notes: ImportedNote[] = [];
  // Sections start at a level-2 heading; everything before the first one is the
  // generated preamble.
  const sections = markdown.split(/^## /m).slice(1);

  for (const section of sections) {
    const lines = section.split("\n");
    let title = (lines.shift() ?? "").trim();
    if (!title) continue;

    let kind: "note" | "decision" = "note";
    if (title.startsWith("[decision] ")) { kind = "decision"; title = title.slice(11); }
    else if (title.startsWith("[reversed] ")) { kind = "decision"; title = title.slice(11); }

    let paths: string[] = [];
    let tags: string[] = [];
    const bodyLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "---") break;             // separator between notes
      if (/^_.*_$/.test(trimmed)) continue;     // the author/date byline
      const tagLine = /^\*\*Tags:\*\*\s*(.+?)(?:\s{2,}\*\*Paths:\*\*\s*(.+))?$/.exec(trimmed);
      if (tagLine) {
        tags = tagLine[1]!.split(",").map((t) => t.replace(/`/g, "").trim()).filter(Boolean);
        if (tagLine[2]) paths = tagLine[2].split(",").map((t) => t.replace(/`/g, "").trim()).filter(Boolean);
        continue;
      }
      const pathLine = /^\*\*Paths:\*\*\s*(.+)$/.exec(trimmed);
      if (pathLine) {
        paths = pathLine[1]!.split(",").map((t) => t.replace(/`/g, "").trim()).filter(Boolean);
        continue;
      }
      bodyLines.push(line);
    }
    notes.push({ title, body: bodyLines.join("\n").trim(), tags, paths, kind });
  }
  return notes;
}

export function readExportedNotes(repoRoot: string): ImportedNote[] {
  const path = join(repoRoot, ".parley", "notes.md");
  if (!existsSync(path)) return [];
  return parseNotes(readFileSync(path, "utf8"));
}
