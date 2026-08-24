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
| `OBSERVER_ONLY` | An agent tried `brain enable`/`brain disable`. Spending somebody's disk and somebody's money is the person's call, not a front's. |
| `NOT_TAKEN` | A work item you cannot act on: `done` on someone else's, `drop` on one neither offered to you nor taken by you, or either on one already `done` — including a `done` you sent twice. |
| `NO_CAPACITY` | Reserved for the front-birth ceiling. **No operation returns it yet**; it is in the closed list so a client written against this version already knows it. |

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
     "claims":["src/backend/finance/**"]}],
   "births":{"allowed":true,"max":6,"live":1}}
```

`births` is whether parley may start more fronts, the ceiling from `spawn.json`,
and how many agent fronts are live against it — carried here so a panel showing
that switch needs no second round trip. See `summon` in §6.9.

This is the memory of "who touches what" that a markdown board never had.

#### `wake`, and the one front parley may wake

`join` may carry `wake`: **an address the front's own harness published for
it**, and nothing else. Claude Code puts one in `CLAUDE_CODE_MESSAGING_SOCKET`;
a front reads its own environment and reports what it finds. parley never
writes this field and never uses it to act — it hands the address back to
whoever asked that front a question and has been waiting, so *they* can wake it
with the session tool their own harness gives them. It is kept to the shape of
an address: one line, at most 512 characters. Anything else is not recorded.

The reason parley does not do the waking is stated in `src/state/types.ts` and
holds for every front a person opened: the format belongs to the harness, and
guessing it means sending malformed bytes into somebody's live session.

**A front parley started is the one place that reasoning does not apply**, and
it is worth stating because it is the only exception in the protocol. parley is
the parent of that process: it chose the command, it holds the pipes, and
`born: "parley"` on the participant is what records it. That is what licenses
the two things parley will do to such a front and to no other — invite it to
retire when the pool is empty, and collect its worktree once it has gone — and
neither of those is anything a person's session can be subjected to.

What that exception does **not** license today is waking. A front parley bears
is started as a one-shot run (`claude -p …`) with its standard input closed,
and in `terminal` mode the process parley holds is the terminal launcher rather
than the agent. So parley owns the newborn's *output*, not its attention: see
`output` below, which is why the panel is a newborn's window.

`born` is set once, from `PARLEY_BORN`, at the join that creates the
participant, and is never revised by a later frame. The only direction a
revision could take is `person` → `parley`, which would make somebody's own
session retirable by a frame anyone can send.

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

Outside `shape: "bus"` the response also carries **`pool`**: a short plain-text
footer naming the work items offered to this participant (at most three, then a
count) and how many are open to anybody. It rides here rather than behind a
second request because `drain` is already on the hottest path in the system, and
a client that has nothing to show simply gets `""`. Every command a hook or an
MCP tool answers appends it; the hook returns that do not drain — `SessionStart`,
`Stop`, `SessionEnd`, and an edit denied under `enforced` — carry neither the
inbox nor the pool.

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

### 6.2.1 Questions, when a message is not enough

```json
→ {"v":1,"op":"question","to":"BUSSOLA","text":"are you holding finance/services.py?","ttl_s":600}
← {"ok":true,"question":"q_0003","to":"BUSSOLA","expires_at":"…"}
```

A `say` lands in an inbox that an idle session will not read until its person
prompts it again — so a direct question to a stopped agent goes unanswered for
as long as its window sits there. A question carries state: **somebody owes an
answer.** That is what lets a harness refuse to let the recipient go idle, and
what lets the asker wait instead of guessing.

```json
→ {"v":1,"op":"reply","id":"q_0003","text":"not touching it, go ahead"}
→ {"v":1,"op":"ack","id":"q_0003","text":"got it, doing the edit now"}
```

- Only the addressee may `reply`, and only once. Only the asker may `ack`, and
  only after an answer exists.
- `ack` closes the loop. Without it the front that answered has no idea whether
  the answer arrived, and the asker has no natural place to say what it is doing
  with it.
- `question_status` (with `id`) lets the asker poll: `answered`, `answer`,
  `expired`, `seconds_left`.
- Questions expire (default 10 minutes), so nobody waits forever on a session
  that died.

```json
→ {"v":1,"op":"questions","deliver":true}
← {"ok":true,
   "owed":[…],            // you have not answered these
   "undelivered":[…],     // …and have not been interrupted about them yet
   "waiting":[…],         // you asked, still open
   "answered":[…],        // answers that arrived
   "unseen_answers":[…]}  // …that you have not been shown yet
