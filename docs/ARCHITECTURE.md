# How parley works inside

This document explains the implementation: what each piece is responsible for,
how a single request flows through the system, and why the awkward-looking
decisions are the way they are.

For the wire contract, see [`PROTOCOL.md`](PROTOCOL.md).

---

## 1. The shape of the thing

```
   your agent session                    another agent session
   ┌──────────────────┐                  ┌──────────────────┐
   │  Claude Code     │                  │  Codex / shell   │
   │   hooks + skill  │                  │      CLI         │
   └────────┬─────────┘                  └────────┬─────────┘
            │  parley hook PreToolUse             │  parley claim …
            │  (JSON in, JSON out)                │
            ▼                                     ▼
   ┌───────────────────────────────────────────────────────┐
   │  parley client — reads endpoint.json, connects,        │
   │  spawns a daemon if nobody answers                     │
   └────────────────────────┬──────────────────────────────┘
                            │ NDJSON over unix socket / named pipe / loopback
                            ▼
   ┌───────────────────────────────────────────────────────┐
   │  parley daemon                                        │
   │   ├─ journal.append(frame)   ← BEFORE responding      │
   │   ├─ tick(state, now)        ← expiries first         │
   │   ├─ apply(state, actor, frame, ctx)                  │
   │   ├─ respond on this connection                       │
   │   └─ push events to the other connections             │
   └────────────────────────┬──────────────────────────────┘
                            ▼
              <state>/<repo-id>/journal.ndjson
```

Two files decide everything about discovery and identity:

- `<git-common-dir>/parley/endpoint.json` — **where** the daemon is.
- `<state>/<repo-id>/journal.ndjson` — **what** the daemon knows.

The first lives inside the repository so that every worktree, and both sides of
the WSL boundary, find it with no configuration. The second lives outside the
repository, because it is machine-local runtime state and has no business being
committed.

---

## 2. Module map

| Module | Responsibility | I/O? |
|---|---|---|
| `src/repo/canonical.ts` | Canonicalise a repository path, hash it into `repo-id`. Where the WSL boundary bug lives. | injected |
| `src/repo/paths.ts` | Normalise territory paths; decide glob overlap. | none |
| `src/repo/locate.ts` | `git rev-parse` — the only place that shells out to git. | yes |
| `src/repo/workspace.ts` | Multi-root workspaces: membership from the `.code-workspace` file, and path comparison that survives symlinks. | yes |
| `src/protocol/types.ts` | Wire constants, ops, error codes, defaults. | none |
| `src/protocol/codec.ts` | NDJSON encode and incremental decode. | none |
| `src/state/*.ts` | The state machine: participants, conversation, territory, permissions, notes, questions, results. | **none** |
| `src/mcp/server.ts` | The bus as MCP tools over stdio, for harnesses with no pre-tool gate. | yes |
| `src/adapters/registry.ts` | Every project set up, so one `update` reaches all of them. | yes |
| `src/state/machine.ts` | `apply` (dispatch) and `tick` (every time-driven rule). | **none** |
| `src/journal/journal.ts` | Append-only log; tolerant replay. | yes |
| `src/transport/address.ts` | Address per OS; state directory per OS. | none |
| `src/daemon/endpoint.ts` | Publish, read, remove `endpoint.json`. | yes |
| `src/daemon/server.ts` | The socket server, presence, push, idle shutdown. | yes |
| `src/client/client.ts` | Connect, auto-spawn, request/response, push handling. | yes |
| `src/cli/*.ts` | Argument parsing, identity derivation, command dispatch, output. | yes |
| `src/cli/watch.ts` | The terminal panel. Read-only unless `--speak`. | yes |
| `src/cli/web.ts` + `web-page.ts` | The browser panel: local HTTP + SSE, token-gated, one self-contained page. | yes |
| `src/adapters/*.ts` | The Claude Code hook runner and `parley init`. | yes |

The line that matters is the one around `src/state/`. Everything in there is a
pure function of `(state, frame, ctx)`. No clock, no randomness, no filesystem.

---

## 3. Why the state machine has no clock

Every state function takes a `Ctx`:

```ts
interface Ctx {
  now: string;          // ISO timestamp
  nowMs: number;        // epoch millis
  nextId(prefix: string): string;
}
```

`Date.now()` and `Math.random()` appear nowhere below `src/state/`. That is not
purity for its own sake — it is what makes the interesting tests possible.

