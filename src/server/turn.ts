import "server-only";
import type { TurnEvent, TurnMetrics } from "@/lib/protocol";
import { LIMITS } from "@/lib/protocol";
import { config, testing } from "./config";
import {
  buildInterviewContext,
  buildLiveMessages,
  clip,
  isRepeatOf,
  recordQuestion,
  stateFromSession,
  type TranscriptEntry,
} from "./interview-context";
import { buildTurnInstruction, currentSection, elapsedSince, END_MARKER, isRepeatRequest, normalizePlan } from "./interview-plan";
import type { ChatMessage } from "./interview-context";
import { LlmError, streamCompletion, streamSentences } from "./llm";
import { logger } from "./logger";
import { appendTranscript, getTranscripts, type SessionDoc, type TurnSessionUpdate } from "./sessions";
import { SttError, transcribeAudio } from "./stt";
import { synthesizeSentence } from "./tts";

export type TurnInput =
  | { kind: "audio"; audio: Uint8Array }
  /** `voice`: the text came from speech recognition in the browser (speculative STT). */
  | { kind: "text"; text: string; voice?: boolean }
  /** No new answer: open the interview, or retry a reply that previously failed. */
  | { kind: "continue" };

export type TurnResult = {
  /** Present when a candidate answer should be analyzed in the background. */
  analysis: { question: string; answer: string } | null;
  /** The interview has just opened: prepare the canvas exercise in the background. */
  prepareCanvas: boolean;
  /** Already-loaded state, handed to background analysis to avoid re-reading it. */
  context?: { session: SessionDoc; transcripts: TranscriptEntry[] };
};

type Emit = (event: TurnEvent) => void;

const TTS_CONCURRENCY = 3;
/** Hard cap on sentences per reply (voice answers must stay short). */
const MAX_SENTENCES = 4;
/** Speak the first clause early once it has at least this many characters. */
const FIRST_CHUNK_MIN_CHARS = 28;
/** Minimum opening text compared against earlier replies before anything is sent. */
const REPEAT_CHECK_CHARS = 50;

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** True when a transcribed "answer" is mostly the interviewer's own last words. */
export function isEcho(userText: string, lastAi: string): boolean {
  const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const said = words(userText);
  const spoken = new Set(words(lastAi));
  if (said.length < 4) return false;
  const contained = said.filter((word) => spoken.has(word)).length / said.length;
  return contained >= 0.85;
}

function lastInterviewerQuestion(history: TranscriptEntry[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "ai") return history[i].content;
  }
  return "";
}

/** Yield tokens unchanged while recording when the first one arrives. */
async function* tapFirstToken(tokens: AsyncIterable<string>, onFirst: () => void, onToken: (t: string) => void) {
  let first = true;
  for await (const token of tokens) {
    if (first) {
      first = false;
      onFirst();
    }
    onToken(token);
    yield token;
  }
}

const ANTI_REPEAT_NOTE = (repeated: string) =>
  `\n\nIMPORTANT: Your draft repeated an earlier reply or echoed the candidate: "${repeated.slice(0, 300)}". ` +
  "Respond to what the candidate actually just said, in completely different words, and ask a different question that has not been asked yet.";

/** Regenerations allowed when a draft repeats itself (each at a higher temperature). */
const MAX_REGENERATIONS = 2;

/**
 * A short neutral acknowledgement ("Got it.", "Okay.", "No problem.") can't be a
 * repetition problem, so it is released immediately instead of waiting for the
 * repeat check: the candidate hears the interviewer respond right away.
 */
export function isAcknowledgement(sentence: string): boolean {
  const text = sentence.trim();
  return text.length <= 24 && !text.includes("?") && text.split(/\s+/).length <= 4 && /[.!]$/.test(text);
}