```

**`deliver: true` stamps what it returns as delivered**, and an already-stamped
item never appears in `undelivered` or `unseen_answers` again. That single bit
is the whole loop guard: each question interrupts its recipient exactly once and
each answer interrupts its asker exactly once, after which they are ordinary
inbox items. Two agents cannot push each other round in a circle.

A client that only wants to look, and not to consume the nudge, omits `deliver`.

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
- **Only the owner may answer.** Ownership decides, not `kind` — a human
  holding the path answers exactly like an agent holding it would; anyone
  else, human or agent, is refused `NOT_OWNER`. A settled request cannot be
  answered again.

State machine: `pending → granted | denied | granted_by_timeout`.

#### Expiry grants, loudly

An unanswered request becomes `granted_by_timeout` and produces a **broadcast
that names who did not answer**:

> `TESTE-CAMPO took src/backend/finance/services.py by timeout; FINANCEIRO did not answer in 5 min.`

Default TTL 5 minutes, configurable per request via `ttl_s`. The reasoning: an
idle agent is the most expensive waste in the system, so the deadline concedes —
and the visibility is what stops it from becoming a habit.

### 6.4.1 Nudging permission, symmetrically

`requests` accepts the same `deliver` bit, and answers with what *this*
participant still has to do about permission:

```json
→ {"v":1,"op":"requests","deliver":true}
← {"ok":true,"requests":[…],
   "needs_my_decision":[…],   // you own the path, someone is blocked
   "settled_for_me":[…],      // you asked, it was granted or denied
   "i_am_waiting_on":[…]}
```

Each side is stamped once, for the same reason as questions: a harness can
refuse to go idle on the strength of it without the two fronts trapping each
other.

### 6.5 Durable memory

#### `note`

```json
→ {"v":1,"op":"note","title":"CI here runs tsc -b, not tsc --noEmit",
   "body":"the root tsconfig is solution-style (references only)…",
   "tags":["ci","backoffice"]}
← {"ok":true,"id":"n_0007"}
```

#### Anchoring a note to the files it is about

```json
→ {"v":1,"op":"note","title":"this serializer is used by the mobile app too",
   "body":"renaming fields here breaks the collection screen",
   "paths":["src/backend/app/accounts/schemas.py"],"tags":["mobile"]}
```

`paths` is what makes a note find its reader. **A note anchored to a path comes
back from `claim` when anybody takes that path** — inside the answer to a call
the pre-tool hook was already making, with no extra round trip. It inverts who
does the remembering: the agent does not have to think to ask. And it fires only
on the file in question, which is what keeps unsolicited context rare and
precise instead of a running commentary.

#### Decisions, and reversing them

```json
→ {"v":1,"op":"note","kind":"decision","title":"no Pydantic v2 yet",
   "body":"the mobile serializers depend on v1 coercion"}
→ {"v":1,"op":"reverse","id":"n_0007","reason":"v2 shipped the compat layer"}
```

A `decision` is broadcast at high priority and **binds until reversed**. It
exists so the next front does not relitigate a settled question. `reverse` keeps
it on the record and stops it binding — the difference between reversing and
deleting, and the reason a reversed decision stays readable.

#### `notes`

```json
→ {"v":1,"op":"notes","path":"src/app.ts","tag":"ci","kind":"decision","active":true}
← {"ok":true,"notes":[…]}
```

All four filters are optional and combine.

#### `result` and `results`

```json
→ {"v":1,"op":"result","key":"bun test","status":"pass",
   "summary":"200 pass, 0 fail","paths":["src/**","tests/**"]}
→ {"v":1,"op":"results","fresh":true}
← {"ok":true,"results":[{"key":"bun test","status":"pass",
    "staleBecause":"TESTE-CAMPO touched src/state/machine.ts after this ran"}]}
