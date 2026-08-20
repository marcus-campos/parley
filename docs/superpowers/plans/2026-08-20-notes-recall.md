# Notes Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make what fronts already learned findable — a lexical floor that always works, and an optional local brain a person turns on and chooses the model for.

**Architecture:** The corpus stays in `State`. The index is a **derived structure** built by the daemon from the journal, living in `src/brain/`, never in the pure state machine. The daemon holds it in memory, so the 30 ms hook budget is untouched. The floor is BM25 with identifier-aware tokenisation; the brain is a static (lookup-only) embedding model, downloaded on a person's say-so.

**Tech Stack:** TypeScript, Bun. No new runtime dependencies. The model is downloaded at activation, never bundled.

**Spec:** `docs/superpowers/specs/2026-08-20-notes-recall-and-local-brain-design.md`

**Depends on:** nothing. This composes with the work pool but does not need it.

## Global Constraints

- Nothing here goes under `src/state/`. No index, no model, no I/O in the state machine.
- The hook never loads a model and never reads an index file. It sends a query over the socket it already opens.
- Push stays primary: path-anchored note delivery is unchanged. Search is for what anchoring cannot reach.
- Degradation is mandatory: brain off → floor; floor cold → path anchoring, i.e. today's behaviour. Nothing may block an edit.
- Repository knowledge never leaves the machine. No remote embedding API, ever.
- A model whose SHA-256 does not match is deleted and the brain stays off.
- `bun run typecheck` and `bun test` must pass before every commit.

---

### Task 1: Identifier-aware tokenisation

**Files:**
- Create: `src/brain/tokenize.ts`
- Test: `tests/brain/tokenize.test.ts`

