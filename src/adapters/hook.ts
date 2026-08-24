import { ParleyClient, ParleyUnreachable } from "../client/client";
import { DEFAULTS } from "../protocol/types";
import { locateRepo } from "../repo/locate";
import { joinFrame, resolveIdentity, wakeAddress } from "../cli/identity";
import { relative, isAbsolute } from "node:path";
import { rememberSession } from "../cli/session";
import { isEnabledForRepo } from "./claude-code";

/**
 * One executable, JSON in, JSON out. Never a shell one-liner: on Windows a hook
 * runs under cmd.exe, where `jq`, pipes and `&&` do not exist. That is exactly
 * how "cross-platform" tools break in practice.
 */

interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  cwd?: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function context(event: string, text: string): void {
  if (!text) return emit({});
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

function readStdin(): Promise<HookInput> {
  return new Promise((resolve) => {
    let raw = "";
    const timer = setTimeout(() => resolve({}), 200);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(raw) as HookInput); } catch { resolve({}); }
    });
    process.stdin.on("error", () => { clearTimeout(timer); resolve({}); });
  });
}

function formatEvents(events: { from: { name: string; kind: string } | null; text: string; priority: string }[]): string {
  if (events.length === 0) return "";
  const lines = events.map((e) => {
    const who = e.from ? `${e.from.name}${e.from.kind === "human" ? " (human)" : ""}` : "parley";
    return `${e.priority === "high" ? "[!] " : ""}${who}: ${e.text}`;
  });
  return `Messages from other sessions on this repository (parley):\n${lines.join("\n")}`;
}

