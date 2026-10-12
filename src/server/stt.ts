import "server-only";
import { config } from "./config";
import { ApiError } from "./http";
import { logger } from "./logger";

/** 16 kHz mono 16-bit PCM: 32,000 bytes per second of audio. */
const BYTES_PER_SECOND = 32_000;
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // Stays under Vercel's 4.5 MB request limit.
const MIN_AUDIO_SECONDS = 0.25;

/** Per-attempt timeout grows with the upload (long answers on slow uplinks), capped well under maxDuration. */
const BASE_TIMEOUT_MS = 6_000;
const UPLOAD_BYTES_PER_MS = 300; // ~300 KB/s
const MAX_ATTEMPT_TIMEOUT_MS = 20_000;
/** A failed first attempt is retried only if it failed fast. */
const RETRY_WINDOW_MS = 3_000;
/** An invalid key stays invalid until the deployment changes; stop calling Groq meanwhile. */
const INVALID_KEY_HOLD_MS = 60_000;
/** Speculative calls stop before this many Groq requests per minute (free tier: 20 RPM per key). */
const SPECULATIVE_RPM_BUDGET = 16;
/** A real answer waits out a rate limit this short instead of failing. */
const REAL_TURN_RATE_LIMIT_WAIT_MS = 4_000;

// Whisper commonly hallucinates these on silence or background noise. Stored
// normalized (lowercase, letters/digits/apostrophes and single spaces only).
// "yes", "no", "okay" and "yeah" are deliberately absent: they are real answers.
const HALLUCINATIONS = new Set([
  "thank you",
  "thank you very much",
  "thank you so much",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thanks for listening",
  "thank you for listening",
  "please subscribe",
  "like and subscribe",
  "see you next time",
  "see you in the next video",
  "you",
  "bye",
  "bye bye",
  "subtitles by the amara org community",
  "music",
  "applause",
  "laughter",
  "blank audio",
  "silence",
  "hmm",
  "mm",
  "mmm",
  "uh",
  "um",
  "ah",
  "oh",
  "huh",
]);

export type SttReason = "not_configured" | "invalid_key" | "rate_limited" | "model" | "upstream";

export class SttError extends Error {
  constructor(
    message: string,
    public readonly retryable = true,
    public readonly reason: SttReason = retryable ? "upstream" : "invalid_key",
    /** For rate limits: how long to wait before trying again. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SttError";
  }
}

/** Validate a RIFF/WAVE payload and return its approximate duration in seconds. */
export function validateWav(bytes: Uint8Array): number {
  if (bytes.byteLength < 44) throw new ApiError(400, "invalid_audio", "Audio payload is too short.");
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new ApiError(413, "audio_too_large", "That answer was too long to process. Please answer in shorter segments.");
  }
  const ascii = (offset: number, length: number) => Buffer.from(bytes.subarray(offset, offset + length)).toString("latin1");
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    throw new ApiError(415, "unsupported_audio", "Audio must be a WAV file.");
  }
  return (bytes.byteLength - 44) / BYTES_PER_SECOND;
}

type VerboseSegment = { text?: string; no_speech_prob?: number; avg_logprob?: number };

// Technical terms Whisper often mishears ("item potency" for idempotency, "cash" for
// cache). Included in the prompt when the resume, job description or role mentions them.
const TECH_TERMS = new Set(
  "api apis sql nosql postgres postgresql mysql sqlite redis kafka rabbitmq kubernetes k8s docker terraform aws gcp azure microservices microservice idempotency idempotent latency throughput sharding replication cache caching memcached grpc graphql rest oauth jwt typescript javascript nodejs golang rust java kotlin swift python django flask fastapi spring react angular vue nextjs mongodb dynamodb cassandra elasticsearch kibana grafana prometheus datadog observability ci/cd jenkins github gitlab s3 ec2 lambda serverless webhook webhooks websocket websockets async concurrency mutex deadlock queue queues pubsub etl airflow spark hadoop snowflake bigquery dbt tableau figma jira scrum agile okr okrs kpi kpis a/b".split(
    " ",
  ),
);
// Always worth priming: common in software interviews and easy to mishear.
const BASE_TERMS = ["API", "SQL", "Postgres", "Redis", "Kafka", "Kubernetes", "idempotency", "latency", "cache", "microservices"];

/**
 * A short Whisper prompt with the vocabulary this interview is likely to use, taken
 * from the role, job description and resume (product names, acronyms, mixed-case
 * terms), so technical words are transcribed correctly.
 */
