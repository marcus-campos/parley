# Permission

Permission is what a front reaches for once territory says no.
`parley ask <path> --reason "..."` only becomes a request if somebody else
genuinely holds that path right now — if it is unclaimed, or already yours, the
answer is immediate and no request object is created at all
(`src/state/permissions.ts:8-27`). That is deliberate: it keeps the pending
list meaningful, since anything in it is a real contention between two
fronts rather than ceremony. Otherwise the owner is pushed a high-priority
directed event naming the path, the reason, the request id, and how long
they have to answer (`src/state/permissions.ts:46-53`). Only the owner may
answer, with `parley grant <id> --scope once|transfer` or
`parley deny <id> --reason "..."`, and a request already settled cannot be
answered again (`src/state/permissions.ts:99-139`, CLI at
`src/cli/main.ts:849-861`). `scope: once` carves out just the requested
path; `scope: transfer` moves the whole overlapping claim to the requester
(`src/state/permissions.ts:78-96`). A request's state machine is
`pending → granted | denied | granted_by_timeout`.


```mermaid
stateDiagram-v2
    [*] --> pending: parley ask &lt;path&gt; --reason
    pending --> granted: the holder grants
    pending --> denied: the holder denies,<br/>with a reason
    pending --> granted_by_timeout: nobody answered
    granted --> [*]
    denied --> [*]
    granted_by_timeout --> [*]: and it is said<br/>out loud on the bus
```

The timeout is the load-bearing part. A request that can hang forever costs
every front waiting on it, so silence resolves — and resolves *toward* the
asker, loudly enough that the holder finds out it happened.

## Why it is built this way

An unanswered request does not stay pending forever — it becomes
`granted_by_timeout` after the deadline (five minutes by default,
`DEFAULTS.PERMISSION_TTL_MS` at `src/protocol/types.ts:71`, configurable per
request via `ttl_s`) and the grant is announced by name. The announcement is
built from this template, with the requester, the path, the owner and the
minutes waited filled in at the time (`src/state/permissions.ts:176`):

```
${requester} took ${path} by timeout; ${owner} did not answer in ${waited} min.
```

which reaches the bus reading something like `TESTE-CAMPO took
src/backend/finance/services.py by timeout; FINANCEIRO did not answer in
5 min.` — an illustration, not a recorded event.

Everything quoted below in this shape is verbatim source, unlike the line
above. The comment beside that code states the trade-off directly:

> Expiry is a grant, and it is announced by name. An idle agent is the most
> expensive waste in the system; naming who failed to answer is what stops
> the timeout from quietly becoming the normal path.
> (`src/state/permissions.ts:157-160`)

In other words: a request that never resolves costs every front waiting on
an owner who may simply be idle; a request that resolves without the owner
weighing in costs one path edited without their input. parley accepts the
second cost over the first, and pays for the risk with visibility rather
than with prevention — the broadcast names both sides, so an early or wrong
grant is never a quiet one.

## What happens when it fails

The timeout above already covers the most common "failure": an owner who
never answers, including one whose front has gone entirely — `tick`
evaluates every pending request's deadline on a timer and before each
command regardless of whether the owner is still connected, so a request
against a dead front still resolves on schedule instead of waiting forever
(`src/state/permissions.ts:162-181`, `src/state/machine.ts:238-242,289-290`).

If the daemon itself cannot be reached, `parley ask` (like every other CLI
command) reports it on stderr and exits clean rather than blocking —
`parley: <reason> — continuing without coordination`
(`src/cli/main.ts:187-193`). And in `off` mode, `ask` short-circuits to an
immediate grant with no request created at all, the same as an unclaimed
path (`src/state/permissions.ts:11-13`).
