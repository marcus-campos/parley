import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParleyDaemon } from "../../src/daemon/server";
import { DEFAULTS } from "../../src/protocol/types";
import { joinFrame, resolveIdentity } from "../../src/cli/identity";
import { bearFront, harnessBin } from "../../src/spawn/birth";
import { removeWorktreeIfClean, type WorktreeRemoval } from "../../src/spawn/worktree";
import { RawClient } from "./harness";

/**
 * The wire, end to end.
 *
 * `src/spawn/birth.ts` wrote `PARLEY_BORN` into every newborn's environment.
 * `src/state/work.ts` gated the whole retirement feature on `p.born ===
 * "parley"`. Both ends had tests. Nothing in between read the variable: no
 * `PARLEY_BORN` branch in `resolveIdentity`, no `born` field in any `join`
 * frame in `src/`. So every participant that has ever joined a real bus
 * arrived as `person`, `shouldRetire` was false at its first line for all of
 * them, and the feature could be deleted without a single test noticing.
 *
 * The existing tests asserted each end against a frame shape no caller
 * produced. These start from the environment `bearFront` actually sets, go
 * through the code that actually builds a `join` frame, over a real socket, to
 * a real daemon.
 */

const dirs: string[] = [];
const daemons: ParleyDaemon[] = [];
const clients: RawClient[] = [];
let savedEnv: NodeJS.ProcessEnv | null = null;

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const d of daemons.splice(0)) await d.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedEnv) { process.env = savedEnv; savedEnv = null; }
});

function gitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "parley-born-"));
  dirs.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return repo;
}

/** The environment a newborn front is actually started with, and its worktree. */
function bearOne(repo: string): { env: Record<string, string>; worktree: string } {
  const calls: { opts: Record<string, unknown> }[] = [];
  const born = bearFront({
    repoRoot: repo,
    config: { mode: "panel", harness: "claude-code", maxFronts: 6 },
    intent: { reason: "2 open item(s) and no idle front", forItemIds: ["w_1", "w_2"] },
    index: 1,
    spawnFn: ((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      calls.push({ opts });
      // `on` is not decoration. A real ChildProcess reports a binary it could
      // not resolve asynchronously, as an `error` event, and an `error` event
      // with no listener is an uncaught exception in the daemon's own process.
      // A fake without `on` is a fake that cannot tell you that.
      return { pid: 4242, unref() { /* detached */ }, on() { /* no events from a fake */ } };
    }) as never,
  });
  expect(born).not.toBeNull();
  return { env: calls[0]!.opts.env as Record<string, string>, worktree: born!.worktree };
}

/**
 * A daemon wired the way production wires it: the *discovery* directory,
 * `<git-common-dir>/parley`, is what `src/cli/main.ts` passes as
 * `gitCommonDir` — not the git directory, and not a bare temp folder.
 */
async function daemonFor(
  repo: string,
  now: () => number,
  removeWorktree?: (
    repoRoot: string, path: string, stillEmpty?: () => boolean,
  ) => Promise<WorktreeRemoval>,
) {
  const sockDir = mkdtempSync(join(tmpdir(), "parley-sock-"));
  dirs.push(sockDir);
  const daemon = new ParleyDaemon({
    gitCommonDir: join(repo, ".git", "parley"),
    address: { kind: "unix", address: join(sockDir, "p.sock") },
    journalPath: join(sockDir, "journal.ndjson"),
    tickIntervalMs: 100_000, // ticks are driven by the commands the test sends
    now,
    removeWorktree,
  });
  daemons.push(daemon);
  const endpoint = await daemon.listen();
  return { daemon, endpoint };
}

/**
 * A collection paused in the one window that matters, so a test can put a real
 * frame inside it.
 *
 * It stands exactly where the two real `git` calls stand: `git status` has
 * answered clean, `git worktree remove` has not been issued. What the real
 * function does at that point is pinned in tests/spawn/worktree.test.ts; this
 * is what the *daemon* still knows at that point, which is the half no test
 * could reach — every other collection test asserts after `await
 * daemon.close()`, and `close()` awaits `this.collecting`, so the window is
 * always fully drained before the assertion runs.
 */
function pausedCollector(pretend?: WorktreeRemoval) {
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  /**
   * What "is anybody in there" answers, asked twice per removal: once where
   * `git status` has just come back clean, once where `git worktree remove` is
   * about to be issued. Two readings and not one, because a single `false`
   * cannot tell a re-join that landed in the window from a daemon that threw
   * the record away before `git` even started — which is the bug.
   */
  const answers: boolean[] = [];

  const collect = async (
    repoRoot: string, path: string, stillEmpty?: () => boolean,
  ): Promise<WorktreeRemoval> => {
    const ask = () => (stillEmpty ? stillEmpty() : true);
    answers.push(ask());
    entered();
    await released;
    const empty = ask();
    answers.push(empty);
    // A removal whose `git` had already answered by the time the front came
    // back: the losing side of the race, which the caller still has to handle.
    if (pretend) return pretend;
    if (!empty) return "cancelled";
    return removeWorktreeIfClean(repoRoot, path);
  };

  return { collect, inside, answers, release: () => release() };
}

/** The real producer of a `join` frame, fed the real newborn environment. */
function joinAsNewborn(env: Record<string, string>, worktree: string, session: string) {
  savedEnv ??= { ...process.env };
  process.env.PARLEY_NAME = env.PARLEY_NAME;
  process.env.PARLEY_MISSION = env.PARLEY_MISSION;
  process.env.PARLEY_BORN = env.PARLEY_BORN;
  const identity = resolveIdentity(worktree, worktree);
  return joinFrame(identity, { cwd: worktree, kind: "agent", session });
}

/**
 * A PATH with `git` on it and no harness anywhere, so the daemon's real birth
 * path can be run end to end without ever starting a real agent session.
 *
 * This is the production failure verbatim: §the terminal a birth opens runs
 * the person's shell, and a PATH or an auth difference yields a window
 * printing `claude: command not found`. Everything that matters about that
 * case happens *after* `addWorktree` has already created a full checkout and a
 * branch.
 *
 * The probe at the end is a hard gate, not a courtesy: if `claude` were still
 * reachable this would spawn a live, unsupervised, billed agent session in a
 * temp repository, which is the one thing every test in this tree is written
 * to avoid. It throws rather than degrading.
 *
 * The probe is written as the exact call `bearFront` makes — same binary, same
 * explicit `env` — because that is the only thing that proves anything.
 * Mutating `process.env.PATH` alone does *not* move a spawn under Bun: the
 * lookup follows the `env` handed to the call, and `bearFront` hands it
 * `{...process.env, ...identity}`. Written any other way this gate would pass
 * while the real spawn still resolved.
 */
