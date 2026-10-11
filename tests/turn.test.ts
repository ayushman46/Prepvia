import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnEvent } from "@/lib/protocol";
import { defaultInterviewMemory, defaultInterviewState, type ChatMessage } from "@/server/interview-context";

const store = vi.hoisted(() => ({
  transcripts: [] as { role: "user" | "ai"; content: string }[],
  questionUpdates: [] as unknown[],
  turnIncrements: 0,
  started: 0,
  canvasIntroduced: 0,
}));

vi.mock("@/server/sessions", () => ({
  getTranscripts: vi.fn(async () => store.transcripts.map((t) => ({ ...t }))),
  appendTranscript: vi.fn(async (_id: string, role: "user" | "ai", content: string) => {
    store.transcripts.push({ role, content });
  }),
  incrementTurnCount: vi.fn(async () => {
    store.turnIncrements += 1;
  }),
  applyQuestionUpdate: vi.fn(async (_id: string, update: unknown) => {
    store.questionUpdates.push(update);
  }),
  markStarted: vi.fn(async () => {
    store.started += 1;
  }),
  markCanvasIntroduced: vi.fn(async () => {
    store.canvasIntroduced += 1;
  }),
}));

const providers = vi.hoisted(() => ({
  transcribe: vi.fn<(audio: Uint8Array) => Promise<string>>(),
  tokens: vi.fn<(messages: ChatMessage[]) => AsyncGenerator<string>>(),
  tts: vi.fn<(text: string) => Promise<Buffer>>(),
  calls: [] as ChatMessage[][],
}));

vi.mock("@/server/stt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/stt")>();
  return { ...actual, transcribeAudio: (audio: Uint8Array) => providers.transcribe(audio) };
});

vi.mock("@/server/tts", () => ({ synthesizeSentence: (text: string) => providers.tts(text) }));

vi.mock("@/server/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm")>();
  return {
    ...actual,
    streamCompletion: (messages: ChatMessage[]) => {
      providers.calls.push(messages);
      return providers.tokens(messages);
    },
  };
});

const { runTurn, closingLine } = await import("@/server/turn");
const { LlmError } = await import("@/server/llm");
const { SttError } = await import("@/server/stt");

const baseSession = {
  _id: "a".repeat(32),
  candidate_name: "Jane",
  target_role: "Backend Engineer",
  resume_text: "Go, Postgres",
  job_description: "",
  status: "active" as const,
  interview_state: defaultInterviewState(),
  interview_memory: defaultInterviewMemory(),
  turn_count: 0,
  duration_minutes: 30,
  interview_type: "mixed" as const,
  level: "mid" as const,
  canvas_enabled: true,
  created_at: new Date(),
};

async function* tokens(parts: string[]) {
  for (const part of parts) yield part;
}

type Overrides = Partial<typeof baseSession> & Record<string, unknown>;

async function run(input: Parameters<typeof runTurn>[2], overrides: Overrides = {}) {
  const events: TurnEvent[] = [];
  const sessionUpdate: Record<string, unknown> = {};
  const result = await runTurn(baseSession._id, { ...baseSession, ...overrides } as never, input, (e) => events.push(e), Date.now(), sessionUpdate);
  return { events, result, sessionUpdate };
}

const types = (events: TurnEvent[]) => events.map((e) => e.type);
const lastSystemPrompt = () => providers.calls.at(-1)?.[0].content ?? "";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
/** A session that has been running for a while with a few questions asked. */
const inProgress = (minutes: number, extra: Overrides = {}): Overrides => ({
  started_at: minutesAgo(minutes),
  interview_state: { ...defaultInterviewState(), question_number: 3 },
  turn_count: 3,
  ...extra,
});

beforeEach(() => {
  store.transcripts = [];
  store.questionUpdates = [];
  store.turnIncrements = 0;
  store.started = 0;
  store.canvasIntroduced = 0;
  providers.calls = [];
  providers.transcribe.mockReset();
  providers.tokens.mockReset();
  providers.tts.mockReset();
  providers.tts.mockImplementation(async (text) => Buffer.from(`mp3:${text}`));
  process.env.TTS_ENABLED = "true";
  process.env.MAX_TURNS_PER_SESSION = "40";
});