**Interfaces:**
- Produces: `export function tokenize(text: string): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/brain/tokenize.test.ts
import { describe, expect, test } from "bun:test";
import { tokenize } from "../../src/brain/tokenize";

describe("tokenising a corpus made of code", () => {
  test("snake_case splits and keeps the whole too", () => {
    expect(tokenize("is_staff()")).toEqual(expect.arrayContaining(["is_staff", "is", "staff"]));
  });

  test("a filename splits on dot and slash", () => {
    const out = tokenize("templates/pages/app/screen_builder.html");
    expect(out).toEqual(expect.arrayContaining(["templates", "pages", "app", "screen", "builder", "html"]));
  });

  test("camelCase splits", () => {
    expect(tokenize("addClassToggle")).toEqual(expect.arrayContaining(["add", "class", "toggle"]));
  });

  test("everything is lowercased", () => {
    expect(tokenize("DIVIDA CONHECIDA")).toEqual(["divida", "conhecida"]);
  });

  test("accents survive, because half the corpus is Portuguese", () => {
    expect(tokenize("menu lateral está com 37px")).toEqual(
      expect.arrayContaining(["menu", "lateral", "está", "37px"]),
    );
  });

  test("a route keeps its shape and its parts", () => {
    const out = tokenize("/setting/reference");
    expect(out).toEqual(expect.arrayContaining(["setting", "reference"]));
  });

  test("empty input is an empty list, not a crash", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/brain/tokenize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write it**

```ts
// src/brain/tokenize.ts
/**
 * This corpus is notes about code: `screen_builder.html`, `select2`,
 * `/setting/reference`, `is_staff()`. Queries against it are dense with
 * identifiers, which is exactly where exact-token matching is strongest.
 *
 * The compound is kept alongside its parts so that both `is_staff` and `staff`
 * find the same note.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/[\s(),;:"'`\[\]{}<>|!?]+/)) {
    if (!chunk) continue;
    const cleaned = chunk.replace(/^[./-]+|[./-]+$/g, "");
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    if (/[_\-./]/.test(lower) || /[a-z][A-Z]/.test(cleaned)) out.push(lower);
    for (const part of cleaned.split(/[_\-./]+/)) {
      if (!part) continue;
      for (const camel of part.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
        const token = camel.toLowerCase();
        if (token) out.push(token);
      }
    }
  }
  // Duplicates are kept on purpose: BM25 scores on term frequency.
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/brain/tokenize.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/tokenize.ts tests/brain/tokenize.test.ts
git commit -m "feat: tokenizar como quem lê código, porque as notas são sobre código"
```

---

### Task 2: The lexical floor

**Files:**
- Create: `src/brain/lexical.ts`
- Test: `tests/brain/lexical.test.ts`

**Interfaces:**
- Consumes: `tokenize` (Task 1); `Note` and `CommandResult` from `src/state/types.ts`.
- Produces:
  ```ts
  export interface Hit { id: string; score: number; kind: "note" | "decision" | "result" }
  export class LexicalIndex {
    add(id: string, kind: Hit["kind"], text: string): void;
    remove(id: string): void;
    search(query: string, k: number): Hit[];
    get size(): number;
  }
  export function indexFromState(state: State): LexicalIndex;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/brain/lexical.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { LexicalIndex } from "../../src/brain/lexical";

let index: LexicalIndex;
beforeEach(() => {
  index = new LexicalIndex();
  index.add("n_1", "note", "A armadilha do select2 um for apontando pra elemento escondido pode nao abrir o componente");
  index.add("n_2", "note", "DIVIDA CONHECIDA menu lateral do dashboard tem 37px de alvo em tablet deitado");
  index.add("n_3", "decision", "Mapa de URLs reais do yzilab-front por que /setting/reference da 404");
  index.add("n_4", "note", "templates/pages/app/screen_builder.html tem labels sem for");
});

describe("the lexical floor", () => {
  test("an identifier query finds the note that carries it", () => {
    expect(index.search("select2", 3)[0]!.id).toBe("n_1");
  });

  test("a filename query finds it, whole or in parts", () => {
    expect(index.search("screen_builder.html", 3)[0]!.id).toBe("n_4");
    expect(index.search("screen builder", 3)[0]!.id).toBe("n_4");
  });

  test("a route query finds the decision", () => {
    expect(index.search("/setting/reference", 3)[0]!.id).toBe("n_3");
  });

  test("Portuguese prose is retrieved as well as identifiers", () => {
    expect(index.search("menu lateral tablet", 3)[0]!.id).toBe("n_2");
  });

  test("results are ranked, and k is respected", () => {
    const hits = index.search("for", 2);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
  });

  test("a query matching nothing returns nothing, not the least-bad note", () => {
    expect(index.search("kubernetes helm chart", 3)).toEqual([]);
  });

  test("the same query on the same corpus always returns the same order", () => {
    const a = index.search("for", 4).map((h) => h.id);
    const b = index.search("for", 4).map((h) => h.id);
    expect(a).toEqual(b);
  });

  test("removing a document removes it from results", () => {
    index.remove("n_1");
    expect(index.search("select2", 3)).toEqual([]);
    expect(index.size).toBe(3);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/brain/lexical.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement BM25**

```ts
// src/brain/lexical.ts
import { tokenize } from "./tokenize";
import type { State } from "../state/types";

export interface Hit {
  id: string;
  score: number;
  kind: "note" | "decision" | "result";
}

const K1 = 1.2;
const B = 0.75;

interface Doc { id: string; kind: Hit["kind"]; length: number; freq: Map<string, number> }

/**
 * The floor. Always present, deterministic, no model, no download.
 *
 * It is not a consolation prize: it is what answers while the brain is off,
 * what answers if the model is missing, and what a fresh install has on day
 * one. The brain is strictly additive on top of this.
 */
export class LexicalIndex {
  private docs = new Map<string, Doc>();
  private postings = new Map<string, Set<string>>();
  private totalLength = 0;

  get size(): number { return this.docs.size; }

  add(id: string, kind: Hit["kind"], text: string): void {
    this.remove(id);
    const tokens = tokenize(text);
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    this.docs.set(id, { id, kind, length: tokens.length, freq });
    this.totalLength += tokens.length;
    for (const term of freq.keys()) {
      let set = this.postings.get(term);
      if (!set) { set = new Set(); this.postings.set(term, set); }
      set.add(id);
    }
  }

  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.totalLength -= doc.length;
    this.docs.delete(id);
    for (const term of doc.freq.keys()) {
      const set = this.postings.get(term);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.postings.delete(term);
    }
  }

  search(query: string, k: number): Hit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.docs.size === 0) return [];
    const avg = this.totalLength / this.docs.size;
    const scores = new Map<string, number>();

    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (this.docs.size - posting.size + 0.5) / (posting.size + 0.5));
      for (const id of posting) {
        const doc = this.docs.get(id)!;
        const f = doc.freq.get(term) ?? 0;
        const score = idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avg)));
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
    }

    return [...scores.entries()]
      // Ties break on the id, so the same corpus always answers in the same order.
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, k)
      .map(([id, score]) => ({ id, score, kind: this.docs.get(id)!.kind }));
  }
}