function harnessOffThePath(): void {
  const binDir = mkdtempSync(join(tmpdir(), "parley-bin-"));
  dirs.push(binDir);
  const gitBin = (process.env.PATH ?? "").split(":")
    .map((d) => join(d, "git"))
    .find((candidate) => existsSync(candidate));
  if (!gitBin) throw new Error("no `git` on PATH to hand the test");
  // Reached only on a POSIX box with no git, which CI does not have. Windows
  // never gets here: the tests that call this skip, see WINDOWS_SPAWN below.
  symlinkSync(gitBin, join(binDir, "git"));

  savedEnv ??= { ...process.env };
  process.env.PATH = binDir;

  // git still works…
  execFileSync("git", ["--version"], { stdio: "ignore" });
  // …and the harness does not. Anything but "could not be found" and the test
  // refuses to run at all.
  const bin = harnessBin("claude-code");
  const probe = spawnSync(bin, ["--version"], { env: { ...process.env } });
  if (!probe.error) {
    throw new Error(`refusing to run: \`${bin}\` is still reachable, and this test must never start one`);
  }
}

/**
 * A newborn's output arrives on its own schedule — it is a real process
 * writing to a real pipe — so this waits for it, with a ceiling, instead of
 * assuming it has landed by the next line of the test. Nothing here can pass
 * by waiting long enough: the lines either arrive or they do not.
 *
 * The ceiling is generous because it is only ever reached when something is
 * genuinely broken. At 5s it went red on a loaded machine while the code was
 * innocent — a false red, and a false red in a suite this size is worse than a
 * slow test: it teaches whoever sees it that a red here means nothing. The
 * failing direction is unchanged; only the patience is.
 */
async function untilLines(
  daemon: ParleyDaemon, front: RawClient, wanted: number,
): Promise<{ n: number; name: string; text: string; at: string }[]> {
  const ceiling = Date.now() + 20_000;
  let lines: { n: number; name: string; text: string; at: string }[] = [];
  while (Date.now() < ceiling) {
    const r = await front.send({ op: "output" });
    lines = (r.lines ?? []) as typeof lines;
    if (lines.length >= wanted) return lines;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  void daemon;
  return lines;
}

async function connectTo(address: string): Promise<RawClient> {
  const client = await RawClient.connect(address);
  clients.push(client);
  return client;
}

describe("a front parley bore, from its environment to the bus", () => {
  test("THE test that was missing: the participant arrives as born parley", async () => {
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    expect(env.PARLEY_BORN).toBe("parley");

    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);

    const frame = joinAsNewborn(env, worktree, "session-pool-1");
    // Not a hand-written `born: "parley"`: this is what `resolveIdentity` and
    // `joinFrame` produce from the environment `bearFront` set, which is what
    // the hook, the CLI and the MCP server all send.
    expect(frame.born).toBe("parley");

    const joined = await front.send(frame);
    expect(joined.ok).toBe(true);
    expect(String(joined.name)).toContain("POOL");

    const me = daemon.snapshot().participants[String(joined.id)]!;
    expect(me.born).toBe("parley");
  });

  test("a front a person opened arrives as born person, from the same code path", async () => {
    const repo = gitRepo();
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);

    savedEnv = { ...process.env };
    delete process.env.PARLEY_BORN;
    process.env.PARLEY_NAME = "DEVELOP";
    const frame = joinFrame(resolveIdentity(repo, repo), { cwd: repo, kind: "agent", session: "session-develop" });
    expect(frame.born).toBe("person");

    const joined = await front.send(frame);
    expect(daemon.snapshot().participants[String(joined.id)]!.born).toBe("person");
  });

  test("and the notice reaches it: retirement arrives on the channel the front reads", async () => {
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));

    // Past the grace period, so `shouldRetire` names it on the next command's
    // pre-command tick — which runs on this front's own connection.
    clock += DEFAULTS.RETIRE_GRACE_MS + 1;
    const drained = await front.send({ op: "drain" });
    const texts = (drained.events as { text: string }[]).map((e) => e.text);
    expect(texts.join("\n")).toContain("retiring you");

    // The daemon pushed it down this same socket as an unsolicited frame,
    // which a hook-driven front drops on the floor. Before the fix that push
    // also advanced the cursor past it, so `drain` returned nothing and the
    // notice existed only in the journal.
    expect(front.pushes.length).toBeGreaterThan(0);

    // Rung once. Another command, no second notice.
    clock += 5_000;
    const again = await front.send({ op: "drain" });
    expect((again.events as { text: string }[]).map((e) => e.text).join("\n")).not.toContain("retiring you");
  });

  test("a person's front is never told to go home, however idle", async () => {
    const repo = gitRepo();
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    savedEnv = { ...process.env };
    delete process.env.PARLEY_BORN;
    process.env.PARLEY_NAME = "DEVELOP";
    await front.send(joinFrame(resolveIdentity(repo, repo), { cwd: repo, kind: "agent", session: "s" }));

    clock += DEFAULTS.RETIRE_GRACE_MS + 1;
    const drained = await front.send({ op: "drain" });
    expect((drained.events as { text: string }[]).map((e) => e.text).join("\n")).not.toContain("retiring you");
  });
});

// This helper builds a POSIX precondition three ways at once: it splits PATH on
// ":", looks for `git` rather than `git.exe`, and symlinks — which on Windows
// needs a privilege CI does not grant. Underneath it, the thing being tested is
// a spawn path this repository already knows does not work on Windows: the
// terminal command was `export K=V && ...` handed to `cmd.exe`, where `export`
// is not a builtin, so the chain died on its first token and `claude` never
// ran. Rewriting that blind is not an improvement over saying so, which is the
// call the branch that found it made. So these skip, loudly, rather than fail
// for a reason that has nothing to do with what they check.
const WINDOWS_SPAWN = process.platform === "win32";

