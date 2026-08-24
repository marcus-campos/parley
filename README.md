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

## Where this fits, and where it does not

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

## VS Code multi-root workspaces

One repository is one bus, keyed on the git common dir — which is what every
worktree of that repository shares. That is right until you open a multi-root
workspace: a session then edits several repositories, joins whichever bus its
working directory happens to sit in, and two sessions working across the same
set of projects never see each other.

Make the workspace itself the bus. Run this beside the `.code-workspace` file —
parley reads it and takes **only the folders it names**:

```bash
cd ~/personal_projects        # where yzilab.code-workspace lives
parley init --workspace
parley init --global          # the hooks, once for every project
parley init                   # the skill in each member folder
```

```
parley: /Users/you/personal_projects is now one bus, covering 7 folder(s)
        from yzilab.code-workspace:
        yzilab
        yzilab-front
        yzilab-logistic
        yzilab-logistic-mobile
        yzilab-interfacing
        animalex-site
        yzilab-extension
```

That directory holds twenty other projects; none of them are on this bus. A
session opened in one of *those* keeps its own repository bus, as it should.

**`parley init` installs the skill into each member folder, not just the root** —
Claude Code reads it from the folder a session was opened in, and in a workspace
that is a member, never the root. The `--global` hooks matter more here than
anywhere else, for the same reason: `.claude/` lives inside each folder and is
usually gitignored, so per-folder hooks go missing exactly where you did not
think to look.
With several workspace files side by side, name the one you mean:
`parley init --workspace yzilab.code-workspace`. With none at all, it falls back
to every repository directly inside — say so on purpose, because that is rarely
what you want.

Territory then reads `backend/src/app.ts` — unambiguous, and how a person would
say it. The hooks prefix it for you: editing `frontend/src/plans.tsx` from a
session opened in `frontend/` claims exactly that. Every session opened anywhere
inside the directory is on the same bus, whichever repository it is working in.

**It is opt-in and never inferred.** Guessing would put the same session on a
different bus depending on where it was started from, and territory that
silently splits in two is worse than no territory at all. `parley doctor` shows
which scope you are in.

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

## Shape pool

`mode` says how strict territory is. `shape` says **where work comes from** —
a second axis, also held by the daemon and also repo-scoped: a front running
`bus` in the middle of a `pool` would ignore every offer, and the pool would
be theatre. `bus` is everything above, and the default — a repository that
never sets a shape behaves exactly as it always has. (`plan` is a third,
reserved value; nothing consumes it yet.)

```bash
parley shape pool
```

A front that finds work — sixty-four instances of the same defect, a batch of
files that all need the same label removed — publishes it instead of writing
it into a chat message that evaporates with the scrollback:

```bash
parley work "label sem for" templates/a.html templates/b.html src/orphan.ts
```

One item per path, because the path is the unit of territory, and each is
routed on publish, not by hand: a path a live front already holds becomes an
**offer**, exclusive to that front for 5 minutes before it returns to the
pool unanswered; a path owned by nobody is **open** for anyone.

```bash
parley works --mine          # what has been offered to you
parley works --state open    # what belongs to nobody
parley take w_0012           # first refusal is exclusive while it stands
parley drop w_0012 --reason "not my mission"
parley done w_0012 --summary "3 labels removed"
```

**Offers ride the footer** — the same one every hook and MCP response already
carries — so a front never polls `works` to learn one arrived. **`take` hands
back the notes and results already gathered for the item, in the same
response**, so nobody re-runs the investigation that produced them. **`drop`
costs nothing and is the right call whenever the item is not your mission**;
it goes back in the pool for whoever it actually belongs to.

A front holding no claim and no taken item is spare capacity. If the pool
still has something open ten minutes later, parley rings that front once —
same discipline as the doorbell for an unanswered question, never a loop.

`--kind review --review-of <id>` marks an item as somebody else's work to
check rather than new work to do.

---

## Recall: ask, don't just list

`claim` already pushes path-anchored notes at whoever edits that file next —
the deal since day one. What was missing: a front with a *question* that has
no single path to anchor on could only list everything or filter by path, both
of which cost tokens on a corpus that outgrows any one session fast.

```bash
parley notes --query "how does the footer cap work" --k 3
parley results --query "select2 dropdown test" --k 3
```