```

One front runs the suite — minutes of wall clock plus the tokens to read the
output — and another runs the same suite on the same tree ten minutes later,
paying both again.

**Staleness is computed on read**, against the touch log: a result goes stale the
moment anything it depends on is edited, and nothing has to go around
invalidating anything. A result that declares no `paths` is invalidated by *any*
edit — the safe default, because it is better to re-run than to trust a stale
green.

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
| `claim`, `release`, `ask`, `grant`, `deny` | **allowed**, exactly like an agent — none of them is gated by `kind` |
| `summon` with `allow` | **allowed, and refused for an agent** — see §6.9 |

None of the five share one mechanism, and it would overstate things to say so.
`release`, `grant` and `deny` are ownership-gated: refused `NOT_OWNER` unless
the path is the caller's (§5). `claim` is not — it is refused `CONFLICT` on
overlap with anyone's territory, human or agent, regardless of who is asking.
`ask` has no ownership check on the actor at all; asking about a path someone
else holds is the entire point of the op. What all five have in common, and
the only thing this row claims, is that a human hits exactly the same check
an agent would — never a `kind`-only refusal.

**Spending is the one thing that runs the other way.** Starting a front spends
somebody's money on somebody's account, and no front is ever the right one to
decide that — so `summon` with an `allow` field is refused for an *agent* with
the same `OBSERVER_ONLY`, in the opposite direction from every other use of that
code in this document. It is the narrow exception §4.7 of the design describes:
a human here has a voice and not a vote, except on the bill.


`grant` and `deny` refuse with `NOT_OWNER` unless `request.ownerId === me.id`,
for a human the same as for an agent. That check is what keeps this safe: a
person can only ever settle a request for a path they themselves hold, never
arbitrate a dispute between two fronts that has nothing to do with them. A
human editing a file by hand needs exactly the answer this gives: `deny`, so
that "no, I am using this" is something the bus can hear, instead of only
`release` (hand it over) or silence (grant it by timeout).

So a human is a participant with a voice, not a bystander with one — full
standing over whatever territory is theirs, and none at all over anyone
else's. Participation is optional and silence is the expected state: an
interface built on this protocol should reflect that posture, growing an
input only when the person explicitly asks for one.

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

### 6.9 Shape, and where work comes from

`shape` is a second repo-scoped axis, independent of `mode`. Neither enforces
the other: `mode` says how strict territory is, `shape` says where work comes
from.

```json
→ {"v":1,"op":"shape","shape":"pool"}
← {"ok":true,"shape":"pool"}
```

Sending `shape` with no `shape` field reads the current value. `bus`, `pool` and
`plan` are the only accepted values; anything else is `UNKNOWN_OP` and changes
nothing. A change is broadcast at high priority; setting the shape to what it
already is broadcasts nothing. `bus` is the default and the behaviour of every
section above.

#### 6.9.1 The pool

A **work item** is one path. A front publishing three paths creates three items,
because the path is the unit of territory: that is what lets an owner refuse two
files and keep ten.

```json
→ {"v":1,"op":"work","title":"label sem for","paths":["a.html","b.html"],
   "evidence":["n_0003"],"kind":"review","reviewOf":"w_0007"}
← {"ok":true,"items":[
     {"id":"w_0012","path":"a.html","state":"offered","offeredTo":"p_2"},
     {"id":"w_0013","path":"b.html","state":"open","offeredTo":null}]}
```

`title` and at least one path are required; `evidence` is a list of `Note` and
`CommandResult` ids, `kind` is `"work"` (default) or `"review"`, and `reviewOf`
names the item being checked. Refused with `UNKNOWN_OP` in `shape: "bus"`.

Each item is routed **on publish**, never by hand: a path a live participant
already holds becomes `offered` to that participant, and a path owned by nobody
is `open`. Where several live claims match one path, the pattern with more
segments wins; on a tie a literal beats a wildcard; on a further tie the claim
touched least recently. It is a routing hint, not a permission — the loser is
never consulted. **`origin` is not a field a client may set** — see 6.9.3.

```json
→ {"v":1,"op":"works","state":"open"}
← {"ok":true,"work":[{"id":"w_0013","paths":["b.html"],"title":"label sem for",
     "evidenceIds":["n_0003"],"publishedById":"p_1","publishedByName":"CORE",
     "kind":"work","origin":"discovered","state":"open",
     "offeredToId":null,"offeredAtMs":null,"takenById":null,
     "orphanedAtMs":null,"nudgedAtMs":null,"reviewOf":null,
     "at":"2026-08-20T12:00:00Z"}]}
```

`state` filters to one of `open`, `offered`, `taken`, `done`; anything else is
ignored rather than refused. `mine` returns what is offered to you **plus what
you have taken**, `done` items included. The two filters combine, and one
combination is always empty: `{"state":"open","mine":true}` returns nothing for
any participant, because an `open` item has `offeredToId` and `takenById` both
null and `mine` matches on exactly those two. `mine` is ignored altogether on a
connection with no participant bound to it — there is nobody for it to mean.

```json
→ {"v":1,"op":"take","id":"w_0013"}
← {"ok":true,"id":"w_0013","title":"label sem for","paths":["b.html"],
   "evidence":{"notes":[…],"results":[…]},"reviewing":null,"selfReview":false}