describe("the newborn's worktree", () => {
  test("survives being named for retirement — it is an invitation, not an eviction", async () => {
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    expect(existsSync(worktree)).toBe(true);

    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));

    clock += DEFAULTS.RETIRE_GRACE_MS + 1;
    // One `parley who` used to be enough: `removeWorktreeIfClean` ran in the
    // same synchronous loop iteration as the notification, on the tick that
    // first named the front — while the agent was still running in there.
    await front.send({ op: "who" });
    await front.send({ op: "who" });
    await front.send({ op: "drain" });
    // Far past every window there is, and still the front has not left.
    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 60_000;
    await front.send({ op: "who" });
    // Collection is asynchronous, so "still there on the next line" proves
    // nothing. This waited 500ms instead — which went red in 595ms on a
    // reviewer's machine, and the flake direction was *a mutation surviving*.
    // `close` waits for anything in flight, so there is nothing left to race.
    await daemon.close();
    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
  });

  test("is collected once the front has actually gone", async () => {
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));

    clock += DEFAULTS.RETIRE_GRACE_MS + 1;
    await front.send({ op: "drain" });
    expect(existsSync(worktree)).toBe(true);

    await front.send({ op: "leave" });
    // Said, but not yet proven: `leave` is what a front claims, silence is
    // what proves it.
    expect(existsSync(worktree)).toBe(true);

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });
    // Collection is deliberately off the event loop: two `git` subprocesses
    // are never something the daemon waits on. `close` is the one place that
    // does wait — a daemon that exits from under a `git worktree remove`
    // leaves a half-removed worktree and a stale entry in `.git` — which is
    // also what makes this assertion a fact rather than a sleep.
    await daemon.close();
    expect(existsSync(worktree)).toBe(false);
  });

  test.skipIf(WINDOWS_SPAWN)("a harness that is not there does not take the bus down with it", async () => {
    // `spawn` reports a binary it could not resolve *asynchronously*, as an
    // `error` event on the child, after it has already returned — and an
    // `error` event with no listener is an uncaught exception. Nothing in
    // `bearFront` listened. So the most ordinary failure there is, `claude`
    // not on this PATH, killed the daemon process: every front on the
    // repository lost the bus, mid-work, and the try/catch around the spawn
    // could not help because nothing throws.
    harnessOffThePath();
    const repo = gitRepo();
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const core = await connectTo(endpoint.address);
    await core.send({ op: "join", name: "CORE", cwd: repo });
    await core.send({ op: "shape", shape: "pool" });
    const mine = await core.send({ op: "work", title: "what CORE is on", paths: ["a.ts"] });
    await core.send({ op: "work", title: "what nobody took", paths: ["b.ts"] });
    const mineId = (mine as unknown as { items: { id: string }[] }).items[0]!.id;
    await core.send({ op: "take", id: mineId });

    clock += DEFAULTS.ORPHAN_POOL_MS + 1;
    await core.send({ op: "who" });

    // The error event lands on its own schedule, a turn or two after `spawn`
    // returned. This is the window the process used to die in.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await core.send({ op: "who" })).toMatchObject({ ok: true });

    // And it is not a silence: the panel is told why, at the moment it is
    // known, rather than two minutes later when `sweepBirths` notices nothing
    // ever joined.
    const out = await core.send({ op: "output" });
    const lines = ((out.lines ?? []) as { text: string }[]).map((l) => l.text).join("\n");
    expect(lines).toContain("could not start claude");
    await daemon.close();
  });

  test.skipIf(WINDOWS_SPAWN)("a birth that never joins leaves no checkout and no branch behind", async () => {
    // `bearFront` creates the worktree *before* it spawns, so a birth that
    // fails has already produced `.parley/worktrees/pool-1` and a
    // `parley/pool-1` branch. That front never joins and never leaves, so
    // nothing ever asked for it to be collected — and `nextFrontIndexIn` reads
    // the surviving branch and skips that index for ever after. A repository
    // whose PATH is wrong accumulated one full checkout per BIRTH_COOLDOWN_MS,
    // permanently, while `sweepBirths` announced the silence and collected
    // nothing.
    harnessOffThePath();
    const repo = gitRepo();
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const core = await connectTo(endpoint.address);
    await core.send({ op: "join", name: "CORE", cwd: repo });
    await core.send({ op: "shape", shape: "pool" });
    const mine = await core.send({ op: "work", title: "what CORE is on", paths: ["a.ts"] });
    await core.send({ op: "work", title: "what nobody took", paths: ["b.ts"] });
    const mineId = (mine as unknown as { items: { id: string }[] }).items[0]!.id;
    await core.send({ op: "take", id: mineId });

    clock += DEFAULTS.ORPHAN_POOL_MS + 1;
    await core.send({ op: "who" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The cost, as it happens: a full checkout with its own `.git`, and a
    // branch, for a front that does not exist.
    const worktree = join(repo, ".parley", "worktrees", "pool-1");
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);

    clock += DEFAULTS.BIRTH_JOIN_GRACE_MS + 1;
    await core.send({ op: "who" });
    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await core.send({ op: "who" });
    await daemon.close();

    const said = daemon.snapshot().events.map((e) => e.text).join("\n");
    expect(said).toContain("POOL-1 was started and never joined");
    expect(existsSync(worktree)).toBe(false);
    // And the index is free again. A branch left behind is an index
    // `nextFrontIndexIn` can never hand out, which is the phantom failure the
    // whole counter-from-git change existed to stop.
    const branches = execFileSync(
      "git", ["branch", "--list", "--format=%(refname:short)", "parley/*"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(branches).not.toContain("parley/pool-1");
  });

  test.skipIf(WINDOWS_SPAWN)("a name somebody carried in an earlier session is not proof this birth arrived", async () => {
    // `sweepBirths` matched any participant that has ever carried the name,
    // live or `gone`, from this session or replayed out of the journal. Names
    // are reused: an index is handed out again the moment the branch behind it
    // is collected, so after a restart a genuinely never-joining POOL-1 was
    // matched by the POOL-1 of a previous session and the announcement — the
    // only thing that ever tells somebody their PATH is wrong — was lost.
    harnessOffThePath();
    const repo = gitRepo();
    const sockDir = mkdtempSync(join(tmpdir(), "parley-sock-"));
    dirs.push(sockDir);
    const journalPath = join(sockDir, "journal.ndjson");
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const boot = async (sock: string) => {
      const daemon = new ParleyDaemon({
        gitCommonDir: join(repo, ".git", "parley"),
        address: { kind: "unix", address: join(sockDir, sock) },
        journalPath,
        tickIntervalMs: 100_000,
        now: () => clock,
      });
      daemons.push(daemon);
      return { daemon, endpoint: await daemon.listen() };
    };

    // An earlier session: something called POOL-1 was on this bus and left.
    const first = await boot("p1.sock");
    const old = await connectTo(first.endpoint.address);
    await old.send({ op: "join", name: "POOL-1", cwd: repo });
    await old.send({ op: "leave" });
    old.close();
    await first.daemon.close();

    // A new daemon, the same journal. No `parley/pool-*` branch was ever
    // created, so the index starts at 1 again — and the replayed POOL-1 is
    // still sitting in the state, `gone`.
    const second = await boot("p2.sock");
    expect(Object.values(second.daemon.snapshot().participants).some((p) => p.name === "POOL-1")).toBe(true);

    const core = await connectTo(second.endpoint.address);
    await core.send({ op: "join", name: "CORE", cwd: repo });
    await core.send({ op: "shape", shape: "pool" });
    const mine = await core.send({ op: "work", title: "what CORE is on", paths: ["a.ts"] });
    await core.send({ op: "work", title: "what nobody took", paths: ["b.ts"] });
    const mineId = (mine as unknown as { items: { id: string }[] }).items[0]!.id;
    await core.send({ op: "take", id: mineId });

    clock += DEFAULTS.ORPHAN_POOL_MS + 1;
    await core.send({ op: "who" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(join(repo, ".parley", "worktrees", "pool-1", "a.txt"))).toBe(true);

    clock += DEFAULTS.BIRTH_JOIN_GRACE_MS + 1;
    await core.send({ op: "who" });
    const said = second.daemon.snapshot().events.map((e) => e.text).join("\n");
    expect(said).toContain("POOL-1 was started and never joined");

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await core.send({ op: "who" });
    await second.daemon.close();
    expect(existsSync(join(repo, ".parley", "worktrees", "pool-1"))).toBe(false);
  });

  test("is collected when the front dies without ever saying goodbye", async () => {
    // §4.4 says removed **on death**. What was implemented was removal on
    // *saying goodbye*: `scheduleCollection` had one call site, the `leave`
    // branch, and nothing in the rule that decides a front is dead ever asked
    // for one. So a newborn killed by SIGKILL, by a crash, by a closed laptop,
    // or by a harness that fires no `SessionEnd` was marked `gone` — freeing
    // its slot under the ceiling, correctly — and kept a full checkout and a
    // branch for ever, with `nextFrontIndexIn` reserving that index for ever
    // with it. Two ends covered, the middle missing.
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));

    // The kill. No `leave`, no `SessionEnd`, no last frame of any kind: the
    // socket simply goes away, which is all a daemon ever sees of a SIGKILL.
    front.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Somebody else is still working, which is what drives the clock. The
    // lease is now the only thing that can notice POOL-1 is not coming back.
    const person = await connectTo(endpoint.address);
    await person.send({ op: "join", name: "CORE", mission: "the work", cwd: repo });

    clock += DEFAULTS.LEASE_TTL_MS + 1_000;
    await person.send({ op: "who" });
    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await person.send({ op: "who" });
    await daemon.close();

    expect(existsSync(worktree)).toBe(false);
    // And the branch with it, or the index is reserved for ever — which was
    // the phantom "a front could not be started" every restart used to pay.
    const branches = execFileSync(
      "git", ["branch", "--list", "--format=%(refname:short)", "parley/*"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(branches).not.toContain("parley/pool-1");
  });

  test("a front that dies and comes straight back keeps its directory", async () => {
    // The control on the fix, and the reason death alone is not enough. A
    // front that crashed and restarted re-joins from the same directory, and
    // "is anybody in there" is asked before any deadline is looked at.
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    front.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const person = await connectTo(endpoint.address);
    await person.send({ op: "join", name: "CORE", mission: "the work", cwd: repo });
    clock += DEFAULTS.LEASE_TTL_MS + 1_000;
    await person.send({ op: "who" });

    // It is back, in the same directory, before the collection deadline.
    const again = await connectTo(endpoint.address);
    await again.send(joinAsNewborn(env, worktree, "session-pool-1"));
    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await person.send({ op: "who" });
    await daemon.close();

    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
  });

  test("a front that says leave and then makes one more tool call keeps its directory", async () => {
    // The notice itself asks for this: "Say so and run `parley leave`". So the
    // front runs it — and then makes one more tool call, because it is a
    // language model finishing a turn, not a process that has exited. Its cwd
    // must still be there. Note which of the three locks cannot help: "only if
    // clean" — a newborn's tree is clean by construction.
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));

    clock += DEFAULTS.RETIRE_GRACE_MS + 1;
    await front.send({ op: "drain" });
    await front.send({ op: "leave" });

    // One more tool call: the hook re-joins on the same session, from the same
    // directory. Anything that puts a live front back in there cancels the
    // collection outright.
    clock += 2_000;
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });
    await daemon.close();
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
  });

  test("a front that says leave and then makes one *long* tool call keeps its directory", async () => {
    // The same shape as above, with the clock crossing the deadline — which is
    // the only version that could ever have failed. POOL-1 runs `parley leave`
    // at 14:00 and then makes a single tool call that outlasts
    // `COLLECT_AFTER_LEAVE_MS`: a full test run, a build. Its PostToolUse hook
    // re-joins at 14:06, and that re-join must cancel the collection.
    //
    // It did not. `handle()` swept *before* it applied the frame, so the
    // joining participant was invisible to the sweep that ran on its own join:
    // the directory was removed first and the cancel arrived one statement
    // later. The test above passes either way, because its clock never crosses
    // the deadline and so nothing is ever collected in it.
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));

    clock += DEFAULTS.RETIRE_GRACE_MS + 1;
    await front.send({ op: "drain" });
    await front.send({ op: "leave" });

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    // And it stays cancelled: the schedule is gone, not merely postponed.
    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });
    await daemon.close();
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
  });


  test("a front that comes back while git is still running keeps its directory", async () => {
    // The window nothing in this suite could see. Every other collection test
    // asserts after `await daemon.close()`, and `close()` awaits
    // `this.collecting` — so the in-flight window is always fully drained
    // before any assertion runs, and a frame landing inside it was untestable
    // by construction.
    //
    // The failure it hid: the pending entry was deleted one line *before* the
    // two `git` subprocesses started, so from that instant the daemon held no
    // record that a collection was happening and `sweepCollections` returned
    // at `size === 0`. POOL-1 runs `parley leave` at 14:00 and makes one more
    // tool call, as the retirement notice asks. At 14:05 the sweep starts
    // `git status`. The PostToolUse hook re-joins at 14:05.001 — a socket
    // round trip, ~1ms, far inside a window that is tens of milliseconds on a
    // two-file repository and bounded only by GIT_TIMEOUT_MS behind a stale
    // `index.lock`. The daemon accepted the join, the sweep found nothing
    // pending, `git status` came back clean, and `git worktree remove` deleted
    // a live front's checkout.
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 14, 0, 0);

    const paused = pausedCollector();
    const { daemon, endpoint } = await daemonFor(repo, () => clock, paused.collect);

    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    clock += DEFAULTS.RETIRE_GRACE_MS + 1;
    await front.send({ op: "drain" });
    await front.send({ op: "leave" });

    // 14:05. This frame's sweep crosses the deadline and starts the removal,
    // and the response only comes back after the sweep has run.
    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });
    await paused.inside;
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);

    // 14:05.001, and this is the whole point: a real `join` frame over the
    // real socket, answered by the real daemon, while the removal is in
    // flight. Nothing here is faked but the clock and the pause.
    const rejoin = await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    expect(rejoin.ok).toBe(true);

    paused.release();
    await daemon.close();

    // Asked, and answered "somebody is in there". Before the fix there was
    // nothing left to ask: the record had been deleted before `git` started.
    expect(paused.answers).toEqual([true, false]);
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
  });

  test("a front that comes back one instant too late does not stop the removal", async () => {
    // The other side of the same window, and the reason the check sits where
    // it sits rather than being a promise the daemon cannot keep. Once `git
    // worktree remove` is issued there is nothing to cancel, and the design
    // says so out loud instead of pretending the race has no losing side. The
    // front is `gone` and its work is on its branch; what it loses is a
    // directory it had already said `leave` from.
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 14, 0, 0);

    const paused = pausedCollector();
    const { daemon, endpoint } = await daemonFor(repo, () => clock, paused.collect);

    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    clock += DEFAULTS.RETIRE_GRACE_MS + 1;
    await front.send({ op: "drain" });
    await front.send({ op: "leave" });

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });
    await paused.inside;

    // And every frame that arrives while it is in flight leaves it alone. The
    // record is kept so the cancel above has something to find, which is also
    // a record a second sweep could act on — it must not start a second
    // removal of the same directory.
    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });

    // Nobody comes back. The record is still there — that is what makes the
    // question answerable at all — and it answers the other way.
    paused.release();
    await daemon.close();

    expect(paused.answers).toEqual([true, true]);
    expect(existsSync(worktree)).toBe(false);
  });

  test("a collection nobody wants any more says nothing and retries nothing", async () => {
    // The losing side of the same race, and the clause that handles it. The
    // check catches the common case; it cannot catch a removal whose `git` had
    // already answered by the instant the front walked back in. When that
    // happens the record is gone — the sweep deleted it — and every conclusion
    // the removal reached is about a directory that is somebody's again.
    //
    // Telling a front sitting in its worktree working that it "left
    // uncommitted changes in .parley/worktrees/pool-1 — its worktree is kept"
    // is a false statement about a live session, and the `unknown`/`failed`
    // arm would put the same directory back in the sweep's queue.
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    writeFileSync(join(worktree, "b.txt"), "half an hour of work\n");
    let clock = Date.UTC(2026, 7, 20, 14, 0, 0);

    const paused = pausedCollector("dirty");
    const { daemon, endpoint } = await daemonFor(repo, () => clock, paused.collect);
    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    await front.send({ op: "leave" });

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });
    await paused.inside;
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    paused.release();
    await daemon.close();

    expect(paused.answers).toEqual([true, false]);
    const said = daemon.snapshot().events.map((e) => e.text).join("\n");
    expect(said).not.toContain("uncommitted changes");
    expect(existsSync(join(worktree, "b.txt"))).toBe(true);
  });

  test("a person who walks into the worktree mid-session keeps it too", async () => {
    // The same hazard reached through `join`'s other branch. A person's
    // session starts at the repository root and later `cd`s into
    // `.parley/worktrees/pool-1` to look at what POOL-1 did. Every tool call
    // re-joins on the same session id with the new cwd — and the reattach
    // branch read `branch`, `wake`, `connected` and `mission` off that frame
    // and dropped `cwd` on the floor.
    //
    // So parley still believed they were standing at the root, the sweep's
    // "is anybody in there" answered no, and the checkout went out from under
    // a live session. Cancelling on the participant's own id cannot help
    // here: the pending collection belongs to POOL-1, and POOL-1 really has
    // gone.
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);

    savedEnv = { ...process.env };
    delete process.env.PARLEY_BORN;
    process.env.PARLEY_NAME = "DEVELOP";
    const person = await connectTo(endpoint.address);
    await person.send(joinFrame(resolveIdentity(repo, repo), { cwd: repo, kind: "agent", session: "s-person" }));

    const pool = await connectTo(endpoint.address);
    await pool.send(joinAsNewborn(env, worktree, "session-pool-1"));
    await pool.send({ op: "leave" });

    // They walk in. Same session, new directory.
    delete process.env.PARLEY_BORN;
    process.env.PARLEY_NAME = "DEVELOP";
    clock += 1_000;
    const back = await person.send(
      joinFrame(resolveIdentity(worktree, worktree), { cwd: worktree, kind: "agent", session: "s-person" }),
    );
    expect(back.reattached).toBe(true);

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await person.send({ op: "who" });
    await daemon.close();
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
  });

  test("a person opening a session inside a departed newborn's worktree keeps it", async () => {
    // The other half of the same defect, and a different branch of the sweep:
    // not the front reattaching to its own participant, but somebody new
    // standing in that directory. A person opens a session in
    // `.parley/worktrees/pool-1` to read what POOL-1 did, long after POOL-1
    // left. Their very first hook frame swept before it applied, and deleted
    // the checkout they had just opened.
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const pool = await connectTo(endpoint.address);
    await pool.send(joinAsNewborn(env, worktree, "session-pool-1"));
    await pool.send({ op: "leave" });

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    delete process.env.PARLEY_BORN;
    process.env.PARLEY_NAME = "DEVELOP";
    const person = await connectTo(endpoint.address);
    const frame = joinFrame(resolveIdentity(worktree, worktree), { cwd: worktree, kind: "agent", session: "s-person" });
    expect(frame.born).toBe("person");
    await person.send(frame);

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await person.send({ op: "who" });
    await daemon.close();
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
  });

  test("a front that leaves holding uncommitted work keeps its directory", async () => {
    const repo = gitRepo();
    const { env, worktree } = bearOne(repo);
    writeFileSync(join(worktree, "b.txt"), "half an hour of work\n");

    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    await front.send({ op: "leave" });

    // Past the point where the collection is genuinely attempted — otherwise
    // this would pass on the deferral alone and prove nothing about clean.
    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });
    await daemon.close();
    expect(existsSync(join(worktree, "b.txt"))).toBe(true);

    // And somebody is told. `removeWorktreeIfClean` answers with four distinct
    // outcomes and the daemon threw all four away — `.then(() => {}).catch(()
    // => {})` — so this, the case most worth hearing, was a silence: a full
    // checkout left on disk holding half an hour of somebody's work, under a
    // name nothing would ever mention again.
    const said = daemon.snapshot().events.map((e) => e.text).join("\n");
    expect(said).toContain("uncommitted changes");
    expect(said).toContain(join(".parley", "worktrees", "pool-1"));
    expect(said).toContain("nothing was thrown away");
  });

  test("a worktree that cannot be asked is retried, and then said out loud", async () => {
    // The other two outcomes. A half-removed worktree — the directory is
    // there, its `.git` points at nothing — makes `git status` fail outright
    // rather than answer clean or dirty. That is `unknown`, and `unknown` is
    // not an answer: nothing is known and nothing happened, so it must come
    // back to the sweep rather than being dropped like a success or announced
    // like a verdict. Bounded, because retrying forever with nobody told is
    // the shape this codebase has been burned by before.
    const repo = gitRepo();
    const worktree = join(repo, ".parley", "worktrees", "pool-1");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /nonexistent/nowhere\n");

    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    const env = { PARLEY_NAME: "POOL-1", PARLEY_MISSION: "pool: x", PARLEY_BORN: "parley" };
    await front.send(joinAsNewborn(env, worktree, "session-pool-1"));
    await front.send({ op: "leave" });

    // Three attempts are three subprocesses, and a removal never lands on the
    // frame that started it — so this waits *for the thing*, with a ceiling,
    // rather than sleeping a number somebody guessed. It leaves as soon as the
    // daemon has spoken (~60ms here); it fails loudly if the retry is dropped,
    // or never bounded, because then there is nothing to leave on.
    const said = () => daemon.snapshot().events.map((e) => e.text).join("\n");
    const ceiling = Date.now() + 4_000;
    while (Date.now() < ceiling && !said().includes("could not be collected")) {
      clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
      await front.send({ op: "who" });
      await new Promise((r) => setTimeout(r, 5));
    }
    await daemon.close();

    expect(said()).toContain("could not be collected");
    // Said once the tries ran out, not on the first failure to find out. The
    // count is read back out of the message rather than interpolated into it:
    // asserting `after ${DEFAULTS.COLLECT_MAX_ATTEMPTS} tries` passed happily
    // with the bound mutated to 1, because the assertion moved with it.
    const tries = Number(said().match(/after (\d+) tries/)?.[1]);
    expect(tries).toBeGreaterThan(1);
    expect(tries).toBe(DEFAULTS.COLLECT_MAX_ATTEMPTS);
    expect(existsSync(worktree)).toBe(true);
  });

  test("only what parley created: a newborn that left from a worktree a person made keeps it", async () => {
    // `p.cwd` is wherever the front's process happened to be, not a fact about
    // what parley made. This is the case where `git worktree remove` would not
    // save anybody: a perfectly ordinary worktree, registered, clean, and
    // somebody's. Only the `.parley/worktrees/` prefix stands between it and
    // deletion.
    const repo = gitRepo();
    const { env } = bearOne(repo);
    const theirs = join(repo, "..", `their-worktree-${process.pid}`);
    execFileSync("git", ["worktree", "add", "-b", "theirs", theirs, "HEAD"], { cwd: repo, stdio: "ignore" });
    dirs.push(theirs);
    expect(existsSync(join(theirs, "a.txt"))).toBe(true);

    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    // Born by parley, but sitting in a directory parley did not create.
    await front.send(joinAsNewborn(env, theirs, "session-pool-1"));
    await front.send({ op: "leave" });

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });
    await daemon.close();
    expect(existsSync(join(theirs, "a.txt"))).toBe(true);
  });

  test("a person's session is never collected, even standing in a newborn's worktree", async () => {
    // The cwd this must be run from. The version this replaces used the
    // repository root, where the `.parley/worktrees/` prefix guard already
    // refuses on its own — so `born` could be deleted from the check and the
    // test stayed green. The real case is a person opening a session *inside*
    // `.parley/worktrees/pool-1` to see what POOL-1 did: every other guard
    // says yes there, and only `born` says no.
    const repo = gitRepo();
    const { worktree } = bearOne(repo);
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { daemon, endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    savedEnv = { ...process.env };
    delete process.env.PARLEY_BORN;
    process.env.PARLEY_NAME = "DEVELOP";
    const frame = joinFrame(resolveIdentity(worktree, worktree), { cwd: worktree, kind: "agent", session: "s" });
    expect(frame.born).toBe("person");
    await front.send(frame);
    await front.send({ op: "leave" });

    clock += DEFAULTS.COLLECT_AFTER_LEAVE_MS + 1;
    await front.send({ op: "who" });
    await daemon.close();
    expect(existsSync(join(worktree, "a.txt"))).toBe(true);
  });
});