Both `notes` and `results` gain `--query` (`q` in the protocol, `query` on the
MCP tools) and `--k`. Every front gets a lexical floor for free — no download,
no configuration, no model:

- **Identifier-aware tokenisation.** `screen_builder.html` is retrieved by
  `screen builder`; `is_staff()` by `is_staff`. This corpus is notes about
  code, so splitting on `_`, `-`, `.` and camelCase is the common case, not an
  edge case.
- **BM25 with a distinctiveness threshold.** A term present in more than half
  the corpus does not count as a match on its own — otherwise a note sharing
  only "the" or "test" with the query would outrank returning nothing. (Below
  four documents in the corpus this threshold does not engage yet; a corpus
  that small has no meaningful notion of "common.")
- **Silence below the floor, on purpose.** A query with no good answer returns
  `[]`, never the least-bad note. The least-bad note costs tokens and teaches
  the agent to distrust the channel.

### The brain: optional, local, off by default

Enabling the brain (`parley brain enable`) fuses a local embedding model into
every ranked query by reciprocal rank, on top of the lexical floor — so a
Portuguese note about *"o menu lateral"* is still found by an English query
about *"hidden sidebar,"* paraphrase rather than shared tokens. It is opt-in,
deliberately:

- **Human-only.** An agent asking `parley brain enable` is refused — it is
  somebody's disk and somebody's ~100MB download, so it is the person's call.
  An agent's query still answers from the lexical floor either way, and never
  waits on a person. What the asking costs is one notice — *"a front asked for
  semantic recall and the brain is off — `parley brain enable` to pick a
  model"* — pushed to every **other** front on the bus, the panel among them,
  and never back to the front that asked. It is spent once for the whole bus,
  not once per front: whoever asks second while the brain is still off gets
  the floor and no notice at all. Turning the brain on or off arms it again.
- **Static embeddings only.** A token-lookup-and-mean model, not a
  transformer: deterministic down to the bit, no GPU, no per-platform native
  runtime. Vectors persist beside the journal, int8-quantised, and are
  rebuilt from the notes and results already in `state` if that file ever
  goes missing — nothing here needs re-deriving from scratch.
- **A relevance floor measured from the model itself.** Dense embedding
  tables are anisotropic: two texts about nothing in common still land at
  cosine 0.85 or higher, and exactly where they land drifts with how long the
  texts are. So enabling a model does two things before it will answer
  anything. It subtracts the table's own centre of mass from every vector,
  document and query alike, which is what stops that drift — measured across
  every text-length regime from one token against one to eight against sixty,
  the score of unrelated text goes from *"0.76 to 0.98, which is 11σ of
  movement from length alone against the widest regime's own spread and over
  100σ against the narrowest's"* to *"0.00, ±0.06 at 256 dimensions and ±0.09
  at 128, with 0.02 to 0.06σ of residual drift for text that is about
  nothing, and up to 0.5σ for text that is about one thing on a table with
  only a dozen topic directions to spare"*. Not perfectly still, and worth
  saying so; still a different universe. Then it measures what unrelated text
  actually scores on that table, over 4,096 pairs drawn from a vocabulary big
  enough to lay out at least 256 of them without repeating a word — a table
  too small for that is refused rather than estimated from a handful — and
  keeps `mean + 4σ` of that as an absolute floor. A hit clears that one number or it
  is not returned: the same verdict whether it is the only candidate or one of
  forty, and regardless of what anything else scored. Two notes that match
  equally well both come back; a corpus where everything is equally irrelevant
  returns none of it.
- **A model that cannot be measured does not get a guessed floor.** If the
  table is too small to measure a null distribution over, or the measurement
  comes back degenerate, the brain does not come up: the lexical floor answers
  and the bus is told. A wrong floor is worse than no floor, because nobody
  can tell which direction it is wrong in.

**Honestly, about this build:** the registry lists one model today,
`potion-multilingual-128M-int8`, and it declares the `xlmr` tokenizer —
XLM-RoBERTa's SentencePiece tokenizer, which has no TypeScript implementation
yet (only Python or WASM). **This build cannot load it.** `parley brain
enable` says so, and refuses, before a single byte downloads — not after.
The registry entry is not hidden or removed to paper over that: a reader
deserves to see that the intended model is known and simply not shippable
yet, not silently absent. Recall still works in full on the lexical floor
regardless of any of this — the brain is strictly additive, never a
dependency.

