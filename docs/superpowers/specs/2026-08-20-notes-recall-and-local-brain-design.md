# Notes recall: a lexical floor and an opt-in local brain

**Status:** approved design, not implemented
**Date:** 2026-08-20
**Companion to:** `2026-08-20-shapes-work-pool-and-capacity-design.md` — composes
with it, depends on it for nothing.

---

## 1. The problem

A single real session already carries forty-plus notes, and the number only goes
up. Today a note reaches a front one way: it is anchored to a path, and it is
delivered to whoever touches that path (`src/state/types.ts:93`).

That inversion — *"the agent does not have to think to ask"* — is the best
property the notes system has, and nothing here weakens it.

But it leaves two things uncovered:

- **Knowledge with no path.** A rule about measuring Portuguese text, a
  convention, a decision about how routes are spelled. There is no file to hang
  it on, so it is never delivered to anyone.
- **A front that wants to ask.** *"Is anything already known about the sidebar
  on tablets?"* has no answer that is cheaper than reading every note.

And the cost that matters: **delivering notes by dumping them does not scale.**
Forty-three notes in a footer is a tax on every tool call. What saves tokens is
**ranking and cutting to top-k** — and that requires an index.

---

## 2. Two layers, and only one of them is always on

**Layer 1 — the lexical floor.** Always present, deterministic, no dependency,
no model, no download. BM25 over the note corpus, held in memory by the daemon.

**Layer 2 — the brain.** Opt-in, activated by a person, local static embeddings
for semantic recall.

The floor is not a consolation prize; it is load-bearing. It is what answers
while the brain is off, what answers if the model is missing or corrupt, and
what a fresh install has on day one. The brain is strictly additive.

**Push stays primary.** Path-anchored delivery is unchanged and is still how
most knowledge arrives. Search exists for what anchoring cannot reach.

---

## 3. Where this lives

`src/state/` is pure: no clock, no randomness, no I/O. An index is none of those
things, and a model is all three. **Neither goes in the state machine.**

- The corpus stays where it is: `State.notes`, `State.results`.
- The index is a **derived structure**, built by the daemon from the journal,
  living in `src/brain/`.
- Vectors persist beside the journal, in `stateDir(repoId, env)`
  (`src/transport/address.ts:59`), so a daemon restart does not re-embed
  everything.
- **The daemon holds the index in memory.** The hook never loads a model, never
  reads an index file, and never pays for any of this. It sends a query string
  over the socket it already opens. `HOOK_BUDGET_MS` is untouched, and the 35 ms
  startup that the whole hook design rests on stays exactly as it is.

Downloaded models live in the machine-local state directory, not in any
repository — a fact about the machine, like `repos.json` in
`src/adapters/registry.ts`. One download serves every project.

---

## 4. The lexical floor

BM25 over `title`, `body`, `tags`, and the path segments of `paths`, across
`Note` (both `note` and `decision`) and `CommandResult`.

Tokenisation is tuned for a code corpus, because that is what this corpus is:
split on whitespace, `_`, `-`, `.`, `/`, and camelCase boundaries, then lowercase.
`screen_builder.html` matches a query for `screen builder`, and `is_staff()`
matches `is_staff`.

This is deliberate. The queries this system will actually receive are dense with
identifiers — `select2`, `label sem for`, `/setting/reference` — and exact-token
matching is precisely where lexical retrieval is strongest and where embeddings
are weakest.

Rebuilt from the journal on boot. Deterministic, so *"which three notes come
back for this query"* is a unit test with an exact expected answer, like the
`claim` race.

---

## 5. The brain

### 5.1 Activation is a human act, and it happens in the panel

An agent cannot answer an interactive prompt. Choosing a model and authorising a
~100 MB download is a decision about somebody's machine and somebody's disk, and
the person is watching the panel.

So the flow is:

1. A front asks for recall. The brain is not active.
2. parley answers **from the lexical floor**, immediately. Nothing blocks, and
   the agent is not told to go ask a human.
