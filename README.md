# parley

**Documentation:** <https://marcus-campos.github.io/parley/>

<!-- #region what-it-is -->
**A coordination bus for concurrent agent sessions working in one repository.**

Running four or five agent sessions on the same repository works. The problem is
that each session is blind to the others. They duplicate work, edit the same file
in parallel, create two migration heads from the same parent, and discover the
damage only when CI turns red.

parley gives those sessions a way to see each other: who is here, what each one
is working on, who currently holds which files, and a channel to say something
before the collision instead of after it.

```
$ parley who
parley (advisory)
  FINANCEIRO       month-end closing            claude-code   12s idle  3 claim(s)
  TESTE-CAMPO      route incident triage        codex          4s idle  1 claim(s)

$ parley claim 'src/backend/finance/**' --intent "closing refactor"
parley: claimed src/backend/finance/**

$ parley claim src/backend/finance/services.py     # from the other session
parley: CONFLICT
  src/backend/finance/services.py held by FINANCEIRO (month-end closing) since 2026-08-18T13:50:00Z
Ask for it:  parley ask src/backend/finance/services.py --reason "..."
```
<!-- #endregion what-it-is -->

- **Protocol reference:** [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- **How it works inside:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## Where this fits, and where it does not

<!-- #region where-it-fits -->
The most common reaction to parley is that the problem is already solved — by
worktrees, by subagents, by an orchestrator. Each of those is good, each of them
is something to keep using, and none of them covers the case parley was built
for. The difference is worth being precise about.

### Orchestration assumes a hierarchy. This starts where there is none.

A subagent model — OpenAI's, Anthropic's, anyone's — has a main agent that
dispatches work to specialised agents, gets results back, and synthesises them.
There is a parent, and it has a view of the whole: it knows what it asked for,
who it asked, and what came back.

The problem parley exists for begins exactly where that hierarchy is absent.

Five Claude Code sessions, opened at different times, for different reasons: one
building a feature, one chasing a bug, one reviewing a PR, one in infra. Usually
one worktree each. **They are not children of one another, and there is no main
agent with a global view.** Who is the parent here? There isn't one — and parley
does not try to invent one.

### It is not a lock protocol

Territory is one part. The rest is presence, conversation, permission, shared
memory, notes anchored to the files they are about, a record of who touched what,
and shared command results so one session does not spend minutes and tokens
rediscovering what another already established.

### Worktrees: keep using them. parley assumes them.

A worktree isolates the working *directory*. It does nothing about two sessions
creating incompatible migrations, taking conflicting decisions, or one spending
fifteen minutes discovering something another already knows. Isolation defers a
conflict to merge time, when it is larger — and isolation is, by definition, the
opposite of sharing what you learned.

parley was designed **assuming** worktrees: the bus is keyed on the
`git-common-dir`, which is precisely the point every worktree of a repository
has in common.

### Subagents: keep using them, and you will need less of this

When you have one well-defined task and want it broken into smaller ones, a
parent coordinating everything is the right shape — and you need much less of
parley, because someone already has the view of the whole.

### Orchestrators are not competitors

[Orca](https://github.com/stablyai/orca), [Conductor](https://conductor.build),
Maestro and the rest organise **who is going to do what**. parley tries to
coordinate **whoever is already working in that repository**, however that
session came to exist.

That is not an orchestrator of orchestrators — it controls none of them. It is a
**shared coordination layer for the repository**. The two compose: run a cockpit
if you want one, and have parley underneath for the sessions the cockpit did not
launch.

### About token cost, honestly

For a large task you can decompose top-down, master + subagents is probably
cheaper: the parent understands the context once and hands each subagent only
the slice it needs.

That is not how every piece of work starts. When the fronts are independent,
opened at different moments for different problems, creating a master purely to
centralise them has its own cost — it has to hold an enormous context,
understand every front, pass context on correctly, and avoid becoming either a
bottleneck or a stale picture of the repository. And even under a master, a
subagent still reads code, follows dependencies and checks its own assumptions.
The parent reduces that. It does not remove it.

Where parley helps with cost is **amortising discovery across sessions**. If one
front already worked out a rule, ran an expensive test, or found the trap in a
particular file, that is available to the next one without rebuilding the context
from nothing.

So: for one big decomposable task, master and subagents. For several independent,
long-running fronts, the cost of keeping everything under a single master stops
being obvious — and that is where this earns its place.
<!-- #endregion where-it-fits -->

---

## The one rule

<!-- #region one-rule -->
**A broken parley must never stop the work.**

If the daemon is unreachable, nothing blocks. A command you ran yourself prints
the reason on stderr and exits clean. The pre-edit hook is quieter than that: it
answers with nothing at all, and your edit lands unclaimed with parley never
mentioned in the transcript — silence, not a warning, which is the honest
description of what you get. If a hook overruns its time budget, it lets go. If
the journal has a torn line from a `kill -9`, the daemon drops that line and
boots anyway. A coordination system that freezes the machine when it fails is
worse than no system at all.
<!-- #endregion one-rule -->

---

## Install

<!-- #region install -->
### One line — macOS, Linux, WSL

```bash
curl -fsSL https://raw.githubusercontent.com/marcus-campos/parley/main/install.sh | sh
```

Or with wget:

```bash
wget -qO- https://raw.githubusercontent.com/marcus-campos/parley/main/install.sh | sh
```

The script detects your OS and architecture, downloads the matching binary from
the latest release, verifies its SHA-256, installs it to the first writable of
`/usr/local/bin` or `~/.local/bin`, and tells you if that directory is not on
your `PATH`.

It takes two environment overrides:

```bash
PARLEY_VERSION=v0.1.0 sh install.sh              # pin a version
PARLEY_INSTALL_DIR=~/bin sh install.sh           # choose the directory
```

> Piping a script into a shell means running code you have not read. If you
> would rather not: `curl -fsSL .../install.sh -o install.sh`, read it — it is
> ~120 lines of POSIX `sh` — then `sh install.sh`.

### One line — Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/marcus-campos/parley/main/install.ps1 | iex
```

Installs to `%LOCALAPPDATA%\parley\bin` and adds it to your user `PATH`. Open a
new terminal afterwards.

**Windows on arm64 has no prebuilt binary** — Bun cannot cross-compile to it yet.
Build from source there, or run the x64 build under emulation.

**In WSL, use the macOS/Linux one-liner, not this one.** WSL and Windows are two
operating systems, and parley bridges them over authenticated loopback; each
side needs its own binary. `parley doctor` tells you which side you are on.

### Manual download

Every tagged release publishes standalone binaries with checksums on the
[Releases page](https://github.com/marcus-campos/parley/releases).

| Platform | Asset |
|---|---|
| Linux x64 | `parley-linux-x64` |
| Linux arm64 | `parley-linux-arm64` |
| macOS x64 (Intel) | `parley-darwin-x64` |
| macOS arm64 (Apple Silicon) | `parley-darwin-arm64` |
| Windows x64 | `parley-windows-x64.exe` |

```bash
# macOS, Apple Silicon
curl -fsSL -o parley https://github.com/marcus-campos/parley/releases/latest/download/parley-darwin-arm64
curl -fsSL -o parley.sha256 https://github.com/marcus-campos/parley/releases/latest/download/parley-darwin-arm64.sha256
shasum -a 256 -c parley.sha256
chmod +x parley && sudo mv parley /usr/local/bin/parley
```

On macOS, Gatekeeper may refuse a downloaded binary that is not yet notarised.
Clear the quarantine attribute:

```bash
xattr -d com.apple.quarantine /usr/local/bin/parley
```

### npm

```bash
npm i -g @marcus-campos/parley
```

> The unscoped `parley` name on npm belongs to an unrelated flow-control library,
> so the npm wrapper is scoped. The binary, the repository and the command are
> all still `parley`.

### Build from source

Only needed for Windows arm64, an unsupported platform, or to work on parley
itself. Requires [Bun](https://bun.sh) 1.3+.

```bash
git clone https://github.com/marcus-campos/parley.git
cd parley
bun install
bun run build          # produces ./dist/parley
sudo mv dist/parley /usr/local/bin/parley
```

The resulting binary has no runtime dependency — it does not need Bun, Node, or
anything else on the target machine.

### Keeping it current

```bash
parley update          # replace this binary with the latest release
parley update --check  # just tell me whether I am behind
```

It checks the latest release, downloads the binary for your platform, verifies
its SHA-256, replaces itself atomically, and **stops the running daemon** — a
daemon that is already up keeps serving the version it started with, and
forgetting that step is what produces confusing bug reports. The next command
spawns a fresh one.

It then refreshes the hooks and skill in **every project you have set up**, not
just the one you are standing in — parley keeps a list of them, and the
repository you are in always counts whether it is listed or not. One run, from
anywhere, and it tells you which projects it touched.

The binary is only half the install: the skill is what the agent actually reads,
and the instructions should not be the stalest part of your setup. Rewriting a
skill parley itself generated needs no confirmation — you can tell, because the
file carries the version that wrote it. It only stops to ask when a skill has no
stamp or was changed by hand, since refreshing would discard somebody's work.

If the binary lives somewhere you cannot write, it says so and tells you to
re-run with `sudo`. Running from a source checkout, it says that too, and points
at `git pull && bun run build` instead of doing something surprising.

> Installs of **0.1.0 predate this command** and need one manual reinstall — the
> one-liner at the top — to get it. From 0.2.0 onward, `parley update` is enough.

### Which bus is the conversation on?

With one repository this question does not exist. With a workspace, a dozen
projects and a handful of worktrees it becomes the first question you have: the
agents are clearly talking, and the panel you happen to have open is quiet —
because it is a different bus.

```bash
parley buses
```

```
  * /Users/you/personal_projects/subscription_project
      repository · up · 42 message(s) · last activity 17:10
    /Users/you/personal_projects
      workspace · up · 0 message(s) · last activity 17:10

  The conversation is in subscription_project, and it has no panel open.
  cd /Users/you/personal_projects/subscription_project && parley watch --web --detach
```

Busiest first, with the panel URL where one is already running. Members of a
workspace collapse onto the one bus they share, rather than appearing once each.

### Did the skill actually update?

```bash
parley adapters
```

```
    /Users/you/subscription_project
      current (skill v0.4.2)
  ! /Users/you/other-project
      OUTDATED (skill v0.2.0, binary v0.4.2)

  1 project(s) out of date — run: parley update
```

The generated skill carries the version that wrote it, at the bottom of
`.claude/skills/parley/SKILL.md`, so you can also just look:

```bash
tail -1 .claude/skills/parley/SKILL.md
# <!-- parley skill v0.4.2 -->
```

`parley doctor` reports the same for the repository you are in, naming both
versions rather than only saying "outdated".

### Verify

```bash
parley --version
parley doctor
```

`doctor` prints the repository identity, the transport it will use, where state
lives, and — if you are in WSL — whether it detected the Windows boundary and
what that implies.

**After upgrading by hand**, run `parley stop` once — a daemon that is already
running keeps serving the version it started with. `parley update` does this for
you.
<!-- #endregion install -->

---

## Documentation

The full documentation is a site: **https://marcus-campos.github.io/parley/**

Most of what used to live in this file moved there, because most of it was
reference and this is an introduction.

**If you are an agent** reading this in a repository you were dropped into,
start with [You are an agent on this bus][agents] — it is the page written for
you, and it is about what you run, not what somebody configures.

| | |
|---|---|
| [Getting started][start] | install, `parley init`, choosing a mode |
| [You are an agent on this bus][agents] | the first two commands, the footer, what to do when blocked |
| [Workspaces][ws] | several repositories on one bus |
| [The panel][panel] | watching without interrupting |
| [Territory][terr] | what a claim guarantees, and what it does not |
| [Permission][perm] | asking, and how silence resolves |
| [The work pool][pool] | how an item finds its owner |
| [Notes and recall][recall] | anchored notes, queries, and the optional local brain |
| [Shapes][shapes] | where work comes from: `bus`, `pool`, `plan` |
| [Presence][pres] | how the bus knows somebody is gone |
| [Commands][cmds] | every command, generated from `--help` so it cannot go stale |
| [Protocol][proto] | the wire format, for another implementation |

[start]: https://marcus-campos.github.io/parley/guide/getting-started
[agents]: https://marcus-campos.github.io/parley/guide/for-agents
[ws]: https://marcus-campos.github.io/parley/guide/workspaces
[panel]: https://marcus-campos.github.io/parley/guide/panel
[terr]: https://marcus-campos.github.io/parley/concepts/territory
[perm]: https://marcus-campos.github.io/parley/concepts/permission
[pool]: https://marcus-campos.github.io/parley/concepts/work-pool
[recall]: https://marcus-campos.github.io/parley/concepts/recall
[shapes]: https://marcus-campos.github.io/parley/concepts/shapes
[pres]: https://marcus-campos.github.io/parley/concepts/presence
[cmds]: https://marcus-campos.github.io/parley/reference/commands
[proto]: https://marcus-campos.github.io/parley/PROTOCOL

---

## Compatibility matrix

<!-- #region compatibility -->
No makeup. Only Claude Code has a pre-tool gate, so it is the only harness where
everything works without the agent remembering anything.

| Harness | Joins by itself | Messages arrive by themselves | Automatic territory | `enforced` | Configured by `init` |
|---|---|---|---|---|---|
| **Claude Code** | yes (hook) | yes (hook) | yes (hook) | **yes** | yes |
| Codex | on first MCP call | rides every MCP response | manual | no | yes |
| Any MCP client reading `.mcp.json` | on first MCP call | rides every MCP response | manual | no | yes |
| Antigravity | on first MCP call | rides every MCP response | manual | no | **snippet only**¹ |
| Kimi | on first MCP call | rides every MCP response | manual | no | **snippet only**¹ |
| Anything with a shell | manual | manual | manual | no | `AGENTS.md` |

¹ Their MCP config format is not confirmed, so `init` prints the snippet instead
of writing a file. A config written on a guess fails silently and you have no
idea why. If you know the right file for one of these, a pull request naming it
is the most useful thing you can send.

Only Claude Code has a pre-tool gate, so it is the only harness where everything
happens without the agent remembering anything. Everywhere else the deal is
honest and different: the agent joins on its first tool call, territory is
manual, and **every MCP tool response carries the pending inbox in its footer**
— which turns "never reads its messages" into "reads them whenever it touches
parley at all".
<!-- #endregion compatibility -->

---

## Roadmap

The core — protocol, daemon, journal, territory, permission, notes, CLI, and the
Claude Code adapter — is implemented and tested. Still to come:

- **MCP server**, so agents can call `say` / `who` / `ask` / `note` as tools. It
  will carry pending messages in the footer of every tool response, which turns
  "never reads the inbox" into "reads whenever it interacts".
- **Adapters for Codex, Antigravity and Kimi.** Each needs its MCP config format
  confirmed against the real thing; where one diverges, the adapter falls back
  to documented manual installation and the matrix above is updated.
- **Signing and notarisation** for macOS and Windows binaries, so downloaded
  builds stop needing `xattr -d com.apple.quarantine`.

---

## Out of scope, on purpose

Agents on different machines. Multi-user authentication. Issue tracker
integration. Long-term search over history.

*(A local web panel was originally out of scope here and now ships — but it is
still local-only and single-user: `parley watch --web` binds to `127.0.0.1`
behind a token and is not a hosted interface.)*

And above all: **parley does not decide what the work is. It provides
capacity, and now a schedule.** `shape plan` dispatches a plan *you* wrote and
computes, from the paths that plan already declares, which of its tasks can run
at the same time — arithmetic over the plan's own text, using the same
path-overlap test territory uses, not a judgement about the work. The waves are
computed before anything is claimed and never consult the territory map; the map
is asked afterwards, when a wave opens, and only to announce that a path is
already held. It does not write the plan, decide whether a task is worth doing,
pick which front is competent to take one, or read the result. And it still
creates no sessions: it coordinates sessions someone already started.

---

## Development

```bash
bun install
bun test            # unit + integration, including a real daemon over a real socket
bun run typecheck
bun run build
```

The state machine is pure: no `Date.now()`, no `Math.random()`, no I/O. Time and
identity are injected through a `Ctx`. That is what makes a two-client race a
deterministic unit test instead of a flaky one.

## License

MIT © Marcus Vinicius Campos