describe("runTurn: conversation flow", () => {
  it("opens the interview (without starting the clock) and prepares the canvas exercise", async () => {
    providers.tokens.mockImplementation(() => tokens(["Hi Jane, I'm Aria. ", "Tell me about a project you're proud of?"]));
    const { events, result, sessionUpdate } = await run({ kind: "continue" });

    expect(types(events)[0]).toBe("ai_start");
    expect(types(events).slice(-3)).toEqual(["ai_done", "metrics", "done"]);
    expect(types(events).filter((t) => t === "audio")).toHaveLength(2);
    expect(lastSystemPrompt()).toMatch(/Current section: opening/);
    expect(providers.calls[0].at(-1)).toEqual({ role: "user", content: expect.stringMatching(/joined the call/) });
    expect(store.transcripts).toEqual([{ role: "ai", content: "Hi Jane, I'm Aria. Tell me about a project you're proud of?" }]);
    // The clock starts when the candidate presses Start, not while the opening is prefetched.
    expect(sessionUpdate.startedAt).toBeUndefined();
    expect(sessionUpdate.question).toMatchObject({ question_number: 1 });
    expect(result).toMatchObject({ analysis: null, prepareCanvas: true });
  });

  it("starts the clock on the first answer if the client never sent a start event", async () => {
    store.transcripts = [{ role: "ai", content: "Hi, tell me about yourself?" }];
    providers.tokens.mockImplementation(() => tokens(["What drew you to backend work?"]));
    const first = await run({ kind: "text", text: "I'm a backend engineer." }, { interview_state: { ...defaultInterviewState(), question_number: 1 } });
    expect(first.sessionUpdate.startedAt).toBeInstanceOf(Date);
    const later = await run({ kind: "text", text: "Distributed systems." }, inProgress(2));
    expect(later.sessionUpdate.startedAt).toBeUndefined(); // already started: not reset
  });

  it("sends the dialogue as alternating chat turns with the candidate's answer last", async () => {
    store.transcripts = [{ role: "ai", content: "What did you build?" }];
    providers.transcribe.mockResolvedValue("I built a payments API.");
    providers.tokens.mockImplementation(() => tokens(["Which part was hardest to get right?"]));

    const { events, result, sessionUpdate } = await run({ kind: "audio", audio: new Uint8Array(100) }, inProgress(3));

    expect(events[0]).toEqual({ type: "user_transcript", content: "I built a payments API." });
    const messages = providers.calls[0];
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages.at(-1)?.content).toBe("I built a payments API.");
    expect(store.transcripts.map((t) => t.role)).toEqual(["ai", "user", "ai"]);
    expect(sessionUpdate.incrementTurn).toBe(true);
    expect(result.analysis).toEqual({ question: "What did you build?", answer: "I built a payments API." });
    // Background analysis gets the already-loaded state (no extra database reads).
    expect(result.context?.transcripts.at(-1)).toEqual({ role: "ai", content: "Which part was hardest to get right?" });
  });

  it("reports server timings in a metrics event", async () => {
    providers.transcribe.mockResolvedValue("An answer.");
    store.transcripts = [{ role: "ai", content: "Q?" }];
    providers.tokens.mockImplementation(() => tokens(["Thanks. ", "What next?"]));
    const { events } = await run({ kind: "audio", audio: new Uint8Array(100) }, inProgress(4));
    const metrics = events.find((e): e is Extract<TurnEvent, { type: "metrics" }> => e.type === "metrics")?.metrics;
    expect(metrics).toMatchObject({ section: "background" });
    for (const key of ["stt_ms", "llm_first_token_ms", "first_sentence_ms", "first_audio_ms", "total_ms"] as const) {
      expect(typeof metrics?.[key]).toBe("number");
    }
  });

  it("does nothing on continue when the interviewer already spoke last", async () => {
    store.transcripts = [{ role: "ai", content: "Q1?" }];
    const { events } = await run({ kind: "continue" });
    expect(types(events)).toEqual(["done"]);
    expect(providers.tokens).not.toHaveBeenCalled();
  });

  it("answers a saved-but-unanswered response on retry and analyzes it", async () => {
    store.transcripts = [
      { role: "ai", content: "Q1?" },
      { role: "user", content: "Answer one" },
    ];
    providers.tokens.mockImplementation(() => tokens(["Got it. What happened next?"]));
    const { events, result } = await run({ kind: "continue" }, inProgress(5, { turn_count: 1 }));
    expect(types(events)).not.toContain("user_transcript");
    expect(store.transcripts.at(-1)).toEqual({ role: "ai", content: "Got it. What happened next?" });
    expect(result.analysis).toEqual({ question: "Q1?", answer: "Answer one" });
  });
});