```

`take` resolves the item's evidence into the response, so the front that picks
the work up does not repay the discovery. `CommandResult` staleness is
recomputed at read time, exactly as `results` does — a stored result always
claims `staleBecause: null`. `reviewing` is the whole `WorkItem` under review,
or `null`; `selfReview` says whether this review was published by the front
taking it, and is **always present** so `false` is never confused with a build
that does not send it.

An offer is exclusive while it stands: a `take` from anyone but the offeree is
`CONFLICT`, and the response carries `offeredTo: {id, name, mission}` at the top
level so the caller can act without a second round trip. An item already `taken`
or `done` is `CONFLICT` too.

```json
→ {"v":1,"op":"drop","id":"w_0013","reason":"not my mission"}
← {"ok":true,"id":"w_0013","state":"open"}

→ {"v":1,"op":"done","id":"w_0013","summary":"3 labels removed"}
← {"ok":true,"id":"w_0013","state":"done"}
```

`drop` returns the item to the pool and is free: possession bought first
refusal, not obedience. It refuses with `NOT_TAKEN` when the item is neither
offered to you nor taken by you, or is already `done`, and with `NOT_OWNER` for
a planned **task** (6.9.3). `done` is only for the participant holding the item,
and refuses with `NOT_TAKEN` on an item already `done` — a retried `done` is
answered, never applied twice, because the second one would file a second
review. `done` is terminal: no operation moves an item out of it.

#### 6.9.2 Dispatching a plan

`shape: "plan"` adds one operation. The daemon never reads a file: the client
parses the markdown and only the parsed tasks cross the wire.

```json
→ {"v":1,"op":"plan","goal":"…","spec":"docs/…/plan.md","replace":false,
   "tasks":[{"n":1,"title":"Task 1","paths":["a.ts"],"parseError":null},
            {"n":2,"title":"Task 2","paths":["a.ts"],"parseError":null}]}
← {"ok":true,"waves":2,"opened":1,"withdrawn":0}
```

Every task is read rather than trusted. An entry that is not an object, whose
`n` is not a number, or whose `paths` the daemon cannot read refuses the whole
frame with `UNKNOWN_OP` and withdraws nothing. `title` and `parseError` are
coerced instead — anything that is not a string reads as `""` and `null`.

Two fields are refused rather than coerced, because coercing either would make
the daemon assert something the client never sent. `n` is what the waves and
`itemsByTask` are keyed on, and the daemon will not supply one. `paths` is what
the waves are *computed from*, so emptying a `paths` the client did send would
claim the task declared no files and open it in the same wave as a task it
collides with — silently, and indistinguishably from a task that really
declared nothing. `paths` may be omitted, `null` or `[]`, which are three
spellings of "this task declares nothing" and can hide no file name; anything
else must be a list of strings that each read as a repository path. A single
unreadable element refuses the whole frame, and the error names which task and
which element inside it.

The waves are computed from the paths each task declares: tasks whose paths are
disjoint open together, tasks that touch the same file are serialised, and a
task is seated no earlier than one wave past the latest wave holding a task it
collides with. `opened` counts **items**, not tasks — one item per declared
path.

Only wave 0 is published. Each later wave opens by itself once every item of the
current one is `done`, reviews included. Finishing a planned task publishes a
`kind: "review"` item for it, offered to a live participant with `kind: "agent"`
that is not the author, or `open` when there is none.

Refused with `UNKNOWN_OP` outside `shape: "plan"` and for an empty `tasks` list.
**One plan runs at a time:** a second `plan` while the running one still has an
unfinished item is `CONFLICT`. `replace: true` is the way through — it withdraws
every unfinished item of the running plan, reports how many in `withdrawn`, and
dispatches the new plan from wave 0. What the old plan finished is kept.

#### 6.9.3 `origin`, and what a client may not say

Every work item carries `origin`, and it is the field that decides whether the
item can be refused: a `discovered` item is an offer, a `planned` **task** is a
dispatch and `drop` returns `NOT_OWNER` for it. A `planned` **review** is an
offer like any other and can be dropped.

**A client cannot set `origin`.** It appears in `works` output and nowhere in
any request. Honouring it on `work` would let any front publish an item its
offeree is forbidden to hand back, aimed by construction at whoever already
holds the path — the front that discovered the work acquiring authority over the
front that holds the file. `planned` items are created by `plan` and by the
review a `done` spawns, and by nothing else.
### 6.9 Fronts parley started

#### `summon`

```json
→ {"v":1,"op":"summon","reason":"three items in the pool and nobody free"}
← {"ok":true,"summoned":true,"reason":"three items in the pool and nobody free"}
```

A front asking for capacity. Refused with `NO_CAPACITY` at the ceiling
(`maxFronts` in `spawn.json`), and refused with `NO_CAPACITY` while a person has
stopped parley starting fronts.

```json
→ {"v":1,"op":"summon","allow":false}
← {"ok":true,"birthsAllowed":false,"maxFronts":6,"live":2}
```

The same op with an `allow` field is a **different frame with a different
owner**: it settles whether parley may start fronts at all, and only a
participant that joined as `kind: "human"` may send it. An agent gets
`OBSERVER_ONLY`.

The veto stops both routes to a birth — the automatic one in `tick`, and a
front asking by name — and stops nothing else. The pool stays open, every front
already on the bus keeps working, and nothing is retired. It is journalled, so
it survives a restart: a person's decision about their own money is not
something an unrelated daemon restart quietly reverses.

The change is broadcast at high priority, once, on the change. Re-affirming a
veto already in place is not a louder veto.

`who` carries `births: {allowed, max, live}` so a panel can show what the switch
is switching without a second round trip.

#### `output`

```json
→ {"v":1,"op":"output","after":41}
← {"ok":true,"lines":[
    {"n":42,"name":"POOL-1","text":"reading the pool","at":"2026-08-20T12:00:00Z"}]}