/**
 * A birth driven all the way through the daemon: a stale pool, no idle front,
 * `tick` raising an intent and `bearFrontFor` turning it into a worktree and a
 * process. Nothing here may start a real agent, so `claude` is a stub on PATH
 * that exits immediately — which is also, conveniently, exactly what a harness
 * the person's shell cannot find looks like from the daemon's side.
 */
async function bearThroughDaemon(repo: string, clockRef: { ms: number }, stub = "exit 0") {
  savedEnv = { ...process.env };
  const binDir = mkdtempSync(join(tmpdir(), "parley-stub-bin-"));
  dirs.push(binDir);
  writeFileSync(join(binDir, "claude"), `#!/bin/sh\n${stub}\n`);
  chmodSync(join(binDir, "claude"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;

  const { daemon, endpoint } = await daemonFor(repo, () => clockRef.ms);
  const front = await connectTo(endpoint.address);
  await front.send({ op: "join", name: "CORE", cwd: repo, kind: "agent" });
  await front.send({ op: "shape", shape: "pool" });
  // An explicit claim is what makes CORE busy rather than idle capacity —
  // otherwise the pool rings its doorbell and never asks to be born.
  await front.send({ op: "claim", paths: ["src/**"] });
  await front.send({ op: "work", title: "the thing nobody picked up", paths: ["a.ts"] });

  clockRef.ms += DEFAULTS.ORPHAN_POOL_MS + 1;
  await front.send({ op: "who" });
  return { daemon, endpoint, front, said: () => daemon.snapshot().events.map((e) => e.text).join("\n") };
}

describe("which index the daemon's next newborn gets", () => {
  test.skipIf(WINDOWS_SPAWN)("a branch a previous daemon left behind is not asked for twice", async () => {
    // The whole birth path through the daemon, which nothing exercised before:
    // a stale pool, no idle front, `tick` raising an intent, `bearFrontFor`
    // turning it into a worktree and a process.
    //
    // And the defect it was hiding. `git worktree remove` does not delete the
    // branch, and the daemon's index lived in memory and restarted at 1 — so
    // the first birth of every daemon lifetime after the first asked git for
    // `parley/pool-1`, which was already there. `bearFront` caught the
    // failure and returned null, the daemon announced "a front could not be
    // started", and the pool then waited out a full BIRTH_COOLDOWN_MS — five
    // minutes — before index 2 got through. Every restart, forever.
    const repo = gitRepo();
    // A newborn that committed its work: the worktree was collected, and
    // `git branch -d` refused the branch because it holds commits.
    execFileSync("git", ["branch", "parley/pool-1"], { cwd: repo, stdio: "ignore" });

    const clock = { ms: Date.UTC(2026, 7, 20, 12, 0, 0) };
    const { daemon, said } = await bearThroughDaemon(repo, clock);
    await daemon.close();

    expect(said()).toContain("providing a front");
    expect(said()).not.toContain("could not be started");
    expect(existsSync(join(repo, ".parley", "worktrees", "pool-2"))).toBe(true);
    expect(existsSync(join(repo, ".parley", "worktrees", "pool-1"))).toBe(false);
  });
});

describe("the human's voice on spending", () => {
  test.skipIf(WINDOWS_SPAWN)("a person's veto stops a birth that would otherwise have happened", async () => {
    // Over a real socket, on the whole path: the pool goes stale, nobody is
    // idle, `tick` would raise an intent and `bearFrontFor` would turn it into
    // a worktree and a process. A person said no, so none of it happens — and
    // the pool stays open and CORE keeps working, which is the point: the veto
    // is on spending, not on the work.
    const repo = gitRepo();
    const clock = { ms: Date.UTC(2026, 7, 20, 12, 0, 0) };

    savedEnv = { ...process.env };
    const binDir = mkdtempSync(join(tmpdir(), "parley-stub-bin-"));
    dirs.push(binDir);
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "claude"), 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH}`;

    const { daemon, endpoint } = await daemonFor(repo, () => clock.ms);
    const person = await connectTo(endpoint.address);
    await person.send({ op: "join", name: "Marcus", kind: "human", cwd: repo });
    const vetoed = await person.send({ op: "summon", allow: false });
    expect(vetoed.ok).toBe(true);
    expect(vetoed).toMatchObject({ birthsAllowed: false });

    const front = await connectTo(endpoint.address);
    await front.send({ op: "join", name: "CORE", cwd: repo, kind: "agent" });
    await front.send({ op: "shape", shape: "pool" });
    await front.send({ op: "claim", paths: ["src/**"] });
    await front.send({ op: "work", title: "the thing nobody picked up", paths: ["a.ts"] });

    clock.ms += DEFAULTS.ORPHAN_POOL_MS + 1;
    await front.send({ op: "who" });

    const said = daemon.snapshot().events.map((e) => e.text).join("\n");
    expect(said).toContain("stopped parley starting");
    expect(said).not.toContain("providing a front");
    expect(existsSync(join(repo, ".parley", "worktrees", "pool-1"))).toBe(false);

    // The work is untouched: the veto is about money, not about the pool.
    const works = await front.send({ op: "works" });
    expect((works.work as { state: string }[]).some((w) => w.state === "open")).toBe(true);

    // A front asking for a hand by name is refused on the same grounds.
    expect(await front.send({ op: "summon", reason: "need a hand" }))
      .toMatchObject({ ok: false, error: { code: "NO_CAPACITY" } });

    // Lifted, the same pool provides a front on the very next frame.
    await person.send({ op: "summon", allow: true });
    await front.send({ op: "who" });
    await daemon.close();
    expect(existsSync(join(repo, ".parley", "worktrees", "pool-1"))).toBe(true);
  });

  test("a front cannot lift or set the veto, however it asks", async () => {
    const repo = gitRepo();
    const clock = { ms: Date.UTC(2026, 7, 20, 12, 0, 0) };
    const { daemon, endpoint } = await daemonFor(repo, () => clock.ms);
    const front = await connectTo(endpoint.address);
    await front.send({ op: "join", name: "CORE", cwd: repo, kind: "agent" });

    expect(await front.send({ op: "summon", allow: false }))
      .toMatchObject({ ok: false, error: { code: "OBSERVER_ONLY" } });
    expect(daemon.snapshot().birthsAllowed).toBe(true);
    await daemon.close();
  });

  test("`who` carries the switch, so a panel can show what it is switching", async () => {
    const repo = gitRepo();
    mkdirSync(join(repo, ".git", "parley"), { recursive: true });
    writeFileSync(join(repo, ".git", "parley", "spawn.json"), JSON.stringify({ mode: "panel", maxFronts: 2 }));
    const clock = { ms: Date.UTC(2026, 7, 20, 12, 0, 0) };
    const { daemon, endpoint } = await daemonFor(repo, () => clock.ms);
    const front = await connectTo(endpoint.address);
    await front.send({ op: "join", name: "CORE", cwd: repo, kind: "agent" });

    // The repository's own ceiling, not the built-in 6 — the panel would
    // otherwise show a number nobody configured.
    expect((await front.send({ op: "who" })).births).toMatchObject({ allowed: true, max: 2, live: 1 });
    await daemon.close();
  });
});

describe("a front parley started that never reached the bus", () => {
  test.skipIf(WINDOWS_SPAWN)("is said out loud, instead of being counted as a success forever", async () => {
    // `bearFront` returns as soon as it has a pid, and in terminal mode that
    // pid belongs to `osascript`, not to the agent. The window runs the
    // person's shell, so the harness resolves from *their* PATH and auth —
    // neither of which the daemon can see — and one that prints `command not
    // found` was a birth parley believed in and nobody else ever saw. The
    // stub `claude` here exits immediately, which is the same thing from the
    // daemon's side.
    //
    // It costs no capacity: `canBearFront` counts live participants, and a
    // front that never joins never becomes one. What it cost was silence —
    // `lastBirthMs` is stamped at the intent, so the pool waits out a whole
    // BIRTH_COOLDOWN_MS, tries again, fails the same way, forever.
    const repo = gitRepo();
    const clock = { ms: Date.UTC(2026, 7, 20, 12, 0, 0) };
    const { daemon, front, said } = await bearThroughDaemon(repo, clock);
    expect(said()).toContain("providing a front");
    // Not yet. A cold harness is allowed to take a while.
    expect(said()).not.toContain("never joined");

    clock.ms += DEFAULTS.BIRTH_JOIN_GRACE_MS + 1;
    await front.send({ op: "who" });
    expect(said()).toContain("POOL-1 was started and never joined");

    // Said once. A second frame does not repeat it.
    const before = said().split("never joined").length;
    clock.ms += DEFAULTS.BIRTH_JOIN_GRACE_MS + 1;
    await front.send({ op: "who" });
    expect(said().split("never joined").length).toBe(before);
    await daemon.close();
  });

  test("a newborn that does join is never accused of it", async () => {
    const repo = gitRepo();
    const clock = { ms: Date.UTC(2026, 7, 20, 12, 0, 0) };
    const { daemon, endpoint, front, said } = await bearThroughDaemon(repo, clock);

    const worktree = join(repo, ".parley", "worktrees", "pool-1");
    const newborn = await connectTo(endpoint.address);
    await newborn.send(joinAsNewborn(
      { PARLEY_NAME: "POOL-1", PARLEY_MISSION: "pool: x", PARLEY_BORN: "parley" },
      worktree, "session-pool-1",
    ));

    clock.ms += DEFAULTS.BIRTH_JOIN_GRACE_MS + 1;
    await front.send({ op: "who" });
    await daemon.close();
    expect(said()).not.toContain("never joined");
  });
});