async function* guardedSentences(
  messages: ChatMessage[],
  /** Texts the reply must not parrot: earlier interviewer replies and the candidate's last message. */
  avoid: string[],
  hooks: {
    onFirstToken: () => void;
    onToken: (token: string) => void;
    onRetry: () => void;
    onServed?: (provider: string, model: string) => void;
    /** A sentence was produced but is held back for the repeat check (start TTS early). */
    onHeld?: (sentence: string) => void;
  },
): AsyncGenerator<string> {
  let rejected = "";
  let acknowledged = false;
  for (let attempt = 0; attempt <= MAX_REGENERATIONS; attempt++) {
    const attemptMessages =
      attempt === 0 ? messages : [{ ...messages[0], content: messages[0].content + ANTI_REPEAT_NOTE(rejected) }, ...messages.slice(1)];
    const iterator = streamSentences(
      tapFirstToken(
        streamCompletion(attemptMessages, "realtime", {
          temperature: attempt === 0 ? undefined : Math.min(1, 0.85 + attempt * 0.05),
          onServed: hooks.onServed,
        }),
        hooks.onFirstToken,
        hooks.onToken,
      ),
      { firstChunkMinChars: FIRST_CHUNK_MIN_CHARS },
    )[Symbol.asyncIterator]();

    // Hold back the opening (at least REPEAT_CHECK_CHARS of substance) so generic
    // openers like "Thanks for sharing that." don't decide the check on their own.
    // A leading short acknowledgement is spoken immediately (unless one was already
    // spoken by an earlier, rejected draft).
    const held: string[] = [];
    let finished = false;
    let first = true;
    while (held.join(" ").length < REPEAT_CHECK_CHARS) {
      const next = await iterator.next();
      if (next.done) {
        finished = true;
        break;
      }
      if (first && isAcknowledgement(next.value)) {
        first = false;
        if (!acknowledged) {
          acknowledged = true;
          yield next.value;
        }
        continue;
      }
      first = false;
      held.push(next.value);
      hooks.onHeld?.(next.value);
    }
    if (held.length === 0) return;
    const opening = held.join(" ");
    if (attempt < MAX_REGENERATIONS && avoid.some((text) => text && text.length >= 12 && isRepeatOf(opening, text))) {
      await iterator.return?.(undefined);
      rejected = opening;
      hooks.onRetry();
      continue;
    }
    try {
      for (const sentence of held) yield sentence;
      if (finished) return;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      // The consumer stopped early (e.g. after the first question): cancel the LLM stream.
      if (!finished) await iterator.return?.(undefined);
    }
  }
}

/**
 * Run one interview turn: STT -> persist -> stream LLM sentences -> concurrent
 * TTS -> persist. Every stage reports progress through `emit`, so the browser
 * can display text and play audio while later stages are still running.
 *
 * Latency notes: transcript loading runs in parallel with STT, persistence of
 * the answer runs in parallel with generation, and TTS sockets are prewarmed
 * by the route before this function is called.
 */
