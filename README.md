# parley

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

- **Protocol reference:** [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- **How it works inside:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## The one rule

**A broken parley must never stop the work.**

If the daemon is unreachable, `enforced` degrades to `advisory` and says so
loudly. If a hook overruns its time budget, it lets go. If the journal has a torn
line from a `kill -9`, the daemon drops that line and boots anyway. A
coordination system that freezes the machine when it fails is worse than no
system at all.

---

## Install

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

---

## What runs by itself, and what you launch

Once `parley init` has run in a repository — **once, not per session** — agent
sessions need nothing from you:

| | |
|---|---|
| A new agent session joins the bus | automatic (`SessionStart` hook) |
| Sessions in **other worktrees** join too | automatic, but only with `parley init --global` |
| Messages arrive in its context | automatic (`UserPromptSubmit`, `PreToolUse`) |
| Territory is claimed on first edit | automatic (`PreToolUse`) |
| It leaves and hands territory back | automatic (`SessionEnd`) |
| The daemon starts | automatic, on the first command that needs it |

What you run on purpose is the panel, because it is a thing you look at:
`parley watch`, or `parley watch --web --detach` once, and then just open the
browser whenever you want to see what is going on.

## Set it up in a repository

```bash
parley init --global    # once per machine
cd your-repo && parley init
```

**Do the `--global` one.** `.claude/settings.json` lives in the working tree and
`.claude/` is usually gitignored, so hooks installed in your main checkout
**simply do not exist in your other worktrees** — sessions opened there never
join the bus, and you get exactly the silence you were trying to avoid. Global
hooks are the only arrangement that covers every worktree.

They are safe to leave on: they do nothing in a repository that was never set
up. `parley init` writes a marker in the git common dir, which every worktree of
that repository shares, and the hooks check it before doing anything.

`init` detects the harnesses you have installed, **shows you the diff of what it
would write**, asks for confirmation, and only then writes. It never edits your
configuration blind. `parley uninit` removes exactly what it wrote.

For Claude Code it installs four hooks in `.claude/settings.json` and a skill in
`.claude/skills/parley/`:

| Hook | What it does |
|---|---|
| `SessionStart` | Joins under a name derived from the worktree or branch, then tells the agent to rename itself, declare a mission, **and say that name to you in its first reply** — you are watching several windows and the panel shows names, not windows. |
| `UserPromptSubmit` | Drains the inbox and injects it as context. |
| `PreToolUse` | One hook, one call: drains the inbox and, when the tool is `Edit`/`Write`/`NotebookEdit`, settles territory in the same answer. It also matches `Bash` — the tool the agent runs `parley` through — so the record of which session owns this worktree is refreshed microseconds before a CLI call reads it. That is what lets two sessions in the *same* worktree be told apart. |
| `Stop` | **Refuses to let the session go idle while another front is blocked on it** — an unanswered question, a permission decision it owes, or an answer it asked for and has not read. Each of those interrupts exactly once, so two agents cannot push each other round in a loop. |
| `SessionEnd` | Leaves and hands territory back. |

The skill is the other half: hooks handle what should be automatic (territory,
inbox), and the skill teaches the agent to use the deliberate verbs — `say`,
`ask`, `note` — on purpose.

---

## The three modes

The mode belongs to **the repository**, not to a session, and it is held by the
daemon. If each session picked its own, one session in `advisory` would drive
over the others and `enforced` would be theatre.

| Mode | Territory and permission | Conversation and notes |
|---|---|---|
| `off` | disabled: no claim, no auto-claim, no `ask` | work normally |
| `advisory` | claim and auto-claim active; a conflict warns loudly but does not block | work normally |
| `enforced` | a conflict **blocks the edit** until granted | work normally |

```bash
parley mode enforced
```

`enforced` is only honest where the harness has a pre-tool gate. Today that is
Claude Code. See the compatibility matrix below.

---

## Commands

```
parley init | uninit | doctor | status | stop | update

parley whoami
parley join --as NAME [--mission "..."]
parley rename --as NAME [--mission "..."]
parley leave
parley who

parley watch [--web] [--port N] [--detach] [--stop]   # i / s to speak

parley say [--to NAME] [--priority high] "text"
parley drain
parley history [--limit 200]

parley claim <paths...> [--intent "..."] [--auto]
parley release [<paths...>] [--all]

parley ask <path> --reason "..." [--ttl 300]
parley requests [--all]
parley grant <request> [--scope once|transfer]
parley deny <request> --reason "..."

parley note --title "..." [--body "..."] [--tags a,b]
parley notes [--tag x] [--export]

parley mode [off|advisory|enforced]
```

Every command accepts `--json` for machine consumption, and `--as NAME` to say
which front you are. `PARLEY_NAME`, `PARLEY_MISSION` and `PARLEY_HARNESS` do the
same through the environment.

---

## Following along: the panel

Two ways to watch everything happening on the bus in real time. Both join as a
**human**, so anything you send from them reaches the agents marked as human and
at high priority.

### In the terminal

```bash
parley watch
```

```
parley · advisory · your-repo                        2 fronts · you are PANEL
────────────────────────────────────────────────────────────────────────────
  • FINANCEIRO     month-end closing        claude-code    11s  1 claim
      src/backend/finance/**
  • TESTE-CAMPO    route incidents          codex          15s  1 claim
      src/backend/routes/incidents.py

  PENDING PERMISSION (1)
  ! TESTE-CAMPO wants src/backend/finance/services.py from FINANCEIRO  4:31 left
      adding one column
      FINANCEIRO settles this; unanswered, it is granted to TESTE-CAMPO and announced
────────────────────────────────────────────────────────────────────────────
14:31   FINANCEIRO  touching alembic, check your heads before migrating
14:32 ! Marcus      do not drop any column today
────────────────────────────────────────────────────────────────────────────
  watching · i to say something · Ctrl+C to leave
```

Live fronts with their missions and claims, pending permission requests in focus
with the clock running, and the conversation stream. **It opens watching** — no
input line, nothing asking for your attention.

Press <kbd>i</kbd> and a composer appears; <kbd>Esc</kbd> closes it again:

| Input | Effect |
|---|---|
| <kbd>i</kbd> | open the composer |
| `anything` + <kbd>Enter</kbd> | broadcast to every front |
| `@FINANCEIRO anything` | directed to one front |
| <kbd>n</kbd> | browse the notes |
| <kbd>m</kbd> | set how you appear on the bus (remembered per repository) |
| <kbd>Esc</kbd> | back one screen |
| <kbd>q</kbd> or <kbd>Ctrl+C</kbd> | leave and restore your terminal |

In the note list, <kbd>j</kbd>/<kbd>k</kbd> or the arrows move and
<kbd>Enter</kbd> opens the note full screen. In the reader,
<kbd>j</kbd>/<kbd>k</kbd> scroll and <kbd>n</kbd>/<kbd>p</kbd> step to the next
and previous note without going back to the list.

There is no grant, deny or mode anywhere in the panel, by design — see below.

It uses the alternate screen buffer, so quitting gives you your scrollback back,
and falls back to ASCII where the terminal does not advertise UTF-8.

### In the browser

```bash
parley watch --web
```

```
parley: web panel on http://127.0.0.1:7717/?t=a619ab2e16136a21d6098859087f9d89
parley: bound to 127.0.0.1 only; the token is required. Ctrl+C to stop.
parley: the page opens in watching mode; press s there to say something.
```

Opens your browser on a live page — the same fronts, feed and pending requests,
streamed over server-sent events. Light and dark follow your system. It opens
watching, with no message box; press <kbd>s</kbd> for a composer and
<kbd>Esc</kbd> to dismiss it. There is no grant or deny anywhere on the page.

Click any note — or press <kbd>n</kbd> — to read it full screen, with
<kbd>&larr;</kbd>/<kbd>&rarr;</kbd> stepping between notes and <kbd>Esc</kbd>
closing.

- `--detach` leaves it running after you close the terminal, prints the URL and
  exits. A second `--detach` hands you the panel already running instead of
  opening a rival on another port with a different token.
  `parley watch --web --stop` shuts it down.
- **Each repository gets its own port**, derived from its id, so panels for
  several projects run side by side — and it is the *same* port every time, so
  the URL in your browser history keeps working. If it happens to be taken,
  parley moves to a free one and tells you.
- `--port N` pins it. If that one is busy, you get told which, rather than a
  raw bind error.
- `--open=false` skips launching the browser.
- **It binds to `127.0.0.1` only and requires the token in the URL.** Localhost is
  not a security boundary on a shared machine: without a token, any process — or
  any page you have open — could read your bus and speak on it.

### Why the panel is built for watching

A person joins the room, and then mostly watches. That posture is deliberate, and
it is enforced by the protocol rather than left to the interface:

- **A human cannot grant or deny.** The daemon refuses it with `OBSERVER_ONLY`.
  Territory disputes are for the fronts to settle among themselves, so a stalled
  request can never turn into a request for a person's attention.
- **A human does have a voice.** What you send arrives marked as human and at
  high priority, and the agents are told to weigh it above a peer's opinion —
  but never to wait for it, and never to ask a person to decide.
- **Saying nothing is the normal case**, not a signal. Participation is optional;
  the bus does not stall because nobody is watching.
- **So the composer is something you open, not something that waits for you.**
  <kbd>i</kbd> in the terminal, <kbd>s</kbd> in the browser. A prompt sitting
  there permanently invites exactly the behaviour the design tries to avoid.

Prefer not to sit in a panel at all? `parley who`, `parley requests` and
`parley drain` give you the same information from any terminal. The panel is a
convenience, never a dependency.

---

## How the pieces behave

### Territory

A path is always POSIX and relative to the repository root. `src\app.ts` and
`src/app.ts` are the same territory — without that rule a session on Windows and
a session in WSL would hold the same file without ever colliding, which is the
worst failure class, the silent one.

Claims accept a concrete path or a glob. A bare directory covers everything
beneath it. Overlap is decided conservatively: when two wildcard patterns cannot
be compared exactly, parley reports a conflict. A false conflict costs one
conversation; a false clear costs two agents editing the same file.

**Auto-claim.** The first edit of a free file claims it automatically, through
the hook. Agents ignore protocol constantly, so auto-claim is what makes `who`
reflect reality rather than intention. An auto-claim expires after 15 idle
minutes — otherwise a front that swept the repository would end up owning half
of it. A claim you asked for explicitly never expires from inactivity; it is
yours until you leave.

### Permission

```bash
parley ask src/backend/finance/services.py --reason "adding one column"
```

You only ever need this when someone actually holds the path. Asking for a free
file is granted instantly and never becomes a pending request — which is what
keeps the pending list meaningful: everything in it is a real contention between
two fronts.

The owner answers in one of three ways:

- `parley grant <id>` — hand it over, `--scope once` or `--scope transfer`.
- `parley deny <id> --reason "..."` — with the reason delivered to the requester.
- **`parley release <path>` — just let it go.** Releasing a path settles every
  request waiting on it automatically and hands the claim to whoever was waiting,
  so nobody can slip in between. Leaving does the same, since leaving is
  releasing. Requiring the owner to release *and* answer would be asking twice
  for one decision, and the second half is the half an agent forgets.

**An unanswered request is granted, and announced by name:**

> `TESTE-CAMPO took src/backend/finance/services.py by timeout; FINANCEIRO did not answer in 5 min.`

An idle agent is the most expensive waste in the system, so the deadline
concedes. Naming who stayed silent in a broadcast is what stops the timeout from
quietly becoming the normal path.

### Asking another front, and getting an answer

A message lands in an inbox that an idle session will not read until its person
prompts it again — so a direct question to a window that is just sitting there
goes unanswered for as long as it sits.

```bash
parley question --to BUSSOLA "are you holding finance/services.py?" --wait 60
parley questions            # what you owe, what you are waiting on
parley reply q_0003 "not touching it, go ahead"
parley ack q_0003 "got it, doing the edit now"
```

A question is not a message: **someone owes an answer**, and the recipient's
session is interrupted before it can go idle. The asker is interrupted too, if
an answer arrived and it has not read it. Same for a permission decision you owe
somebody.

Each of those interrupts **exactly once**. That is the whole loop guard: a
question gets one hard nudge and then becomes an ordinary inbox item, so two
agents cannot block each other's turn forever.

### Conversation vs. notes

`say` and `note` exist separately because they have different useful lifetimes.

*"CI is red on develop, I fixed it in branch X"* is conversation — it dies
resolved. *"`npx tsc --noEmit` checks nothing in this repo"* is knowledge that is
worth something to every future front, including the ones that do not exist yet.

Notes live in **`.parley/notes.md`, versioned in git**: they cross machines,
reach a colleague, and outlive the project. The file is written **automatically
whenever a note is added**, so it is always current; `parley notes --import`
reads it back onto the bus, which is how a fresh clone picks up what the team
already knows. parley never commits for you — a human or an agent commits it,
on purpose.

### Presence, and what happens when a session dies

Presence comes from two sources, because both exist in practice:

- **A live connection**, when there is one. An MCP server process lives as long
  as the session does. If the connection drops, the daemon knows immediately.
- **A lease with a TTL**, for the CLI path. A hook is an ephemeral process: it
  connects, speaks, and exits — presence cannot depend on it staying. Every call
  renews the lease (5 minutes by default), and hooks fire on every tool call, so
  renewal is constant. A dead session stops renewing and expires.

Either way, when a front drops, its claims become `orphaned`, the bus announces
it — *"FINANCEIRO dropped holding 3 claim(s)"* — and they are released after a
60-second grace period.

---

## Compatibility matrix

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

And above all: **parley does not distribute work.** It coordinates sessions
someone already created. Orchestration is a different project.

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