### The footer cap

A live session accumulates notes fast — forty, sixty, more — and `claim`
already rides some of them on every call, automatically. Sending the whole
corpus on every edit is a tax on every edit, so both halves of it are capped,
each with its own overflow count:

| kind | rides in full up to | overflow field |
|---|---|---|
| plain notes | newest 5 | `more_notes` |
| decisions | newest 20 | `more_decisions` |

Decisions get their own cap rather than an outright exemption from one: a
decision binds until reversed, so it is worth more per line than a plain note
— but "worth more" is not "unbounded," and a path that has collected thirty
decisions over a repository's lifetime should not answer every claim with all
thirty of them. Either overflow count points at `parley notes --path <file>`
(add `--kind decision` for just the rest of those) for the full list.

### Degradation

| failure | behaviour |
|---|---|
| brain off | the lexical floor answers |
| model missing, corrupt, or too small to measure a floor from | the lexical floor answers, and the bus is told once |
| model fails its checksum | the file is deleted, the brain is never switched on, and `parley brain enable` says so **to the person who ran it**. The bus hears nothing, because nothing about the bus changed |
| the ranked query itself fails | the plain, unranked list `parley notes` / `parley results` would have returned with no `--query` at all |
| nothing in the corpus clears the floor | an empty answer, marked ranked. Silence on purpose, never the least-bad note |
| daemon unreachable | today's behaviour |

`claim`'s path-anchored footer is underneath all of that and is not in the
table, because no failure above can reach it: it reads the notes filed against
the paths being claimed straight out of `state` and never consults either
index.

