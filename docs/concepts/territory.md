# Territory

Territory is how parley answers one question: who owns this path right now.
A front takes territory with `parley claim <paths...> --intent "..."`, or
takes it implicitly — the Claude Code hook auto-claims the exact path an
`Edit`/`Write`/`NotebookEdit`/`MultiEdit` call is about to touch, before the
tool runs. A claim is checked as an all-or-nothing batch: either every path
in the request is free and all of them are taken, or none are, so a
partially granted claim can never exist. Conflicts are resolved by arrival
order at the daemon — whoever's `claim` frame lands first wins. Letting go
with `parley release` is not a separate step from answering whoever was
waiting: releasing a path that somebody has already asked for hands it to
them immediately and announces it, rather than merely freeing it for them to
race for.

## Why it is built this way

Deciding whether two glob patterns can ever describe the same concrete path
is, in general, regex intersection — expensive, and easy to get subtly
wrong. parley walks both patterns segment by segment instead: `**` consumes
any number of segments, `*`/`?` stay inside one, literals must match
exactly, and when *both* sides carry a wildcard in the same segment and
neither is a literal, the honest answer is "maybe" — and "maybe" is treated
as a conflict, never as clear
(`src/repo/paths.ts:94-105`, `src/state/territory.ts:109-111`).

That asymmetry is deliberate:

> A false conflict costs one conversation. A false clear costs two agents
> editing the same file and finding out from CI.
> (`docs/ARCHITECTURE.md:195-198`, restated at `src/repo/paths.ts:100-104`)

A second, smaller heuristic follows the same bias: a wildcard-free pattern
that names something with no dot after its first character is read as a
directory and covers everything beneath it — `parley claim src/backend`
means the subtree, not one literal path that happens to not exist
(`src/repo/paths.ts:54-68`). It is wrong for a directory literally named
`v1.2`; write `v1.2/**` for that case.

Claims come in two strengths for the same reason. An **auto-claim**, taken
by a first edit rather than declared, expires after 15 idle minutes so a
front that swept the repository does not end up owning half of it forever;
an explicit `claim` over an existing auto-claim promotes it and it stops
expiring (`src/state/territory.ts:174-181`, `src/state/machine.ts:306-322`,
`DEFAULTS.AUTO_CLAIM_TTL_MS` at `src/protocol/types.ts:67`). Explicit claims
never expire from inactivity — only from a dead front, and even then not
immediately (see below).

## What happens when it fails

If the daemon cannot be reached at all, a direct CLI command like
`parley claim` says so on stderr with a message of the shape
`parley: <reason> — continuing without coordination`, and exits clean
rather than blocking (`src/cli/main.ts:183-189`). The Claude Code hook
takes the quieter path
that a background tool call needs: it emits an empty response and the edit
proceeds unclaimed, with no coordination and no warning in the transcript
(`src/adapters/hook.ts:84-93`). Either way, the rule is the same: parley
failing must never be the reason an edit does not happen.

Failure also shows up short of the daemon being unreachable. A front that
stops renewing its lease — no live connection, and no call in over five
minutes — is marked gone, and its claims are stamped `orphaned` immediately
rather than dropped on the spot: they are released only after a 60-second
grace period, so a session that is merely restarting gets its territory
back instead of having to fight for it
(`src/state/machine.ts:288-303`, `DEFAULTS.ORPHAN_GRACE_MS` at
`src/protocol/types.ts:73`). And in `off` mode, `claim` is a documented
no-op — `{"claimed": [], "ignored": true}` — rather than an error, so
turning territory off never breaks a script written against it
(`src/state/territory.ts:142-144`).
