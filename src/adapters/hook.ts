import { ParleyClient, ParleyUnreachable } from "../client/client";
import { DEFAULTS } from "../protocol/types";
import { locateRepo } from "../repo/locate";
import { resolveIdentity } from "../cli/identity";
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
  const budget = setTimeout(() => { emit({}); process.exit(0); }, DEFAULTS.HOOK_BUDGET_MS * 40);

  let repo;
  try { repo = locateRepo(input.cwd ?? process.cwd()); } catch { clearTimeout(budget); return emit({}); }

  // Hooks installed globally fire in every repository you open. Doing nothing
  // where parley was never set up is what makes that safe.
  if (!isEnabledForRepo(repo.gitCommonDir)) { clearTimeout(budget); return emit({}); }

  let client: ParleyClient;
  try {
    client = await ParleyClient.connect({ gitCommonDir: repo.gitCommonDir, timeoutMs: 2_000 });
  } catch (e) {
    clearTimeout(budget);
    // enforced degrades to advisory when the daemon is unreachable. A
    // coordination system that freezes the machine when it fails is worse than
    // no system at all.
    if (e instanceof ParleyUnreachable) return emit({});
    throw e;
  }

  const identity = resolveIdentity(repo.root, input.cwd ?? process.cwd());
  // The harness session id is what keeps this front the same front across
  // every tool call, and across the rename the agent is asked to do.
  const session = input.session_id ?? process.env.PARLEY_SESSION ?? "";
  let joined = await client.request({
    op: "join", name: identity.name, mission: identity.mission,
    harness: "claude-code", cwd: repo.root, kind: "agent",
    branch: identity.branch, session,
  });
  if (!joined.ok && joined.error.code === "NAME_TAKEN" && "suggestion" in joined.error) {
    joined = await client.request({
      op: "join", name: String(joined.error.suggestion), mission: identity.mission,
      harness: "claude-code", cwd: repo.root, kind: "agent",
      branch: identity.branch, session,
    });
  }
  if (!joined.ok) { clearTimeout(budget); client.close(); return emit({}); }

  // Write down which harness session owns this worktree, so the CLI calls the
  // agent makes through its shell can claim the same identity.
  if (session) {
    rememberSession(repo.gitCommonDir, repo.root, {
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
        `You are on a parley bus as "${me.name}" (mode: ${me.mode}). Other agent sessions may be working in this same repository right now.\n` +
          `Rename yourself and declare what you are doing: \`parley rename --as SHORTNAME --mission "what you are working on"\`.\n` +
          `Use \`parley who\` to see the other fronts, \`parley say "..."\` to tell them something, \`parley ask <path> --reason "..."\` when a file you need belongs to someone else, and \`parley note --title "..." --body "..."\` for knowledge worth keeping for every future session.`,
      );
    }

    if (name === "SessionEnd" || name === "Stop") {
      await client.request({ op: "leave" });
      clearTimeout(budget);
      return emit({});
    }

    const drained = await client.request({ op: "drain" });
    const events = drained.ok ? (drained as unknown as { events: never[] }).events : [];
    const inbox = formatEvents(events);

    if (name !== "PreToolUse") {
      clearTimeout(budget);
      return context(name, [inbox, territoryReminder()].filter(Boolean).join("\n\n"));
    }

    // PreToolUse: one hook, one call — drain the inbox and, when the tool is an
    // edit, settle territory in the same answer.
    if (!EDIT_TOOLS.has(input.tool_name ?? "")) {
      clearTimeout(budget);
      return context(name, inbox);
    }

    const rawPath = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
    if (!rawPath) { clearTimeout(budget); return context(name, inbox); }
    const target = isAbsolute(rawPath) ? relative(repo.root, rawPath) : rawPath;

    const claimed = await client.request({ op: "claim", paths: [target], auto: true });
    clearTimeout(budget);

    if (claimed.ok) {
      // Everything below rides on the call the hook was already making. It
      // fires only for the path being edited, which is what keeps unsolicited
      // context rare and precise instead of a running commentary.
      const settled = claimed as unknown as {
        notes?: { title: string; body: string; authorName: string; kind: string }[];
        recent?: { byName: string; intent: string; at: string }[];
      };

      const known = (settled.notes ?? []).map((n) => {
        const label = n.kind === "decision" ? "DECISION" : "note";
        return `  [${label}] ${n.title}${n.body ? `\n      ${n.body.replace(/\n+/g, " ")}` : ""} (${n.authorName})`;
      });
      const knowledge = known.length
        ? `parley: what other fronts have written down about ${target}:\n${known.join("\n")}`
        : "";

      const touches = (settled.recent ?? []).map(
        (t) => `  ${t.byName} touched it at ${t.at.slice(11, 16)}${t.intent ? ` — ${t.intent}` : ""}`,
      );
      const changed = touches.length
        ? `parley: recently edited by someone else — read it before assuming what is in it:\n${touches.join("\n")}`
        : "";

      return context(name, [inbox, knowledge, changed, territoryReminder()].filter(Boolean).join("\n\n"));
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
    return context(name, `${inbox ? `${inbox}\n\n` : ""}parley warning: ${reason} Consider \`parley ask ${target} --reason "..."\` or coordinating with \`parley say\`.`);
  } finally {
    client.close();
  }
}
