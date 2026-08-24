# The work pool

The pool exists for work a front finds but did not go looking for — a
sweep that turns up more than the task that started it. Turn it on with
`parley shape pool` (see [shapes](/concepts/shapes) for how that setting
relates to `mode`); everything below only runs once that is set.

## Walking one item through it

Hypothetically, a front is chasing something unrelated and notices the
same defect in thirteen files — sixty-four instances of it, but thirteen
places to fix. It publishes one item per file, not per instance, because
the path is already the unit parley uses for territory
(`src/state/work.ts:53-57`):

```
parley work "remove the deprecated retry wrapper" src/a.ts src/b.ts ... (13 paths)
```

Each of the thirteen items is routed the instant it is published, by asking
one question per path — does a live front already hold this?
(`ownerForPath`, `src/state/work.ts:35-51`). Say one front, FINANCEIRO,
already holds claims covering twelve of the thirteen files from an earlier,
unrelated refactor. Those twelve become **offers**, exclusive to FINANCEIRO;
the thirteenth path belongs to nobody, so it is **open** from the moment it
is published (`src/state/work.ts:76-99`).

FINANCEIRO does not have to poll for this. The offers ride the same footer
every hook and MCP response already carries, capped at three named lines
before it falls back to a count so the pool itself never becomes the token
cost it exists to avoid (`poolFooterFor`, `MAX_NAMED_OFFERS = 3`,
`src/state/work.ts:773-801`).

FINANCEIRO takes ten of the twelve:

```
parley take w_0002
```

Taking an item hands back, in the same response, whatever notes and results
were already attached to it as evidence — so the front that picks the item
up is never the one that reruns the investigation that produced them
(`evidenceFor`, `src/state/work.ts:541-558`; `takeWork`,
`src/state/work.ts:615-655`).

Two of the twelve are not actually FINANCEIRO's problem — the label does not
apply in those files — so it drops them:

```
parley drop w_0011 --reason "does not apply in this file"
```

Dropping costs nothing: the item goes straight back to `open`
(`src/state/work.ts:723-731`), and its earlier nudge state is cleared too, so
returning an item to the pool always starts a clean clock rather than
inheriting whatever staleness it had before (`src/state/work.ts:730`).

The pool now holds three items — the two FINANCEIRO handed back, and the one
that was open from the start — for whoever comes looking:

```
parley works --state open
parley take w_0013
```

Whoever finishes an item closes it:

```
parley done w_0002 --summary "3 labels removed"
```

`--kind review --review-of <id>` marks a published item as somebody else's
finished work to check, rather than new work to do — routed through the same
`ownerForPath` and the same offer/open split, just with a different meaning
once it is taken (`src/state/work.ts:61,81`; CLI syntax at
`src/cli/main.ts:139`).

## Why it is built this way

Possession is what routes an item, not a plan and not a parent — and it
buys the owner exactly one thing: the first refusal, never obedience.

> Possession is what routes discovered work — no plan, no parent. It buys the
> first refusal and nothing more: the item is an offer, and the owner may
> drop it. Otherwise the front that discovered the work would have acquired
> authority over the front that holds the file, which is the hierarchy this
> whole system exists to do without.
> (`src/state/work.ts:14-18`, restated at `src/state/work.ts:692-697`)

Evidence travels with the item for the same reason parley amortises anything
else: a front that already read the code and found the trap in a file has
done work worth keeping, and handing it over on `take` is what stops the
next front from paying for it twice (`src/state/work.ts:610-613`).

Spare capacity is defined narrowly on purpose. `idleFronts` only counts a
live `agent` participant holding no explicit claim and no taken item — a
human watching the panel is filtered out because they are not a front to
dispatch to, and an auto-claim does not count as busy because it is the
footprint of an edit, not a declaration of intent
(`src/state/work.ts:745-763`). The doorbell that rings for one of them is
correspondingly narrow: it fires once an open item has sat for ten minutes
(`DEFAULTS.ORPHAN_POOL_MS`, `src/protocol/types.ts:76-82`) — longer than the
five-minute presence lease on purpose (`DEFAULTS.LEASE_TTL_MS`,
`src/protocol/types.ts:69`), so a front that stopped renewing that long ago
reads as gone rather than as idle capacity waiting to be pinged. It addresses exactly one idle front, at high priority, and stamps
every stale item as nudged so the same one is never rung twice
(`src/state/machine.ts:352-372`).

## What happens when it fails

An offer nobody answers does not stay pending forever: it returns to the
pool automatically after five minutes, the same window an unanswered
permission request gets, matched on purpose
(`DEFAULTS.OFFER_TTL_MS`, `src/protocol/types.ts:75`), and the return is
announced by name rather than happening quietly
(`src/state/machine.ts:333-349`).

A front holding a **taken** item that goes dark does not lose it the instant
its lease lapses either. The item is stamped orphaned immediately but only
actually returned to the pool after the same sixty-second grace period a
claim gets (`DEFAULTS.ORPHAN_GRACE_MS`, `src/protocol/types.ts:73`;
`src/state/machine.ts:308-331`), so a front that is merely restarting does
not come back to find its work already given away.

If the daemon cannot be reached at all, `work`, `works`, `take`, `drop` and
`done` behave like every other direct CLI command: the problem is reported
on stderr and the process exits clean rather than blocking —
`parley: <reason> — continuing without coordination`
(`src/cli/main.ts:183-189`). A broken parley never stops the fix the item
describes; it only stops the bookkeeping around it.

A `planned` item — one dispatched rather than discovered — cannot be dropped,
because dispatch is not an offer. `publishWork` does **not** read the origin
off the incoming frame: a front able to set it could publish work its offeree
is forbidden to hand back, and route that item straight at whoever already
holds the path — the hierarchy `ownerForPath` exists to prevent. Everything
published through `parley work` is `"discovered"`
(`src/state/work.ts:87-95`), and only a dispatched plan makes a planned item —
see [shapes](/concepts/shapes).
