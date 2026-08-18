# The parley protocol, version 1

This document is the open core of the project. The CLI, the hooks, the MCP
server and the panel are adapters over it. **Reimplementing parley in another
language means implementing this document.**

---

## 1. Transport and framing

### 1.1 Framing

NDJSON, bidirectional, over a single connection. **One line, one JSON object,
terminated by `\n`.**

The server also emits **unsolicited frames** on the same connection — inbox push
and territory events. A client must therefore never assume request/response
lockstep. The rule for telling them apart:

> A frame with `"op": "push"` is unsolicited. Anything else is the response to
> the oldest request the client has not yet had answered.

Clients that send requests serially can match responses by order. Clients that
pipeline must serialise or add their own correlation.

Blank lines are ignored. A line that is not valid JSON, or that parses to
something other than an object, is answered with an error frame; it never kills
the connection. Implementations should cap line size (parley uses 4 MiB) so a
peer that never sends a newline cannot exhaust memory.

### 1.2 Addresses

Named IPC per operating system, never a port — zero port conflicts, isolation by
file permission.

| OS | Address |
|---|---|
| Linux | `$XDG_RUNTIME_DIR/parley/<repo-id>.sock`, falling back to `~/.local/state/parley/run/` |
| macOS | `~/Library/Application Support/parley/run/<repo-id>.sock` |
| Windows | `\\.\pipe\parley-<repo-id>` |
| WSL ↔ Windows boundary | TCP on `127.0.0.1:<ephemeral>` **plus a token** |

`sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux. A long username
plus a long application-support path overruns it, and `bind()` then fails with a
message that names none of this. Implementations must check the byte length of
the socket path and fall back to a short directory (parley uses `$TMPDIR/parley/`)
when it would not fit.

**Nothing listens on the network in any case.** The only TCP mode is the WSL
boundary, and it binds exclusively to `127.0.0.1` with a mandatory token.

### 1.3 Authentication

Only in loopback (TCP) mode. The first frame on a connection must be:

```json
{"op":"auth","token":"<secret from endpoint.json>"}
```

Any other frame before a successful `auth` is answered
`{"ok":false,"error":{"code":"AUTH_REQUIRED"}}`. Without this, loopback TCP would
be an open bus for every process on the machine.

---

## 2. Bus identity

The bus key is `git rev-parse --git-common-dir` — **not** the session directory.
Every worktree of a repository shares one common dir, so five sessions land on
the same bus with no configuration.

Canonicalisation is mandatory before hashing. Without it `C:\Repo` and `c:\repo`
become two buses that never see each other.

1. Resolve to a real absolute path, following symlinks.
2. Convert separators to `/`.
3. If the path is on a Windows drive — `C:\...` **or** `/mnt/c/...` when running
   under WSL — reduce it to the canonical form `c/dev/proj`. **This must happen
   on both sides of the WSL boundary**, so that `C:\dev\proj` and
   `/mnt/c/dev/proj` produce the same string.
4. Case-fold only where the filesystem is case-insensitive. A Windows drive is
   case-insensitive regardless of which OS is reading it — under WSL, the
   filesystem flag describes the Linux root, not `/mnt/c`.
5. `sha256`, truncated to **16 lowercase hex characters** → `repo-id`.

The `/mnt/<drive>` reduction must be gated on actually running under WSL. A plain
Linux box may legitimately have a real `/mnt/c`, and merging it would join two
unrelated repositories onto one bus.

---

## 3. Discovery

The daemon publishes its address at `<git-common-dir>/parley/endpoint.json`:

```json
{
  "protocol": 1,
  "pid": 48213,
  "transport": "pipe",
  "address": "\\\\.\\pipe\\parley-9f2c1a7b3e5d8c04",
  "os": "win32",
  "token": null,
  "started_at": "2026-08-18T14:02:11.310Z"
}
```

This file is visible to every worktree **and to both sides of the WSL boundary** —
`C:\dev\proj\.git` and `/mnt/c/dev/proj/.git` are the same bytes on the same
disk. One discovery mechanism covers every scenario.

An entry left by a dead daemon is detected **on connection**, not by inspecting
the pid: pids are meaningless across the WSL boundary. Whoever fails to connect
claims the entry and spawns a new daemon.

In loopback mode, `token` carries a random secret and `port` carries the bound
port.

---

## 4. Versioning

Every frame carries `"v": 1`. A daemon that receives a different version answers:

```json
{"ok":false,"error":{"code":"PROTOCOL_MISMATCH",
 "message":"this daemon speaks v1, the client sent v99","server":1,"client":99}}