describe("runTurn: audio pipeline", () => {
  it("keeps sequence numbers ordered even when TTS finishes out of order", async () => {
    providers.tokens.mockImplementation(() => tokens(["First sentence here. ", "Second sentence here. ", "Third one?"]));
    providers.tts.mockImplementation(async (text) => {
      await new Promise((resolve) => setTimeout(resolve, text.startsWith("First") ? 30 : 1));
      return Buffer.from(text);
    });
    const { events } = await run({ kind: "continue" });

    const sentences = events.filter((e): e is Extract<TurnEvent, { type: "ai_sentence" }> => e.type === "ai_sentence");
    expect(sentences.map((s) => s.seq)).toEqual([1, 2, 3]);
    const audio = events.filter((e): e is Extract<TurnEvent, { type: "audio" }> => e.type === "audio");
    expect(audio.map((a) => a.seq).sort()).toEqual([1, 2, 3]);
    expect(audio[0].seq).not.toBe(1); // later sentences really did finish first
    expect(Buffer.from(audio.find((a) => a.seq === 1)!.data, "base64").toString()).toBe("First sentence here.");
    expect(types(events).indexOf("ai_done")).toBeGreaterThan(types(events).lastIndexOf("audio"));
  });

  it("releases a failed TTS sequence with audio_error instead of stalling", async () => {
    providers.tokens.mockImplementation(() => tokens(["One sentence that fails. ", "Two works?"]));
    providers.tts.mockImplementation(async (text) => {
      if (text.startsWith("One")) throw new Error("tts down");
      return Buffer.from(text);
    });
    const { events } = await run({ kind: "continue" });
    expect(events).toContainEqual({ type: "audio_error", seq: 1 });
    expect(events.some((e) => e.type === "audio" && e.seq === 2)).toBe(true);
  });

  it("falls back to browser speech for every sentence when TTS is disabled", async () => {
    process.env.TTS_ENABLED = "false";
    providers.tokens.mockImplementation(() => tokens(["Hello there, Jane. Ready to start?"]));
    const { events } = await run({ kind: "continue" });
    expect(events.filter((e) => e.type === "audio_error")).toHaveLength(2);
    expect(providers.tts).not.toHaveBeenCalled();
  });

  it("emits no_speech and skips the AI turn for empty transcriptions", async () => {
    store.transcripts = [{ role: "ai", content: "Q?" }];
    providers.transcribe.mockResolvedValue("");
    const { events } = await run({ kind: "audio", audio: new Uint8Array(100) });
    expect(types(events)).toEqual(["no_speech"]);
    expect(providers.tokens).not.toHaveBeenCalled();
  });

  it("tells the candidate to type when speech recognition is unavailable (bad key), and to retry when it is busy", async () => {
    providers.transcribe.mockRejectedValueOnce(new SttError("401", false, "invalid_key"));
    let { events } = await run({ kind: "audio", audio: new Uint8Array(100) });
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "stt_unavailable", retryable: false })]);
    providers.transcribe.mockRejectedValueOnce(new SttError("429", false, "rate_limited", 2_000));
    ({ events } = await run({ kind: "audio", audio: new Uint8Array(100) }));
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "stt_busy", retryable: true })]);
    expect(store.transcripts).toEqual([]);
  });

  it("reports STT failures without saving anything", async () => {
    store.transcripts = [{ role: "ai", content: "Q?" }];
    providers.transcribe.mockRejectedValue(new SttError("groq down", true));
    const { events } = await run({ kind: "audio", audio: new Uint8Array(100) });
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "stt_failed", retryable: true })]);
    expect(store.transcripts).toHaveLength(1);
  });

  it("never speaks or persists provider error text when the LLM fails", async () => {
    store.transcripts = [{ role: "ai", content: "Q?" }];
    providers.tokens.mockImplementation(async function* () {
      throw new LlmError("nvidia 503");
    });
    const { events, result } = await run({ kind: "text", text: "My answer" }, inProgress(2));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "llm_failed", retryable: true });
    expect(store.transcripts).toEqual([
      { role: "ai", content: "Q?" },
      { role: "user", content: "My answer" },
    ]);
    expect(result.analysis).toBeNull();
  });
});

describe("runTurn: interview quality guards", () => {
  it("regenerates once when the reply repeats an earlier interviewer reply", async () => {
    const earlier = "You mentioned owning the cutover plan. Can you walk me through one specific decision you made?";
    store.transcripts = [
      { role: "ai", content: earlier },
      { role: "user", content: "We used an outbox table." },
      { role: "ai", content: "How did you handle schema evolution?" },
    ];
    let call = 0;
    providers.tokens.mockImplementation(() => (call++ === 0 ? tokens([earlier]) : tokens(["How did you version the event schema across both systems?"])));
    const { events } = await run({ kind: "text", text: "We argued about Cassandra versus Postgres." }, inProgress(6));

    expect(providers.calls).toHaveLength(2);
    expect(providers.calls[1][0].content).toMatch(/repeated an earlier reply/);
    expect(providers.calls[1][0].content).toContain("You mentioned owning the cutover plan"); // quotes the rejected draft
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content).join(" ");
    expect(spoken).toBe("How did you version the event schema across both systems?");
  });

  it("regenerates up to twice when the model keeps repeating itself, then accepts", async () => {
    const earlier = "You mentioned owning the cutover plan. Can you walk me through one specific decision you made?";
    store.transcripts = [
      { role: "ai", content: "Tell me about the migration?" },
      { role: "user", content: "We used an outbox table." },
      { role: "ai", content: earlier },
    ];
    let call = 0;
    providers.tokens.mockImplementation(() =>
      call++ < 2 ? tokens([earlier]) : tokens(["Which failure mode worried you most during the cutover?"]),
    );
    const { events } = await run({ kind: "text", text: "Kafka consumers." }, inProgress(6));
    expect(providers.calls).toHaveLength(3);
    // The final attempt drops the dialogue, including the previous reply being copied,
    // and keeps only the candidate's latest message.
    expect(providers.calls[0].length).toBeGreaterThan(providers.calls[2].length);
    expect(providers.calls[2].map((m) => m.content)).not.toContain(earlier);
    expect(providers.calls[2][0].content).toContain("You mentioned owning the cutover plan. Can you walk me…");
    expect(providers.calls[2][0].content).not.toContain("one specific decision"); // only a short excerpt is quoted
    expect(providers.calls[2].at(-1)?.role).toBe("user");
    expect(providers.calls[2].at(-1)?.content.endsWith("Kafka consumers.")).toBe(true);
    expect(events.find((e): e is Extract<TurnEvent, { type: "metrics" }> => e.type === "metrics")?.metrics.regenerated).toBe(2);
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content).join(" ");
    expect(spoken).toBe("Which failure mode worried you most during the cutover?");
  });

  it("does not regenerate for a generic opener shared with earlier replies", async () => {
    store.transcripts = [
      { role: "ai", content: "Thanks for sharing that. You mentioned the ledger migration. What was hardest?" },
      { role: "user", content: "Keeping both systems consistent." },
    ];
    providers.tokens.mockImplementation(() => tokens(["Thanks for sharing that. ", "How did you detect drift between the two ledgers?"]));
    await run({ kind: "text", text: "We compared outputs nightly." }, inProgress(6));
    expect(providers.calls).toHaveLength(1);
  });

  it("regenerates when the reply parrots the candidate", async () => {
    store.transcripts = [{ role: "ai", content: "How would you design rate limiting?" }];
    let call = 0;
    providers.tokens.mockImplementation(() =>
      call++ === 0 ? tokens(["I would use a token bucket per merchant in Redis."]) : tokens(["How would you handle bursts at the start of a window?"]),
    );
    await run({ kind: "text", text: "I would use a token bucket per merchant in Redis." }, inProgress(8));
    expect(providers.calls).toHaveLength(2);
  });

  it("handles 'repeat the question' deterministically without scoring it", async () => {
    store.transcripts = [{ role: "ai", content: "How would you design rate limiting for the payments API?" }];
    providers.tokens.mockImplementation(() => tokens(["Sure, how would you design rate limiting for the payments API?"]));
    const { result, events, sessionUpdate } = await run({ kind: "text", text: "Sorry, could you repeat the question?" }, inProgress(9));

    expect(lastSystemPrompt()).toMatch(/asked you to repeat the question/);
    expect(lastSystemPrompt()).toContain("How would you design rate limiting for the payments API?");
    expect(providers.calls).toHaveLength(1); // restating is not treated as a repetition loop
    expect(result.analysis).toBeNull();
    expect(sessionUpdate.question).toBeNull();
    expect(events.find((e) => e.type === "ai_done")).toMatchObject({ question_number: 3 });
  });
});