export async function runHook(event: string): Promise<void> {
  const input = await readStdin();
  const name = input.hook_event_name ?? event;

  // Hard budget. Overrun means let go — the agent never waits for parley.
  const budget = setTimeout(() => { emit({}); process.exit(0); }, DEFAULTS.HOOK_BUDGET_MS);

  let repo;
  try { repo = locateRepo(input.cwd ?? process.cwd()); } catch { clearTimeout(budget); return emit({}); }

  // Hooks installed globally fire in every repository you open. Doing nothing
  // where parley was never set up is what makes that safe.
  if (!isEnabledForRepo(repo.discoveryDir)) { clearTimeout(budget); return emit({}); }

  // Repositories set up before the registry existed have the marker but are not
  // listed, so `parley update` would skip them. Registering here costs one file
  // write per session start and needs nobody to re-run `init`.
  if (name === "SessionStart") {
    try {
      const { readRegistry, registerRepo } = await import("./registry");
      if (!readRegistry().some((r) => r.gitCommonDir === repo.gitCommonDir)) {
        registerRepo(repo.gitCommonDir, repo.root, repo.discoveryDir);
      }
    } catch { /* the registry is a convenience, never a blocker */ }
  }

  let client: ParleyClient;
  try {
    client = await ParleyClient.connect({ gitCommonDir: repo.discoveryDir, busKey: repo.gitCommonDir, timeoutMs: 2_000 });
  } catch (e) {
    clearTimeout(budget);
    // enforced degrades to advisory when the daemon is unreachable. A
    // coordination system that freezes the machine when it fails is worse than
    // no system at all.
    if (e instanceof ParleyUnreachable) return emit({});
    throw e;
  }

  const identity = resolveIdentity(repo.cwd, repo.cwd);
  // The harness session id is what keeps this front the same front across
  // every tool call, and across the rename the agent is asked to do.
  const session = input.session_id ?? process.env.PARLEY_SESSION ?? "";
  const join = (name?: string) => joinFrame(identity, {
    harness: "claude-code", cwd: repo.cwd, kind: "agent", wake: wakeAddress(), session,
    ...(name ? { name } : {}),
  });
  let joined = await client.request(join());
  if (!joined.ok && joined.error.code === "NAME_TAKEN" && "suggestion" in joined.error) {
    joined = await client.request(join(String(joined.error.suggestion)));
  }
  if (!joined.ok) { clearTimeout(budget); client.close(); return emit({}); }

  // Write down which harness session owns this worktree, so the CLI calls the
  // agent makes through its shell can claim the same identity.
  if (session) {
    rememberSession(repo.discoveryDir, repo.cwd, {
      session,
      name: (joined as unknown as { name: string }).name,
      at: new Date().toISOString(),
    });
  }

  const me = joined as unknown as {
    id: string; name: string; mode: string; reattached?: boolean;
    claims?: { pattern: string; auto: boolean; idle_s: number }[];
  };

  /**
   * Territory an agent forgot about is the most common way this system gets in
   * its own way: a front finishes with a subtree and keeps it locked, and
   * everybody else waits on a file nobody is editing. The reminder fires only
   * for paths that have gone quiet, and only where the agent is already reading
   * — asking it to remember on its own does not work.
   */
  const STALE_CLAIM_S = 300;
  function territoryReminder(): string {
    const stale = (me.claims ?? []).filter((c) => c.idle_s >= STALE_CLAIM_S);
    if (stale.length === 0) return "";
    const list = stale.map((c) => `${c.pattern} (idle ${Math.round(c.idle_s / 60)}m)`).join(", ");
    return `parley: you still hold ${list}. Release whatever you are done with — \`parley release ${stale[0]!.pattern}\` — and re-claim it if you need it again. Holding a path you are not editing blocks the other fronts.`;
  }

  try {
    if (name === "SessionStart") {
      clearTimeout(budget);
      return context(
        name,
        `You are on a parley bus as "${me.name}" (mode: ${me.mode}). Other agent sessions may be working in this same repository right now.\n\n` +
          `FIRST, do two things:\n` +
          `1. Pick a short name that says what you are here to do and claim it:\n` +
          `   \`parley rename --as SHORTNAME --mission "what you are working on"\`\n` +
          `   The name you have now was derived from the branch, and every session on\n` +
          `   this branch derives the same one.\n` +
          `2. **Tell the person, in your first reply, which name you are using on the\n` +
          `   bus.** They are watching several sessions at once and have no other way\n` +
          `   to tell which window is which. One line is enough, e.g.\n` +
          `   "I'm on parley as TAXAS." Repeat it if you rename later.\n\n` +
          `Then: \`parley who\` to see the other fronts, \`parley say "..."\` to tell them\n` +
          `something, \`parley ask <path> --reason "..."\` when a file you need belongs to\n` +
          `someone else, and \`parley note --title "..." --paths <file>\` for knowledge the\n` +
          `next session should not have to rediscover.`,
      );
    }

    if (name === "Stop") {
      // The one place parley can make an idle agent answer.
      //
      // A direct question to a session that has stopped goes unanswered until
      // its person happens to type something — which can be hours. Claude Code
      // lets a Stop hook refuse the stop, so a front does not go idle while it
      // owes someone an answer.
      //
      // Each question does this exactly once: `deliver` marks it, and an
      // already-delivered question never blocks again. Two agents cannot
      // ping-pong each other into a loop.
      const [pending, perms] = await Promise.all([
        client.request({ op: "questions", deliver: true }),
        client.request({ op: "requests", deliver: true }),
      ]);
      clearTimeout(budget);

      const parts: string[] = [];

      if (pending.ok) {
        const q = pending as unknown as {
          undelivered: { id: string; from: string; text: string; seconds_left: number }[];
          unseen_answers: { id: string; from: string; text: string; answer: string }[];
          need_nudge: { id: string; to: string; text: string; wake: string | null; idle_s: number }[];
        };
        if (q.undelivered.length) {
          parts.push(
            `Another front is blocked waiting on you to answer:\n` +
              q.undelivered.map((x) => `- ${x.from} asks (${x.id}, ${x.seconds_left}s left): ${x.text}`).join("\n") +
              `\nAnswer now: \`parley reply <id> "your answer"\`. If you cannot answer, say so — that unblocks them too.`,
          );
        }
        if (q.need_nudge?.length) {
          parts.push(
            `You asked a front that has since gone quiet, and it will not see your\n` +
              `question until something wakes it. No external process can do that —\n` +
              `only another session can:\n` +
              q.need_nudge
                .map((x) => `- ${x.id}: ${x.to} (idle ${Math.round(x.idle_s / 60)}m) at ${x.wake}\n  you asked: ${x.text}`)
                .join("\n") +
              `\nUse your session-message tool now, at that address, saying only that they\n` +
              `have a parley question and should run \`parley questions\`. Keep the content\n` +
              `on the bus. Then record it: \`parley nudged <id>\`, so this stops asking.`,
          );
        }
        if (q.unseen_answers.length) {
          parts.push(
            `You asked, and they answered — read it before you finish:\n` +
              q.unseen_answers.map((x) => `- ${x.from} on "${x.text}": ${x.answer}`).join("\n") +
              `\nAct on it, then close the loop so they know it landed: \`parley ack <id> "got it, doing X"\`.`,
          );
        }
      }

      if (perms.ok) {
        const p = perms as unknown as {
          needs_my_decision: { id: string; requester: string; path: string; reason: string; seconds_left: number }[];
          settled_for_me: { id: string; path: string; state: string; deny_reason: string | null }[];
        };
        if (p.needs_my_decision.length) {
          parts.push(
            `You hold paths another front is waiting on:\n` +
              p.needs_my_decision.map((x) => `- ${x.requester} wants ${x.path} (${x.id}, ${x.seconds_left}s left): ${x.reason}`).join("\n") +
              `\nSettle it: \`parley grant <id>\`, \`parley deny <id> --reason "..."\`, or simply ` +
              `\`parley release <path>\` if you are done with it — releasing hands it straight over.`,
          );
        }
        if (p.settled_for_me.length) {
          parts.push(
            `A path you asked for has been settled:\n` +
              p.settled_for_me.map((x) => `- ${x.path}: ${x.state}${x.deny_reason ? ` — ${x.deny_reason}` : ""}`).join("\n") +
              `\nIf it was granted, do the edit now while it is yours, then release it.`,
          );
        }
      }

      if (parts.length === 0) return emit({});
      return emit({ decision: "block", reason: parts.join("\n\n") });
    }

    if (name === "SessionEnd") {
      await client.request({ op: "leave" });
      clearTimeout(budget);
      return emit({});
    }

    const drained = await client.request({ op: "drain" });
    const events = drained.ok ? (drained as unknown as { events: never[] }).events : [];
    const inbox = formatEvents(events);
    // Rides on the same drain the inbox came from — a second request for the
    // pool would double the round trips this hook pays against
    // `DEFAULTS.HOOK_BUDGET_MS`, which is the deadline the timer above is
    // actually armed with. It said "30ms budget" — one of three surviving
    // copies of a number this code has not enforced since the constant was
    // corrected, in three different files.
    const pool = drained.ok ? (drained as unknown as { pool?: string }).pool ?? "" : "";

    if (name !== "PreToolUse") {
      clearTimeout(budget);
      return context(name, [inbox, territoryReminder(), pool].filter(Boolean).join("\n\n"));
    }

    // PreToolUse: one hook, one call — drain the inbox and, when the tool is an
    // edit, settle territory in the same answer. For every other tool, having
    // got this far already did the job that matters: the session marker above
    // was refreshed, so the `parley` call this Bash is about to make will be
    // attributed to the right front.
    if (!EDIT_TOOLS.has(input.tool_name ?? "")) {
      clearTimeout(budget);
      return context(name, [inbox, pool].filter(Boolean).join("\n\n"));
    }

    const rawPath = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
    if (!rawPath) { clearTimeout(budget); return context(name, [inbox, pool].filter(Boolean).join("\n\n")); }
    const target = isAbsolute(rawPath) ? relative(repo.root, rawPath) : rawPath;

    const claimed = await client.request({ op: "claim", paths: [target], auto: true });
    clearTimeout(budget);

    if (claimed.ok) {
      // Everything below rides on the call the hook was already making. It
      // fires only for the path being edited, which is what keeps unsolicited
      // context rare and precise instead of a running commentary.
      const settled = claimed as unknown as {
        notes?: { title: string; body: string; authorName: string; kind: string }[];
        more_notes?: number;
        more_decisions?: number;
        recent?: { byName: string; intent: string; at: string }[];
      };

      const known = (settled.notes ?? []).map((n) => {
        const label = n.kind === "decision" ? "DECISION" : "note";
        return `  [${label}] ${n.title}${n.body ? `\n      ${n.body.replace(/\n+/g, " ")}` : ""} (${n.authorName})`;
      });
      if (settled.more_decisions) known.push(`  ${settled.more_decisions} more decision(s) — parley notes --path ${target} --kind decision`);
      if (settled.more_notes) known.push(`  ${settled.more_notes} more — parley notes --path ${target}`);
      const knowledge = known.length
        ? `parley: what other fronts have written down about ${target}:\n${known.join("\n")}`
        : "";

      const touches = (settled.recent ?? []).map(
        (t) => `  ${t.byName} touched it at ${t.at.slice(11, 16)}${t.intent ? ` — ${t.intent}` : ""}`,
      );
      const changed = touches.length
        ? `parley: recently edited by someone else — read it before assuming what is in it:\n${touches.join("\n")}`
        : "";

      return context(name, [inbox, knowledge, changed, territoryReminder(), pool].filter(Boolean).join("\n\n"));
    }

    const conflicts = (claimed as unknown as {
      conflicts?: { path: string; owner: { name: string; mission: string }; since: string }[];
    }).conflicts ?? [];
    const first = conflicts[0];
    const reason = first
      ? `${first.path} belongs to ${first.owner.name}${first.owner.mission ? ` (${first.owner.mission})` : ""} since ${first.since}.`
      : "another session holds this path.";

    if (me.mode === "enforced") {
      return emit({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `parley: ${reason} Run: parley ask ${target} --reason "why you need it" — unanswered in ${DEFAULTS.PERMISSION_TTL_MS / 60000} minutes means granted.`,
        },
      });
    }
    const warning = `parley warning: ${reason} Consider \`parley ask ${target} --reason "..."\` or coordinating with \`parley say\`.`;
    return context(name, [inbox, warning, pool].filter(Boolean).join("\n\n"));
  } finally {
    client.close();
  }
}
