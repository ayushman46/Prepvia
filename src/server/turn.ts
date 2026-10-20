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
import {
  buildTurnInstruction,
  currentSection,
  elapsedSince,
  END_MARKER,
  isEndRequest,
  isRepeatRequest,
  normalizePlan,
  PREMATURE_WRAP_UP,
} from "./interview-plan";
import type { ChatMessage } from "./interview-context";
import { LlmError, streamCompletion, streamSentences } from "./llm";
import { logger } from "./logger";
import { sessionPrompt } from "./stt-vocabulary";
import { amendLastAnswer, appendTranscript, getTranscripts, markLastReplyHeard, type SessionDoc, type TurnSessionUpdate } from "./sessions";
import { SttError, transcribeAudio } from "./stt";
import { synthesizeSentence } from "./tts";

export type TurnInput = (
  | { kind: "audio"; audio: Uint8Array }
  /** `voice`: the text came from speech recognition in the browser (speculative STT). */
  | { kind: "text"; text: string; voice?: boolean }
  /** No new answer: open the interview, retry a reply that previously failed, or close it when time is up. */
  | { kind: "continue" }
) & {
  /** The candidate continued their last answer before hearing the reply: merge, and replace that reply. */
  amend?: boolean;
  /** The candidate interrupted the previous reply after hearing this much of it. */
  heard?: string;
};

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

/** What the candidate is told when their spoken answer couldn't be transcribed. */
export function sttErrorEvent(error: SttError): TurnEvent {
  if (error.reason === "invalid_key" || error.reason === "not_configured" || error.reason === "model") {
    // Permanent until the server is fixed: the browser switches to typing.
    return { type: "error", code: "stt_unavailable", message: "Voice answers aren't available right now, so please type your answer.", retryable: false };
  }
  if (error.reason === "rate_limited") {
    return { type: "error", code: "stt_busy", message: "Speech recognition is busy. Wait a few seconds and say that again, or type it.", retryable: true };
  }
  return { type: "error", code: "stt_failed", message: "We couldn't transcribe that answer. Please try saying it again.", retryable: true };
}

/** A sentence that leads into a new topic or question (pointless once the interview is closing). */
const TOPIC_SHIFT =
  /\b(?:let'?s (?:switch|move|turn|shift|dive|talk|look|go|get|explore|discuss)|switch(?:ing)? gears|moving on|next,? (?:i'?d|let'?s|we|i want)|i'?d (?:now )?like to (?:ask|move|turn|switch|talk|explore|discuss|hear)|another (?:area|topic|question)|is a key part of)\b/i;

/** Fewest words of a repeated run that can be an echo (a shorter match is coincidence). */
const ECHO_RUN_MIN = 5;
/** Fewest words of an utterance that can be a pure echo. */
const ECHO_MIN_WORDS = 4;
/** Share of an utterance's words that must be placed in order over the interviewer's words to be an echo. */
const ECHO_OVERLAP = 0.7;

/**
 * Words the candidate says about themselves. Contractions are included because speech
 * recognition writes "I'm" as "Im". An echo never adds one the interviewer did not say.
 */
const FIRST_PERSON = new Set(["i", "im", "ive", "ill", "id", "me", "my", "mine", "myself", "we", "were", "weve", "us", "our", "ours", "ourselves", "lets"]);

/** A spoken word with the span of the whitespace-delimited token it came from. */
type SpokenWord = { word: string; start: number; end: number };