```

Naming both versions is the point. Failing obscurely on a version skew is how
protocols become impossible to debug in the field.

---

## 5. Error codes

A closed list. Anything outside it is a protocol violation.

| Code | Meaning |
|---|---|
| `NAME_TAKEN` | The requested name is in use by a live participant in a different worktree. The response carries `suggestion`. |
| `CONFLICT` | The requested territory overlaps a claim held by someone else. The response carries `conflicts`. |
| `NOT_OWNER` | You tried to release, grant or deny something that is not yours, or a request that is already settled. |
| `NOT_JOINED` | The connection has no participant bound to it. |
| `UNKNOWN_OP` | Unrecognised `op`, or a malformed frame. |
| `PROTOCOL_MISMATCH` | Version skew. Carries `server` and `client`. |
| `AUTH_REQUIRED` | Loopback mode, and `auth` has not succeeded on this connection. |
| `OBSERVER_ONLY` | A participant with `kind: "human"` tried to `grant` or `deny`. A human has a voice, not a vote. |

Success is always `{"ok": true, ...}`. Failure is always
`{"ok": false, "error": {"code": ..., "message"?: ...}, ...}`. Extra detail that
a caller needs to act on — `conflicts`, `suggestion` — travels at the **top
level** of the response, so that acting on a failure never requires a second
round trip.

---

## 6. Operations

### 6.1 Participation

#### `join`

```json
→ {"v":1,"op":"join","name":"FINANCEIRO","mission":"month-end closing",
   "harness":"claude-code","cwd":"/repo/.claude/worktrees/fin","kind":"agent"}
← {"ok":true,"id":"p_0001","name":"FINANCEIRO","mode":"advisory","peers":[…],"inbox":[]}
```

- **`session` is what identity is keyed on**, not the name: an opaque string
  stable for the lifetime of one agent session (the harness session id, where
  there is one). Same `session` always means the same front, whatever name it
  is currently using, and the name it is *already* using wins over whatever the
  caller re-derived. Without this, a hook that re-derives a name from the
  worktree on every tool call recreates a front the moment the agent renames
  itself, and merges two sessions that happen to share a branch.
- Re-attaching also **renews territory**: claims orphaned while the front was
  quiet are un-orphaned. A session that paused to think, or to wait on a person,
  must not lose files it is still holding.
- The response carries `claims`, your own territory with `idle_s` per path, so a
  hook can remind the agent to release what it has finished with without a
  second round trip.
- `name` is chosen by the agent. `kind` is `"agent"` or `"human"`; a panel or a
  person at a terminal joins as `human`.
- **Re-attach:** the same `name` from the same `cwd` is the same front coming
  back. It re-attaches, keeps its id and read cursor, and renews its lease. This
  is what makes the ephemeral hook path viable — a hook connects, speaks and
  exits on every single tool call, and must not collide with itself.
- A different `cwd` with the same name is a genuine collision:
  `{"ok":false,"error":{"code":"NAME_TAKEN","suggestion":"FINANCEIRO-2"}}`.
- A participant that previously left reclaims its own id and cursor, so a
  crash-and-restart does not replay the whole conversation at it.
- A fresh participant's read cursor starts at the current sequence number, set
  *after* its own join is announced, so a front never drains the announcement of
  its own arrival. New sessions are not flooded with history; a panel that wants
  backlog asks for it with `history`.
- A participant that had left keeps the cursor it had, so it catches up on
  everything said while it was away.

#### `rename`

```json
→ {"v":1,"op":"rename","name":"FINANCEIRO","mission":"month-end closing"}
← {"ok":true,"id":"p_0001","name":"FINANCEIRO","mission":"month-end closing"}
```

What an agent calls after a hook enrolled it under a provisional name derived
from the worktree or branch. Either field may be omitted to change only the other.

#### `leave`

```json
→ {"v":1,"op":"leave"}
← {"ok":true,"released":["src/backend/finance/**"]}
```

Leaves and hands territory back immediately — no orphan grace period, because
this is a clean exit.

#### `who`

```json
← {"ok":true,"mode":"advisory","participants":[
    {"id":"p_0001","name":"FINANCEIRO","mission":"month-end closing",
     "harness":"claude-code","kind":"agent","connected":true,
     "since":"2026-08-18T13:50:00Z","idle_s":12,
     "claims":["src/backend/finance/**"]}]}