export async function runTurn(
  sessionId: string,
  session: SessionDoc,
  input: TurnInput,
  emit: Emit,
  requestStartedAt = Date.now(),
  /** Collected session changes; the route writes them together when it releases the lock. */
  sessionUpdate: TurnSessionUpdate = {},
): Promise<TurnResult> {
  const since = () => Date.now() - requestStartedAt;
  const metrics: TurnMetrics = { total_ms: 0 };
  const result: TurnResult = { analysis: null, prepareCanvas: false };
  const plan = normalizePlan(session);
  const maxTurns = config.limits.maxTurnsPerSession;

  // ---- 1. Transcribe (in parallel with loading the conversation) ----------
  const historyPromise = getTranscripts(sessionId);
  let userText = "";
  if (input.kind === "audio") {
    try {
      userText = await transcribeAudio(input.audio);
      metrics.stt_ms = since();
    } catch (error) {
      await historyPromise.catch(() => undefined);
      if (error instanceof SttError) {
        logger.error("Transcription failed", error, { sessionId });
        emit({
          type: "error",
          code: "stt_failed",
          message: error.retryable
            ? "We couldn't transcribe that answer. Please try saying it again."
            : "Speech recognition is unavailable right now. You can type your answer instead.",
          retryable: error.retryable,
        });
        return result;
      }
      throw error;
    }
    if (!userText) {
      await historyPromise.catch(() => undefined);
      emit({ type: "no_speech" });
      return result;
    }
    // Speaker echo: the microphone picked up the interviewer's own voice.
    const recent = await historyPromise;
    const lastAi = lastInterviewerQuestion(recent);
    if (lastAi && userText.length >= 20 && isEcho(userText, lastAi)) {
      logger.warn("Discarded an utterance that echoed the interviewer", undefined, { sessionId });
      emit({ type: "no_speech" });
      return result;
    }
  } else if (input.kind === "text") {
    userText = clip(input.text, LIMITS.answerChars).replace(/\n\[truncated\]$/, "");
  }

  const history = await historyPromise;
  if (input.kind === "text" && input.voice) {
    // Speculative STT happened in the browser: apply the same speaker-echo filter.
    const lastAi = lastInterviewerQuestion(history);
    if (lastAi && userText.length >= 20 && isEcho(userText, lastAi)) {
      logger.warn("Discarded an utterance that echoed the interviewer", undefined, { sessionId });
      emit({ type: "no_speech" });
      return result;
    }
  }
  const turnCount = session.turn_count ?? history.filter((m) => m.role === "user").length;

  // ---- 2. Decide what the interviewer should do --------------------------
  let previousQuestion = lastInterviewerQuestion(history);
  let answerForAnalysis = userText;
  let persistAnswer: Promise<unknown> = Promise.resolve();
  let hasNewAnswer = false;
  const opening = history.length === 0 && !userText;

  if (userText) {
    emit({ type: "user_transcript", content: userText });
    // Persist without blocking generation; awaited before the reply is saved.
    persistAnswer = appendTranscript(sessionId, "user", userText);
    sessionUpdate.incrementTurn = true;
    history.push({ role: "user", content: userText });
    hasNewAnswer = true;
  } else if (opening) {
    // fall through: opening turn
  } else if (history[history.length - 1].role === "user") {
    // The previous reply failed after the answer was saved: answer it now.
    answerForAnalysis = history[history.length - 1].content;
    previousQuestion = lastInterviewerQuestion(history.slice(0, -1));
    hasNewAnswer = true;
  } else {
    emit({ type: "done" });
    return result;
  }

  const state = stateFromSession(session);
  const elapsedMs = opening ? 0 : elapsedSince(session.started_at) * testing.clockSpeedup;
  const answeredTurns = turnCount + (userText ? 1 : 0);
  const forceClose = answeredTurns >= maxTurns;
  let section = currentSection(plan, elapsedMs, state.question_number);
  let canvasMissing = false;
  if (section === "hands_on" && !session.canvas?.task) {
    // Exercise not ready (still generating or failed): keep assessing technically.
    section = "technical";
    canvasMissing = session.canvas?.task_status !== "generating";
  }

  // Introduce the canvas exercise once, at the start of the hands-on section.
  let introduceCanvas: { title: string } | null = null;
  if (section === "hands_on" && session.canvas?.task && !session.canvas.introduced_at && !forceClose) {
    introduceCanvas = { title: session.canvas.task.title };
    const task = session.canvas.task;
    emit({
      type: "canvas_task",
      task: { title: task.title, instructions: task.instructions, language: task.language, starter_code: task.starter_code },
    });
    sessionUpdate.canvasIntroduced = true;
  }

  // A request to repeat the question is handled deterministically: the model is
  // handed the exact question to restate, and nothing is scored or counted.
  const repeatRequested = hasNewAnswer && !introduceCanvas && isRepeatRequest(answerForAnalysis) && !!previousQuestion;
  const instruction = buildTurnInstruction({
    plan,
    section,
    elapsedMs,
    questionNumber: state.question_number,
    hasNewAnswer,
    introduceCanvas,
    forceClose,
    repeatQuestion: repeatRequested ? previousQuestion : null,
  });
  metrics.section = forceClose ? "closing" : section;
  const includeCanvas = !!session.canvas?.introduced_at || !!introduceCanvas;
  const messages = buildLiveMessages(buildInterviewContext(session, history, true, { includeCanvas }), instruction, history);
  const lastCandidateMessage = hasNewAnswer ? answerForAnalysis : "";

  // ---- 3. Stream the reply and synthesize sentences concurrently ----------
  emit({ type: "ai_start" });
  // The clock normally starts when the candidate presses Start (see the events
  // route); fall back to the first answer for clients that never sent it.
  if (hasNewAnswer && !session.started_at) sessionUpdate.startedAt = new Date();

  const limit = createLimiter(TTS_CONCURRENCY);
  const ttsTasks: Promise<void>[] = [];
  // Speech synthesized while a sentence is still held back by the repeat guard.
  const earlyTts = new Map<string, Promise<Buffer>>();
  const synthesize = (sentence: string) => {
    const early = earlyTts.get(sentence);
    if (early) {
      earlyTts.delete(sentence);
      return early;
    }
    return limit(() => synthesizeSentence(sentence));
  };
  const sentences: string[] = [];
  let raw = "";
  let seq = 0;
  let generationError: unknown = null;

  try {
    // When asked to repeat, restating the last question is the point; only guard against echoing the candidate.
    const earlierReplies = history.filter((m) => m.role === "ai").map((m) => m.content);
    const avoid = repeatRequested ? [lastCandidateMessage] : [...earlierReplies, lastCandidateMessage];
    const replies = guardedSentences(messages, avoid, {
      onFirstToken: () => (metrics.llm_first_token_ms ??= since()),
      onToken: (token) => (raw += token),
      onRetry: () => {
        raw = "";
        earlyTts.clear(); // discard audio for the rejected draft
        metrics.regenerated = (metrics.regenerated ?? 0) + 1;
        logger.warn("Interviewer repeated an earlier reply; regenerating", undefined, { sessionId, model: metrics.model });
      },
      onServed: (_provider, model) => {
        metrics.model = model;
      },
      onHeld: (sentence) => {
        if (config.tts.enabled && !earlyTts.has(sentence)) {
          const task = limit(() => synthesizeSentence(sentence));
          task.catch(() => undefined); // handled when the sentence is released
          earlyTts.set(sentence, task);
        }
      },
    });
    for await (const sentence of replies) {
      seq += 1;
      const current = seq;
      sentences.push(sentence);
      if (current === 1) metrics.first_sentence_ms = since();
      emit({ type: "ai_sentence", seq: current, content: sentence });

      if (!config.tts.enabled) {
        emit({ type: "audio_error", seq: current });
        if (/\?["')\]]*$/.test(sentence) || current >= MAX_SENTENCES) break;
        continue;
      }
      const isQuestion = /\?["')\]]*$/.test(sentence);
      ttsTasks.push(
        synthesize(sentence).then(
          (audio) => {
            if (metrics.first_audio_ms === undefined) metrics.first_audio_ms = since();
            emit({ type: "audio", seq: current, data: audio.toString("base64"), mime: "audio/mpeg" });
          },
          (error) => {
            // Release the sequence so one failed sentence never stalls playback.
            logger.warn("TTS failed for sentence", error, { sessionId, seq: current });
            emit({ type: "audio_error", seq: current });
          },
        ),
      );
      // One question per turn, enforced: anything after the first question (or past
      // the sentence cap) would never be heard well in a voice interview.
      if (isQuestion || current >= MAX_SENTENCES) break;
    }
  } catch (error) {
    generationError = error;
    logger.error("Interviewer generation failed", error, { sessionId, sentences: sentences.length });
  }

  await Promise.all(ttsTasks);
  await persistAnswer;
  const fullText = sentences.join(" ").trim();

  if (!fullText) {
    const retryable = !(generationError instanceof LlmError) || generationError.retryable;
    emit({
      type: "error",
      code: "llm_failed",
      message: retryable
        ? "The interviewer is having trouble responding. Retrying usually works."
        : "The AI interviewer is not configured on this server.",
      retryable,
    });
    // The answer is saved, so a retry (kind "continue") will regenerate the reply.
    return result;
  }

  // ---- 4. Persist ----------------------------------------------------------
  // Safety net: a farewell without a question in wrap-up means the interview is over
  // even if the model forgot the end marker (prevents "take care" loops).
  const farewell =
    (section === "wrap_up" || section === "closing") &&
    !fullText.includes("?") &&
    /\b(take care|best of luck|good luck|goodbye|that'?s all the time|this concludes|interview is (now )?(complete|over|finished)|have a (great|good|wonderful) (day|evening|one))\b/i.test(fullText);
  const ended = forceClose || section === "closing" || raw.includes(END_MARKER) || farewell;
  const update = recordQuestion(state, fullText);
  await appendTranscript(sessionId, "ai", fullText);
  sessionUpdate.question = repeatRequested ? null : update;

  metrics.total_ms = since();
  emit({ type: "ai_done", content: fullText, question_number: repeatRequested ? state.question_number : update.question_number });
  emit({ type: "metrics", metrics });
  emit({ type: "done", limit_reached: ended || undefined });
  logger.info("turn", { sessionId, ...metrics, sentences: sentences.length, ended });

  result.analysis = answerForAnalysis && !repeatRequested ? { question: previousQuestion, answer: answerForAnalysis } : null;
  result.prepareCanvas = plan.canvas_enabled && (opening || canvasMissing);
  result.context = { session, transcripts: [...history, { role: "ai", content: fullText }] };
  return result;
}