export function vocabularyPrompt(source: { target_role?: string | null; job_description?: string | null; resume_text?: string | null }): string {
  const text = [source.target_role, source.job_description, source.resume_text].filter(Boolean).join(" ").slice(0, 20_000);
  const terms = new Map<string, string>();
  for (const term of BASE_TERMS) terms.set(term.toLowerCase(), term);
  for (const [word] of text.matchAll(/[A-Za-z][A-Za-z0-9+#./-]*[A-Za-z0-9+#]/g)) {
    const key = word.toLowerCase().replace(/\.js$/, "js");
    const technical = TECH_TERMS.has(key) || /[a-z][A-Z]|[A-Z]{2,}|\d|[+#]|\.[a-z]/.test(word);
    if (technical && word.length <= 24 && !terms.has(key) && terms.size < 48) terms.set(key, word);
  }
  const role = (source.target_role ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${role ? `${role} interview. ` : ""}${[...terms.values()].join(", ")}.`.slice(0, 600);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g, " ") // [Music], (applause), *laughs*, ♪
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanTranscript(text: string, segments?: VerboseSegment[]): string {
  let result = text;
  if (segments && segments.length > 0) {
    // Whisper's own silence rule (no_speech_threshold 0.6, logprob_threshold -1.0):
    // only segments that are both likely silent and low confidence are dropped.
    const kept = segments.filter((segment) => !((segment.no_speech_prob ?? 0) > 0.6 && (segment.avg_logprob ?? 0) < -1));
    result = kept.map((segment) => segment.text ?? "").join(" ");
  }
  result = result.replace(/\s+/g, " ").trim();
  if (!/[a-z0-9]/i.test(normalize(result))) return "";
  // Noise transcribed as a stock phrase, possibly repeated ("Thank you. Thank you.").
  const sentences = result
    .split(/[.!?]+/)
    .map(normalize)
    .filter(Boolean);
  if (sentences.length > 0 && sentences.every((sentence) => HALLUCINATIONS.has(sentence))) return "";
  return result;
}

// ------------------------------------------------------------ upstream state

let invalidKeyUntil = 0;
let rateLimitedUntil = 0;
const recentCalls: number[] = [];

/** Test hook: forget remembered key and rate-limit state. */
export function __resetSttStateForTests(): void {
  invalidKeyUntil = 0;
  rateLimitedUntil = 0;
  recentCalls.length = 0;
  keyState = null;
}

function callsInLastMinute(now: number): number {
  while (recentCalls.length && recentCalls[0] <= now - 60_000) recentCalls.shift();
  return recentCalls.length;
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(60_000, seconds * 1000) : 2_000;
}

type TranscribeOptions = {
  /** Made while the candidate pauses: yields to real turns when the request budget runs low. */
  speculative?: boolean;
  /** The browser gave up on this request (e.g. the candidate kept talking). */
  signal?: AbortSignal;
  /** Vocabulary to prime Whisper with (see vocabularyPrompt). */
  prompt?: string;
};

async function requestTranscription(audio: Uint8Array, timeoutMs: number, options: TranscribeOptions): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "answer.wav");
  form.append("model", config.groq.sttModel);
  form.append("response_format", "verbose_json");
  form.append("language", "en");
  form.append("temperature", "0");
  if (options.prompt) form.append("prompt", options.prompt);

  recentCalls.push(Date.now());
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${config.groq.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
    signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    const message = `Groq STT HTTP ${response.status}: ${detail}`;
    if (response.status === 401 || response.status === 403) {
      invalidKeyUntil = Date.now() + INVALID_KEY_HOLD_MS;
      throw new SttError(message, false, "invalid_key");
    }
    if (response.status === 429) {
      const wait = retryAfterMs(response);
      rateLimitedUntil = Date.now() + wait;
      throw new SttError(message, false, "rate_limited", wait);
    }
    if (response.status === 404) throw new SttError(message, false, "model");
    if (response.status === 400 || response.status === 413 || response.status === 415 || response.status === 422) {
      // A clip Groq can't decode is "nothing heard"; any other rejection (model,
      // parameters) is a configuration problem that must not pose as silence.
      if (response.status !== 400 || /audio|file|decod|format|too short|duration|empty|invalid media/i.test(detail)) {
        logger.warn("Groq rejected an audio clip", undefined, { status: response.status, detail });
        return "";
      }
      logger.error("Groq rejected the transcription request", undefined, { status: response.status, detail });
      throw new SttError(message, false, "model");
    }
    throw new SttError(message, true, "upstream");
  }
  const data = (await response.json()) as { text?: string; segments?: VerboseSegment[] };
  return cleanTranscript(data.text ?? "", data.segments);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transcribe a candidate utterance with Groq Whisper. Returns "" for silence/noise.
 * `speculative` calls (made while the candidate pauses) yield to real turns when
 * the per-key request budget is nearly used up, and fail fast when rate limited;
 * a real answer waits out a short rate limit instead of being lost.
 */
export async function transcribeAudio(audio: Uint8Array, options: TranscribeOptions = {}): Promise<string> {
  if (!config.groq.apiKey) {
    throw new SttError("Speech recognition is not configured. Set GROQ_API_KEY.", false, "not_configured");
  }
  const now = Date.now();
  if (invalidKeyUntil > now) throw new SttError("Groq rejected the API key recently; not retrying yet.", false, "invalid_key");
  if (rateLimitedUntil > now) {
    const wait = rateLimitedUntil - now;
    if (options.speculative || wait > REAL_TURN_RATE_LIMIT_WAIT_MS) throw new SttError("Groq is rate limiting this key.", false, "rate_limited", wait);
    await sleep(wait);
  }
  if (options.speculative && callsInLastMinute(now) >= SPECULATIVE_RPM_BUDGET) {
    throw new SttError("Speculative transcription budget used up.", false, "rate_limited", 5_000);
  }
  const seconds = validateWav(audio);
  if (seconds < MIN_AUDIO_SECONDS) return "";

  const started = Date.now();
  const attemptTimeout = Math.round(Math.min(MAX_ATTEMPT_TIMEOUT_MS, BASE_TIMEOUT_MS + audio.byteLength / UPLOAD_BYTES_PER_MS));
  try {
    return await requestTranscription(audio, attemptTimeout, options);
  } catch (error) {
    if (options.signal?.aborted) throw new SttError("Transcription cancelled.", false, "upstream");
    const rateLimited = error instanceof SttError && error.reason === "rate_limited";
    const retryable = !(error instanceof SttError) || error.retryable;
    const elapsed = Date.now() - started;
    if (rateLimited && !options.speculative && (error.retryAfterMs ?? 0) <= REAL_TURN_RATE_LIMIT_WAIT_MS) {
      // A real answer: wait out a short rate limit and try once more.
      await sleep(error.retryAfterMs ?? 1_000);
    } else if (!retryable || elapsed > RETRY_WINDOW_MS) {
      throw error instanceof SttError ? error : new SttError(String(error), true, "upstream");
    } else {
      logger.warn("STT failed; retrying once", error);
      await sleep(300);
    }
    try {
      return await requestTranscription(audio, attemptTimeout, options);
    } catch (retryError) {
      throw retryError instanceof SttError ? retryError : new SttError(String(retryError), true, "upstream");
    }
  }
}

// ------------------------------------------------------------ key health

export type SttKeyState = "ok" | "not_configured" | "invalid_key" | "model_unavailable" | "rate_limited" | "unreachable";
let keyState: { value: SttKeyState; at: number; pending?: Promise<SttKeyState> } | null = null;

/**
 * Whether the configured Groq key can actually transcribe (cached; a cheap
 * GET /models call). Never exposes the key itself.
 */
export async function sttKeyState(): Promise<SttKeyState> {
  if (!config.groq.apiKey) return "not_configured";
  const now = Date.now();
  if (invalidKeyUntil > now) return "invalid_key";
  if (keyState?.pending) return keyState.pending;
  if (keyState && now - keyState.at < (keyState.value === "ok" ? 5 * 60_000 : 60_000)) return keyState.value;
  const pending = (async (): Promise<SttKeyState> => {
    try {
      const response = await fetch(`${config.groq.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { Authorization: `Bearer ${config.groq.apiKey}` },
        signal: AbortSignal.timeout(2_500),
        cache: "no-store",
      });
      if (response.status === 401 || response.status === 403) return "invalid_key";
      if (response.status === 429) return "rate_limited";
      if (!response.ok) return "unreachable";
      const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = body?.data?.map((model) => model.id) ?? [];
      return ids.length === 0 || ids.includes(config.groq.sttModel) ? "ok" : "model_unavailable";
    } catch {
      return "unreachable";
    }
  })();
  keyState = { value: keyState?.value ?? "unreachable", at: keyState?.at ?? 0, pending };
  const value = await pending;
  keyState = { value, at: Date.now() };
  return value;
}