```

This is the memory of "who touches what" that a markdown board never had.

### 6.2 Conversation

#### `say`

```json
→ {"v":1,"op":"say","to":null,"text":"touching alembic, check your heads","priority":"normal"}
← {"ok":true,"seq":128,"event":{"seq":128,"kind":"say","from":{…},"to":null,
    "priority":"normal","text":"touching alembic, check your heads","at":"…"}}
```

The receipt carries the whole event back. `drain` never returns your own
messages — right for an agent, wrong for whoever is typing, who would otherwise
get no evidence at all that anything was sent. A client that appends this event
locally cannot end up showing it twice, precisely because `drain` will not
repeat it.

`to: null` is broadcast; `to: "NAME"` is directed. A directed message is private
between the two fronts — but **not from a human**, who receives every event on
the bus regardless of addressee. A person is accountable for what happens in
their repository, and coordination they cannot see is coordination they cannot
correct. This is a local development tool, not a privacy boundary between an
agent and its operator. A message from a participant
with `kind: "human"` is **always** delivered at `priority: "high"` and arrives
marked as human, so the agent weighs it above a peer's opinion.

But the human voice guides and never gates. An agent must not wait for a human,
must not ask one to decide, and must treat silence as the normal case — a person
may be watching the whole session and say nothing. See §6.7.

#### `drain`

```json
→ {"v":1,"op":"drain"}
← {"ok":true,"events":[
     {"seq":129,"kind":"say",
      "from":{"id":"p_1","name":"Marcus","kind":"human"},
      "to":null,"priority":"high","text":"do not drop any column today",
      "at":"2026-08-18T14:31:02Z"}]}
```

The read cursor is **per participant**, so each front drains only what it has not
seen. A participant never receives its own messages. Directed messages reach only
their addressee. `drain` advances the cursor to the current sequence number.

#### `history`

```json
→ {"v":1,"op":"history","limit":200}
← {"ok":true,"events":[…]}
```

The last N events this participant may see, **without moving the read cursor**.
Same visibility rules as `drain`, plus your own messages. `limit` is clamped to
1000; `since` returns only events after that sequence number.

The response also carries `cursor` (where a plain `drain` would resume) and
`seq` (the newest event on the bus). **Normal reading is `drain`, which is
incremental by construction** — a participant only ever receives what it has not
seen, so polling costs nothing when nothing happened. `history` is the escape
hatch for a front that lost its own context and wants to re-read a window it
names.

A joining agent deliberately starts at the current sequence number: nobody wants
a fresh session flooded with an hour of backlog it cannot act on. A panel is the
opposite case — you open it precisely to see what has been going on. So backlog
is a separate request rather than a different kind of join.

### 6.3 Territory

#### `claim`

```json
→ {"v":1,"op":"claim","paths":["src/backend/finance/**"],"intent":"closing refactor"}
← {"ok":true,"claimed":["src/backend/finance/**"],"auto":false}
```

On conflict:

```json
← {"ok":false,"error":{"code":"CONFLICT"},
   "conflicts":[{"path":"src/backend/finance/services.py",
                 "owner":{"id":"p_1","name":"TESTE-CAMPO","mission":"route incidents"},
                 "since":"2026-08-18T13:50:00Z","auto":false}]}
