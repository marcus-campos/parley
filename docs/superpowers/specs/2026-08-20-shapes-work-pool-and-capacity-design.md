# Shapes: work pool, capacity, and plans

**Status:** approved design, not implemented
**Date:** 2026-08-20
**Supersedes nothing.** Everything parley does today keeps working unchanged.

---

## 1. The problem this solves

parley today coordinates fronts that already exist. It answers *who is here*,
*who holds what*, *what has been settled*, and *how do I say something before
the collision*. All of that works.

What it has no answer for is the thing that happens next, and it is visible in
any real session:

- A front sweeps the repository and finds sixty-four instances of a defect
  across thirteen files. That work-list exists **only as a chat message**. It is
  not state, nobody can pull from it, and it evaporates with the scrollback.
- Another front is sitting on `no mission`, idle for nearly seven hours, next to
  that list.
- A third front *offers* to take a batch — the right instinct, expressed as
  prose, settled by a human reading the bus and typing an answer.

The human is the router. Every discovery has to pass through their attention to
become work, and every idle front stays idle until they notice.

That is the gap. Discovery has nowhere to land, and capacity has no way to
appear.

---

## 2. Two axes, not one

`mode` already exists and is taken: `off | advisory | enforced`
(`src/protocol/types.ts:5`). It governs **how strict territory is**, it belongs
to the repository, and it is held by the daemon.

This design adds a second, orthogonal axis: `shape`, which governs **where work
comes from**.

| `shape` | the cycle | central object |
|---|---|---|
| `bus` | presence, territory, conversation, notes | the bus |
| `pool` | discover → slice by ownership → offer → pull → provide capacity | the pool |
| `plan` | plan → decompose → dispatch → collect | the plan |

`bus` is exactly what ships today, and is the default. A repository that never
sets `shape` behaves identically to before.

`shape` is repo-scoped for the same reason `mode` is: a front running `bus` in
the middle of a `plan` would ignore dispatch, and the plan would be theatre.

The axes compose. `plan` + `enforced` is the strongest combination: dispatch is
authoritative, and territory blocks any edit outside the dispatched task.

---

## 3. `shape pool`

### 3.1 The primitive

```ts
export interface WorkItem {
  id: string;
  /** Same normalisation as Claim and Note. */
  paths: string[];
  title: string;
  /** Ids of Note and CommandResult. Reference, never a copy. */
  evidenceIds: string[];
  publishedById: string;
  publishedByName: string;
  /** `work` is something to do. `review` is somebody else's work to check. */
  kind: "work" | "review";
  /**
   * Where the item came from, which is what decides whether it can be refused.
   * A discovered item is an offer. A planned item is a dispatch.
   */
  origin: "discovered" | "planned";
  state: "open" | "offered" | "taken" | "done";
  offeredToId: string | null;
  offeredAtMs: number | null;
  takenById: string | null;
  /** Set when the holder dies; returned to the pool after the grace period. */
  orphanedAtMs: number | null;
  /** For `kind: "review"`, the item whose work is being checked. */
  reviewOf: string | null;
  at: string;
}
```

Five new pool ops: `work` (publish), `works` (list), `take`, `drop`, `done`.
Three more belong to the shapes around them: `shape` (§2), `summon` (§4.5) and
`plan` (§5.3). Eight in total, against the twenty-six that exist today.

`kind: "review"` is available in both shapes and means the same thing in each:
somebody else's finished work, published as something to check. In `shape plan`
the coordinator emits one after every task, because superpowers already requires
the review. In `shape pool` a front publishes one voluntarily — which is the
reviewing front people already run by agreement, finally holding a state the bus
can see: who asked, who took it, and whether the verdict was ever applied.

**Deliberately absent:** priority, dependencies between items, due dates, and
assigning an item to a named front. Those are orchestrator features, and they
are the trap — the moment the backlog carries a priority order it has become a
plan, and a plan needs an owner. In `shape pool` there is no owner.