describe("runTurn: timed sections, canvas, and ending", () => {
  const task = { title: "Rate limiter", instructions: "Implement allow(user)", language: "python", starter_code: "def allow(user):\n    pass", focus: [] };

  it("introduces the canvas exercise once when the hands-on section begins", async () => {
    store.transcripts = [{ role: "ai", content: "Earlier question?" }];
    providers.tokens.mockImplementation(() => tokens(["I've opened a canvas with a problem. Walk me through your approach?"]));
    const { events, sessionUpdate } = await run({ kind: "text", text: "Sure." }, inProgress(16, { canvas: { task, content: "" } }));

    expect(events.find((e) => e.type === "canvas_task")).toEqual({
      type: "canvas_task",
      task: { title: "Rate limiter", instructions: "Implement allow(user)", language: "python", starter_code: "def allow(user):\n    pass" },
    });
    expect(lastSystemPrompt()).toMatch(/Current section: hands on/);
    expect(lastSystemPrompt()).toMatch(/opened a canvas on their screen with a problem titled "Rate limiter"/);
    expect(lastSystemPrompt()).toContain("<CANVAS>"); // visible on the introducing turn
    expect(sessionUpdate.canvasIntroduced).toBe(true);
  });

  it("keeps a generated-but-unintroduced exercise hidden from the interviewer", async () => {
    store.transcripts = [{ role: "ai", content: "Earlier question?" }];
    providers.tokens.mockImplementation(() => tokens(["How did you handle failures there?"]));
    await run({ kind: "text", text: "Answer." }, inProgress(9, { canvas: { task, content: "" } })); // technical section
    expect(lastSystemPrompt()).not.toContain("<CANVAS>");
    expect(lastSystemPrompt()).not.toContain("Rate limiter");
  });

  it("does not re-introduce an exercise that was already introduced, but shows the work to the model", async () => {
    store.transcripts = [{ role: "ai", content: "How's it going?" }];
    providers.tokens.mockImplementation(() => tokens(["Why did you pick a sliding window?"]));
    const { events } = await run(
      { kind: "text", text: "I'm using a sliding window." },
      inProgress(18, { canvas: { task, content: "def allow(user):\n    window = deque()", introduced_at: new Date() } }),
    );
    expect(types(events)).not.toContain("canvas_task");
    expect(lastSystemPrompt()).toContain("window = deque()");
  });

  it("keeps assessing technically and requests the exercise if it is missing at hands-on time", async () => {
    store.transcripts = [{ role: "ai", content: "Q?" }];
    providers.tokens.mockImplementation(() => tokens(["How would you test that?"]));
    const { result, events } = await run({ kind: "text", text: "Answer." }, inProgress(17, { canvas: { content: "" } }));
    expect(types(events)).not.toContain("canvas_task");
    expect(lastSystemPrompt()).toMatch(/Current section: technical/);
    expect(result.prepareCanvas).toBe(true);
  });

  it("treats a farewell without a question in wrap-up as the end (no 'take care' loops)", async () => {
    store.transcripts = [{ role: "ai", content: "Any questions for me?" }];
    providers.tokens.mockImplementation(() => tokens(["You're welcome, Jane. Best of luck, and take care."]));
    const { events } = await run({ kind: "text", text: "No, thank you!" }, inProgress(28));
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
  });

  it("does not end on a farewell-like phrase that still asks a question", async () => {
    store.transcripts = [{ role: "ai", content: "Any questions for me?" }];
    providers.tokens.mockImplementation(() => tokens(["Good luck with the search. Is there anything else you'd like to know?"]));
    const { events } = await run({ kind: "text", text: "Maybe one more." }, inProgress(28));
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("enforces one question per turn by stopping after the first question", async () => {
    store.transcripts = [{ role: "ai", content: "Q?" }];
    providers.tokens.mockImplementation(() => tokens(["Got it. Why did you pick Kafka? And how did you handle ordering? Also, what about retries?"]));
    const { events } = await run({ kind: "text", text: "We used Kafka." }, inProgress(9));
    const spokenText = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content).join(" ");
    expect(spokenText).toBe("Got it. Why did you pick Kafka?");
    expect(store.transcripts.at(-1)?.content).toBe("Got it. Why did you pick Kafka?");
  });

  it("wraps up near the end and closes when the model emits the end marker", async () => {
    store.transcripts = [{ role: "ai", content: "Any questions for me?" }];
    providers.tokens.mockImplementation(() => tokens(["Thanks Jane, that's the end of our interview. <<END>>"]));
    const { events } = await run({ kind: "text", text: "No, that's all from me." }, inProgress(28));
    expect(lastSystemPrompt()).toMatch(/Current section: wrap up/);
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content);
    expect(spoken.join(" ")).not.toContain("<<");
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
  });

  it("forces a closing turn after the scheduled time plus grace period", async () => {
    store.transcripts = [{ role: "ai", content: "Last thing?" }];
    providers.tokens.mockImplementation(() => tokens(["Thank you Jane, our time is up."]));
    const { events } = await run({ kind: "text", text: "Here's my answer." }, inProgress(33));
    expect(lastSystemPrompt()).toMatch(/Current section: closing/);
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
  });

  it("closes the interview when the turn limit is reached", async () => {
    process.env.MAX_TURNS_PER_SESSION = "3";
    store.transcripts = [{ role: "ai", content: "Last question?" }];
    providers.tokens.mockImplementation(() => tokens(["Thank you Jane, that completes the interview."]));
    const { events } = await run({ kind: "text", text: "Final answer" }, inProgress(5, { turn_count: 2 }));
    expect(lastSystemPrompt()).toMatch(/interview is complete/);
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
  });
});

