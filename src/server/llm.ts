import "server-only";
import { config } from "./config";
import type { ChatMessage } from "./interview-context";
import { logger } from "./logger";

/** realtime: live interviewer · analysis: reports/canvas tasks · notes: per-answer background analysis */
export type Purpose = "realtime" | "analysis" | "notes";

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly retryable = true,
    /** Set for HTTP 429 (rate limited), from Retry-After when provided. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

type Provider = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  extraBody: Record<string, unknown>;
};

function providersFor(purpose: Purpose): Provider[] {
  const analysis = purpose !== "realtime";
  const providers: Provider[] = [];

  if (config.nvidia.apiKey) {
    const thinking = purpose === "analysis" ? config.nvidia.analysisThinking : purpose === "notes" ? false : config.nvidia.realtimeThinking;
    const extraBody: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: thinking } };
    if (thinking && purpose === "analysis") extraBody.reasoning_budget = config.nvidia.analysisReasoningBudget;
    providers.push({
      name: "nvidia",
      baseUrl: config.nvidia.baseUrl,
      apiKey: config.nvidia.apiKey,
      model: purpose === "analysis" ? config.nvidia.analysisModel : purpose === "notes" ? config.nvidia.notesModel : config.nvidia.realtimeModel,
      extraBody,
    });
    const backupModel = config.nvidia.realtimeBackupModel;
    if (!analysis && backupModel && backupModel !== config.nvidia.realtimeModel) {
      providers.push({
        name: "nvidia-backup",
        baseUrl: config.nvidia.baseUrl,
        apiKey: config.nvidia.apiKey,
        model: backupModel,
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
      });
    }
  }

  if (config.groq.apiKey && config.groq.llmFallback) {
    providers.push({
      name: "groq",
      baseUrl: config.groq.baseUrl,
      apiKey: config.groq.apiKey,
      model: analysis ? config.groq.analysisModel : config.groq.realtimeModel,
      extraBody: {},
    });
  }

  return providers;
}

function withThinkingOverride(extraBody: Record<string, unknown>, thinking: boolean | undefined): Record<string, unknown> {
  if (thinking === undefined || !("chat_template_kwargs" in extraBody)) return extraBody;
  const { reasoning_budget: _budget, ...rest } = extraBody;
  void _budget;
  return { ...rest, chat_template_kwargs: { enable_thinking: thinking } };
}

export function llmConfigured(): boolean {
  return providersFor("realtime").length > 0;
}

/**
 * Stream completion tokens from one OpenAI-compatible endpoint.
 * Reasoning deltas are ignored; only final answer content is yielded.
 */
export type CompletionOptions = {
  maxTokens?: number;
  signal?: AbortSignal;
  /** Background work only: retry rate-limited/transient failures with backoff for up to this long. */
  retryForMs?: number;
  /** Override the configured reasoning mode (e.g. disable it for a faster retry). */
  thinking?: boolean;
  /** Override sampling temperature (e.g. higher for a regeneration). */
  temperature?: number;
  /** Reports which provider/model actually served the response (monitoring). */
  onServed?: (provider: string, model: string) => void;
  /** Receives the provider's finish_reason ("stop", or "length" when max_tokens cut the output short). */
  onFinishReason?: (reason: string) => void;
};

