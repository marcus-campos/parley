import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParleyDaemon } from "../../src/daemon/server";
import { DEFAULTS } from "../../src/protocol/types";
import { joinFrame, resolveIdentity } from "../../src/cli/identity";
import { bearFront } from "../../src/spawn/birth";
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
      return { pid: 4242, unref() { /* detached */ } };
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
async function daemonFor(repo: string, now: () => number) {
  const sockDir = mkdtempSync(join(tmpdir(), "parley-sock-"));
  dirs.push(sockDir);
  const daemon = new ParleyDaemon({
    gitCommonDir: join(repo, ".git", "parley"),
    address: { kind: "unix", address: join(sockDir, "p.sock") },
    journalPath: join(sockDir, "journal.ndjson"),
    tickIntervalMs: 100_000, // ticks are driven by the commands the test sends
    now,
  });
  daemons.push(daemon);
  const endpoint = await daemon.listen();
  return { daemon, endpoint };
}

/** The real producer of a `join` frame, fed the real newborn environment. */
function joinAsNewborn(env: Record<string, string>, worktree: string, session: string) {
  savedEnv = { ...process.env };
  process.env.PARLEY_NAME = env.PARLEY_NAME;
  process.env.PARLEY_MISSION = env.PARLEY_MISSION;
  process.env.PARLEY_BORN = env.PARLEY_BORN;
  const identity = resolveIdentity(worktree, worktree);
  return joinFrame(identity, { cwd: worktree, kind: "agent", session });
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
    const { endpoint } = await daemonFor(repo, () => clock);
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
    // are never something the daemon waits on.
    const deadline = Date.now() + 5_000;
    while (existsSync(worktree) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(worktree)).toBe(false);
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