// Every test here spawns a real child through a `#!/bin/sh` stub and prepends
// it to PATH with ":" — a POSIX precondition twice over. What sits underneath is
// the same spawn path this repository already records as not working on Windows.
describe.skipIf(WINDOWS_SPAWN)("the panel is the newborn's window", () => {
  test("what the newborn prints reaches the panel, and never the bus", async () => {
    // §7 of the design: a newborn's output streams into the *panel*, which is
    // what makes headless spawning legible instead of a black box. Into the
    // panel — the plan's sketch pushed each line onto the bus as a `say`,
    // which journals it and drains it into every other front's context. A
    // harness printing its answer would cost every agent on the repository the
    // tokens to read it, which is the exact trade the pool footer exists to
    // avoid.
    const repo = gitRepo();
    const clock = { ms: Date.UTC(2026, 7, 20, 12, 0, 0) };
    const { daemon, front, said } = await bearThroughDaemon(
      repo, clock,
      "echo 'reading the pool'\necho 'taking w_1' >&2\nprintf 'no newline at the end'",
    );

    const lines = await untilLines(daemon, front, 3);
    expect(lines.map((l) => l.text)).toEqual(
      expect.arrayContaining(["reading the pool", "taking w_1", "no newline at the end"]),
    );
    // Under the front's name, which is the only way a panel can tell two
    // newborns apart.
    expect(new Set(lines.map((l) => l.name))).toEqual(new Set(["POOL-1"]));

    // stderr as well as stdout: a harness that fails says so on stderr, and
    // that is the line somebody watching most needs.
    expect(lines.some((l) => l.text === "taking w_1")).toBe(true);

    // And not one word of it on the bus.
    expect(said()).not.toContain("reading the pool");
    const history = await front.send({ op: "history", limit: 200 });
    expect(JSON.stringify(history.events)).not.toContain("reading the pool");
    await daemon.close();
  });

  test("a cursor, so a panel polling every second does not re-render everything", async () => {
    const repo = gitRepo();
    const clock = { ms: Date.UTC(2026, 7, 20, 12, 0, 0) };
    const { daemon, front } = await bearThroughDaemon(repo, clock, "echo one\necho two");

    const lines = await untilLines(daemon, front, 2);
    const after = Math.max(...lines.map((l) => l.n));
    const again = await front.send({ op: "output", after });
    expect(again.lines).toEqual([]);
    await daemon.close();
  });

  test("a runaway newborn cannot grow the daemon without bound", async () => {
    const repo = gitRepo();
    const clock = { ms: Date.UTC(2026, 7, 20, 12, 0, 0) };
    const many = DEFAULTS.PANEL_TAIL_LINES + 50;
    const { daemon, front } = await bearThroughDaemon(
      repo, clock,
      // Sem `seq`: ele não está em toda máquina, e a linha longa é o ponto do
      // teste — se ela não sai, o que falha é a asserção sobre truncamento, por
      // um motivo que nada tem a ver com o anel que ela verifica.
      `i=0; while [ $i -lt ${many} ]; do echo "line $i"; i=$((i+1)); done; ` +
      `long=; i=0; while [ $i -lt 400 ]; do long="\${long}x"; i=$((i+1)); done; echo "\$long"`,
    );

    const lines = await untilLines(daemon, front, DEFAULTS.PANEL_TAIL_LINES);
    expect(lines.length).toBe(DEFAULTS.PANEL_TAIL_LINES);
    // A ring, so what survives is the tail — the part somebody watching wants.
    expect(lines.some((l) => l.text === `line ${many - 1}`)).toBe(true);
    expect(lines.some((l) => l.text === "line 0")).toBe(false);
    // And no single line can fill a panel by itself.
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(DEFAULTS.PANEL_TAIL_LINE_CHARS + 1);
    await daemon.close();
    // Past bun's 5s default, because `untilLines` is allowed to wait longer
    // than that before calling a real pipe dead.
  }, 30_000);
});