describe("runTurn: speculative TTS for held-back sentences", () => {
  it("starts speech synthesis for held sentences before the repeat check releases them", async () => {
    store.transcripts = [{ role: "ai", content: "Earlier question about something else entirely?" }];
    const order: string[] = [];
    providers.tts.mockImplementation(async (text) => {
      order.push(`tts:${text}`);
      return Buffer.from(text);
    });
    providers.tokens.mockImplementation(async function* () {
      yield "Short one. ";
      order.push("llm:second-sentence");
      yield "Then a longer follow-up question about your design choices?";
    });
    const { events } = await run({ kind: "text", text: "An answer." }, inProgress(5));
    // TTS for the first (held) sentence started before the second sentence even existed.
    expect(order.indexOf("tts:Short one.")).toBeLessThan(order.indexOf("llm:second-sentence"));
    expect(providers.tts).toHaveBeenCalledTimes(2); // no duplicate synthesis on release
    expect(events.filter((e) => e.type === "audio")).toHaveLength(2);
  });

  it("discards early audio when the draft is rejected as a repeat", async () => {
    const earlier = "You mentioned owning the cutover plan. Can you walk me through one specific decision you made?";
    store.transcripts = [
      { role: "ai", content: earlier },
      { role: "user", content: "Sure." },
    ];
    let call = 0;
    providers.tokens.mockImplementation(() => (call++ === 0 ? tokens([earlier]) : tokens(["Which metric told you the cutover worked?"])));
    const { events } = await run({ kind: "text", text: "Another answer." }, inProgress(6));
    const audio = events.filter((e): e is Extract<TurnEvent, { type: "audio" }> => e.type === "audio");
    expect(audio).toHaveLength(1);
    expect(Buffer.from(audio[0].data, "base64").toString()).toBe("mp3:Which metric told you the cutover worked?");
  });
});

describe("runTurn: immediate acknowledgements", () => {
  it("releases a short acknowledgement before the repeat check finishes", async () => {
    store.transcripts = [{ role: "ai", content: "Earlier question about something else entirely?" }];
    const order: string[] = [];
    providers.tts.mockImplementation(async (text) => {
      order.push(`tts:${text}`);
      return Buffer.from(text);
    });
    const events: TurnEvent[] = [];
    providers.tokens.mockImplementation(async function* () {
      yield "Got it. ";
      // The acknowledgement must already be on its way to the browser here.
      order.push(`emitted-before-rest:${events.some((e) => e.type === "ai_sentence")}`);
      yield "How did you decide on the retry policy for the payment consumers?";
    });
    const sessionUpdate = {};
    await runTurn(baseSession._id, { ...baseSession, ...inProgress(5) } as never, { kind: "text", text: "We retried." }, (e) => events.push(e), Date.now(), sessionUpdate);
    expect(order).toContain("emitted-before-rest:true");
    const sentences = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content);
    expect(sentences).toEqual(["Got it.", "How did you decide on the retry policy for the payment consumers?"]);
  });

  it("still regenerates a repeat after an acknowledgement, without saying the acknowledgement twice", async () => {
    const earlier = "You mentioned owning the cutover plan. Can you walk me through one specific decision you made?";
    store.transcripts = [
      { role: "ai", content: earlier },
      { role: "user", content: "Sure." },
    ];
    let call = 0;
    providers.tokens.mockImplementation(() =>
      call++ === 0 ? tokens(["Okay. ", earlier]) : tokens(["Got it. ", "Which metric told you the cutover actually worked?"]),
    );
    const { events } = await run({ kind: "text", text: "Another answer." }, inProgress(6));
    const sentences = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content);
    expect(sentences).toEqual(["Okay.", "Which metric told you the cutover actually worked?"]);
    expect(providers.calls).toHaveLength(2);
  });
});