Two new error codes: `NOT_TAKEN` (settling an item you do not hold) and
`NO_CAPACITY` (a birth was requested at the ceiling).

### 3.2 The slicer is already written

`src/repo/paths.ts:105` — `patternsOverlap(a, b)`.

When a front publishes a work-list, slicing is: for each path, find the live
claim that covers it. Covered → `offered` to that owner. Uncovered → `open`, in
the pool.

Sixty-four cases in thirteen files with three owners slices into thirteen items:
some offered, some open. Nobody decided anything. **Possession that already
existed did the routing.**

This is a pure function of `(state.claims, paths)`. No clock, no I/O, exactly
like the rest of `src/state/`. Which means the test that matters — *two owners
whose claims both cover a newly discovered file* — is the same kind of
deterministic unit test the `claim` race already is.

Ownership resolution when two claims overlap the same path: the more specific
pattern wins; on a tie, the older claim wins. Deterministic, and the loser is
not consulted — it is a routing hint, not a permission.

### 3.3 An offer never interrupts

`offered` does nothing to the owner's session. There is no interrupt, no forced
read, no blocking. The owner sees the item on its next interaction, through the
same channel notes already use: the hook footer, the MCP tool-response footer,
or `drain`.

`parley take <id>` or `parley drop <id>`, one line each. Silence for
`OFFER_TTL_MS` and `tick()` returns it to the pool.

This is the same nudge-once discipline `src/state/permissions.ts:204` already
enforces, and for the same reason: a front that can be pushed round in circles
stops reading anything.

**Possession buys the first refusal, not obedience.** A front discovering work
must never acquire authority over a front that holds files. Otherwise the
publisher has become a parent, and parley has grown the hierarchy it exists to
do without.

### 3.4 Evidence travels by reference

A note is already *"delivered to whoever touches that path"*
(`src/state/types.ts:93`). A `CommandResult` already carries the paths that
invalidate it.

`evidenceIds` points at those. A front that runs `take` inherits the sweep that
found the defect, the rule that was worked out, and the trap somebody already
hit — without paying to rediscover any of it.

**This is where the token saving is.** An item without evidence is a chat
message that moved house. An item with evidence is amortised discovery, and it
is the one cost argument that hierarchies cannot match: a parent passes down the
slice it understood; a peer passes down what it learned with its hands in the
file.

### 3.5 `tick()` gains four rules

All time-driven behaviour stays in one function, as it is today.

| condition | effect |
|---|---|
| `offered` unanswered for `OFFER_TTL_MS` | back to `open` |
| `taken` by a front that died, past `ORPHAN_GRACE_MS` | back to `open` |
| pool has `open` items for `ORPHAN_POOL_MS` **and** an idle front exists | ring that front's doorbell |
| pool has `open` items for `ORPHAN_POOL_MS` **and** no idle front exists | provide capacity (§4) |

**Idle** means: alive, holding no explicit claim, and holding no `taken` item.

New defaults, all configurable, all beside the existing ones in
`src/protocol/types.ts`:

```ts
OFFER_TTL_MS:      5 * 60_000,   // matches PERMISSION_TTL_MS on purpose
ORPHAN_POOL_MS:   10 * 60_000,
BIRTH_COOLDOWN_MS: 5 * 60_000,
MAX_FRONTS:        6,
```

---

## 4. Capacity

A pool with eleven orphan items and every front busy is still a stalled pool.
`shape pool` is only complete if supply can move.

### 4.1 This is not work distribution

The README's line — *"parley does not distribute work"* — holds, and the
distinction is load-bearing:

> **parley does not assign work. It provides capacity.**

A newborn front is spawned, joins the bus, reads the pool, and pulls on its own.
Nobody decided what it would do. It is supply, not command — and that is
precisely what separates this from a Conductor or an Orca, which decide *and*
dispatch.

### 4.2 Recycle before creating

