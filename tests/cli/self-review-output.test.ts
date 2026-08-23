import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParleyDaemon } from "../../src/daemon/server";

/**
 * The first test in this repository that reads what the CLI actually prints.
 *
 * It exists for one line and no other: the self-review disclosure. Asserting
 * on stdout elsewhere would pin formatting nobody promised — but this line is
 * a claim about honesty rather than a convenience pointer, and `take` does not
 * refuse a self-review, so the printed fact IS the enforcement. A line that
 * must not silently disappear is worth the harness.
 *
 * It is deliberately not a substring test on the wording. Both cases run the
 * same command over items shaped identically, the item-specific tokens are
 * masked, and the assertion is that the two outputs still DIFFER — so
 * rewording the disclosure keeps this green and deleting it turns it red.
 * `skill-plan.test.ts`'s prose-substring weakness relocated to stdout would
 * have been the easy version of this file and worth nothing.
 *
 * A real `git init`, because `parley` finds its bus through
 * `git rev-parse --git-common-dir`, and a real daemon on a real unix socket,
 * because `endpoint.json` is how a fresh CLI process finds it. Every command
 * below is a separate process, which is what a plan driven from hooks or a
 * shell actually is.
 */
const MAIN = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

let repo: string;
let sockDir: string;
let daemon: ParleyDaemon;

/**
 * One `parley` invocation: its own process, its own session, its own name.
 *
 * Asynchronous, and not for tidiness: the daemon runs in THIS process, so
 * `Bun.spawnSync` blocks the event loop that has to answer the socket, and
 * every command times out instead of returning.
 */
async function cli(front: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["bun", MAIN, ...args, "--as", front], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    // Identity is keyed on the session, never the name (see `join`): without a
    // distinct session per front, every invocation here would reattach to the
    // same participant and there would be exactly one front in the repository.
    env: { ...process.env, PARLEY_SESSION: `session-${front}`, PARLEY_NAME: front },
  });
  const [out, error] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  await p.exited;
  return `${out}${error}`;
}

function json<T>(text: string): T {
  return JSON.parse(text.trim().split("\n").pop() ?? "{}") as T;
}

interface Row { id: string; kind: string; state: string; publishedById: string; takenById: string | null }
const works = async (front: string, ...args: string[]): Promise<Row[]> =>
  json<{ work: Row[] }>(await cli(front, "works", ...args, "--json")).work;

/** One task per entry, one path each, no two colliding: one wave, N items. */
const PLAN_PATHS = ["a", "b", "c", "d"] as const;

/**
 * Everything that identifies WHICH item this is. What survives is the shape of
 * the output — the only thing the cases below are allowed to differ in.
 */
// `w_[0-9a-z]+`, not `w_\d+`: `makeCtx` numbers items in base 36, so the tenth
// item of a run is `w_000a` and a digits-only mask leaves a stray letter behind
// that reads as a difference between two otherwise identical rows.
//
// The path half is BUILT from the fixture rather than written out as a range:
// a literal `[a-d]` silently stops masking the moment the fixture grows a
// fifth path, and an unmasked path is exactly the kind of incidental
// difference these assertions must not see.
const pathMask = new RegExp(PLAN_PATHS.map((p) => `${p}\\.ts`).join("|"), "g");
const mask = (s: string) => s.replace(/w_[0-9a-z]+/g, "<id>").replace(pathMask, "<path>");

/**
 * Which front closes each review out. Two of the four are taken by the front
 * that wrote the work and two are not, which is the whole point of the
 * fixture — and it is declared here, once, so the last test does not have to
 * inherit it from whether the tests before it happened to run.
 */
const REVIEWER_OF = ["WORKER", "COORD", "WORKER", "COORD"] as const;

/** The four reviews WORKER's four finished tasks produced, in creation order. */
let reviews: Row[] = [];

/**
 * Drive one review to `done` in the hands of a named front, from whatever
 * state it is currently in.
 *
 * Every test in this file shares one daemon and one wave — `beforeAll` costs a
 * plan, four takes and four dones — so they run in order and each leaves the
 * bus further along. That is fine until a test *depends* on a predecessor
 * having run, which turns `bun test -t` on that one test into a red that says
 * nothing about the code. This reads the current state instead of assuming it.
 */
async function finishReview(front: string, id: string): Promise<void> {
  const now = (await works("COORD")).find((w) => w.id === id)!;
  if (now.state === "done") return;
  if (now.state !== "taken") {
    // Offered to COORD by construction, since COORD is the only other live
    // front. WORKER reaches the review of its own work only once COORD hands
    // it back — the two-command path, and the only path there is.
    if (front !== "COORD") await cli("COORD", "drop", id);
    await cli(front, "take", id);
  }
  await cli(front, "done", id, "--summary", "ok");
}