describe("withoutLeadingAcknowledgement", () => {
  it("drops a second acknowledgement at the start of a regenerated draft", async () => {
    const { withoutLeadingAcknowledgement } = await import("@/server/turn");
    expect(withoutLeadingAcknowledgement("Okay, you're suggesting a token bucket in Redis.")).toBe("You're suggesting a token bucket in Redis.");
    expect(withoutLeadingAcknowledgement("Got it. What did you measure?")).toBe("What did you measure?");
    expect(withoutLeadingAcknowledgement("Okay so what happened next?")).toBe("Okay so what happened next?");
    expect(withoutLeadingAcknowledgement("Thanks to the outbox table, events were reliable.")).toBe("Thanks to the outbox table, events were reliable.");
    expect(withoutLeadingAcknowledgement("Go ahead and share that detail about the rollout.", "Go ahead.")).toBe("Share that detail about the rollout.");
    expect(withoutLeadingAcknowledgement("Go ahead.", "Go ahead.")).toBe("");
    expect(withoutLeadingAcknowledgement("Going further, what broke first?", "Go ahead.")).toBe("Going further, what broke first?");
  });

  it("does not repeat the acknowledgement in the next sentence of the same reply", async () => {
    store.transcripts = [{ role: "ai", content: "What happened during the rollout?" }];
    providers.tokens.mockImplementation(() => tokens(["Go ahead. ", "Go ahead and share that detail about the rollout. ", "What changed for merchants?"]));
    const { events } = await run({ kind: "text", text: "Sorry to interrupt, can I add one detail?" }, inProgress(8));
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content).join(" ");
    expect(spoken).toBe("Go ahead. Share that detail about the rollout. What changed for merchants?");
  });
});

describe("isAcknowledgement", () => {
  it("recognizes short neutral acknowledgements only", async () => {
    const { isAcknowledgement } = await import("@/server/turn");
    for (const text of ["Got it.", "Okay.", "No problem.", "Thanks, Jane.", "Sure!"]) expect(isAcknowledgement(text)).toBe(true);
    for (const text of ["Why Kafka?", "That makes sense for a payments ledger with retries.", "Okay so what"]) expect(isAcknowledgement(text)).toBe(false);
  });
});