Ordering is a rule, not an optimisation. A front idle for seven hours next to an
orphan pool is the larger waste, and reviving it costs nothing: no worktree, no
dependency install, no cold context.

Capacity is only created when the doorbell has been rung and there is nobody to
ring it at.

### 4.3 How a front is born

parley already spawns detached processes — it is how the daemon itself is born
(`detached`, `stdio: 'ignore'`, `windowsHide: true`, `unref()`). And
`src/adapters/registry.ts` already knows which harness is installed where,
because that is what makes one `parley update` reach every project. Birth is the
same spawn pointed at the harness binary instead of at parley.

Configuration lives in `<git-common-dir>/parley/spawn.json`, per repository and
never committed, mirroring `src/cli/panel-config.ts`:

```jsonc
{
  "mode": "panel",            // "panel" | "terminal"
  "harness": "claude-code",   // from the adapter registry when omitted
  "maxFronts": 6
}
```

**`panel`** — headless detached spawn. The front does not vanish: the panel that
already exists (terminal and web, over SSE) becomes its window. You read what it
does there, and the `i say` that already exists talks to it. One implementation
across all four platforms.

**`terminal`** — a real system terminal (`osascript`, `wt.exe`, the VS Code
integrated terminal), which is what a person does by hand today. Three
platform-specific implementations, and it depends on which editor is open.

**`terminal` that cannot open degrades to `panel` and says so loudly.** No
editor, headless execution, Windows on arm64. Same discipline as `enforced`
degrading to `advisory`: a coordination system that stops the work when it fails
is worse than no system.

### 4.4 A newborn front always gets its own worktree

`git worktree add` at birth; removed on death if it has no changes.

Territory resolves **logical** conflict — two agents in one file. It does not
resolve **physical** conflict: the same port, the same `dist/`, the same dev
server, the same `.pytest_cache`. A front born inside an occupied worktree
inherits all of it, and the bus never even finds out.

The bus stays single regardless. It is keyed on `git-common-dir`, which is
exactly what every worktree of a repository shares — so isolating the directory
does not fragment the conversation. This is the property the README already
relies on, used for the case it was built for.

### 4.5 Ceilings, death, and recursion

- `maxFronts` is global and hard. `summon` at the ceiling returns `NO_CAPACITY`.
- At most one birth per `BIRTH_COOLDOWN_MS`. A large pool must not become six
  fronts in ten seconds.
- Both live in `tick()`, the only place with a clock.
- A newborn front with no `taken` item and an empty pool says goodbye by itself.
  Without this you accumulate six idle headless fronts occupying the ceiling and
  none of them working.
- A newborn front may publish work. Its discoveries enter the pool like anyone
  else's. The ceiling and the cooldown are what bound the recursion; no special
  case is needed.

### 4.6 The waking asymmetry

`src/state/types.ts:31` is explicit: parley never writes `wake` itself, because
the format belongs to the harness and guessing it means sending malformed bytes
into somebody's live session.

That holds for fronts a person opened. **It does not hold for a front parley
spawned** — there parley is the parent of the process and owns its stdin. So:

- Fronts you opened: parley rings the doorbell and refuses to forget. Unchanged.
- Fronts parley bore: parley can genuinely wake them, and writes `wake` itself.

Worth stating in the protocol, because it is the only case where the constraint
that shaped the question mechanism does not apply.

### 4.7 The human's voice on spending

`src/state/machine.ts:60` establishes that a human observer has *"a voice, not a
vote"* — they may watch and speak, not act.

Capacity is the one exception, and it is narrow: a human observer may set
`shape`, and may veto or approve a birth. Money is theirs. Work is still the
fronts' to settle among themselves.

---

## 5. `shape plan`

### 5.1 It completes a branch superpowers already leaves open

`superpowers:subagent-driven-development` asks *"Stay in this session?"* and, on
`no — parallel session`, routes to `superpowers:executing-plans` — which today
ends with a person opening another session by hand and pasting a plan path.

