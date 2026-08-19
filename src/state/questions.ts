import { DEFAULTS, err, ok } from "../protocol/types";
import { actorOf, byName, pushEvent, type Ctx, type Outcome, type Question, type State } from "./types";

/**
 * Asking a front something and actually getting an answer.
 *
 * A plain `say` lands in an inbox that an idle session will not read until the
 * person prompts it again — so a direct question to a stopped agent goes
 * unanswered for as long as its window sits there. A question carries state:
 * somebody owes an answer. The recipient's harness can then refuse to go idle
 * while one is open, and the asker can wait for it instead of guessing.
 */

const QUESTION_TTL_MS = 10 * 60_000;

export function askFront(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const toName = typeof frame.to === "string" ? frame.to.trim() : "";
  const target = toName ? byName(state, toName) : undefined;
  if (!target) return { state, response: err("NOT_JOINED", `no live front named ${toName}`), broadcast: [] };
  if (target.id === me.id) return { state, response: err("NOT_OWNER", "you cannot question yourself"), broadcast: [] };

  const text = typeof frame.text === "string" ? frame.text.trim() : "";
  if (!text) return { state, response: err("UNKNOWN_OP", "a question needs text"), broadcast: [] };

  const ttlMs = typeof frame.ttl_s === "number" && frame.ttl_s > 0 ? frame.ttl_s * 1000 : QUESTION_TTL_MS;
  const question: Question = {
    id: ctx.nextId("q"),
    fromId: me.id, fromName: me.name,
    toId: target.id, toName: target.name,
    text, at: ctx.now, atMs: ctx.nowMs,
    expiresAtMs: ctx.nowMs + ttlMs,
    answer: null, answeredAtMs: null, answerSeenAtMs: null,
    acknowledgedAtMs: null, deliveredAtMs: null,
  };
  state.questions[question.id] = question;
  me.lastSeenMs = ctx.nowMs;

  const event = pushEvent(state, ctx, {
    kind: "say",
    from: { id: me.id, name: me.name, kind: me.kind },
    to: target.name,
    priority: "high",
    text: `[question ${question.id}] ${text}`,
  });

  // Telling the asker how this lands is the difference between waiting on
  // purpose and waiting in the dark — which is what makes somebody reach for a
  // side channel instead.
  const idle = Math.round((ctx.nowMs - target.lastSeenMs) / 1000);
  const reach =
    target.delivery === "live"
      ? "they hold an open connection, so it is already in front of them"
      : idle > 120
        ? `they read their inbox on their next tool call, and have been idle ${Math.round(idle / 60)}m — this may sit for a while`
        : "they read their inbox on their next tool call, usually within seconds";

  return {
    state,
    response: ok({
      question: question.id,
      to: target.name,
      delivery: target.delivery,
      reach,
      expires_at: new Date(question.expiresAtMs).toISOString(),
    }),
    broadcast: [event],
  };
}

export function replyToQuestion(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const question = state.questions[String(frame.id ?? "")];
  if (!question) return { state, response: err("UNKNOWN_OP", "no open question with that id"), broadcast: [] };
  if (question.toId !== me.id) {
    return { state, response: err("NOT_OWNER", "that question was not put to you"), broadcast: [] };
  }
  if (question.answer !== null) {
    return { state, response: err("NOT_OWNER", "already answered"), broadcast: [] };
  }

  const text = typeof frame.text === "string" ? frame.text.trim() : "";
  if (!text) return { state, response: err("UNKNOWN_OP", "an answer needs text"), broadcast: [] };

  question.answer = text;
  question.answeredAtMs = ctx.nowMs;
  me.lastSeenMs = ctx.nowMs;

  const asker = state.participants[question.fromId];
  const event = pushEvent(state, ctx, {
    kind: "say",
    from: { id: me.id, name: me.name, kind: me.kind },
    to: asker?.name ?? null,
    priority: "high",
    text: `[answer to ${question.id}] ${text}`,
  });

  return { state, response: ok({ id: question.id, answered: true }), broadcast: [event] };
}

/**
 * Acknowledging an answer.
 *
 * Without this the exchange ends in the dark: the front that answered has no
 * idea whether the answer arrived or was understood, and the one that asked has
 * no natural place to say "got it, I am going ahead". It also gives the asker's
 * own harness a reason not to go idle before it has read the answer.
 */