beforeAll(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "parley-cli-")));
  sockDir = realpathSync(mkdtempSync(join(tmpdir(), "parley-sock-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".git", "parley"), { recursive: true });

  // Four tasks with one title on four non-colliding paths: one wave, four
  // items, identical in every respect the output can show except the path.
  writeFileSync(
    join(repo, "plan.md"),
    ["**Goal:** quatro tarefas iguais", ""].concat(
      PLAN_PATHS.flatMap((p, i) => [
        `### Task ${i + 1}: mesma coisa`,
        "**Files:**",
        `- Modify: \`${p}.ts\``,
        "",
      ]),
    ).join("\n"),
    "utf8",
  );

  daemon = new ParleyDaemon({
    gitCommonDir: join(repo, ".git", "parley"),   // where the CLI looks for endpoint.json
    address: { kind: "unix", address: join(sockDir, "s") },
    journalPath: join(sockDir, "journal.ndjson"),
    tickIntervalMs: 50,
  });
  await daemon.listen();

  await cli("COORD", "shape", "plan");
  await cli("COORD", "plan", "plan.md");
  const open = await works("WORKER", "--state", "open");
  for (const item of open) {
    await cli("WORKER", "take", item.id);
    await cli("WORKER", "done", item.id);
  }
  // COORD is the only other live front, so every review was offered to it.
  reviews = await works("COORD", "--state", "offered");
});

afterAll(async () => {
  await daemon?.close().catch(() => { /* already gone */ });
  for (const dir of [repo, sockDir]) rmSync(dir, { recursive: true, force: true });
});

describe("what a front is told when it takes the review of its own work", () => {
  test("the wave produced one review per task, every one of them offered away", () => {
    expect(reviews).toHaveLength(PLAN_PATHS.length);
    expect(reviews.every((r) => r.kind === "review")).toBe(true);
  });

  test("the plain-text take says something it does not say for anyone else's work", async () => {
    const [own, theirs] = reviews as [Row, Row];

    // The two-command path a reviewer found: COORD hands the review back, it
    // goes to the pool open, and nothing refuses WORKER taking it.
    await cli("COORD", "drop", own.id);
    const takenBySelf = await cli("WORKER", "take", own.id);
    const takenByOther = await cli("COORD", "take", theirs.id);

    expect(takenBySelf).toContain("parley: took");
    expect(takenByOther).toContain("parley: took");

    // The fact, not the phrasing: same command, items identical once the id
    // and the path are masked, and the outputs still differ.
    expect(mask(takenBySelf)).not.toBe(mask(takenByOther));

    // And what differs is present, not merely reordered or missing — a self
    // review is told MORE, and the extra text appears nowhere in the ordinary
    // case. This is on stdout: the skill tells fronts to take items in plain
    // text, so a disclosure that lived only under --json would be invisible to
    // the audience it exists for.
    const control = mask(takenByOther);
    const extra = mask(takenBySelf).split("\n").filter((l) => l.trim() && !control.includes(l.trim()));
    expect(extra.length).toBeGreaterThan(0);
    expect(control).not.toContain(extra.join("").trim());
  });

  test("--json names the fact in a field, so nothing has to be read out of prose", async () => {
    const [, , own, theirs] = reviews as [Row, Row, Row, Row];
    await cli("COORD", "drop", own.id);

    const mine = json<{ selfReview: boolean }>(await cli("WORKER", "take", own.id, "--json"));
    const yours = json<{ selfReview: boolean }>(await cli("COORD", "take", theirs.id, "--json"));

    // Always present, both ways round, so a consumer never has to tell "no"
    // apart from "this build does not send it".
    expect(mine.selfReview).toBe(true);
    expect(yours.selfReview).toBe(false);
  });

  test("the finished wave does not read the same either way in parley works", async () => {
    // Driven from REVIEWER_OF rather than from whatever the tests above left
    // behind, so this one is honest run on its own. Run in sequence it is a
    // no-op for the four takes they already made: the assignment is the same.
    for (const [i, r] of reviews.entries()) await finishReview(REVIEWER_OF[i]!, r.id);

    const rows = (await cli("COORD", "works")).split("\n").filter((l) => l.includes("review"));
    expect(rows).toHaveLength(PLAN_PATHS.length);
    expect(rows.every((r) => r.includes("done"))).toBe(true);

    // Every task done, every review done — this listing is the only place a
    // person reads the finished wave back, and the four rows are otherwise the
    // same row four times. Two masked shapes: two of these were checked by the
    // front that wrote them and two were not, and the listing says which.
    expect(new Set(rows.map(mask)).size).toBe(2);
  });
});