**That branch is the hole this fills.** This does not compete with superpowers;
it completes the edge it declares and does not implement.

### 5.2 The plan already declares territory

`superpowers:writing-plans` requires every task to state exact paths:

```markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`
```

So each task maps to a `WorkItem` with `paths` **declared, not inferred**, and
`patternsOverlap` computes the collision graph *before anything is dispatched*.

`subagent-driven-development` asks *"Tasks mostly independent?"* and expects a
human to eyeball it. **parley computes it.**

That is the strongest claim in this design. In every orchestrator on the market
parallelism is a guess, because none of them has a territory map — they never
needed one. parley has the only component that knows what a path conflict is.
Here, parallelism becomes a proof.

### 5.3 The cycle

1. The coordinating front runs `brainstorming` → `writing-plans`. **superpowers
   is not modified in any way.**
2. `parley plan docs/superpowers/plans/YYYY-MM-DD-x.md` parses `### Task N` and
   its `**Files:**` block and publishes N items with `origin: "planned"`.
3. The collision graph orders them: disjoint tasks dispatch together, colliding
   tasks serialise.
4. Dispatch is authoritative: a `planned` **task** cannot be dropped once
   taken. **As shipped, it arrives with no owner:** it is published `open` and
   any front takes it, rather than being addressed to an idle front the way
   this line first read. Naming an owner would have meant the bus choosing who
   works on what, which is the authority §5.5(d) refuses to put inside the
   daemon; "dispatched" therefore means *published into its wave*, not
   *assigned*. The one planned item that really is addressed to somebody is the
   `review` §5.3(6) creates, and that one **can** be dropped — an offer buys
   first refusal, not obedience.
5. The executing front follows the plan's `- [ ]` steps, TDD as written.
6. Each finished task produces a `kind: "review"` item — superpowers already
   mandates a review after every task. Peer review stops being a convention the
   humans agreed on and becomes a state the bus enforces.
7. `done` advances the graph.

### 5.4 The plan parser is pure

Markdown in, `{ tasks: [{ n, title, paths }] }` out. No clock, no I/O, so it
lives beside the state machine and *"do two tasks in this plan collide?"* is a
deterministic unit test.

A task whose `**Files:**` block is missing or unparseable is dispatched like any
other — published `open` into its wave, with the parse failure **appended to its
title** (the whole title only when the heading carried none). An earlier draft
of this line said such a task is "not dispatched", using the word in the
assigned-to-an-owner sense §5.3(4) has since dropped; nothing about the item
differs from a task that parsed, and the README's Shape plan section says it
the shipped way. Silently dropping a task from a plan is the one failure mode
that would make this untrustworthy.

### 5.5 Four rulings

**a) A plan never overrides live possession.** If Task 5 touches a file a front
holds under an explicit claim, dispatch waits or the coordinator re-sequences.
Dispatch authority covers fronts working the plan; it does not cover a front a
person is directing by hand.

**b) `shape` is repo-scoped**, by the same argument as `mode`.

**c) The axes compose.** `plan` + `enforced` is the strongest pairing.

**d) The coordinator is a front, never the daemon.** The daemon stays stupid: it
stores state and expires things. Putting an LLM inside the bus loses the only
component in the system you can trust when everything else has failed.

---

## 6. Guarantees

**Durability holds for what a frame decided, not for what a tick decided.**
Work items are frames like any other: `journal.append` before responding, and
replay puts every item back with the same id, paths and frame-set state.
Nothing new is written to make that much work.

What replay does not reproduce is a tick-driven transition — an unanswered
offer lapsing back to `open`, an orphaned item's grace period elapsing — because
`restore()` replays frames without ever calling `tick`, while the live daemon
calls `tick` before every `apply`. A pool rebuilt from the journal can
therefore diverge from the live one it was rebuilt from. This is not new to
work: the same gap already exists for territory's auto-claim expiry and
permission's timeout grant. It matters and it is not fixed here — closing it
is a follow-up that covers all three at once, not a one-off patch to the pool.