describe("production wiring: the daemon is handed the discovery directory", () => {
  test("it finds the working tree, so notes are exported and births are possible", async () => {
    // `repoRootForExport()` matched `basename(gitCommonDir) === ".git"`, but
    // the spawner passes `<git-common-dir>/parley`, so it returned `null` for
    // every real repository — which silently disabled `.parley/notes.md` and,
    // on this branch, the whole birth path (`bearFrontFor` returns early with
    // no root).
    const repo = gitRepo();
    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send({ op: "join", name: "CORE", cwd: repo });
    await front.send({ op: "note", title: "CI runs tsc -b here", body: "solution-style tsconfig" });

    const exported = join(repo, ".parley", "notes.md");
    expect(existsSync(exported)).toBe(true);
    expect(readFileSync(exported, "utf8")).toContain("CI runs tsc -b here");
  });

  test("it reads the repository's spawn.json, beside endpoint.json and panel.json", async () => {
    // Read through `join(gitCommonDir, "parley", "spawn.json")` with the
    // discovery directory already ending in `parley`, the daemon looked for
    // `<git-common-dir>/parley/parley/spawn.json` — a path nothing writes — so
    // `maxFronts` was always the built-in 6.
    const repo = gitRepo();
    mkdirSync(join(repo, ".git", "parley"), { recursive: true });
    writeFileSync(join(repo, ".git", "parley", "spawn.json"), JSON.stringify({ mode: "panel", maxFronts: 1 }));

    let clock = Date.UTC(2026, 7, 20, 12, 0, 0);
    const { endpoint } = await daemonFor(repo, () => clock);
    const front = await connectTo(endpoint.address);
    await front.send({ op: "join", name: "CORE", cwd: repo });
    const refused = await front.send({ op: "summon", reason: "need a hand" });
    expect(refused).toMatchObject({ ok: false, error: { code: "NO_CAPACITY" } });
  });
});
