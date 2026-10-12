import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanForSpeech, findClauseEnd, findSentenceEnd, hedgedStream, LlmError, streamCompletion, streamSentences } from "@/server/llm";

async function* fromArray(chunks: string[]) {
  for (const chunk of chunks) yield chunk;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

function sseResponse(contents: string[], status = 200): Response {
  const body = contents.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("sentence splitting", () => {
  it("splits on sentence punctuation followed by whitespace", async () => {
    const sentences = await collect(streamSentences(fromArray(["Hello Jane", ". Great to ", "meet you! What did you", " build?"])));
    expect(sentences).toEqual(["Hello Jane.", "Great to meet you!", "What did you build?"]);
  });

  it("does not split decimals, file names or abbreviations", async () => {
    const sentences = await collect(
      streamSentences(fromArray(["You used Node.js and Python 3.12, e.g. for APIs. ", "Dr. Smith agreed. Why?"])),
    );
    expect(sentences).toEqual(["You used Node.js and Python 3.12, e.g. for APIs.", "Dr. Smith agreed.", "Why?"]);
  });

  it("drops inline reasoning blocks and markdown", async () => {
    const sentences = await collect(streamSentences(fromArray(["<think>internal", " notes.</think>**Great** answer. ", "- Next?"])));
    expect(sentences).toEqual(["Great answer.", "Next?"]);
  });

  it("findSentenceEnd returns -1 for incomplete sentences", () => {
    expect(findSentenceEnd("No terminal punctuation yet")).toBe(-1);
    expect(findSentenceEnd("Ends here.")).toBe(-1); // needs following whitespace
    expect(findSentenceEnd("Line one\nLine two")).toBe(9);
  });

  it("cleanForSpeech strips markdown and code", () => {
    expect(cleanForSpeech("## Title\n* item `code` ```js\nx```")).toBe("Title item code");
  });
});

describe("streamCompletion provider chain", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NVIDIA_API_KEY = "nv-test";
    process.env.GROQ_API_KEY = "gq-test";
    process.env.LLM_FALLBACK_GROQ = "true";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("streams content from NVIDIA with thinking disabled for realtime turns", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["Hi ", "there."]));
    vi.stubGlobal("fetch", fetchMock);
    const chunks = await collect(streamCompletion([{ role: "user", content: "x" }], "realtime"));
    expect(chunks.join("")).toBe("Hi there.");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.reasoning_budget).toBeUndefined();
  });

  it("enables reasoning with a budget for analysis", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["{}"]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(streamCompletion([{ role: "user", content: "x" }], "analysis"));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(body.reasoning_budget).toBe(1024);
  });

  it("fails over to the NVIDIA backup model, then Groq, when earlier providers fail before output", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 })) // primary
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 })) // backup model
      .mockResolvedValueOnce(sseResponse(["Groq answered."]));
    vi.stubGlobal("fetch", fetchMock);
    const chunks = await collect(streamCompletion([{ role: "user", content: "x" }]));
    expect(chunks.join("")).toBe("Groq answered.");
    const models = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).model);
    expect(models.slice(0, 2)).toEqual(["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3.5-lightning-30b-a3b"]);
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("runs per-answer notes on a different model than the live interviewer (separate rate limit)", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["{}"]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(streamCompletion([{ role: "user", content: "x" }], "notes"));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.reasoning_budget).toBeUndefined();
  });

  it("falls back to Groq when NVIDIA fails before producing output", async () => {
    process.env.NVIDIA_REALTIME_BACKUP_MODEL = "nvidia/nemotron-3-super-120b-a12b"; // same as primary => no backup entry
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(sseResponse(["Fallback works."]));
    vi.stubGlobal("fetch", fetchMock);
    const chunks = await collect(streamCompletion([{ role: "user", content: "x" }]));
    expect(chunks.join("")).toBe("Fallback works.");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("does not fail over (and duplicate text) after output has started", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const broken = new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`));
        } else {
          controller.error(new Error("connection reset"));
        }
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(broken, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    await expect(async () => {
      for await (const chunk of streamCompletion([{ role: "user", content: "x" }])) seen.push(chunk);
    }).rejects.toBeInstanceOf(LlmError);
    expect(seen).toEqual(["Partial"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /** A request the provider accepts but never starts streaming (queued or stalled). */
  const hangingResponse = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const modelsCalled = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string).model as string);

  it("abandons a live provider that hasn't started streaming within the first-token timeout", async () => {
    process.env.LLM_FALLBACK_GROQ = "false";
    process.env.LLM_HEDGE_MS = "10000";
    process.env.LLM_REALTIME_FIRST_TOKEN_TIMEOUT = "0.05";
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(hangingResponse) // primary is stuck in a queue
      .mockResolvedValueOnce(sseResponse(["Backup answered."]));
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    const chunks = await collect(streamCompletion([{ role: "user", content: "x" }], "realtime"));
    expect(chunks.join("")).toBe("Backup answered.");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(modelsCalled(fetchMock)).toEqual(["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3.5-lightning-30b-a3b"]);
  });

  it("retries a live turn once when every provider failed quickly (burst 429 + stalled backup)", async () => {
    process.env.LLM_FALLBACK_GROQ = "false";
    process.env.LLM_HEDGE_MS = "10000";
    process.env.LLM_REALTIME_FIRST_TOKEN_TIMEOUT = "0.05";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 })) // primary: burst limit
      .mockImplementationOnce(hangingResponse) // backup model stalls
      .mockResolvedValueOnce(sseResponse(["Recovered."])); // primary again, a moment later
    vi.stubGlobal("fetch", fetchMock);
    const chunks = await collect(streamCompletion([{ role: "user", content: "x" }], "realtime"));
    expect(chunks.join("")).toBe("Recovered.");
    expect(modelsCalled(fetchMock)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/nemotron-3-super-120b-a12b",
    ]);
  });

  it("does not retry outside the live retry window, or for background work", async () => {
    process.env.LLM_FALLBACK_GROQ = "false";
    process.env.LLM_REALTIME_RETRY_WINDOW = "0";
    let fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(collect(streamCompletion([{ role: "user", content: "x" }], "realtime"))).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // primary + backup model, no second round

    delete process.env.LLM_REALTIME_RETRY_WINDOW;
    fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(collect(streamCompletion([{ role: "user", content: "x" }], "analysis"))).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // background calls retry in complete() instead
  });

  it("throws a non-retryable error when no provider is configured", async () => {
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GROQ_API_KEY;
    await expect(collect(streamCompletion([{ role: "user", content: "x" }]))).rejects.toMatchObject({ retryable: false });
  });
});

describe("hedgedStream", () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function* slow(tokens: string[], firstDelayMs: number, signal?: AbortSignal, log?: string[], name?: string) {
    await delay(firstDelayMs);
    for (const token of tokens) {
      if (signal?.aborted) {
        log?.push(`${name}:aborted`);
        return;
      }
      yield token;
      await delay(1);
    }
  }

  it("uses the backup when the primary's first token is slow, and cancels the primary", async () => {
    const log: string[] = [];
    const started = Date.now();
    const out = await collect(
      hedgedStream(
        (signal) => slow(["primary"], 300, signal, log, "primary"),
        (signal) => slow(["backup ", "wins"], 10, signal, log, "backup"),
        50,
      ),
    );
    expect(out.join("")).toBe("backup wins");
    expect(Date.now() - started).toBeLessThan(250);
    await delay(300);
    expect(log).toContain("primary:aborted");
  });

  it("does not start the backup when the primary is fast", async () => {
    const backup = vi.fn((signal: AbortSignal) => slow(["backup"], 0, signal));
    const out = await collect(hedgedStream((signal) => slow(["fast"], 5, signal), backup, 200));
    expect(out).toEqual(["fast"]);
    expect(backup).not.toHaveBeenCalled();
  });

  it("falls through to the other request when the first to settle fails", async () => {
    async function* failing(): AsyncGenerator<string> {
      await delay(80);
      throw new LlmError("primary broke");
    }
    const out = await collect(hedgedStream(() => failing(), (signal) => slow(["backup ok"], 120, signal), 20));
    expect(out).toEqual(["backup ok"]);
  });

  it("propagates an early primary failure without waiting for the hedge", async () => {
    async function* failing(): AsyncGenerator<string> {
      throw new LlmError("instant failure");
    }
    const backup = vi.fn((signal: AbortSignal) => slow(["never"], 0, signal));
    await expect(collect(hedgedStream(() => failing(), backup, 500))).rejects.toThrow("instant failure");
    expect(backup).not.toHaveBeenCalled();
  });
});

describe("early first chunk", () => {
  it("splits the first chunk at a clause boundary once it is long enough", async () => {
    const out = await collect(
      streamSentences(fromArray(["That makes sense for a payments ledger, especially ", "with retries. Next question?"]), {
        firstChunkMinChars: 28,
      }),
    );
    expect(out).toEqual(["That makes sense for a payments ledger,", "especially with retries.", "Next question?"]);
  });

  it("does not split short clauses or later sentences", () => {
    expect(findClauseEnd("Sure, tell me more", 28)).toBe(-1);
    expect(findClauseEnd("Thanks for walking me through that migration, it", 28)).toBeGreaterThan(28);
  });

  it("strips the end-of-interview marker from speech", async () => {
    const out = await collect(streamSentences(fromArray(["Thanks Jane, that completes our interview. <<END", ">>"])));
    expect(out).toEqual(["Thanks Jane, that completes our interview."]);
  });
});

describe("complete(): background retries on rate limits", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.NVIDIA_API_KEY = "nv-test";
    process.env.NVIDIA_REALTIME_BACKUP_MODEL = "nvidia/nemotron-3-super-120b-a12b";
    delete process.env.GROQ_API_KEY;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("waits for Retry-After on 429 and succeeds within the retry window", async () => {
    const { complete } = await import("@/server/llm");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0.05" } }))
      .mockResolvedValueOnce(sseResponse(['{"ok": true}']));
    vi.stubGlobal("fetch", fetchMock);
    const started = Date.now();
    expect(await complete([{ role: "user", content: "x" }], "analysis", { retryForMs: 5_000 })).toBe('{"ok": true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it("does not retry without a retry window (live paths fail fast)", async () => {
    const { complete } = await import("@/server/llm");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })));
    await expect(complete([{ role: "user", content: "x" }], "analysis")).rejects.toMatchObject({ retryable: true, retryAfterMs: 2_000 });
  });
});

describe("completeWithDetails: finish_reason and error selection", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.NVIDIA_API_KEY = "nv-test";
    process.env.GROQ_API_KEY = "gq-test";
    process.env.LLM_FALLBACK_GROQ = "true";
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  function sseWithFinish(contents: string[], finishReason: string): Response {
    const chunks = contents.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] })}\n\n`);
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`, "data: [DONE]\n\n");
    return new Response(chunks.join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  it("exposes the provider's finish_reason, so truncated output can be rejected", async () => {
    const { completeWithDetails } = await import("@/server/llm");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sseWithFinish(['{"score": 7', "0, "], "length")));
    expect(await completeWithDetails([{ role: "user", content: "x" }], "analysis")).toEqual({ text: '{"score": 70, ', finishReason: "length" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(sseResponse(["done"])));
    expect(await completeWithDetails([{ role: "user", content: "x" }], "analysis")).toEqual({ text: "done", finishReason: null });
  });

  it("keeps a retryable 429 over a later non-retryable fallback error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "4" } })) // NVIDIA
        .mockResolvedValueOnce(new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 })), // Groq
    );
    await expect(collect(streamCompletion([{ role: "user", content: "x" }], "analysis"))).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 4_000,
    });
  });

  it("still reports a non-retryable failure when nothing was retryable", async () => {
    const { pickProviderError } = await import("@/server/llm");
    const fatal = new LlmError("bad key", false);
    expect(pickProviderError([fatal])).toBe(fatal);
    expect(pickProviderError([new Error("x"), fatal])).toBe(fatal);
  });
});
