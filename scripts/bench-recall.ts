#!/usr/bin/env bun
//
// Re-measures every number in the model listing, against a real daemon.
//
// WHY THIS EXISTS. `src/brain/registry.ts` carries a score for each model, and
// that score is the only claim the listing makes — somebody reads it and spends
// two hundred megabytes of their own disk on it. Until this script existed the
// numbers were reproducible only by whoever measured them, which is the same
// standing as an adjective.
//
// WHAT IT MEASURES. The product, not the model. It writes the benchmark notes
// over the socket, enables a model, waits for the background embedding to
// finish, and asks the questions the way an agent asks them. Everything in the
// path is included: the relevance floor, the fusion with the lexical channel,
// the top-k slice. Scoring a model on cosine similarity alone gives a different
// and better number — that mistake shipped once, and it was wrong by two.
//
// Two question families, and both are load-bearing:
//
//   paraphrase  — a question sharing almost no vocabulary with the note that
//                 answers it. This is what a model is for; the lexical floor
//                 scores 24 of 100.
//   exact term  — an identifier or phrase that appears in exactly one note.
//                 This is what the lexical floor is for, and it scores 92 of
//                 92. It is here to catch a change that improves paraphrase by
//                 quietly breaking symbol search.
//
// Tuning on either family alone produces a confident wrong answer. Measured on
// the paraphrase set by itself, the right vector weight looks like "turn the
// lexical channel off".
//
// USAGE
//   bun run scripts/bench-recall.ts                  every registry model
//   bun run scripts/bench-recall.ts <name> [<name>]  only these
//   bun run scripts/bench-recall.ts --none           the lexical floor alone
//
// It downloads models and takes minutes per entry, which is why it is a script
// somebody runs and not a test everybody pays for. `tests/brain/benchmark.test.ts`
// guards the corpus itself, cheaply, on every run.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS } from "../src/brain/registry";

interface Benchmark {
  notes: { lang: "pt" | "en"; q: string; title: string; body: string; paths: string; term: string }[];
  exactTerms: { query: string; answers: number }[];
}

const ROOT = join(import.meta.dir, "..");
const BENCH: Benchmark = JSON.parse(
  readFileSync(join(ROOT, "tests", "brain", "fixtures", "recall-benchmark.json"), "utf8"),
);
const CLI = join(ROOT, "dist", "parley");

/** Title prefix long enough to identify a note in one line of output. */
const IDENT = 34;

function parley(repo: string, args: string[]): string {
  const r = spawnSync(CLI, args, { cwd: repo, encoding: "utf8", env: { ...process.env } });
  return r.stdout ?? "";
}

/** A throwaway repository with its own bus, so nothing here touches a real one. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "parley-bench-"));
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function loadNotes(repo: string): void {
  parley(repo, ["join", "--as", "BENCH", "--mission", "measuring recall"]);
  for (const n of BENCH.notes) {
    parley(repo, ["note", "--title", n.title, "--body", n.body, "--paths", n.paths]);
  }
}

/**
 * Wait for the encoder to finish embedding, because a model measured halfway
 * through its own backfill scores as a worse model rather than as an unfinished
 * one. Static models are synchronous and this returns immediately.
 */
async function awaitVectors(repo: string, want: number): Promise<boolean> {
  const dir = JSON.parse(parley(repo, ["doctor", "--json"]) || "{}").state_dir as string | undefined;
  if (!dir) return false;
  const path = join(dir, "vectors.json");
  for (let i = 0; i < 180; i++) {
    try {
      if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).entries.length >= want) return true;
    } catch { /* being written right now */ }
    await Bun.sleep(2_000);
  }
  return false;
}

function score(repo: string): { paraphrase: number; pt: number; exact: number } {
  const top = (q: string): string => {
    const lines = parley(repo, ["notes", "--query", q, "--k", "1"]).split("\n");
    return lines.find((l) => l.trim().startsWith("n_")) ?? "";
  };
  let paraphrase = 0, pt = 0, exact = 0;
  for (const n of BENCH.notes) {
    if (!top(n.q).includes(n.title.slice(0, IDENT))) continue;
    paraphrase++;
    if (n.lang === "pt") pt++;
  }
  for (const e of BENCH.exactTerms) {
    if (top(e.query).includes(BENCH.notes[e.answers]!.title.slice(0, IDENT))) exact++;
  }
  return { paraphrase, pt, exact };
}

async function measure(name: string | null): Promise<void> {
  const repo = freshRepo();
  try {
    loadNotes(repo);
    if (name) {
      const out = parley(repo, ["brain", "enable", name, "--human"]);
      if (!out.includes("enabled")) {
        console.log(`${name.padEnd(24)}  could not be enabled — skipped`);
        return;
      }
      if (!(await awaitVectors(repo, BENCH.notes.length))) {
        console.log(`${name.padEnd(24)}  embedding did not finish — skipped`);
        return;
      }
    }
    const s = score(repo);
    const label = name ?? "no model at all";
    console.log(
      `${label.padEnd(24)}  ${String(s.paraphrase).padStart(3)}/${BENCH.notes.length} paraphrase` +
      `  ${String(s.pt).padStart(3)} pt` +
      `  ${String(s.exact).padStart(3)}/${BENCH.exactTerms.length} exact term`,
    );
  } finally {
    parley(repo, ["stop"]);
  }
}

if (!existsSync(CLI)) {
  console.error("build the binary first:  bun run build");
  process.exit(1);
}

const args = process.argv.slice(2);
mkdirSync(join(ROOT, "dist"), { recursive: true });

console.log(
  `${BENCH.notes.length} notes, ${BENCH.notes.length} paraphrase questions, ` +
  `${BENCH.exactTerms.length} exact-term questions — through a real daemon\n`,
);

await measure(null);
if (!args.includes("--none")) {
  const wanted = args.filter((a) => !a.startsWith("--"));
  for (const m of MODELS) {
    if (wanted.length && !wanted.includes(m.name)) continue;
    await measure(m.name);
  }
}