/** Rebuilt from state on daemon boot; state is itself rebuilt from the journal. */
export function indexFromState(state: State): LexicalIndex {
  const index = new LexicalIndex();
  for (const note of state.notes) {
    if (note.reversedBy !== null) continue;
    index.add(note.id, note.kind, [note.title, note.body, note.tags.join(" "), note.paths.join(" ")].join(" "));
  }
  for (const result of Object.values(state.results)) {
    index.add(result.key, "result", [result.key, result.summary, result.paths.join(" ")].join(" "));
  }
  return index;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/brain/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/lexical.ts tests/brain/lexical.test.ts
git commit -m "feat: um piso de busca que nunca depende de modelo nenhum"
```

---

### Task 3: `notes --query` over the socket

**Files:**
- Modify: `src/daemon/server.ts` (hold the index, maintain it on `note`, `reverse`, `result`)
- Modify: `src/state/notes.ts` (`listNotes` accepts pre-ranked ids)
- Modify: `src/cli/main.ts` (`parley notes --query "..." [-k N]`)
- Test: `tests/integration/recall.test.ts`

**Interfaces:**
- Consumes: `LexicalIndex`, `indexFromState` (Task 2).
- Produces: frame `{ op: "notes", q, k }` responding `ok({ notes, ranked: true })`. The daemon resolves `q` to ids **before** calling `apply`, and passes them as `frame.ids`, so `src/state/` never sees an index.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/recall.test.ts
import { describe, expect, test } from "bun:test";
import { withDaemon } from "./harness";

describe("recall over the wire", () => {
  test("a query returns ranked notes, top-k only", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      await core.send({ v: 1, op: "note", title: "the select2 trap", body: "a for pointing at a hidden element" });
      await core.send({ v: 1, op: "note", title: "menu lateral", body: "37px de alvo em tablet deitado" });
      await core.send({ v: 1, op: "note", title: "unrelated", body: "nothing to do with anything" });

      const out = await core.send({ v: 1, op: "notes", q: "select2 hidden", k: 1 });
      expect(out.notes).toHaveLength(1);
      expect(out.notes[0].title).toBe("the select2 trap");
      expect(out.ranked).toBe(true);
    });
  });

  test("a query with no good match returns nothing", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      await core.send({ v: 1, op: "note", title: "the select2 trap", body: "..." });
      const out = await core.send({ v: 1, op: "notes", q: "kubernetes helm", k: 3 });
      expect(out.notes).toEqual([]);
    });
  });

  test("listing without a query is unchanged", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      await core.send({ v: 1, op: "note", title: "a", body: "" });
      await core.send({ v: 1, op: "note", title: "b", body: "" });
      const out = await core.send({ v: 1, op: "notes" });
      expect(out.notes).toHaveLength(2);
      expect(out.ranked).toBeUndefined();
    });
  });

  test("a reversed decision leaves the index", async () => {
    await withDaemon(async (connect) => {
      const core = await connect("CORE");
      const made = await core.send({ v: 1, op: "note", title: "routes end with a slash", kind: "decision" });
      await core.send({ v: 1, op: "reverse", id: made.id });
      const out = await core.send({ v: 1, op: "notes", q: "routes slash", k: 3 });
      expect(out.notes).toEqual([]);
    });
  });

  test("the index survives a daemon restart, because state does", async () => {
    await withDaemon(async (connect, restart) => {
      const core = await connect("CORE");
      await core.send({ v: 1, op: "note", title: "the select2 trap", body: "hidden element" });

      await restart();

      const again = await connect("CORE");
      const out = await again.send({ v: 1, op: "notes", q: "select2", k: 3 });
      expect(out.notes).toHaveLength(1);
      // The journal rebuilt state, and indexFromState rebuilt the index from it.
      // Nothing about the index is itself persisted.
    });
  });
});
```

> `withDaemon` comes from `tests/integration/harness.ts`, extracted in
> `docs/superpowers/plans/2026-08-20-work-pool.md` Task 8 Step 1. Do that first
> if it is not there yet.


- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/integration/recall.test.ts`
Expected: FAIL — `q` is ignored.

- [ ] **Step 3: Hold the index in the daemon**

In `src/daemon/server.ts`: build `this.index = indexFromState(this.state)` after journal replay. After each successful `apply`, if the frame's op was `note`, `reverse` or `result`, update the index for the affected id only — a full rebuild on every write would be quadratic on a long-lived daemon.

Before dispatching a `notes` or `results` frame carrying `q`, resolve it:

```ts
if (typeof frame.q === "string" && frame.q.trim()) {
  const k = typeof frame.k === "number" ? Math.max(1, Math.min(20, frame.k)) : 5;
  const hits = this.index.search(frame.q, k);
  frame = { ...frame, ids: hits.map((h) => h.id), ranked: true };
}
```

`listNotes` filters by `frame.ids` when present, preserving that order, and echoes `ranked: true`. The state machine still sees only data.

- [ ] **Step 4: Add the CLI flags**

```
parley notes [--query "..."] [-k 5]
parley results [--query "..."] [-k 5]
```

- [ ] **Step 5: Run everything**

Run: `bun test && bun run typecheck && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/server.ts src/state/notes.ts src/cli/main.ts tests/integration/recall.test.ts
git commit -m "feat: perguntar às notas, e receber as três que importam em vez das quarenta"
```

---

### Task 4: The footer carries the top, never the corpus

**Files:**
- Modify: `src/state/notes.ts` or the hook context builder — wherever notes are attached today
- Test: `tests/brain/footer-budget.test.ts`

**Interfaces:**
- Consumes: the existing path-anchored delivery in `contextFor` (`src/state/territory.ts:37`).
- Produces: a hard cap on how many notes ride along on a claim, and a count for the rest.

- [ ] **Step 1: Write the failing test**

```ts
// tests/brain/footer-budget.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, Note, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: "m" }, at(ms));
  return (out.response as unknown as { id: string }).id;
}