```

The tail of what fronts parley bore have printed — stdout and stderr, one line
each, in the order they arrived. `after` is a cursor: pass the highest `n` you
have already seen and only newer lines come back. Omit it for everything the
daemon still holds.

**This is not the bus, on purpose.** Bus events are journalled and drained into
every other front's context; a harness printing its answer there would cost
every agent on the repository the tokens to read it, which is the exact trade
the pool footer exists to avoid. So these lines are held in the daemon, are
never journalled, do not survive a restart, and reach nobody who does not ask.
Panels ask.

The buffer is a ring — the last 300 lines across all newborns, each truncated
to 240 characters — so a runaway child overwrites its own oldest output rather
than growing the daemon. Reading these pipes is also what keeps a newborn from
wedging: a pipe nobody drains fills at 64KB and blocks the child on its next
write, forever.

Only `panel` mode produces any. A front started in `terminal` mode prints into
its own window, which is where a person can already see it.

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
| Offer TTL | 5 min | An `offered` work item nobody answered returns to the pool as `open` and is announced. Matches the permission TTL on purpose: both are a right of first refusal with a deadline. |
| Work orphan grace | 60 s | A `taken` item whose holder is gone is stamped, then returned to the pool as `open` after the grace. Same constant as the claim orphan grace, and a holder that comes back before it elapses keeps the item. |
| Pool doorbell | 10 min | With at least one idle agent front live, every `open` item older than this that has not rung yet is stamped, and **one** message addressed to that front names how many there are. Rung once per item, so nobody is pushed round in circles. Longer than the presence lease on purpose: a front that has not renewed for this long is gone, not idle. |

"Idle" for the doorbell means an **agent** holding no explicit claim and no
taken item. An auto-claim does not count as busy — it is the footprint of an
edit, not a declaration — and a participant with `kind: "human"` is never rung,
because a panel was never going to pick the item up.

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

An entry that parses and then **throws** while being applied is skipped the same
way, named on stderr, and the replay continues with the entries after it. The
frame is journaled before it is applied, so a frame the daemon cannot survive is
already on disk by the time anyone finds out; refusing to boot would make the
repository undispatchable permanently, since restarting is what replays it.
Reducers validate their own frames at the boundary rather than lean on this, so
a skipped entry should mean a bug, not a malformed client.

**The count on stderr is entries, not damage.** Whatever depended on a skipped
entry is refused on replay and writes nothing, so a skipped `join` costs its
whole session while the count still says one. The number of later entries naming
a participant that no surviving entry joined is reported next to it, because
that is the one dependent loss the daemon can measure — a frame is journaled
under the participant its connection was bound to, and that binding only ever
comes from an accepted `join`.

Nothing survives a restart `connected`. Presence must be re-proven.

---

## 10. Degradation

| Failure | Required behaviour |
|---|---|
| Daemon died | The next command spawns one; it rebuilds from the journal. Sessions re-attach on their next hook. |
| Daemon unreachable | `enforced` **degrades to `advisory`**. A command you ran says so on stderr; the pre-edit hook answers with nothing and lets the edit through unclaimed. |
| Hook slow | Hard time budget. Overrun means let go; the agent never waits for parley. |
| Journal truncated | Drop the bad line, warn, boot. |
| Journal entry throws on replay | Skip that entry, name it on stderr, boot with the rest. |
| Duplicate name | Refuse with a usable suggestion. |
| Version skew | `PROTOCOL_MISMATCH` naming both versions. |