The test that actually matters in this system is *two fronts claiming the same
path at the same instant*. With an injected clock, that is a deterministic unit
test:

```ts
const a = apply(state, fin,   { op: "claim", paths: ["src/finance/**"] },        at(100));
const b = apply(state, campo, { op: "claim", paths: ["src/finance/svc.py"] },    at(100));
// exactly one succeeds, always, on every machine, forever
```

The same applies to every deadline in the protocol. "Does an unanswered request
grant after exactly five minutes, and does the broadcast name the right person?"
is a test that runs in microseconds, not one that sleeps.

`tick()` gathers **all** time-driven behaviour in one function: lease expiry,
orphan grace, auto-claim decay, permission timeout. Nothing expires on its own.
The daemon calls `tick` on a timer *and immediately before every command* — the
second part matters, because a claim held by a front that died two minutes ago
must not win a conflict against the front asking right now.

---

## 4. The life of one request

Take a `PreToolUse` hook firing because the agent is about to edit
`src/backend/finance/services.py`.

1. **Claude Code runs `parley hook PreToolUse`** and pipes the tool payload in as
   JSON on stdin. Note what this is *not*: it is not a shell one-liner. No `jq`,
   no pipes, no `&&`. On Windows a hook runs under `cmd.exe`, where none of that
   exists — that is precisely how "cross-platform" tools break in practice.

2. **The hook locates the repository.** `git rev-parse --git-common-dir` gives
   the bus key shared by every worktree. Canonicalisation reduces it to one
   string both sides of the WSL boundary agree on, and sha256 truncated to 16 hex
   makes the `repo-id`.

3. **The client reads `endpoint.json`** and connects. If the file is missing, or
   present but nobody answers, the client spawns a daemon itself — detached,
   `stdio: 'ignore'`, `windowsHide: true`, `unref()`ed — waits for the endpoint
   to appear, and connects. No command requires a running daemon. The mental
   model is `gpg-agent`, not `dockerd`.

4. **The hook joins.** Same name, same worktree, so this is a re-attach: same id,
   same read cursor, lease renewed. Hooks fire on every tool call, so this is the
   renewal mechanism that keeps a CLI-only front alive.

5. **The daemon expires first, then journals, then applies.** In that order:
   `tick()` so stale claims cannot win, `journal.append()` so a crash between
   here and the response costs nothing, then `apply()`.

6. **Territory is settled in the same call.** The path is normalised to POSIX
   relative form and auto-claimed. Free path → claimed, hook returns the inbox as
   context. Held by someone else → `enforced` returns a `permissionDecision:
   "deny"` naming the owner and telling the agent to run `parley ask`;
   `advisory` returns a warning as context and lets the edit through.

7. **Other sessions get a push** on their open connections. Sessions without one
   see the same event on their next `drain`.

The whole path is one connection, one round trip, and it has a hard time budget.
If it overruns, the hook emits `{}` and lets go. The agent never waits for parley.

---

## 5. Presence, which is genuinely two mechanisms

This looks like duplication and is not. Two kinds of client exist and they have
opposite lifetimes.

**A persistent connection** — an MCP server process, or the panel — lives as long
as the session does. When the socket closes, the daemon knows immediately and
exactly. For these, connection *is* presence.

**An ephemeral hook** connects, sends one frame, and exits, several times a
minute. Presence cannot depend on it staying, because staying is the one thing it
never does. For these, presence is a **lease with a TTL**, renewed by every call.

A participant is alive if `connected || (now - lastSeen) < leaseTtl`. When
neither holds, the front is marked gone, its claims are stamped `orphanedAtMs`,
and the bus announces *"FINANCEIRO dropped holding 3 claim(s)"* at high priority.
After the 60-second grace period the claims are released.

The grace period exists because a session that is merely restarting should get
its territory back, not have to fight for it.

---

## 6. Territory: why overlap is deliberately imprecise

Two claims conflict if some concrete path could be covered by both. For two
arbitrary globs, deciding that exactly is regex intersection — expensive and
error-prone.

parley segments both patterns and walks them together. `**` consumes any number
of segments; `*` and `?` stay inside one; literals must match. When both sides
carry a wildcard in the same position and neither is literal, the answer is
**"maybe", which is treated as conflict**.

That asymmetry is the whole design:

> A false conflict costs one conversation. A false clear costs two agents editing
> the same file and finding out from CI.