**Degradation is unchanged.** A dead bus means nothing is born, nothing is
offered, and the fronts a person opened carry on exactly as they are. The
README's one rule applies without amendment.

**No silent truncation.** If the slicer cannot determine an owner, the item goes
to the pool. If a plan task will not parse, it goes to the pool with the reason.
An item is never dropped quietly.

---

## 7. The panel

`WORK` joins `PENDING PERMISSION`, grouped by owner and collapsed by default. A
real session already carries forty-plus notes; thirteen loose lines would drown
it.

In `spawn.json` mode `panel`, a newborn front's output streams into the panel —
which is what makes headless spawning legible rather than a black box. The panel
stops being pure observation and becomes the seat of the fronts parley created.

---

## 8. Testing

Everything interesting is a pure-state test, as with the rest of the machine:

- Two owners whose claims both cover one discovered path — exactly one is
  offered, deterministically, on every machine.
- An offer expiring back to the pool at exactly `OFFER_TTL_MS`.
- A front dying while holding an item — orphan grace, then pool.
- Recycle-before-birth: an idle front exists, so nothing is spawned.
- Ceiling and cooldown: the eighth birth request at `maxFronts: 6` returns
  `NO_CAPACITY`.
- Plan parsing: tasks and paths extracted; a malformed `**Files:**` block
  publishes to the pool rather than disappearing.
- Two tasks in one plan that collide — serialised, never dispatched together.
- Journal replay reconstructs a pool mid-flight with identical ids and
  frame-set state — but not a tick-driven transition (an offer that lapsed, an
  orphan grace that elapsed), since replay never calls `tick`. Known gap,
  shared with territory and permissions, tracked as a follow-up rather than
  asserted away here.

Integration tests keep using a real daemon over a real socket with a
hand-written NDJSON client, so the wire is exercised rather than our abstraction
over it. Birth is tested against a stub harness binary, not a real agent.

---

## 9. Out of scope, on purpose

- Priority, dependencies, and due dates on pool items. That is a plan, and
  `shape plan` is where plans live.
- parley writing plans. It parses them; `superpowers:writing-plans` writes them.
- Anything that lets a discovering front acquire authority over a holding front
  in `shape pool`.
- Agents on different machines, multi-user auth, issue tracker integration —
  unchanged from the README.

---

## 10. Why this beats the orchestrators

Conductor, Orca, Maestro and every subagent model run
`plan → decompose → dispatch → collect`. The plan is made before the work, by
something that is not inside the code. There is a parent, and it is both the
context bottleneck and the single point of failure.

`shape pool` runs `discover → slice by ownership → offer → pull → provide
capacity`. No plan and no parent. Four things follow that a hierarchy cannot do,
by construction rather than by neglect:

1. **Routing by possession, not by plan.** No orchestrator has a territory map,
   because none of them ever needed one. parley has one, and it is deliberately
   imprecise in the safe direction — `patternsOverlap` treats *maybe* as
   conflict.
2. **Discovery comes from inside.** A parent only knows what it asked. A front
   found the sixty-four cases because its hands were in the file; under a
   hierarchy that finding has nowhere to go but back up, to wait for a replan.
3. **It survives the death of any participant.** There is no parent to lose.
   Journal and `tick` return everything to the pool.
4. **Capacity without command.** An orchestrator creates a worker and tells it
   what to do. Here a worker is born and chooses — with the map as it is now,
   not with the plan as it was forty minutes ago.

And `shape plan` adds the fifth, which is the one that beats them at their own
shape: **provable parallelism.** They guess which tasks can run together. parley
computes it from the paths the plan already declares.

What this gives up, stated honestly: when work genuinely decomposes top-down,
one parent with subagents is still cheaper — it understands the context once and
hands each child only its slice. That is already in the README and stays true.
This design does not change that case. It covers the one the hierarchy cannot
reach.
