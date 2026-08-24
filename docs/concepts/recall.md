# Notes and recall

Recall has two layers, and only one of them is ever guaranteed to be there.

> The floor. Always present, deterministic, no model, no download. It is not
> a consolation prize: it is what answers while the brain is off, what
> answers if the model is missing, and what a fresh install has on day one.
> The brain is strictly additive on top of this.
> (`src/brain/lexical.ts:23-29`)

This page describes that floor in full, because it is what exists on this
branch. The second layer — an opt-in embedding model — is designed and
partly built elsewhere; what is true of it here is stated plainly, and
nothing more.

## The floor: tokens, then BM25, then a distinctiveness check

Text going into the index is split by an identifier-aware tokeniser, not a
plain word splitter. The corpus is notes about code — file names, CSS
classes, function calls — so a compound like `is_staff()` is kept whole
*and* split into its parts, and a `camelCase` boundary is split the same way
snake_case and dashes are, so both `is_staff` and `staff` find the same note
(`src/brain/tokenize.ts:1-27`).

Scoring is BM25 (`K1 = 1.2`, `B = 0.75`), computed per term as inverse
document frequency times a term-frequency curve normalised against average
document length (`src/brain/lexical.ts:10-11,84-89`). On top of that sits one
extra rule: a hit only counts if at least one of its matched terms is not
shared by more than half the corpus.

> A hit qualifies only if it matched a term that does not appear in a
> majority of the corpus. IDF already pushes ubiquitous terms toward zero,
> but never all the way there, so without this a note sharing only a common
> word with the query would still outrank returning nothing — and returning
> the least-bad note is worse than silence (spec §6).
> (`src/brain/lexical.ts:70-75`)

That check only switches on once the corpus holds at least four documents
(`MIN_DOCS_FOR_THRESHOLD`, `src/brain/lexical.ts:14-19`) — below that, "half
the corpus" is one or two notes, not a real signal. Reversed decisions never
enter the index at all: `indexFromState` skips any note with a
`reversedBy`, and a live daemon removes one the moment it is reversed, so a
reversed decision cannot surface as a recall hit even between rebuilds
(`src/brain/lexical.ts:107-118`; `src/daemon/server.ts:319-321`).

## Reaching it: `parley notes --query`

```
parley notes --query "select2 initialisation" --k 8
```

The query never reaches the pure state machine directly. `listNotes` itself
never reads `q` — it cannot, by design:

> The daemon resolves `q` into ranked `ids` before calling `apply` — this
> module has no clock and no I/O, so it cannot search on its own.
> (`src/state/notes.ts:72-73`)

The daemon does the ranking, on its own in-memory copy of the index, before
the frame ever reaches `apply` — and only that copy is touched; the journal
keeps exactly the frame that came in over the wire, so a replay never has to
agree with what the index looked like at write time
(`src/daemon/server.ts:247-250`). It searches across the *whole* corpus —
notes, decisions, and results together — then filters by which op asked, and
only then slices to `k` (`src/daemon/server.ts:264-267`). The order is the
whole point:

> `search` ranks across every kind in one corpus-wide score, and its
> distinctiveness threshold is a property of the whole corpus... So `k`
> cannot be handed to `search` directly: the top-k across all kinds can be
> entirely the other op's kind, which would starve this op of a real match
> it actually has.
> (`src/daemon/server.ts:254-262`)

`k` itself is bounded regardless of what is asked for — between 1 and 20,
defaulting to 5 (`src/daemon/server.ts:253`). That is the same discipline
the work pool's footer uses for offers: never hand back the corpus, only the
top of it, because that gap is exactly where the token saving comes from —
ranking and a small `k`, not a vector (`src/state/work.ts:263-270`;
`src/daemon/server.ts:253,267`).

If the index itself throws, the query does not fail — it falls back to the
same unranked list a plain `notes` call without `--query` gets
(`src/daemon/server.ts:268-272`), which is the same "never let a broken part
stop the work" shape territory and permission already follow.

## The brain: designed as the second layer, not operable here

A `brain` field already exists on state — `{ active, model, askedAtMs }`
(`src/state/types.ts:223-229`) — and a daemon-side handler for `parley brain
enable <model>` / `disable` exists in the state machine
(`src/state/machine.ts:165-202`). Turning it on is deliberately gated to a
human, not a front:

> A ~100MB download and a model choice spend somebody's disk and somebody's
> money, on somebody's machine, and an agent cannot answer the interactive
> prompt that decision deserves on that person's behalf.
> (`src/state/machine.ts:152-155`)

The model registry backs that up with a size up front rather than after the
fact — one static model listed today, `potion-multilingual-128M-int8`, with
its size, checksum, and source declared before anything is fetched
(`src/brain/registry.ts:1-33`).

That is as far as this branch goes. There is no `src/brain/embed.ts` and no
`src/brain/download.ts` — nothing here actually fetches or runs a model, and
the registry's own comment is explicit that the downloader described is a
separate piece: *"the downloader refuses anything that does not match"*
(`src/brain/registry.ts:20-21`) — a downloader this branch does not contain.
Nor is there a shipped way to reach `op: "brain"` at all: neither the CLI nor
the MCP server nor the terminal/web panel wires it up. A front that asks for
`semantic` recall while the brain is off is still answered from the floor,
unconditionally — and earns exactly one high-priority nudge into the
conversation feed, never a repeat, so asking again cannot turn this into
noise (`src/state/notes.ts:78-92`). It is a plain system event today, not a
dedicated control; the person's decision this page describes is designed to
happen in the panel, and is not wired to one here.

## What happens when it fails

The floor cannot really go down: it holds no clock and no I/O of its own,
and a broken index degrades a ranked query to the same unranked list a plain
`notes` call returns rather than failing it (`src/daemon/server.ts:268-272`).
If the daemon itself cannot be reached, `parley notes` behaves like every
other direct CLI command — it reports the problem on stderr and exits clean
rather than blocking, `parley: <reason> — continuing without coordination`
(`src/cli/main.ts:166-172`). Recall failing is never the reason an edit does
not happen; at worst, a front gets the unranked list, or the plain
path-anchored notes it would have had anyway.