let state: State;
let core: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  core = joined(state, "CORE", 0);
});

describe("what rides along on a claim", () => {
  test("all the notes for a path, while there are few", () => {
    for (let i = 0; i < 3; i++) {
      apply(state, core, { v: 1, op: "note", title: `n${i}`, paths: ["a.ts"] }, at(10 + i));
    }
    const other = joined(state, "OTHER", 50);
    const out = apply(state, other, { v: 1, op: "claim", paths: ["a.ts"] }, at(100));
    expect((out.response as unknown as { notes: Note[] }).notes).toHaveLength(3);
  });

  test("forty-three notes do not all ride along — that is a tax on every tool call", () => {
    for (let i = 0; i < 43; i++) {
      apply(state, core, { v: 1, op: "note", title: `n${i}`, paths: ["a.ts"] }, at(10 + i));
    }
    const other = joined(state, "OTHER", 100);
    const out = apply(state, other, { v: 1, op: "claim", paths: ["a.ts"] }, at(200));
    const response = out.response as unknown as { notes: Note[]; more_notes: number };
    expect(response.notes.length).toBeLessThanOrEqual(5);
    expect(response.more_notes).toBe(43 - response.notes.length);
  });

  test("a standing decision is never truncated away — it binds", () => {
    apply(state, core, { v: 1, op: "note", title: "routes end with a slash", kind: "decision", paths: ["a.ts"] }, at(10));
    for (let i = 0; i < 43; i++) {
      apply(state, core, { v: 1, op: "note", title: `n${i}`, paths: ["a.ts"] }, at(20 + i));
    }
    const other = joined(state, "OTHER", 100);
    const out = apply(state, other, { v: 1, op: "claim", paths: ["a.ts"] }, at(200));
    const notes = (out.response as unknown as { notes: Note[] }).notes;
    expect(notes.some((n) => n.kind === "decision")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/brain/footer-budget.test.ts`
Expected: FAIL — every note comes back.

- [ ] **Step 3: Cap it in `contextFor`**

Decisions first, in full, because they bind. Then the newest notes up to a cap of five, then `more_notes: <count>` with the hint that `parley notes --path <p>` shows the rest.

- [ ] **Step 4: Run everything**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state tests/brain/footer-budget.test.ts
git commit -m "feat: o rodapé carrega o topo, e não o acervo inteiro"
```

---

### Task 5: Activation is the person's, and it happens in the panel

**Files:**
- Create: `src/brain/registry.ts`
- Modify: `src/state/types.ts` (`State.brain`)
- Modify: `src/protocol/types.ts` (`OPS` gains `brain`)
- Modify: `src/state/machine.ts` (dispatch; observer exception)
- Test: `tests/brain/activation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BrainModel {
    name: string; dims: number; languages: string; bytes: number;
    url: string; sha256: string; tokenizer: "wordlevel" | "xlmr";
  }
  export const MODELS: BrainModel[];
  ```
  and on `State`: `brain: { active: boolean; model: string | null; askedAtMs: number | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/brain/activation.test.ts
import { beforeEach, describe, expect, test } from "bun:test";
import { MODELS } from "../../src/brain/registry";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

function joined(state: State, name: string, ms = 0, extra: Record<string, unknown> = {}): string {
  const out = apply(state, null, { v: 1, op: "join", name, mission: "m", ...extra }, at(ms));
  return (out.response as unknown as { id: string }).id;
}

let state: State;
let core: string;
let human: string;
beforeEach(() => {
  counter = { n: 0 };
  state = initialState("advisory");
  core = joined(state, "CORE", 0);
  human = joined(state, "Marcus", 10, { kind: "human" });
});

describe("turning the brain on", () => {
  test("it starts off, and every registry entry declares its size and languages", () => {
    expect(state.brain.active).toBe(false);
    expect(MODELS.length).toBeGreaterThan(0);
    for (const m of MODELS) {
      expect(m.bytes).toBeGreaterThan(0);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.languages).toBeTruthy();
    }
  });

  test("an agent asking for semantic recall gets the floor, and never a prompt", () => {
    const out = apply(state, core, { v: 1, op: "notes", q: "anything", semantic: true }, at(100));
    expect(out.response.ok).toBe(true);
    expect(JSON.stringify(out.response)).not.toContain("enable");
  });

  test("but the panel is told, once", () => {
    const first = apply(state, core, { v: 1, op: "notes", q: "x", semantic: true }, at(100));
    expect(first.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(1);
    expect(first.broadcast[0]!.priority).toBe("high");

    const second = apply(state, core, { v: 1, op: "notes", q: "y", semantic: true }, at(200));
    expect(second.broadcast.filter((e) => e.text.includes("parley brain enable"))).toHaveLength(0);
  });

  test("an agent may not turn it on — it is somebody's disk and somebody's money", () => {
    const out = apply(state, core, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    expect(out.response.ok).toBe(false);
  });

  test("the watching human may", () => {
    const out = apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    expect(out.response.ok).toBe(true);
    expect(state.brain.active).toBe(true);
    expect(state.brain.model).toBe(MODELS[0]!.name);
  });

  test("a model that is not in the registry is refused", () => {
    const out = apply(state, human, { v: 1, op: "brain", enable: "something-off-the-internet" }, at(300));
    expect(out.response.ok).toBe(false);
    expect(state.brain.active).toBe(false);
  });

  test("status is readable by anyone", () => {
    const out = apply(state, core, { v: 1, op: "brain" }, at(400));
    expect(out.response).toMatchObject({ ok: true, active: false });
  });

  test("disabling puts it back on the floor without losing the corpus", () => {
    apply(state, human, { v: 1, op: "brain", enable: MODELS[0]!.name }, at(300));
    apply(state, human, { v: 1, op: "brain", disable: true }, at(400));
    expect(state.brain.active).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/brain/activation.test.ts`
Expected: FAIL — module and op missing.

- [ ] **Step 3: Write the registry**

```ts
// src/brain/registry.ts
export interface BrainModel {
  name: string;
  dims: number;
  /** Human-readable, shown at the prompt before anyone agrees to a download. */
  languages: string;
  bytes: number;
  url: string;
  sha256: string;
  /** `wordlevel` needs only a regex split. `xlmr` needs a real tokenizer. */
  tokenizer: "wordlevel" | "xlmr";
}

/**
 * Static models only.
 *
 * A token lookup table plus pooling: deterministic, microseconds, and no
 * per-platform native runtime — which is what keeps the Windows, WSL and arm64
 * work intact. Transformer models are excluded on all three counts.
 *
 * Fill in the real sha256 for each entry when the asset is published; the tests
 * assert the shape, and the downloader refuses anything that does not match.
 */
export const MODELS: BrainModel[] = [
  {
    name: "potion-multilingual-128M-int8",
    dims: 256,
    languages: "101 languages, including Portuguese",
    bytes: 100 * 1024 * 1024,
    url: "https://huggingface.co/minishlab/potion-multilingual-128M/resolve/main/model.safetensors",
    sha256: "0".repeat(64),
    tokenizer: "xlmr",
  },
];

export function findModel(name: string): BrainModel | undefined {
  return MODELS.find((m) => m.name === name);
}
```

- [ ] **Step 4: Add the state and the op**

`State.brain = { active: false, model: null, askedAtMs: null }` in `emptyState`.

`brain` op: no argument → status. `enable: <name>` → human-only, must be in the registry. `disable: true` → human-only. Add `brain` to the observer's allowed list, beside `shape` and `summon`.

When a `notes` frame carries `semantic: true` and `state.brain.active` is false, answer normally from the floor and, if `state.brain.askedAtMs === null`, stamp it and broadcast one `high` event:

> *a front asked for semantic recall and the brain is off — `parley brain enable` to pick a model*

Once, not on every query. Same nudge-once discipline as `src/state/permissions.ts:204`.

- [ ] **Step 5: Run everything**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/brain/registry.ts src/state src/protocol/types.ts tests/brain/activation.test.ts
git commit -m "feat: quem liga o cérebro e escolhe o modelo é a pessoa, no painel"
```

---

### Task 6: Download, verify, refuse

**Files:**
- Create: `src/brain/download.ts`
- Test: `tests/brain/download.test.ts`

**Interfaces:**
- Consumes: `BrainModel` (Task 5); `stateDir` from `src/transport/address.ts:59`.
- Produces:
  ```ts
  export function modelPath(model: BrainModel): string;
  export async function ensureModel(model: BrainModel, fetchFn?: typeof fetch): Promise<string | null>;
  ```
  `null` on any failure. A file whose SHA-256 does not match is deleted.

- [ ] **Step 1: Write the failing test**

```ts
// tests/brain/download.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { ensureModel, modelPath } from "../../src/brain/download";
import type { BrainModel } from "../../src/brain/registry";

const body = new TextEncoder().encode("pretend this is a model");
const digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");

const model = (sha: string): BrainModel => ({
  name: "test-model", dims: 4, languages: "test", bytes: body.length,
  url: "https://example.invalid/model.bin", sha256: sha, tokenizer: "wordlevel",
});

const okFetch = (async () => new Response(body)) as unknown as typeof fetch;

describe("getting a model onto the machine", () => {
  test("a good download lands in the machine-local state directory, not in the repository", async () => {
    const path = await ensureModel(model(digest), okFetch);
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(path!).not.toContain(process.cwd());
  });

  test("a checksum mismatch deletes the file and returns null", async () => {
    const bad = model("f".repeat(64));
    const path = await ensureModel(bad, okFetch);
    expect(path).toBeNull();
    expect(existsSync(modelPath(bad))).toBe(false);
  });

  test("a network failure returns null and never throws", async () => {
    const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await ensureModel(model(digest), failing)).toBeNull();
  });

  test("an HTTP error is a failure, not a zero-byte model", async () => {
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await ensureModel(model(digest), notFound)).toBeNull();
  });

  test("a model already on disk is not downloaded again", async () => {
    let calls = 0;
    const counting = (async () => { calls++; return new Response(body); }) as unknown as typeof fetch;
    await ensureModel(model(digest), counting);
    await ensureModel(model(digest), counting);
    expect(calls).toBe(1);
  });

  test("one download serves every repository — it is a fact about the machine", () => {
    expect(modelPath(model(digest))).toContain("models");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/brain/download.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write it**

Follow `install.sh:75-97` in spirit: fetch, hash, compare, and **refuse to install a corrupted file**. Store under the machine-local state directory in a `models/<name>` folder, never inside a repository — one download serves every project, exactly like `repos.json` in `src/adapters/registry.ts`.

- [ ] **Step 4: Run everything**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/brain/download.ts tests/brain/download.test.ts
git commit -m "feat: baixar o modelo com a mesma desconfiança com que se baixa o binário"
```

---

### Task 7: Static inference, and hybrid ranking

**Files:**
- Create: `src/brain/embed.ts` — model loading, embedding, nearest neighbours, fusion
- Create: `src/brain/vectors.ts` — persisting the int8 vectors beside the journal, nothing else
- Create: `tests/brain/fixtures/tiny-model.json`
- Test: `tests/brain/embed.test.ts`

**Interfaces:**
- Consumes: `tokenize` (Task 1), and `Hit` and `LexicalIndex` from `src/brain/lexical.ts` (Task 2), and `modelPath` (Task 6). `Hit` is defined once, in `lexical.ts`; `embed.ts` imports it rather than declaring a second one.
- Produces:
  ```ts
  // all from src/brain/embed.ts
  export interface StaticModel { dims: number; vocab: Record<string, number[]> }
  export function loadStaticModel(path: string): StaticModel | null;
  export function embed(model: StaticModel, text: string): Float32Array;
  export class VectorIndex {
    constructor(dims: number);
    add(id: string, vec: Float32Array): void;
    remove(id: string): void;
    search(vec: Float32Array, k: number): Hit[];
  }
  export function fuse(lexical: Hit[], vector: Hit[], k: number): Hit[];

  // from src/brain/vectors.ts
  export function saveVectors(dir: string, index: VectorIndex): void;
  export function loadVectors(dir: string, dims: number): VectorIndex | null;
  ```

- [ ] **Step 1: Write the fixture and the failing test**

```json
// tests/brain/fixtures/tiny-model.json
{ "dims": 2, "vocab": { "select2": [1, 0], "menu": [0, 1], "lateral": [0, 1], "hidden": [1, 0] } }
```

```ts
// tests/brain/embed.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { embed, fuse, VectorIndex } from "../../src/brain/embed";

const model = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "tiny-model.json"), "utf8"));

describe("static embeddings", () => {
  test("the same text always gives the same vector, bit for bit", () => {
    expect(Array.from(embed(model, "select2 hidden"))).toEqual(Array.from(embed(model, "select2 hidden")));
  });

  test("it is a lookup and a mean, so it is assertable", () => {
    expect(Array.from(embed(model, "select2"))).toEqual([1, 0]);
    expect(Array.from(embed(model, "menu lateral"))).toEqual([0, 1]);
  });

  test("an unknown token contributes nothing rather than poisoning the vector", () => {
    expect(Array.from(embed(model, "select2 kubernetes"))).toEqual([1, 0]);
  });

  test("text with no known token gives a zero vector, and never a NaN", () => {
    const v = embed(model, "kubernetes helm");
    expect(Array.from(v).every((x) => x === 0)).toBe(true);
  });

  test("nearest neighbours come back in order", () => {
    const index = new VectorIndex(2);
    index.add("n_1", embed(model, "select2 hidden"));
    index.add("n_2", embed(model, "menu lateral"));
    expect(index.search(embed(model, "select2"), 1)[0]!.id).toBe("n_1");
  });

  test("fusion puts a document both rankings agree on above one only a single ranking found", () => {
    const lex = [{ id: "a", score: 3, kind: "note" as const }, { id: "b", score: 2, kind: "note" as const }];
    const vec = [{ id: "b", score: 0.9, kind: "note" as const }, { id: "c", score: 0.8, kind: "note" as const }];
    expect(fuse(lex, vec, 3)[0]!.id).toBe("b");
  });

  test("fusion never invents a document neither ranking returned", () => {
    const out = fuse([{ id: "a", score: 1, kind: "note" }], [], 5);
    expect(out.map((h) => h.id)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/brain/embed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the inference and the fusion**

```ts
// src/brain/embed.ts (sketch — the maths is the easy half)
export function embed(model: StaticModel, text: string): Float32Array {
  const out = new Float32Array(model.dims);
  let seen = 0;
  for (const token of tokenize(text)) {
    const row = model.vocab[token];
    if (!row) continue;                 // unknown tokens contribute nothing
    for (let i = 0; i < model.dims; i++) out[i]! += row[i]!;
    seen++;
  }
  if (seen === 0) return out;           // zero vector, never a NaN
  for (let i = 0; i < model.dims; i++) out[i]! /= seen;
  return out;
}

/**
 * Reciprocal rank fusion.
 *
 * Not a hedge: lexical carries the identifiers, vectors carry the paraphrase,
 * and every sentence in this corpus has both — Portuguese prose around English
 * identifiers.
 */
export function fuse(lexical: Hit[], vector: Hit[], k: number): Hit[] {
  const RRF_K = 60;
  const scores = new Map<string, { score: number; kind: Hit["kind"] }>();
  const add = (hits: Hit[]) => hits.forEach((h, rank) => {
    const prev = scores.get(h.id);
    const bump = 1 / (RRF_K + rank + 1);
    scores.set(h.id, { score: (prev?.score ?? 0) + bump, kind: prev?.kind ?? h.kind });
  });
  add(lexical);
  add(vector);
  return [...scores.entries()]
    .sort((a, b) => (b[1].score - a[1].score) || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([id, v]) => ({ id, score: v.score, kind: v.kind }));
}
```

The XLM-RoBERTa tokenizer is the expensive half and is **not** in this task. Ship the `wordlevel` path first; the registry's `tokenizer` field is what lets `xlmr` arrive later without changing anything else.

- [ ] **Step 4: Wire it into the daemon**

When `state.brain.active`, the daemon embeds each note on write and searches both indexes, fusing the results. Vectors persist beside the journal so a restart does not re-embed. Activating later backfills every note from state, so there is no window where old knowledge is invisible.

- [ ] **Step 5: Run everything**

Run: `bun test && bun run typecheck && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/brain tests/brain/embed.test.ts tests/brain/fixtures
git commit -m "feat: embedding estático é determinístico, então dá para testá-lo de verdade"
```

---

### Task 8: Degradation, proved

**Files:**
- Test: `tests/brain/degradation.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/brain/degradation.test.ts
import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureModel } from "../../src/brain/download";
import { loadStaticModel } from "../../src/brain/embed";
import { LexicalIndex } from "../../src/brain/lexical";
import type { BrainModel } from "../../src/brain/registry";
import { apply, initialState, makeCtx } from "../../src/state/machine";
import type { Ctx, Note, State } from "../../src/state/types";

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);
let counter = { n: 0 };
const at = (ms: number): Ctx => makeCtx(T0 + ms, counter);

describe("nothing here can stop the work", () => {
  test("brain off: the floor answers", () => {
    const index = new LexicalIndex();
    index.add("n_1", "note", "the select2 trap, a for pointing at a hidden element");
    expect(index.search("select2", 3)[0]!.id).toBe("n_1");
  });

  test("a corrupt model file loads as null instead of throwing", () => {
    const path = join(import.meta.dir, "fixtures", "corrupt-model.json");
    writeFileSync(path, "{ not json", "utf8");
    expect(loadStaticModel(path)).toBeNull();
    unlinkSync(path);
  });

  test("a model whose checksum does not match never activates the brain", async () => {
    const model: BrainModel = {
      name: "bad", dims: 4, languages: "x", bytes: 4,
      url: "https://example.invalid/m.bin", sha256: "f".repeat(64), tokenizer: "wordlevel",
    };
    const body = new TextEncoder().encode("not the model");
    const fetchFn = (async () => new Response(body)) as unknown as typeof fetch;
    expect(await ensureModel(model, fetchFn)).toBeNull();
  });

  test("index cold: path-anchored delivery still rides along on a claim", () => {
    counter = { n: 0 };
    const state: State = initialState("advisory");
    const id = (r: { response: unknown }) => (r.response as { id: string }).id;
    const core = id(apply(state, null, { v: 1, op: "join", name: "CORE", mission: "m" }, at(0)));
    apply(state, core, { v: 1, op: "note", title: "the select2 trap", paths: ["a.ts"] }, at(10));
    const other = id(apply(state, null, { v: 1, op: "join", name: "OTHER", mission: "m" }, at(20)));
    const out = apply(state, other, { v: 1, op: "claim", paths: ["a.ts"] }, at(30));
    // No index is involved at all. This is the floor beneath the floor, and it
    // is what parley did before any of this existed.
    expect((out.response as unknown as { notes: Note[] }).notes).toHaveLength(1);
  });

  test("an empty index answers nothing rather than throwing", () => {
    expect(new LexicalIndex().search("anything", 5)).toEqual([]);
  });

  test("a query of only unknown tokens returns nothing, not the least-bad note", () => {
    const index = new LexicalIndex();
    index.add("n_1", "note", "the select2 trap");
    expect(index.search("kubernetes helm chart", 5)).toEqual([]);
  });
});
```

Every one of these is a line in the spec's degradation table, and the table is the feature — not a caveat attached to it.

- [ ] **Step 2: Run everything**

Run: `bun test && bun run typecheck && bun run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/brain/degradation.test.ts
git commit -m "test: cada linha da tabela de degradação vira uma asserção"
```