export function acknowledge(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const question = state.questions[String(frame.id ?? "")];
  if (!question) return { state, response: err("UNKNOWN_OP", "no question with that id"), broadcast: [] };
  if (question.fromId !== me.id) {
    return { state, response: err("NOT_OWNER", "you did not ask that question"), broadcast: [] };
  }
  if (question.answer === null) {
    return { state, response: err("NOT_OWNER", "it has not been answered yet"), broadcast: [] };
  }
  if (question.acknowledgedAtMs !== null) {
    return { state, response: err("NOT_OWNER", "already acknowledged"), broadcast: [] };
  }

  question.acknowledgedAtMs = ctx.nowMs;
  me.lastSeenMs = ctx.nowMs;
  const text = typeof frame.text === "string" ? frame.text.trim() : "";

  return {
    state,
    response: ok({ id: question.id, acknowledged: true }),
    broadcast: [pushEvent(state, ctx, {
      kind: "say",
      from: { id: me.id, name: me.name, kind: me.kind },
      to: question.toName,
      priority: "normal",
      text: `[ack ${question.id}] ${text || "understood"}`,
    })],
  };
}

/** Open questions, from either side. `mine` limits to ones you owe an answer to. */
export function listQuestions(state: State, actorId: string | null, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const me = actorOf(state, actorId);
  if (!me) return { state, response: err("NOT_JOINED"), broadcast: [] };

  const open = Object.values(state.questions).filter(
    (q) => q.answer === null && ctx.nowMs < q.expiresAtMs,
  );
  const owed = open.filter((q) => q.toId === me.id);
  const waiting = open.filter((q) => q.fromId === me.id);

  // Answers you asked for, that arrived, and that you have not acknowledged.
  // This is what keeps the asker from stopping before it reads the reply.
  const answered = Object.values(state.questions).filter(
    (q) => q.fromId === me.id && q.answer !== null && q.acknowledgedAtMs === null,
  );
  // Snapshot before stamping, same as above: the caller asked what was unseen
  // when it asked, not what is left after we marked it. Getting this backwards
  // makes the nudge silently never fire, which is the failure that looks like
  // "the feature does nothing".
  const unseenAnswers = answered.filter((q) => q.answerSeenAtMs === null);
  if (frame.deliver === true) for (const q of unseenAnswers) q.answerSeenAtMs = ctx.nowMs;

  // Snapshot before marking: the caller needs to know what was undelivered
  // when it asked, not what is left after we stamped it.
  const undelivered = owed.filter((q) => q.deliveredAtMs === null);

  // Marking on read is what keeps a question from forcing the same agent to
  // continue over and over: it gets one hard nudge, then it is just an inbox
  // item like anything else.
  if (frame.deliver === true) for (const q of undelivered) q.deliveredAtMs = ctx.nowMs;

  const shape = (q: Question) => ({
    id: q.id, from: q.fromName, to: q.toName, text: q.text, at: q.at,
    seconds_left: Math.max(0, Math.round((q.expiresAtMs - ctx.nowMs) / 1000)),
    delivered: q.deliveredAtMs !== null,
  });

  return {
    state,
    response: ok({
      owed: owed.map(shape),
      undelivered: undelivered.map(shape),
      waiting: waiting.map((q) => ({ ...shape(q), answer: q.answer })),
      answered: answered.map((q) => ({
        id: q.id, from: q.toName, text: q.text, answer: q.answer,
        seen: q.answerSeenAtMs !== null,
      })),
      unseen_answers: unseenAnswers.map((q) => ({
        id: q.id, from: q.toName, text: q.text, answer: q.answer,
      })),
    }),
    broadcast: [],
  };
}

/** One question by id, so an asker can poll for its answer. */
export function questionStatus(state: State, frame: Record<string, unknown>, ctx: Ctx): Outcome {
  const question = state.questions[String(frame.id ?? "")];
  if (!question) return { state, response: err("UNKNOWN_OP", "no question with that id"), broadcast: [] };
  return {
    state,
    response: ok({
      id: question.id, to: question.toName, from: question.fromName,
      answer: question.answer,
      answered: question.answer !== null,
      expired: question.answer === null && ctx.nowMs >= question.expiresAtMs,
      seconds_left: Math.max(0, Math.round((question.expiresAtMs - ctx.nowMs) / 1000)),
    }),
    broadcast: [],
  };
}

export { DEFAULTS };