Nothing here can block an edit, delay a hook, or stop the work — [the one
rule](#the-one-rule) applies to recall exactly as it applies to everything
else.

---

## Commands

Everything takes `--json` for machine consumption. `--as NAME` says which front
you are; `PARLEY_NAME`, `PARLEY_MISSION` and `PARLEY_HARNESS` do the same
through the environment.

### Setting up and keeping current

| | |
|---|---|
| `parley init` | Install hooks and skill here. Once per project — not per session. |
| `parley init --global` | Install the Claude Code hooks once for **every** project. The only arrangement that covers your other worktrees, since `.claude/` lives in the working tree and is usually gitignored. Safe to leave on: the hooks do nothing where parley was never set up. |
| `parley init --workspace [file]` | Make this directory one bus for the folders a `.code-workspace` names. For VS Code multi-root. |
| `parley uninit [--global]` | Remove exactly what `init` wrote. |
| `parley update [--check] [--yes]` | Replace the binary with the latest release, then bring hooks and skill up to date in **every** project you have set up. One run, from anywhere. |
| `parley doctor` | Repository identity, transport, where state lives, the WSL boundary, and whether the adapter here is current. First thing to run when something is odd. |
| `parley adapters` | Every project set up, and whether its skill matches this binary. |
| `parley buses` | Every bus on this machine, busiest first — which is how you find where the conversation actually is. |
| `parley status` | Is a daemon up here, what does it hold, and the panel URL if one is running. |
| `parley stop` | Shut the daemon down. Rarely needed; `update` does it for you. |
| `parley mcp` | Run as an MCP server over stdio. For Codex, Kimi, Antigravity and anything else that speaks MCP — you do not run this by hand, `init` wires it up. |

### Who is here

| | |
|---|---|
| `parley who` | Everyone on the bus: name, mission, branch and worktree, how long idle, what each holds. **Run it before any broad change.** |
| `parley whoami` | Which front you are, and where. Tell the person this name — it is how they know which window you are. |
| `parley rename --as NAME --mission "..."` | Claim a name that says what you are here to do. The one you joined with came from the branch, and every session on that branch derives the same one. |
| `parley join` / `parley leave` | Explicit entry and exit. The hooks do both for you. |

### Talking

| | |
|---|---|
| `parley say "text"` | Tell everyone. `--to NAME` for one front, `--priority high` to mark it urgent. Use it to announce intent **before** a broad change. |
| `parley drain` | Your unread messages. Incremental by construction: it only ever returns what you have not seen, so polling costs nothing when nothing happened. |
| `parley history [--limit N] [--since SEQ]` | Re-read the backlog **without** moving your read cursor. The escape hatch for a front that lost its own context. |
| `parley question --to NAME "..."` | Ask, when you need an answer rather than to be heard. The other session **cannot go idle** while your question is open. `--wait N` blocks for the reply. |
| `parley reply <id> "answer"` | Answer a question put to you. Someone is blocked on it — and "I cannot answer" unblocks them just as well. |
| `parley ack <id> ["got it"]` | Close the loop. Without it the front that answered has no idea the answer landed. |
| `parley questions` | What you owe an answer to, and what you are waiting on. |

### Territory

| | |
|---|---|
| `parley claim <paths…>` | Take files or globs. `--intent "..."` says why. The answer carries **what other fronts wrote about those paths and who edited them recently** — read it before you start. |
| `parley release [<paths…>] [--all]` | Give them back **the moment you stop needing them**, not at the end of the session. If someone is waiting, releasing hands it straight over — letting go *is* the answer. |
| `parley ask <path> --reason "..."` | Ask the owner for a path that is theirs. Only needed when someone actually holds it; a free file is granted instantly. Unanswered for five minutes means granted, and announced. |
| `parley grant <id> [--scope once\|transfer]` | Hand over a path you own. |
| `parley deny <id> --reason "..."` | Refuse, with a reason the requester sees. |
| `parley requests [--all]` | Permission requests waiting, with the clock on each. |
| `parley mode [off\|advisory\|enforced]` | The mode belongs to the repository, not to a session. |

### The pool

| | |
|---|---|
| `parley shape [bus\|pool\|plan]` | The shape belongs to the repository, not to a session. Read it with no argument. |
| `parley work "<title>" <path…> [--evidence <id,...>] [--kind review --review-of <id>]` | Publish discovered work, one item per path. Routed on publish: offered to whoever already holds the path, open for anyone otherwise. |
| `parley works [--state open\|offered\|taken\|done] [--mine]` | List the pool. **Offers also ride the footer of every hook and MCP response** — this is for looking, not for polling. |
| `parley take <id>` | Take an open item, or an offer made to you. The answer carries **the notes and results already gathered for it** — do not re-run the investigation. |
| `parley drop <id> [--reason "..."]` | Hand it back. Free, and the right call whenever the item is not your mission. |
| `parley done <id> [--summary "..."]` | Mark it finished. |

### Knowledge that outlives the session

| | |
|---|---|
| `parley note --title "..." --paths <files>` | Write down what the code does not say about itself. **`--paths` is what makes it find its reader**: it is handed to whoever edits those files next, automatically. Write one whenever you learn something the hard way. |
| `parley decide --title "..."` | Record something binding. Announced to everyone, stands until reversed — so the next front does not relitigate a settled question. |
| `parley reverse <id> --reason "..."` | Un-bind a decision while keeping it on the record. |
| `parley notes [--path p] [--tag t] [--kind decision] [--export] [--import]` | Read them. `--export` rewrites `.parley/notes.md` (it is written automatically on every note anyway); `--import` reads that file back onto the bus, which is what a fresh clone needs. |
| `parley notes --query "..." [--k N]` | **Ask** instead of listing: ranked recall over every note and decision, top-`k` only (default 5). See [Recall](#recall-ask-dont-just-list) above. |
| `parley result "<cmd>" --status pass\|fail --paths <globs>` | Record what a command produced, and what it depends on. |
| `parley results [--fresh]` | What is already known, and whether it still holds. **Check this before running a long suite** — if nothing it depends on changed, running it again buys nothing. |
| `parley results --query "..." [--k N]` | Same idea, over recorded results instead of notes. |

### The brain

| | |
|---|---|
| `parley brain` | Is semantic recall on, and with which model. Readable by anyone; a human sees whether they may turn it on, an agent sees that they may not. |
| `parley brain enable [<model>]` | **Human-only** — it is somebody's disk and somebody's download. With no model named, lists the registry — name, languages, size, and whether **this build** can actually load it — so you weigh it before anything downloads. |
| `parley brain disable` | Back to the lexical floor, without losing the corpus. |

See [Recall](#recall-ask-dont-just-list) above for what turning it on actually buys you, and the honest state of what this build can load today.

### Watching

| | |
|---|---|
| `parley watch` | The terminal panel. Opens watching; <kbd>i</kbd> to say something, <kbd>n</kbd> to read notes, <kbd>m</kbd> to set your name, <kbd>q</kbd> to leave. |
| `parley watch --web` | The same in a browser, on a port of this repository's own. <kbd>s</kbd> to say something, click a note to read it full screen. |
| `parley watch --web --detach` | Leave it running after you close the terminal. `--stop` shuts it down. |

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

A person joins the room, and then mostly watches. That posture is deliberate,
and what a human is allowed to do is enforced by the protocol rather than left
to the interface:

- **A human answers for what they hold, exactly like a front does.** `grant`
  and `deny` are open to a human the same as to an agent — the ownership check
  that refuses an agent `NOT_OWNER` for someone else's territory refuses a
  human too, so the only request a person can settle is one about a path they
  hold themselves. That is the answer someone editing a file by hand actually
  needs: "no, I am using this," not just `release` (hand it over) or silence
  (grant it by timeout).
- **What a human still cannot do is arbitrate someone else's dispute.** A
  stalled request between two agents never becomes a request for a person's
  attention — that is for the fronts to settle among themselves.
- **A human does have a voice regardless of ownership.** What you send arrives
  marked as human and at high priority, and the agents are told to weigh it
  above a peer's opinion — but never to wait for it, and never to ask a
  person to decide.
- **Saying nothing is the normal case**, not a signal. Participation is optional;
  the bus does not stall because nobody is watching.
- **So the composer is something you open, not something that waits for you,**
  and the panel only opens it for `say`. <kbd>i</kbd> in the terminal,
  <kbd>s</kbd> in the browser — `grant`, `deny` and the rest are one `parley`
  command away when you are holding the path, the same way `claim` is: the
  panel puts a button on none of them.

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

### How fast a message actually lands

`parley who` says this per front, because it is not the same for all of them and
it is what you need before deciding to wait:

| | |
|---|---|
| **live** | Holds an open connection — an MCP server, or a panel. Pushed to immediately. |
| **hooks** | An ephemeral CLI front. Reads its inbox on its next tool call: seconds while it is working, and **not until its person prompts it again once it has stopped**. |
| **manual** | A plain shell. Reads when somebody runs `parley` there. |

`parley question` reports the same thing when you ask, so you wait on purpose
rather than in the dark.

**Waking a session that has already stopped** is the one thing parley does not do
itself. The `Stop` hook keeps a front from *going* idle while it owes an answer,
which covers the common case — but a session sitting there waiting for its person
hears nothing until it acts again.

This is not a shortcut parley is taking. **No external process can inject a
message into a running Claude Code session** — [the documentation says so][xsm],
and it is an open feature request ([#24947], [#27441], [#53049]). The per-session
socket is the harness's own private inbox, reachable only by its own
session-to-session tool, which only another session can call.

So parley carries the question and the asking agent rings the doorbell — and
parley **keeps asking until it has been rung**. A front registers the wake
address its harness publishes, and when you question one that has gone quiet:

[xsm]: https://code.claude.com/docs/en/cross-session-messaging
[#24947]: https://github.com/anthropics/claude-code/issues/24947
[#27441]: https://github.com/anthropics/claude-code/issues/27441
[#53049]: https://github.com/anthropics/claude-code/issues/53049

```
parley: asked BUSSOLA (q_0007).
  they read their inbox on their next tool call, and have been idle 11m — this may sit for a while
  BUSSOLA has been idle 11m and will not see this until it acts again.
  To wake it now: uds:/tmp/cc-socks/15979.sock — use your harness's session-message
  tool to nudge it; the question is already on the bus and it will find it with `parley questions`.
```

The question stays on the bus, where everyone and every future session can see
it. The message you send is a doorbell, not the letter. Then `parley nudged <id>`
records that you rang it — and **until you do, every attempt to finish a turn
tells you again**, naming the question and the address. Somebody is waiting on an
answer that will not arrive otherwise.

A front that is merely working gets none of this: it reads its inbox within
seconds anyway. Nor does one with no wake address, because there would be
nothing to do about it.

For a harness with **no** such tool — Codex, Kimi, Antigravity — this is moot:
the MCP server holds an open connection, so delivery is immediate and parley is
the only channel there is.

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

And above all: **parley does not assign work. It provides capacity.** It
coordinates sessions someone already created. Orchestration — deciding what
runs and dispatching it — is a different project.

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