```

The conflict answer already carries owner, mission and since — enough for the
agent to choose between asking and waiting, without a second call.

Rules:

- Paths are always **POSIX, relative to the repository root, normalised**. A path
  that escapes the root is refused.
- A batch is **all-or-nothing**. The whole set is checked before anything is
  taken, so a partially granted claim can never exist.
- Conflicts are resolved by **arrival order at the daemon**.
- A wildcard-free pattern naming a directory also covers everything beneath it.
- Overlap between two wildcard patterns that cannot be compared exactly resolves
  to **conflict**, never to clear.
- `"auto": true` marks an auto-claim, taken by a first edit rather than declared.
  It expires after 15 idle minutes. An explicit `claim` over an existing
  auto-claim **promotes** it, and it stops expiring.

#### `release`

```json
→ {"v":1,"op":"release","paths":["src/backend/finance/**"]}
← {"ok":true,"released":["src/backend/finance/**"]}
```

`{"all": true}` releases everything you hold. Releasing someone else's claim is
`NOT_OWNER`.

**Releasing settles whoever was waiting.** Any pending request for a path covered
by what you just let go is granted automatically, the requester is handed the
claim so nobody can slip in between, and it is announced:

> `FINANCEIRO released src/state/machine.ts; TESTE-CAMPO was waiting for it and now has it`

The response carries `settled`, the number of requests resolved this way. The
same happens on `leave`, since leaving is releasing.

Requiring the owner to release *and* answer would be asking twice for one
decision, and the second half is exactly the half an agent forgets — leaving
somebody blocked on a file that is already free. Requests already `granted`,
`denied` or `granted_by_timeout` are untouched.

### 6.4 Permission

#### `ask`

```json
→ {"v":1,"op":"ask","path":"src/backend/finance/services.py",
   "reason":"add one column","ttl_s":300}
← {"ok":true,"request":"r_0003","state":"pending","owner":"FINANCEIRO",
   "expires_at":"2026-08-18T14:36:02Z"}
```

**Asking only becomes a request when somebody actually holds the path.** If it is
unclaimed, or already yours, the answer is immediate and no request object is
created at all: `{"ok":true,"state":"granted","reason":"unclaimed"}`. There is
nothing to ask. This is what keeps a pending list meaningful — anything in it is
a real contention between two fronts, not protocol ceremony.

Otherwise the owner is pushed a high-priority directed event naming the path,
the reason, the request id and the remaining time.

#### `grant` / `deny`

```json
→ {"v":1,"op":"grant","request":"r_0003","scope":"once"}
← {"ok":true,"request":"r_0003","state":"granted","scope":"once"}
```

- `scope: "once"` carves the single path out of the owner's territory and hands
  it to the requester.
- `scope: "transfer"` moves the whole overlapping claim to the requester.
- `deny` takes a `reason`, which is delivered to the requester.
- **Only the owner may answer.** Not a human, not another front. A settled
  request cannot be answered again.

State machine: `pending → granted | denied | granted_by_timeout`.

#### Expiry grants, loudly

An unanswered request becomes `granted_by_timeout` and produces a **broadcast
that names who did not answer**:

> `TESTE-CAMPO took src/backend/finance/services.py by timeout; FINANCEIRO did not answer in 5 min.`

Default TTL 5 minutes, configurable per request via `ttl_s`. The reasoning: an
idle agent is the most expensive waste in the system, so the deadline concedes —
and the visibility is what stops it from becoming a habit.

### 6.5 Durable memory

#### `note`

```json
→ {"v":1,"op":"note","title":"CI here runs tsc -b, not tsc --noEmit",
   "body":"the root tsconfig is solution-style (references only)…",
   "tags":["ci","backoffice"]}
← {"ok":true,"id":"n_0007"}
```

#### `notes`

```json
→ {"v":1,"op":"notes","tag":"ci"}
← {"ok":true,"notes":[…]}
```

`.parley/notes.md` is **written by the daemon on every accepted `note`**, so the
versioned file is always current without anyone remembering an export step.
`parley notes --export` forces a rewrite, and `parley notes --import` reads the
file back onto the bus — which is how a fresh clone, or a daemon whose state was
lost, picks up what the team already knows.

Automatic *commit* is deliberately out of scope: a human or an agent commits it,
on purpose.

### 6.6 Listing pending requests

```json
→ {"v":1,"op":"requests","all":false}
← {"ok":true,"requests":[
     {"id":"r_0003","path":"src/backend/finance/services.py",
      "requester":"TESTE-CAMPO","owner":"FINANCEIRO","reason":"add one column",
      "state":"pending","created_at":"2026-08-18T14:31:02Z",
      "expires_at":"2026-08-18T14:36:02Z","seconds_left":240}]}