A wildcard-free pattern that names a directory also covers everything beneath it,
because `parley claim src/backend` obviously means the directory. Directory-ness
is decided by the last segment: a dot after the first character reads as a file
(`app.ts`), a leading dot or no dot at all reads as a directory (`.github`,
`backend`). It is wrong for a directory literally named `v1.2` — write `v1.2/**`
when that happens. Without the heuristic, `**/*.py` would "conflict" with
`src/app.ts` through a `src/app.ts/x.py` that can never exist, and eventually
every claim would collide with every other.

---

## 7. Durability: journal before response

```ts
this.journal.append({ at: ctx.now, actorId: conn.participantId, frame });
const outcome = apply(this.state, conn.participantId, frame, ctx);
this.send(conn, outcome.response);
```

Those three lines are in that order on purpose, and it is the only reason the
daemon can be killed with impunity. If the process dies between the append and
the response, the client sees a dropped connection and retries; the event is
already durable. If it died in the other order, the client would believe it held
a claim that no longer existed anywhere.

Replay reconstructs state by feeding every journalled frame back through `apply`
with a `Ctx` rebuilt from the recorded timestamp. Because ids are generated from
a deterministic counter and the frame order is identical, the reconstruction
produces the same ids as the original run.

A line that fails to parse is dropped with a warning on stderr. That is not
sloppiness: a torn final line is exactly what `kill -9` leaves behind, and
refusing to boot because of it would trade one lost event for a dead bus.

---

## 7.1 What one bus covers

By default: one repository, keyed on `git rev-parse --git-common-dir`, which is
what every worktree of that repository shares.

A VS Code multi-root workspace breaks that assumption — a session edits several
repositories and would join whichever bus its working directory happened to sit
in. Marking the directory makes it the bus instead, and membership comes from
the `.code-workspace` file rather than from what is on disk: the folder holding
seven projects usually holds twenty others that have nothing to do with them.

Two details that only show up in use:

- **Paths are compared after resolving symlinks.** `/tmp` is a symlink to
  `/private/tmp` on macOS, home directories are symlinked on plenty of setups,
  and a harness may hand over either spelling. Comparing them as text made a
  session inside a workspace fall back to its own repository bus, silently.
- **The adapter is installed per folder.** Claude Code reads its skill from the
  folder a session was opened in, which in a workspace is a member and never the
  root. Installing only at the root produces a setup that looks complete and
  does nothing.

## 8. The WSL boundary

WSL and native Windows are two operating systems on one machine. They do not
share a named-pipe namespace, so the normal transport cannot bridge them.

Detection: running under WSL (`WSL_DISTRO_NAME`, or `microsoft` in
`/proc/sys/kernel/osrelease`) **and** the repository lives under `/mnt/<drive>/`.
Both conditions, because a Linux box with a real `/mnt/c` is not a boundary case.

When detected, the transport becomes TCP on `127.0.0.1` with an ephemeral port
and a mandatory random token, published in `endpoint.json`.

**Which side hosts matters.** Under WSL2's default NAT networking, Windows can
reach services inside WSL on `localhost`, but WSL cannot reach the Windows
`127.0.0.1`. So when the boundary is detected, the daemon prefers to be born on
the Linux side. With `networkingMode=mirrored` (Windows 11) both directions work
and the preference stops mattering.

`parley doctor` prints all of this, and when the boundary is active it explains
the asymmetry in prose rather than leaving a bare `ECONNREFUSED` behind.

---

## 9. Testing strategy

- **Pure state machine tests** — races, expiries, orphaning, timeout grants. No
  I/O, deterministic clock, microseconds to run.
- **Path canonicalisation battery** — Windows drives, `/mnt/c`, symlinks,
  case-folding, inverted separators. The single most important assertion in the
  suite is that `C:\dev\proj` and `/mnt/c/dev/proj` hash to the same `repo-id`.
- **Integration tests with a real daemon** on a real socket in a temp directory,
  driven by a minimal hand-written NDJSON client rather than parley's own client —
  so the test exercises the wire, not our abstraction over it. This is where the
  two-clients-one-path race is verified for real, along with crash recovery from
  the journal and a deliberately torn final line.

```bash
bun test
```

---

## 10. Distribution

TypeScript compiled with `bun build --compile` into a standalone binary. No
runtime is assumed on the target machine — Codex is Rust, Kimi is Python,
Antigravity is an IDE, and none of them imply Node.

Startup is roughly 35 ms, which matters more than it looks: the `PreToolUse` hook
runs on **every single tool call**. A 300 ms startup would be felt in every edit
the agent makes.