/** Lower-case words with apostrophes dropped, so "I'm" and "Im" agree; "trade-offs" is two words. */
function spokenWords(text: string): SpokenWord[] {
  const words: SpokenWord[] = [];
  for (const token of text.matchAll(/\S+/g)) {
    const start = token.index ?? 0;
    const end = start + token[0].length;
    for (const word of token[0].toLowerCase().replace(/['’`]/g, "").split(/[^\p{L}\p{N}]+/u)) {
      if (word) words.push({ word, start, end });
    }
  }
  return words;
}

/** Edit distance of at most one: a single substitution, insertion or deletion. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * The same word, or a slip a recognizer makes on speech: one letter off ("Aria" for
 * "area"), or a longer word cut short ("interview" for "interviewer").
 */
function nearWord(said: string, aiWord: string): boolean {
  if (said === aiWord) return true;
  const shorter = Math.min(said.length, aiWord.length);
  if (shorter < 4) return false;
  if (shorter >= 6 && (said.startsWith(aiWord) || aiWord.startsWith(said))) return true;
  return oneEditApart(said, aiWord);
}

/**
 * For each length i, the fewest substitutions needed to place said[0..i) in order over
 * the interviewer's words: interviewer words may be skipped, but no said word may be left
 * out. Infinity when some word cannot be placed.
 */
function substitutionsToPlace(said: string[], ai: string[]): number[] {
  const costs = [0];
  let previous = new Array<number>(ai.length + 1).fill(0);
  for (let i = 1; i <= said.length; i++) {
    const row = new Array<number>(ai.length + 1).fill(Infinity);
    for (let j = 1; j <= ai.length; j++) {
      let best = row[j - 1];
      if (said[i - 1] === ai[j - 1]) best = Math.min(best, previous[j - 1]);
      else if (nearWord(said[i - 1], ai[j - 1])) best = Math.min(best, previous[j - 1] + 1);
      row[j] = best;
    }
    costs.push(row[ai.length]);
    previous = row;
  }
  return costs;
}

/** How many leading words repeat the interviewer's words in order, with one substitution per five words. */
function echoedLead(said: string[], ai: string[]): number {
  const costs = substitutionsToPlace(said, ai);
  let lead = 0;
  for (let i = ECHO_RUN_MIN; i <= said.length; i++) if (costs[i] <= Math.floor(i / 5)) lead = i;
  return lead;
}

/**
 * The most words of `said` that can be placed in order over `ai`, where a near word counts
 * as placed but at most `budget` of them may be near. Words may be left out of `said`.
 */
function placedWords(said: string[], ai: string[], budget: number): number {
  // A near word uses up an interviewer word, so no more than ai.length of them can occur.
  const near = Math.min(budget, ai.length);
  const width = near + 1;
  const cols = ai.length + 1;
  let previous = new Int32Array(cols * width);
  let row = new Int32Array(cols * width);
  for (let i = 1; i <= said.length; i++) {
    row.fill(0);
    for (let j = 1; j <= ai.length; j++) {
      const exact = said[i - 1] === ai[j - 1];
      const fuzzy = !exact && nearWord(said[i - 1], ai[j - 1]);
      for (let s = 0; s < width; s++) {
        let best = Math.max(row[(j - 1) * width + s], previous[j * width + s]);
        if (exact) best = Math.max(best, previous[(j - 1) * width + s] + 1);
        else if (fuzzy && s > 0) best = Math.max(best, previous[(j - 1) * width + s - 1] + 1);
        row[j * width + s] = best;
      }
    }
    [previous, row] = [row, previous];
  }
  return previous[ai.length * width + near];
}

/**
 * True when the words are mostly the interviewer's own: at least 70% placed in order (one
 * near word per five words at most), at least four of them, and no first-person word the
 * interviewer never used. A candidate restating the question ("I would design a rate
 * limiter for the payments API") speaks as "I" and is never discarded.
 */
function isEchoOf(said: string[], ai: string[]): boolean {
  if (said.length < ECHO_MIN_WORDS) return false;
  // An echo is no longer than what the interviewer said; longer speech is the candidate's own.
  if (said.length > 2 * ai.length + ECHO_MIN_WORDS * 2) return false;
  const spoken = new Set(ai);
  if (said.some((word) => FIRST_PERSON.has(word) && !spoken.has(word))) return false;
  const placed = placedWords(said, ai, Math.floor(said.length / 5));
  return placed >= ECHO_MIN_WORDS && placed / said.length >= ECHO_OVERLAP;
}

/**
 * The candidate's own words in an utterance the microphone may have picked up from the
 * interviewer, or null when none of it is the candidate's. The interviewer's recent messages
 * are checked, newest first, because the echo may be of a reply they just superseded:
 * a run of at least five words that repeats one of them in order (one substitution per five
 * words) is cut from the start or end. Fewer than three words left means no answer at all.
 * What remains is an echo when it is mostly the interviewer's own words. Short answers such
 * as "Yes." are never discarded.
 */
export function withoutEcho(userText: string, interviewerTexts: string[]): string | null {
  const all = spokenWords(userText);
  if (!all.length) return userText;
  const references = interviewerTexts.map((text) => spokenWords(text).map((w) => w.word)).filter((ai) => ai.length > 0);
  const interviewerWords = new Set(references.flat());
  let words = all;
  for (const ai of references) {
    const lead = echoedLead(words.map((w) => w.word), ai);
    words = words.slice(lead);
    const tail = echoedLead(words.map((w) => w.word).reverse(), ai.slice().reverse());
    words = words.slice(0, words.length - tail);
  }
  if (words.length < all.length && words.length < 3) {
    // A question restated in the candidate's own voice ("I would design ... API") leaves only its
    // first-person word behind: that is an answer, so it is kept whole.
    if (words.some((w) => FIRST_PERSON.has(w.word) && !interviewerWords.has(w.word))) return userText;
    return null;
  }
  const said = words.map((w) => w.word);
  if (references.some((ai) => isEchoOf(said, ai))) return null;
  if (words.length === all.length) return userText;
  return userText.slice(words[0].start, words[words.length - 1].end);
}

/** True when the utterance is only the interviewer's own voice picked up by the microphone (see withoutEcho). */
export function isEcho(userText: string, interviewer: string | string[]): boolean {
  return withoutEcho(userText, typeof interviewer === "string" ? [interviewer] : interviewer) === null;
}

/** The note that sessions.ts appends to a reply the candidate interrupted: words the interviewer never said. */
const INTERRUPTION_NOTE = /\s*\[interrupted by the candidate[^\]]*\]/g;

/** The interviewer's most recent messages, newest first, as they were spoken. */
function recentInterviewerMessages(history: TranscriptEntry[], count = 2): string[] {
  const messages: string[] = [];
  for (let i = history.length - 1; i >= 0 && messages.length < count; i--) {
    if (history[i].role === "ai") messages.push(history[i].content.replace(INTERRUPTION_NOTE, ""));
  }
  return messages;
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

const NOT_OVER_NOTE = (remaining: number) =>
  `\n\nIMPORTANT: The interview is NOT over: about ${remaining} minute${remaining === 1 ? "" : "s"} remain. ` +
  "Do not summarize, wrap up, thank the candidate for their time, or mention ending the interview. Ask your next question for this section.";

const ANTI_REPEAT_NOTE = (repeated: string) =>
  `\n\nIMPORTANT: Your draft repeated an earlier reply or echoed the candidate: "${repeated.slice(0, 300)}". ` +
  "Respond to what the candidate actually just said, in completely different words, and ask a different question that has not been asked yet.";

const SAID_NOTE = (said: string) =>
  `\n\nYou have already said this aloud in your current reply: "${said.slice(-400)}". Continue from there without repeating any of it.`;

/** The first words of a rejected draft, enough to identify it without handing over text to copy. */
const excerpt = (text: string) => `${text.split(/\s+/).slice(0, 10).join(" ")}…`;

/**
 * A question that re-asks one from an earlier reply, even after a different
 * preamble. Short questions ("Why?") legitimately recur, so only longer ones count.
 */
function repeatsEarlierQuestion(sentence: string, avoid: string[]): boolean {
  return sentence.includes("?") && sentence.split(/\s+/).length >= 8 && avoid.some((text) => text && text.length >= 12 && isRepeatOf(sentence, text));
}

const EMPTY_NOTE =
  "\n\nIMPORTANT: The interview is still in progress and your draft said nothing. " +
  "Reply to the candidate's latest message in a sentence, then ask your next question for this section.";

/** Regenerations allowed when a draft repeats itself (each at a higher temperature). */
const MAX_REGENERATIONS = 2;

/** A closing reply already thanks the candidate or says the interview is over. */
const CLOSES_INTERVIEW = /\b(thank|thanks|complete[sd]?|conclude[sd]?|that'?s all|out of time|time is up|feedback report)\b/i;

/**
 * Spoken when the last turn needs a guaranteed ending: the model asked a question
 * anyway (it could never be answered), said nothing, or failed.
 */
export function closingLine(candidateName: string): string {
  const first = candidateName.trim().split(/\s+/)[0]?.slice(0, 40) ?? "";
  return `Thank you${first ? `, ${first}` : ""}. That completes our interview, and your feedback report is ready for you now.`;
}

/**
 * A short neutral acknowledgement ("Got it.", "Okay.", "No problem.") can't be a
 * repetition problem, so it is released immediately instead of waiting for the
 * repeat check: the candidate hears the interviewer respond right away.
 */
export function isAcknowledgement(sentence: string): boolean {
  const text = sentence.trim();
  return text.length <= 24 && !text.includes("?") && text.split(/\s+/).length <= 4 && /[.!]$/.test(text);
}

const words = (text: string) => text.toLowerCase().replace(/[^a-z' ]+/g, " ").trim().split(/\s+/).filter(Boolean);
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Right after an acknowledgement was spoken, drop a repeat of it at the start of
 * the next sentence: "Okay." + "Okay, you're suggesting…" → "You're suggesting…",
 * "Go ahead." + "Go ahead and share…" → "Share…". Returns "" when the sentence is
 * nothing but the repeat.
 */
export function withoutLeadingAcknowledgement(sentence: string, spokenAck?: string | null): string {
  if (spokenAck && words(sentence).join(" ") === words(spokenAck).join(" ")) return "";
  let rest = sentence;
  const listed = /^(okay|ok|got it|sure|alright|all right|right|thanks|thank you|understood|no problem|go ahead)[,.!]\s+(?=\S)/i.exec(rest);
  if (listed) {
    rest = rest.slice(listed[0].length);
  } else if (spokenAck && words(spokenAck).length) {
    const repeat = new RegExp(`^${words(spokenAck).map(escapeRegExp).join("[\\s,]+")}[\\s,.!]*(?:(?:and|so)\\s+)?(?=\\S)`, "i").exec(rest);
    if (repeat) rest = rest.slice(repeat[0].length);
  }
  return rest === sentence ? sentence : rest.charAt(0).toUpperCase() + rest.slice(1);
}

async function* guardedSentences(
  messages: ChatMessage[],
  /**
   * Prompt for the final regeneration: same rules and grounding, but only the
   * candidate's latest message, so a reply the model keeps copying is no longer
   * in its context (repetition loops are in-context copying).
   */
  reducedMessages: ChatMessage[],
  /** Texts the reply must not parrot: earlier interviewer replies and the candidate's last message. */
  avoid: string[],
  /** Minutes left when wrap-up language is not allowed yet; null when closing is allowed. */
  notOverMinutes: number | null,
  hooks: {
    onFirstToken: () => void;
    onToken: (token: string) => void;
    onRetry: (reason: "repeat" | "premature_wrap_up" | "empty") => void;
    onServed?: (provider: string, model: string) => void;
    /** A sentence was produced but is held back for the repeat check (start TTS early). */
    onHeld?: (sentence: string) => void;
  },
): AsyncGenerator<string> {
  let note = "";
  let acknowledged = false;
  let ackText: string | null = null;
  // Everything said aloud so far in this reply, across attempts.
  const spoken: string[] = [];
  let released = false;
  const avoidList = [...avoid];
  for (let attempt = 0; attempt <= MAX_REGENERATIONS; attempt++) {
    const lastAttempt = attempt === MAX_REGENERATIONS;
    const base = lastAttempt ? reducedMessages : messages;
    const attemptMessages = attempt === 0 ? base : [{ ...base[0], content: base[0].content + note }, ...base.slice(1)];
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
    // Notes for the next attempt say what was already spoken, so it continues the reply.
    const continuation = () => (released ? SAID_NOTE(spoken.join(" ")) : "");

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
          ackText = next.value;
          spoken.push(next.value);
          yield next.value;
        }
        continue;
      }
      // The sentence after a spoken acknowledgement must not repeat it ("Go ahead. Go ahead and…").
      const sentence = acknowledged && held.length === 0 ? withoutLeadingAcknowledgement(next.value, ackText) : next.value;
      first = false;
      if (!sentence) continue;
      held.push(sentence);
      hooks.onHeld?.(sentence);
    }
    if (held.length === 0) {
      // Nothing to say (or only the end marker) stalls the interview unless it may close now.
      if (notOverMinutes === null || lastAttempt) return;
      note = continuation() + EMPTY_NOTE;
      hooks.onRetry("empty");
      continue;
    }
    const opening = held.join(" ");
    if (!lastAttempt) {
      // Reject a draft that repeats/parrots (as a whole, or one of its questions), or
      // that starts wrapping up too early.
      const repeat =
        avoidList.some((text) => text && text.length >= 12 && isRepeatOf(opening, text)) ||
        held.some((sentence) => repeatsEarlierQuestion(sentence, avoidList));
      const prematureClose = notOverMinutes !== null && PREMATURE_WRAP_UP.test(opening);
      if (repeat || prematureClose) {
        await iterator.return?.(undefined);
        // The last attempt sees only the first words: a full quote is itself something to copy.
        const quoted = attempt + 1 === MAX_REGENERATIONS ? excerpt(opening) : opening;
        note = continuation() + (prematureClose ? NOT_OVER_NOTE(notOverMinutes as number) : ANTI_REPEAT_NOTE(quoted));
        hooks.onRetry(prematureClose ? "premature_wrap_up" : "repeat");
        continue;
      }
    }
    // Later sentences are checked one by one as they arrive: one that wraps up too
    // early or re-asks an earlier question is never spoken.
    let violation: { reason: "repeat" | "premature_wrap_up"; sentence: string } | null = null;
    try {
      for (const sentence of held) {
        spoken.push(sentence);
        released = true;
        yield sentence;
      }
      if (finished) return;
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          return;
        }
        if (notOverMinutes !== null && PREMATURE_WRAP_UP.test(next.value)) {
          violation = { reason: "premature_wrap_up", sentence: next.value };
          break;
        }
        if (!lastAttempt && repeatsEarlierQuestion(next.value, avoidList)) {
          violation = { reason: "repeat", sentence: next.value };
          break;
        }
        spoken.push(next.value);
        released = true;
        yield next.value;
      }
    } finally {
      // The consumer stopped early (e.g. after the first question): cancel the LLM stream.
      if (!finished) await iterator.return?.(undefined);
    }
    // The last attempt simply ends before the offending sentence.
    if (!violation || lastAttempt) return;
    // Otherwise the next attempt continues the reply with a new question.
    acknowledged = true;
    avoidList.push(spoken.join(" "));
    note =
      continuation() +
      (violation.reason === "premature_wrap_up" ? NOT_OVER_NOTE(notOverMinutes as number) : ANTI_REPEAT_NOTE(excerpt(violation.sentence)));
    hooks.onRetry(violation.reason);
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
  // What the candidate heard of an interrupted reply is recorded first, so the
  // conversation below (and later the report) reads that reply as heard.
  const historyPromise = (input.heard !== undefined ? markLastReplyHeard(sessionId, input.heard).catch(() => undefined) : Promise.resolve()).then(() =>
    getTranscripts(sessionId),
  );
  let userText = "";
  if (input.kind === "audio") {
    try {
      userText = await transcribeAudio(input.audio, { prompt: sessionPrompt(sessionId, session) });
      metrics.stt_ms = since();
    } catch (error) {
      await historyPromise.catch(() => undefined);
      if (error instanceof SttError) {
        logger.error("Transcription failed", error, { sessionId, reason: error.reason });
        emit(sttErrorEvent(error));
        return result;
      }
      throw error;
    }
    if (!userText) {
      await historyPromise.catch(() => undefined);
      emit({ type: "no_speech" });
      return result;
    }
  } else if (input.kind === "text") {
    userText = clip(input.text, LIMITS.answerChars).replace(/\n\[truncated\]$/, "");
  }

  const history = await historyPromise;
  if (userText && (input.kind === "audio" || (input.kind === "text" && input.voice) || input.amend)) {
    // The microphone may have picked up the interviewer's own voice (or speech recognition in
    // the browser did): cut an echoed lead-in or tail, or discard the utterance when only the
    // echo is left. An echoed continuation is rejected before it can replace the reply.
    const answer = withoutEcho(userText, recentInterviewerMessages(history));
    if (answer === null) {
      logger.warn("Discarded an utterance that echoed the interviewer", undefined, { sessionId, amend: input.amend === true });
      emit({ type: "no_speech" });
      return result;
    }
    if (answer !== userText) logger.info("Removed an echoed lead-in or tail from an answer", { sessionId });
    userText = answer;
  }
  const turnCount = session.turn_count ?? history.filter((m) => m.role === "user").length;

  // ---- 2. Decide what the interviewer should do --------------------------
  let previousQuestion = lastInterviewerQuestion(history);
  let answerForAnalysis = userText;
  let persistAnswer: Promise<unknown> = Promise.resolve();
  let hasNewAnswer = false;
  const opening = history.length === 0 && !userText;

  const amended = userText && input.amend ? await amendLastAnswer(sessionId, userText, LIMITS.answerChars) : null;
  const unheardReplies: string[] = [];
  let timeUp = false;
  if (amended !== null) {
    // A continuation of the last answer: the reply to its first part was never heard
    // (deleted with the amend), so the interviewer answers the whole answer now.
    while (history.length && history[history.length - 1].role === "ai") unheardReplies.push(history.pop()!.content);
    if (history.length) history[history.length - 1] = { role: "user", content: amended };
    else history.push({ role: "user", content: amended });
    previousQuestion = lastInterviewerQuestion(history.slice(0, -1));
    answerForAnalysis = amended;
    emit({ type: "user_transcript", content: amended });
    hasNewAnswer = true;
  } else if (userText) {
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
  } else if (!session.ended_at && elapsedSince(session.started_at) * testing.clockSpeedup >= plan.duration_minutes * 60_000) {
    // Time is up and the candidate is silent: close the interview instead of waiting forever.
    timeUp = true;
  } else {
    emit({ type: "done" });
    return result;
  }

  const state = stateFromSession(session);
  const lastAsked = state.questions_asked[state.questions_asked.length - 1];
  if (unheardReplies.length && lastAsked && unheardReplies.some((reply) => clip(reply, 1_500) === lastAsked.question)) {
    // The unheard reply was counted as a question: un-count it (the replacement is counted instead).
    state.question_number = Math.max(0, state.question_number - 1);
    state.questions_asked = state.questions_asked.slice(0, -1);
    sessionUpdate.questionsAsked = state.questions_asked;
  }
  const elapsedMs = opening ? 0 : elapsedSince(session.started_at) * testing.clockSpeedup;
  const answeredTurns = turnCount + (userText && amended === null ? 1 : 0);
  // An explicit "end the interview" closes it now (the report button appears).
  const endRequested = hasNewAnswer && isEndRequest(answerForAnalysis);
  const forceClose = answeredTurns >= maxTurns || endRequested || timeUp;
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
  // After a withdrawn (unheard) reply, the interviewer's own notes must not list it as asked.
  const contextSession = sessionUpdate.questionsAsked ? { ...session, interview_state: { ...session.interview_state, ...state } } : session;
  const liveContext = buildInterviewContext(contextSession, history, true, { includeCanvas });
  const messages = buildLiveMessages(liveContext, instruction, history);
  // Only the candidate's latest message: the reply being copied is often the previous one.
  const reducedMessages = buildLiveMessages(liveContext, instruction, history.slice(-1));
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
  // Decided before generation: this reply ends the interview whatever the model says.
  const finalTurn = forceClose || section === "closing";
  const closingAllowed = finalTurn || section === "wrap_up";
  let droppedQuestion = false;

  const speak = (sentence: string) => {
    seq += 1;
    const current = seq;
    sentences.push(sentence);
    if (current === 1) metrics.first_sentence_ms = since();
    emit({ type: "ai_sentence", seq: current, content: sentence });
    if (!config.tts.enabled) {
      emit({ type: "audio_error", seq: current });
      return;
    }
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
  };

  try {
    // When asked to repeat, restating the last question is the point; only guard against echoing the candidate.
    const earlierReplies = history.filter((m) => m.role === "ai").map((m) => m.content);
    const avoid = repeatRequested ? [lastCandidateMessage] : [...earlierReplies, lastCandidateMessage];
    const remainingMinutes = Math.max(1, Math.round(plan.duration_minutes - elapsedMs / 60_000));
    const replies = guardedSentences(messages, reducedMessages, avoid, closingAllowed ? null : remainingMinutes, {
      onFirstToken: () => (metrics.llm_first_token_ms ??= since()),
      onToken: (token) => (raw += token),
      onRetry: (reason) => {
        raw = "";
        earlyTts.clear(); // discard audio for the rejected draft
        metrics.regenerated = (metrics.regenerated ?? 0) + 1;
        logger.warn("Interviewer draft rejected; regenerating", undefined, { sessionId, reason, model: metrics.model });
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
    // The goodbye is held until it's complete: if it turns out to ask something, the
    // question and its lead-in ("Let's switch gears…") are dropped, not half-spoken.
    const goodbye: string[] = [];
    for await (const sentence of replies) {
      // The last turn must not ask anything: the candidate could never answer it.
      if (finalTurn && sentence.includes("?")) {
        droppedQuestion = true;
        break;
      }
      if (finalTurn) {
        goodbye.push(sentence);
        if (seq + goodbye.length >= MAX_SENTENCES) break;
        continue;
      }
      speak(sentence);
      // One question per turn, enforced: anything after the first question (or past
      // the sentence cap) would never be heard well in a voice interview.
      if (/\?["')\]]*$/.test(sentence) || seq >= MAX_SENTENCES) break;
    }
    // Keep only an acknowledgement of the last answer before the closing line.
    const kept = droppedQuestion ? goodbye.slice(0, 1).filter((sentence) => !TOPIC_SHIFT.test(sentence)) : goodbye;
    kept.forEach(speak);
  } catch (error) {
    generationError = error;
    logger.error("Interviewer generation failed", error, { sessionId, sentences: sentences.length });
  }
  // The end marker closes the interview only once closing is allowed, and never right
  // after a question ("Any questions for me? <<END>>" would cut off the answer).
  const closes = finalTurn || (closingAllowed && raw.includes(END_MARKER) && !sentences.join(" ").includes("?"));
  // The interview always ends cleanly, even if the model asked a question, said nothing, or failed.
  if (closes && (droppedQuestion || !CLOSES_INTERVIEW.test(sentences.join(" ")))) {
    if (droppedQuestion) logger.warn("Dropped a question from the closing turn", undefined, { sessionId });
    speak(closingLine(session.candidate_name ?? ""));
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
  const ended = closes || farewell;
  if (ended) sessionUpdate.ended = true;
  const update = recordQuestion(state, fullText);
  await appendTranscript(sessionId, "ai", fullText);
  sessionUpdate.question = repeatRequested ? null : update;

  metrics.total_ms = since();
  emit({ type: "ai_done", content: fullText, question_number: repeatRequested ? state.question_number : update.question_number });
  emit({ type: "metrics", metrics });
  emit({ type: "done", limit_reached: ended || undefined });
  logger.info("turn", { sessionId, ...metrics, sentences: sentences.length, ended });

  result.analysis =
    answerForAnalysis && !repeatRequested && !endRequested ? { question: previousQuestion, answer: answerForAnalysis } : null;
  result.prepareCanvas = plan.canvas_enabled && (opening || canvasMissing);
  result.context = { session, transcripts: [...history, { role: "ai", content: fullText }] };
  return result;
}