describe("runTurn: ending and premature wrap-up", () => {
  it("closes the interview on an explicit end request", async () => {
    store.transcripts = [{ role: "ai", content: "Tell me about a conflict you resolved?" }];
    providers.tokens.mockImplementation(() => tokens(["Of course, Jane. Thanks for your time; the interview is complete. <<END>>"]));
    const { events, result } = await run({ kind: "text", text: "End interview." }, inProgress(6));
    expect(lastSystemPrompt()).toMatch(/Current section: closing/);
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
    expect(result.analysis).toBeNull(); // an end request is not an answer to analyze
  });

  it("does not treat a softer 'can we stop here?' as an end request", async () => {
    store.transcripts = [{ role: "ai", content: "How did you test it?" }];
    providers.tokens.mockImplementation(() => tokens(["You can press End interview any time. Shall we try one more question?"]));
    const { events } = await run({ kind: "text", text: "Can we just stop here? I'm kind of tired." }, inProgress(6));
    expect(lastSystemPrompt()).not.toMatch(/Current section: closing/);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("rejects wrap-up language before the wrap-up section and regenerates with time remaining", async () => {
    store.transcripts = [{ role: "ai", content: "Tell me about a hard trade-off?" }];
    let call = 0;
    providers.tokens.mockImplementation(() =>
      call++ === 0
        ? tokens(["We've reached the end of the behavioral section. You can now press End interview to get your report."])
        : tokens(["Got it. ", "What would you do differently if you faced that trade-off again?"]),
    );
    const { events } = await run({ kind: "text", text: "We chose consistency over speed." }, inProgress(10));
    expect(providers.calls).toHaveLength(2);
    expect(providers.calls[1][0].content).toMatch(/The interview is NOT over: about \d+ minutes remain/);
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content).join(" ");
    expect(spoken).toBe("Got it. What would you do differently if you faced that trade-off again?");
  });

  it("allows closing language during wrap-up", async () => {
    store.transcripts = [{ role: "ai", content: "Any questions for me?" }];
    providers.tokens.mockImplementation(() => tokens(["That concludes our interview, thank you Jane. <<END>>"]));
    const { events } = await run({ kind: "text", text: "No, thanks." }, inProgress(28));
    expect(providers.calls).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
  });

  it("rejects a goodbye in the middle of the interview and continues with a question", async () => {
    store.transcripts = [{ role: "ai", content: "How do you prioritize roadmap work?" }];
    let call = 0;
    providers.tokens.mockImplementation(() =>
      call++ === 0 ? tokens(["You're welcome. ", "Take care."]) : tokens(["Got it. ", "How did you decide what to cut when the deadline moved?"]),
    );
    const { events } = await run({ kind: "text", text: "Thanks, Aria. Take care!" }, inProgress(10));
    expect(providers.calls).toHaveLength(2);
    expect(providers.calls[1][0].content).toMatch(/The interview is NOT over/);
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content).join(" ");
    expect(spoken).toBe("You're welcome. How did you decide what to cut when the deadline moved?");
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("regenerates an empty draft mid-interview instead of failing the turn", async () => {
    store.transcripts = [{ role: "ai", content: "How do you prioritize roadmap work?" }];
    let call = 0;
    providers.tokens.mockImplementation(() => (call++ === 0 ? tokens(["<<END>>"]) : tokens(["Okay. ", "What signal told you the launch was working?"])));
    const { events } = await run({ kind: "text", text: "Thank you! Have a great day." }, inProgress(10));
    expect(providers.calls).toHaveLength(2);
    expect(providers.calls[1][0].content).toMatch(/your draft said nothing/);
    expect(types(events)).not.toContain("error");
    expect(events.at(-1)).toEqual({ type: "done" }); // an end marker before wrap-up never ends the interview
  });

  it("ignores an end marker before the wrap-up section", async () => {
    store.transcripts = [{ role: "ai", content: "How do you prioritize roadmap work?" }];
    providers.tokens.mockImplementation(() => tokens(["Understood, I appreciate you walking me through that process. <<END>>"]));
    const { events } = await run({ kind: "text", text: "We use RICE scoring." }, inProgress(10));
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("closes with a closing line when a wrap-up reply is only the end marker", async () => {
    store.transcripts = [{ role: "ai", content: "Any questions for me?" }];
    providers.tokens.mockImplementation(() => tokens(["<<END>>"]));
    const { events } = await run({ kind: "text", text: "No, thank you. Have a great day!" }, inProgress(28));
    expect(providers.calls).toHaveLength(1);
    expect(store.transcripts.at(-1)?.content).toBe(closingLine("Jane"));
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
  });

  it("does not acknowledge twice when a draft is regenerated after its acknowledgement was spoken", async () => {
    const earlier = "You mentioned owning the cutover plan. Can you walk me through one specific decision you made?";
    store.transcripts = [
      { role: "ai", content: earlier },
      { role: "user", content: "We used an outbox table." },
      { role: "ai", content: "How did you handle retries?" },
    ];
    let call = 0;
    providers.tokens.mockImplementation(() =>
      call++ === 0 ? tokens(["Okay. ", earlier]) : tokens(["Okay, you're suggesting idempotent consumers. ", "How did you test duplicate deliveries?"]),
    );
    const { events } = await run({ kind: "text", text: "Exponential backoff with a dead-letter queue." }, inProgress(6));
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content).join(" ");
    expect(spoken).toBe("Okay. You're suggesting idempotent consumers. How did you test duplicate deliveries?");
  });

  it("regenerates when a question repeats an earlier one after a different preamble", async () => {
    const earlier =
      "Got it. Thank you for walking me through your experience. We'll now shift to a different area: can you tell me about a time when you had to influence a decision without direct authority, and what approach you used to align stakeholders?";
    store.transcripts = [
      { role: "ai", content: earlier },
      { role: "user", content: "I ran a vision workshop with engineering and design." },
      { role: "ai", content: "What came out of that workshop?" },
    ];
    let call = 0;
    providers.tokens.mockImplementation(() =>
      call++ === 0
        ? tokens([
            "Thanks for that detail. ",
            "Okay, thank you for that example. ",
            "We'll now shift to a different area: can you tell me about a time when you had to influence a decision without direct authority, and what approach you used to align stakeholders?",
          ])
        : tokens(["How did you decide which merchant problems to fix first when engineering time was tight?"]),
    );
    const { events } = await run({ kind: "text", text: "We agreed on a phased rollout." }, inProgress(10));
    expect(providers.calls).toHaveLength(2);
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content).join(" ");
    expect(spoken).toBe("Thanks for that detail. How did you decide which merchant problems to fix first when engineering time was tight?");
  });

  it("never speaks a later sentence that wraps up early: the reply continues with a question instead", async () => {
    store.transcripts = [{ role: "ai", content: "Tell me about a project that didn't go as planned?" }];
    let call = 0;
    providers.tokens.mockImplementation(() =>
      call++ === 0
        ? tokens([
            "Thank you for sharing those examples about feedback, hiring and setbacks. ",
            "We've covered your on-call rotation and OKRs in good depth. ",
            "That's all the time we have for this section. ",
            "You can now press End interview to receive your report.",
          ])
        : tokens(["How do you decide when a struggling project should be paused rather than pushed through?"]),
    );
    const { events } = await run({ kind: "text", text: "Our inventory sync launch had a race condition." }, inProgress(10));
    expect(providers.calls).toHaveLength(2);
    expect(providers.calls[1][0].content).toMatch(/You have already said this aloud/);
    expect(providers.calls[1][0].content).toMatch(/The interview is NOT over/);
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content);
    expect(spoken).toEqual([
      "Thank you for sharing those examples about feedback, hiring and setbacks.",
      "We've covered your on-call rotation and OKRs in good depth.",
      "How do you decide when a struggling project should be paused rather than pushed through?",
    ]);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("replaces a later question that re-asks an earlier one", async () => {
    store.transcripts = [
      { role: "ai", content: "Can you tell me about a time when you had to influence a decision without direct authority, and what approach you used?" },
      { role: "user", content: "I built a prototype to win over the engineering lead." },
      { role: "ai", content: "What did the prototype show?" },
    ];
    let call = 0;
    providers.tokens.mockImplementation(() =>
      call++ === 0
        ? tokens([
            "That prototype sounds like it made the trade-off concrete for the whole team. ",
            "Can you tell me about a time when you had to influence a decision without direct authority, and what approach you used?",
          ])
        : tokens(["What would you do differently the next time several teams disagree on priorities?"]),
    );
    const { events } = await run({ kind: "text", text: "It cut onboarding time by thirty percent." }, inProgress(10));
    expect(providers.calls).toHaveLength(2);
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content);
    expect(spoken).toEqual([
      "That prototype sounds like it made the trade-off concrete for the whole team.",
      "What would you do differently the next time several teams disagree on priorities?",
    ]);
  });

  it("on the last attempt, simply stops before a sentence that wraps up early", async () => {
    store.transcripts = [{ role: "ai", content: "How do you mentor engineers?" }];
    const drafts = [
      ["We covered your migration work and the ledger design choices in real detail. ", "That's all the time we have for this section."],
      ["Let's look at another part of your experience with payment systems for a moment. ", "That's all the time we have."],
      ["One more area I'd like to explore is how you grow the engineers on your team. ", "That concludes our interview."],
    ];
    let call = 0;
    providers.tokens.mockImplementation(() => tokens(drafts[Math.min(call++, 2)]));
    const { events } = await run({ kind: "text", text: "Pairing and design reviews." }, inProgress(10));
    expect(providers.calls).toHaveLength(3);
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content).join(" ");
    expect(spoken).not.toMatch(/all the time we have|concludes/i);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("never ends the interview on a question: a question in the closing turn is replaced by a closing line", async () => {
    store.transcripts = [{ role: "ai", content: "How would you handle duplicates?" }];
    providers.tokens.mockImplementation(() => tokens(["I see you cache results by request id. ", "Could you explain how the lock is released?"]));
    const { events } = await run({ kind: "text", text: "I added a lock around the cache." }, inProgress(33));
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content);
    expect(spoken).toEqual([
      "I see you cache results by request id.",
      "Thank you, Jane. That completes our interview, and your feedback report is ready for you now.",
    ]);
    expect(events.filter((e) => e.type === "audio")).toHaveLength(2);
    expect(store.transcripts.at(-1)?.content).toBe(spoken.join(" "));
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
  });

  it("still closes the interview when generation fails on the closing turn", async () => {
    store.transcripts = [{ role: "ai", content: "Last thing?" }];
    providers.tokens.mockImplementation(async function* () {
      throw new LlmError("nvidia 503");
    });
    const { events } = await run({ kind: "text", text: "Here's my answer." }, inProgress(33));
    expect(types(events)).not.toContain("error");
    expect(store.transcripts.at(-1)).toEqual({ role: "ai", content: closingLine("Jane Doe") });
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
  });

  it("speaks a closing line when the closing reply is only the end marker", async () => {
    store.transcripts = [{ role: "ai", content: "Press End interview at any time to get your feedback report." }];
    providers.tokens.mockImplementation(() => tokens(["<<END>>"]));
    const { events } = await run({ kind: "text", text: "Thank you for the time. I'll end the interview now." }, inProgress(9));
    expect(types(events)).not.toContain("error");
    expect(store.transcripts.at(-1)?.content).toBe(closingLine("Jane"));
    expect(events.at(-1)).toEqual({ type: "done", limit_reached: true });
  });

  it("keeps a closing reply that already ends the interview as is", async () => {
    store.transcripts = [{ role: "ai", content: "Last thing?" }];
    providers.tokens.mockImplementation(() => tokens(["Thanks, Jane, we're out of time and the interview is complete."]));
    const { events } = await run({ kind: "text", text: "Here's my answer." }, inProgress(33));
    const spoken = events.filter((e) => e.type === "ai_sentence").map((e) => (e as { content: string }).content);
    expect(spoken).toEqual(["Thanks, Jane, we're out of time and the interview is complete."]);
  });

  it("does not end on an end marker that follows a question", async () => {
    store.transcripts = [{ role: "ai", content: "What would you improve?" }];
    providers.tokens.mockImplementation(() => tokens(["Got it. Do you have any questions for me? <<END>>"]));
    const { events } = await run({ kind: "text", text: "Better monitoring." }, inProgress(28));
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});