```

An `ask` is pushed only to the owner, so an observer — a panel, or a front that
joined mid-flight — has no way to learn about one from the event stream alone.
This is that way. `"all": true` includes settled requests.

### 6.7 Humans on the bus

A participant may join with `kind: "human"`. The rules that follow are enforced
by the daemon, not by whichever interface the person happens to be using —
otherwise they would hold only for as long as every client behaved.

| A human… | |
|---|---|
| `join`, `who`, `drain`, `requests`, `notes`, `status` | **allowed** — this is what watching is |
| `say` | **allowed**, always delivered at `priority: "high"`, marked as human |
| `grant`, `deny` | **refused** with `OBSERVER_ONLY` |

The reasoning: permission disputes are for the fronts to settle among
themselves. If a human could arbitrate, an unanswered request would degrade into
a request for a person's attention, and the autonomous flow would acquire a
human-shaped bottleneck — which is the exact failure the five-minute expiry
grant exists to prevent.

So a human is an observer with a voice. Participation is optional and silence is
the expected state. An interface built on this protocol should reflect that
posture: parley's own panels ship read-only, and only grow an input when the
person explicitly asks for one.

### 6.8 Mode and status

```json
→ {"v":1,"op":"mode","mode":"enforced"}
← {"ok":true,"mode":"enforced","previous":"advisory"}
```

Sending `mode` with no `mode` field reads the current value. The change is
broadcast at high priority, because it applies to every front on the bus.

```json
→ {"v":1,"op":"status"}
← {"ok":true,"protocol":1,"mode":"advisory","seq":128,"participants":2,
   "claims":4,"pending_requests":1,"notes":7}
```

---

## 7. Server-initiated frames

```json
← {"v":1,"op":"push","events":[{"seq":130,"kind":"system","from":null,
    "to":null,"priority":"high","text":"FINANCEIRO dropped holding 3 claim(s): …",
    "at":"2026-08-18T14:40:00Z"}]}
```

A `push` is delivered only to connections with a bound participant, filtered by
the same visibility rules as `drain` (not your own events; broadcast or addressed
to you), and it advances that participant's read cursor. A client that is not
connected persistently simply sees the same events on its next `drain`.

---

## 8. Time-driven rules

None of these fire on their own. The daemon evaluates them on a timer and before
every command, so a bus nobody touches never invents events.

| Rule | Default | Behaviour |
|---|---|---|
| Auto-claim TTL | 15 min | An auto-claim with no fresh edit is released and announced. Explicit claims are exempt. |
| Presence lease | 5 min | A participant with no live connection that stops renewing is marked gone. Every call renews it. |
| Orphan grace | 60 s | A dead front's claims are announced immediately, then released after the grace period. |
| Permission TTL | 5 min | An unanswered request is granted and announced by name. |
| Idle shutdown | 30 min | Zero connections for this long and the daemon exits, cleaning up its endpoint and socket. |

**Note on interaction:** with the defaults, the 5-minute presence lease fires
before the 15-minute auto-claim TTL. For a CLI-only front, death by lease is what
frees territory; the auto-claim TTL matters for fronts kept alive by a live
connection or by constant hook renewal. This is intentional, and tested.

---

## 9. Durability

**Every accepted frame is written to the journal before its response is sent.**
This ordering is the entire crash story: `kill -9` costs neither territory nor
history, because the next spawn replays `<state>/<repo-id>/journal.ndjson` and
rebuilds.

On replay, a line that does not parse is discarded with a warning on stderr and
the daemon boots anyway — a partially written last line is exactly what a `kill
-9` produces, and refusing to start because of it would be worse than losing one
event.

Nothing survives a restart `connected`. Presence must be re-proven.

---

## 10. Degradation

| Failure | Required behaviour |
|---|---|
| Daemon died | The next command spawns one; it rebuilds from the journal. Sessions re-attach on their next hook. |
| Daemon unreachable | `enforced` **degrades to `advisory`** with a loud warning. |
| Hook slow | Hard time budget. Overrun means let go; the agent never waits for parley. |
| Journal truncated | Drop the bad line, warn, boot. |
| Duplicate name | Refuse with a usable suggestion. |
| Version skew | `PROTOCOL_MISMATCH` naming both versions. |