3. parley raises one `high` priority `system` event in the panel:
   *"a front asked for semantic recall and the brain is off — `parley brain
   enable` to pick a model."*
4. `parley brain enable` is interactive and human-only: it lists the registry,
   shows size and languages for each, downloads on confirmation, and verifies.

Point 3 fires **once**, not on every query. Same nudge-once discipline as
`src/state/permissions.ts:204`, for the same reason.

`src/state/machine.ts:59` says a human observer has *"a voice, not a vote"*.
Activation is on the voice side, exactly like the capacity ceiling in the
companion spec: **money and machine are the person's; work is the fronts'.**

New op: `brain` — `status` readable by anyone, `enable` / `disable` human-only.

### 5.2 The model registry

A curated list compiled into the binary. Each entry:

```ts
interface BrainModel {
  name: string;
  dims: number;
  languages: string;      // human-readable, shown at the prompt
  bytes: number;          // shown before anyone agrees to download
  url: string;
  sha256: string;
  tokenizer: "wordlevel" | "xlmr";
}
```

Download, then verify SHA-256 before use, refusing a corrupt file — the same
discipline `install.sh:75-97` already applies to the binary itself, including
its comment that a checksum fetched over the same channel is worth less than one
that is not. **A model that fails verification is deleted, and the brain stays
off.**

### 5.3 Static models only, in v1

The registry admits only Model2Vec-style **static** embeddings: a token lookup
table plus pooling, no forward pass.

That is not a compromise, it is the requirement:

- **Deterministic.** No GPU, no threads, no floating-point nondeterminism. An
  embedding is a pure function of its input, so top-k is assertable in a unit
  test — the same property the whole state machine was built around.
- **Microseconds, not milliseconds.**
- **No per-platform native runtime.** No ONNX build per OS and architecture,
  which would undo the cross-platform work that Windows, WSL and arm64 cost.

Transformer embedding models are excluded on purpose, for all three reasons.

The reference entry is
[`potion-multilingual-128M`](https://huggingface.co/minishlab/potion-multilingual-128M):
0.1B parameters, 256 dimensions, 101 languages, distilled from `bge-m3`.
Multilingual is not optional here — this corpus is Portuguese prose carrying
English identifiers, and an English-only model would fail on exactly the notes
that matter. [Model2Vec](https://github.com/MinishLab/model2vec) quantises to
int8 at 25% of size without loss of performance, which puts the entry near
100 MB.

### 5.4 The tokenizer is the real implementation cost

The inference maths is about thirty lines: look up rows, pool, normalise.

The tokenizer is not. `bge-m3` uses an XLM-RoBERTa SentencePiece vocabulary, and
there is no TypeScript path for it today — only Python, or WASM. That is the
expensive part of this feature, and it is worth naming so it is not discovered
halfway through.

Hence `tokenizer` in the registry entry, and hence the second admissible kind:
Model2Vec distils against **a vocabulary you choose**, so a word-level vocabulary
reduces tokenisation to a regex split with no WASM and no dependency at all.

**v1 ships whichever kind is ready first**; the registry is what lets the other
arrive later without changing anything else.

### 5.5 Indexing

- A note or result written while the brain is active is embedded and stored on
  write. Notes are short, so this is cheap.
- Activating the brain later **backfills from the journal**. There is no window
  where old knowledge is invisible to the new index.
- Vectors are stored int8-quantised. For a corpus this size the storage cost is
  not the point; consistency with the model's own quantisation is.

---

## 6. Retrieval

`notes` gains `q` (query) and `k` (how many), rather than a new op. `results`
gains the same. The smallest surface that does the job.

When the brain is on, lexical and vector rankings are fused by reciprocal rank —
which is not a hedge but the thing that actually performs best: lexical carries
the identifiers, vectors carry the paraphrase, and this corpus has both in every
sentence.

**A score threshold, and silence below it.** Returning the least-bad note for a
query with no good answer is worse than returning nothing: it costs tokens and it
teaches the agent to distrust the channel.

**The footer carries top-k, never the corpus.** That single sentence is where
the token saving in this entire spec comes from.

---

## 7. Degradation

The README's one rule, applied down the stack:

| failure | behaviour |
|---|---|
| brain off | lexical floor answers |
| model missing, corrupt, or fails checksum | lexical floor answers, and says so once |
| lexical index cold or broken | path-anchored delivery, i.e. today's behaviour |
| daemon unreachable | today's behaviour |

Nothing in this feature can block an edit, delay a hook, or stop the work.

---

## 8. Testing

- Lexical top-k for a fixed corpus and query: exact expected ids.
- Identifier tokenisation: `screen_builder.html` retrieved by `screen builder`;
  `is_staff()` by `is_staff`.
- Static embedding determinism: a tiny fixture model in the test fixtures,
  asserting exact vectors and exact top-k. Possible only because the model has
  no forward pass — and the reason static was made a requirement.
- Backfill: a journal replayed into a cold brain produces the same index as
  incremental writes did.
- Threshold: a query with no good match returns empty, not the least-bad note.
- Activation: the panel event fires once, and never reaches the asking agent.
- A model whose SHA-256 does not match is deleted, the brain stays off, and
  recall still answers.

---

## 9. Out of scope, on purpose

- **Remote embedding APIs.** Repository knowledge does not leave the machine.
  This is not a preference; it is the boundary that makes the feature safe to
  turn on by default later.
- Reranking models.
- Indexing source code. This indexes notes, decisions and command results —
  what fronts learned, not what the repository contains.
- Long-term search over conversation history, which the README already excludes.

---

## 10. Why this shape

Three claims, in order of how much they matter:

1. **Push stays primary.** The best thing about notes is that the agent does not
   have to think to ask. Search is the fallback for what has no path, not a
   replacement for delivery.
2. **The token saving comes from ranking and top-k, not from the vector.** The
   floor delivers most of it. The brain buys recall on paraphrase, which is real
   for a Portuguese corpus full of English identifiers, but it is the smaller
   half of the win.
3. **Nobody pays for it without agreeing to.** The binary stays standalone and
   the same size it is today. The person chooses the model, sees the size before
   the download, and can turn it off.