async function* streamFromProvider(
  provider: Provider,
  messages: ChatMessage[],
  purpose: Purpose,
  options: CompletionOptions = {},
): AsyncGenerator<string> {
  const analysis = purpose === "analysis";
  const timeoutMs = analysis ? config.llm.analysisTimeoutMs : config.llm.realtimeTimeoutMs;
  // A live turn can't wait long for a queued request to start streaming.
  const firstChunkMs = purpose === "realtime" ? Math.min(timeoutMs, config.llm.realtimeFirstTokenTimeoutMs) : timeoutMs;
  const controller = new AbortController();
  // Idle timer: reset on every received chunk so slow-but-alive streams continue,
  // while a stalled provider fails fast and the next provider can take over.
  let timer = setTimeout(() => controller.abort(new LlmError(`${provider.name} timed out`)), firstChunkMs);
  const onExternalAbort = () => controller.abort(new LlmError(`${provider.name} cancelled`, false));
  if (options.signal?.aborted) onExternalAbort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new LlmError(`${provider.name} stalled`)), timeoutMs);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: options.temperature ?? (analysis ? config.llm.analysisTemperature : config.llm.realtimeTemperature),
        top_p: 0.95,
        max_tokens: options.maxTokens ?? (analysis ? config.llm.analysisMaxTokens : config.llm.realtimeMaxTokens),
        stream: true,
        ...withThinkingOverride(provider.extraBody, options.thinking),
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new LlmError(
        `${provider.name} HTTP ${response.status}: ${detail}`,
        response.status === 429 || response.status >= 500,
        response.status === 429 ? (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000) : undefined,
      );
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetTimer();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let parsed: {
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
          error?: { message?: string };
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.error) throw new LlmError(`${provider.name} stream error: ${parsed.error.message ?? "unknown"}`);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) yield content;
        const finishReason = parsed.choices?.[0]?.finish_reason;
        if (finishReason) options.onFinishReason?.(finishReason);
      }
    }
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof LlmError) throw controller.signal.reason;
    if (error instanceof LlmError) throw error;
    throw new LlmError(`${provider.name} request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    // Release the HTTP stream if the consumer stopped early (e.g. a discarded draft).
    reader?.cancel().catch(() => undefined);
  }
}

/** Start a backup request if the primary has not produced a token within this time. */
export function hedgeDelayMs(): number {
  const value = Number.parseFloat(process.env.LLM_HEDGE_MS ?? "");
  return Number.isFinite(value) ? value : 800;
}

type Iter = AsyncIterator<string>;

/**
 * Tail-latency hedging: free hosted endpoints occasionally queue a request for
 * several seconds. If `primary` has not produced its first token after
 * `delayMs`, start `backup` in parallel and continue with whichever streams
 * first; the loser is cancelled. Errors fall through to the other request.
 */
export async function* hedgedStream(
  primary: (signal: AbortSignal) => AsyncIterable<string>,
  backup: ((signal: AbortSignal) => AsyncIterable<string>) | null,
  delayMs: number,
  onWinner?: (winner: "primary" | "backup") => void,
): AsyncGenerator<string> {
  const primaryAbort = new AbortController();
  const a: Iter = primary(primaryAbort.signal)[Symbol.asyncIterator]();
  const aFirst = a.next().then(
    (result) => ({ who: "a" as const, result }),
    (error) => ({ who: "a" as const, error }),
  );

  let winner: Iter = a;
  let first: IteratorResult<string>;

  const timer = new Promise<"hedge">((resolve) => setTimeout(() => resolve("hedge"), backup ? delayMs : 2 ** 31 - 1));
  const early = await Promise.race([aFirst, timer]);
  if (early !== "hedge") {
    if ("error" in early) throw early.error;
    first = early.result;
    onWinner?.("primary");
  } else {
    const backupAbort = new AbortController();
    const b: Iter = (backup as (signal: AbortSignal) => AsyncIterable<string>)(backupAbort.signal)[Symbol.asyncIterator]();
    const bFirst = b.next().then(
      (result) => ({ who: "b" as const, result }),
      (error) => ({ who: "b" as const, error }),
    );
    let settled = await Promise.race([aFirst, bFirst]);
    if ("error" in settled) {
      // The first to settle failed: wait for the other one.
      settled = await (settled.who === "a" ? bFirst : aFirst);
      if ("error" in settled) throw settled.error;
    }
    winner = settled.who === "a" ? a : b;
    first = settled.result;
    (settled.who === "a" ? backupAbort : primaryAbort).abort();
    logger.info("LLM hedge used", { winner: settled.who === "a" ? "primary" : "backup" });
    onWinner?.(settled.who === "a" ? "primary" : "backup");
  }

  if (first.done) return;
  yield first.value;
  for (;;) {
    const next = await winner.next();
    if (next.done) return;
    yield next.value;
  }
}

/**
 * The error to surface when every provider failed. A retryable failure (e.g. a
 * 429 on the primary) wins over a later non-retryable one (e.g. a misconfigured
 * fallback), so callers back off and retry instead of reporting "not configured".
 */
export function pickProviderError(errors: unknown[]): unknown {
  return errors.find((error) => error instanceof LlmError && error.retryable) ?? errors[errors.length - 1];
}

/**
 * Stream tokens, failing over to the next configured provider only if the
 * current one fails before producing any output (so text is never duplicated).
 * Realtime requests are hedged against slow first tokens.
 */
export async function* streamCompletion(
  messages: ChatMessage[],
  purpose: Purpose = "realtime",
  options: CompletionOptions = {},
): AsyncGenerator<string> {
  const providers = providersFor(purpose);
  if (providers.length === 0) {
    throw new LlmError("No language model provider is configured. Set NVIDIA_API_KEY or GROQ_API_KEY.", false);
  }

  const startedAt = Date.now();
  const errors: unknown[] = [];
  let lastError: unknown;
  // Live turns get a second round when every provider failed quickly and retryably
  // (for example a burst 429 on the primary while the backup stalls), so the
  // candidate hears a reply a few seconds late instead of an error.
  for (let round = 0; round < (purpose === "realtime" ? 2 : 1); round++) {
    if (round > 0) {
      const retryable = lastError instanceof LlmError && lastError.retryable;
      if (!retryable || Date.now() - startedAt >= config.llm.realtimeRetryWindowMs) break;
      const waitMs = Math.min(2_000, (lastError as LlmError).retryAfterMs ?? 500);
      logger.warn("All LLM providers failed; retrying the live turn once", lastError, { waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    for (let index = 0; index < providers.length; index++) {
      const provider = providers[index];
      // Hedge against the next provider when there is one, otherwise against a
      // second request to the same provider (often served by another replica).
      const hedgeProvider = providers[index + 1] ?? provider;
      const stream =
        purpose === "realtime"
          ? hedgedStream(
              (signal) => streamFromProvider(provider, messages, purpose, { ...options, signal }),
              (signal) => streamFromProvider(hedgeProvider, messages, purpose, { ...options, signal }),
              hedgeDelayMs(),
              (winner) => {
                const served = winner === "primary" ? provider : hedgeProvider;
                options.onServed?.(served.name, served.model);
              },
            )
          : streamFromProvider(provider, messages, purpose, options);
      if (purpose !== "realtime") options.onServed?.(provider.name, provider.model);
      let yielded = false;
      let failure: unknown;
      try {
        for await (const chunk of stream) {
          yielded = true;
          yield chunk;
        }
        if (yielded) return;
        failure = new LlmError(`${provider.name} returned an empty response`);
      } catch (error) {
        if (yielded) throw error;
        failure = error;
      }
      errors.push(failure);
      lastError = failure;
      logger.warn("LLM provider failed; trying next provider", failure, { provider: provider.name, purpose });
    }
  }
  const error = pickProviderError(errors);
  throw error instanceof LlmError ? error : new LlmError("All language model providers failed.");
}

export type CompletionResult = {
  text: string;
  /** "stop" for a complete answer, "length" when max_tokens truncated it; null if the provider didn't say. */
  finishReason: string | null;
};

/** Collect a full completion and how it ended, retrying background work with backoff. */
export async function completeWithDetails(
  messages: ChatMessage[],
  purpose: Purpose = "analysis",
  options: CompletionOptions = {},
): Promise<CompletionResult> {
  const deadline = Date.now() + (options.retryForMs ?? 0);
  for (let attempt = 0; ; attempt++) {
    let finishReason: string | null = null;
    try {
      let text = "";
      const onFinishReason = (reason: string) => {
        finishReason = reason;
        options.onFinishReason?.(reason);
      };
      for await (const chunk of streamCompletion(messages, purpose, { ...options, onFinishReason })) text += chunk;
      return { text, finishReason };
    } catch (error) {
      const retryable = error instanceof LlmError && error.retryable;
      const wait = Math.min(15_000, (error instanceof LlmError && error.retryAfterMs) || 1_000 * 2 ** attempt);
      if (!retryable || options.signal?.aborted || Date.now() + wait > deadline) throw error;
      logger.warn("LLM call rate limited or failed; backing off", error, { purpose, waitMs: wait, attempt });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export async function complete(
  messages: ChatMessage[],
  purpose: Purpose = "analysis",
  options: CompletionOptions = {},
): Promise<string> {
  return (await completeWithDetails(messages, purpose, options)).text;
}

const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "approx", "inc", "ltd", "co", "no",
]);

/** Make model output safe to speak and display: drop markdown and stray markup. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // Control marker used by the interviewer to signal the end of the interview.
    .replace(/<<\s*END\s*>>|<<\s*END\s*>?$|<<\s*E?N?D?$/gi, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find the end of the first complete sentence in `buffer`, or -1.
 * A sentence ends at [.!?] followed by whitespace (so "3.5", "Node.js" and
 * "e.g." do not split), or at a newline.
 */
export function findSentenceEnd(buffer: string): number {
  const pattern = /([.!?]+)(["')\]]*)(\s+)|\n+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(buffer))) {
    if (match[0].startsWith("\n")) return match.index + match[0].length;
    if (match[1] === ".") {
      const before = buffer.slice(0, match.index);
      const word = (before.match(/([A-Za-z.]+)$/)?.[1] || "").toLowerCase();
      if (ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word)) continue;
    }
    return match.index + match[0].length;
  }
  return -1;
}

/**
 * Find an early clause boundary (", " "; " ": " " - ") at or after `minChars`, or -1.
 * Used only for the first chunk of a reply so speech synthesis can start sooner.
 */
export function findClauseEnd(buffer: string, minChars: number): number {
  const pattern = /[,;:\u2014\u2013]\s+|\s[-\u2014\u2013]\s/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(buffer))) {
    const end = match.index + match[0].length;
    if (match.index >= minChars) return end;
  }
  return -1;
}

export type SentenceStreamOptions = {
  /** Split the very first chunk at a clause boundary once it has this many characters (0 disables). */
  firstChunkMinChars?: number;
};

/** Yield complete, speakable sentences as tokens stream in. */
export async function* streamSentences(tokens: AsyncIterable<string>, options: SentenceStreamOptions = {}): AsyncGenerator<string> {
  let buffer = "";
  let inThink = false;
  let emitted = 0;
  const firstChunkMin = options.firstChunkMinChars ?? 0;
  for await (const chunk of tokens) {
    buffer += chunk;
    // Drop any inline reasoning block before splitting into sentences.
    if (!inThink && buffer.includes("<think>")) inThink = true;
    if (inThink) {
      const end = buffer.indexOf("</think>");
      if (end === -1) continue;
      buffer = buffer.slice(0, buffer.indexOf("<think>")) + buffer.slice(end + "</think>".length);
      inThink = false;
    }
    for (;;) {
      let end = findSentenceEnd(buffer);
      if (end === -1 && emitted === 0 && firstChunkMin > 0) end = findClauseEnd(buffer, firstChunkMin);
      if (end === -1) break;
      const sentence = cleanForSpeech(buffer.slice(0, end));
      buffer = buffer.slice(end);
      if (sentence) {
        emitted++;
        yield sentence;
      }
    }
  }
  const rest = cleanForSpeech(inThink ? buffer.slice(0, buffer.indexOf("<think>")) : buffer);
  if (rest) yield rest;
}
