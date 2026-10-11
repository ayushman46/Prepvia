import { afterEach, describe, expect, it, vi } from "vitest";
import { readNdjson } from "@/lib/api";
import { encodeWav } from "@/lib/wav";
import { buildReportMessages, normalizeReport, summarizeIntegrity, toFivePoint } from "@/server/report";
import { isPdf, normalizeResumeText } from "@/server/resume";
import { __resetSttStateForTests, cleanTranscript, SttError, sttKeyState, transcribeAudio, validateWav } from "@/server/stt";
import { escapeXml, generateSecMsGec } from "@/server/tts";

async function wavBytes(seconds: number): Promise<Uint8Array> {
  const blob = encodeWav(new Float32Array(Math.round(16_000 * seconds)).fill(0.1));
  return new Uint8Array(await blob.arrayBuffer());
}

describe("WAV handling", () => {
  it("encodes a valid 16 kHz mono PCM header", async () => {
    const bytes = await wavBytes(1);
    const view = new DataView(bytes.buffer);
    expect(Buffer.from(bytes.subarray(0, 4)).toString()).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(validateWav(bytes)).toBeCloseTo(1, 2);
  });

  it("rejects non-WAV payloads", () => {
    expect(() => validateWav(new Uint8Array(100))).toThrow(/WAV/);
    expect(() => validateWav(new Uint8Array(10))).toThrow(/too short/);
  });
});

describe("transcript cleanup", () => {
  it("drops common Whisper silence hallucinations", () => {
    expect(cleanTranscript(" Thank you. ")).toBe("");
    expect(cleanTranscript("Thanks for watching!")).toBe("");
    expect(cleanTranscript("I built a cache layer.")).toBe("I built a cache layer.");
  });

  it("drops noise transcribed as stock phrases, sound tags or repeats, but keeps short real answers", () => {
    for (const noise of ["Thank you. Thank you.", "[Music]", "♪ ♪", "Thanks.", "Thank you so much!", "(applause)", "Bye bye.", "Hmm."]) {
      expect(cleanTranscript(noise)).toBe("");
    }
    for (const answer of ["Yes.", "No.", "Okay.", "Yeah, I did.", "Thank you, that was my first project."]) {
      expect(cleanTranscript(answer)).toBe(answer);
    }
  });

  it("drops segments that are probably silence", () => {
    expect(
      cleanTranscript("ignored", [
        { text: " I led the migration.", no_speech_prob: 0.01, avg_logprob: -0.2 },
        { text: " Thank you.", no_speech_prob: 0.9, avg_logprob: -1.2 },
      ]),
    ).toBe("I led the migration.");
  });
});

describe("transcribeAudio", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.unstubAllGlobals();
    __resetSttStateForTests();
  });

  it("sends verbose_json requests to Groq and returns cleaned text", async () => {
    process.env.GROQ_API_KEY = "gq";
    const fetchMock = vi.fn(async () => Response.json({ text: " Hello there ", segments: [{ text: " Hello there", no_speech_prob: 0 }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await transcribeAudio(await wavBytes(1))).toBe("Hello there");
    const form = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("response_format")).toBe("verbose_json");
  });

  it("skips the API for clips shorter than a quarter second", async () => {
    process.env.GROQ_API_KEY = "gq";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await transcribeAudio(await wavBytes(0.1))).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries once on a server error", async () => {
    process.env.GROQ_API_KEY = "gq";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ text: "Recovered" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await transcribeAudio(await wavBytes(1))).toBe("Recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("remembers an invalid key and stops calling Groq", async () => {
    process.env.GROQ_API_KEY = "revoked";
    const fetchMock = vi.fn(async () => new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(await wavBytes(1))).rejects.toMatchObject({ reason: "invalid_key", retryable: false });
    await expect(transcribeAudio(await wavBytes(1))).rejects.toMatchObject({ reason: "invalid_key" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry, and no call while the key is known bad
  });

  it("does not retry a rate limit and honours Retry-After", async () => {
    process.env.GROQ_API_KEY = "gq";
    const fetchMock = vi.fn(async () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }));
    vi.stubGlobal("fetch", fetchMock);
    const error = (await transcribeAudio(await wavBytes(1)).catch((e) => e)) as SttError;
    expect(error).toMatchObject({ reason: "rate_limited", retryAfterMs: 3_000 });
    await expect(transcribeAudio(await wavBytes(1))).rejects.toMatchObject({ reason: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a clip Groq can't decode as nothing heard, but not a rejected model", async () => {
    process.env.GROQ_API_KEY = "gq";
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"could not process file - is it a valid media file?"}}', { status: 400 })));
    expect(await transcribeAudio(await wavBytes(1))).toBe("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"The model `whisper-x` has been decommissioned","code":"model_decommissioned"}}', { status: 400 })));
    await expect(transcribeAudio(await wavBytes(1))).rejects.toMatchObject({ reason: "model", retryable: false });
  });

  it("reports a missing key as not configured", async () => {
    delete process.env.GROQ_API_KEY;
    await expect(transcribeAudio(await wavBytes(1))).rejects.toMatchObject({ reason: "not_configured", retryable: false });
  });

  it("lets speculative calls yield once the per-key request budget is nearly used", async () => {
    process.env.GROQ_API_KEY = "gq";
    const fetchMock = vi.fn(async () => Response.json({ text: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const audio = await wavBytes(1);
    for (let i = 0; i < 16; i++) await transcribeAudio(audio, { speculative: true });
    await expect(transcribeAudio(audio, { speculative: true })).rejects.toMatchObject({ reason: "rate_limited" });
    expect(await transcribeAudio(audio)).toBe("ok"); // a real turn still goes through
    expect(fetchMock).toHaveBeenCalledTimes(17);
  });
});

describe("sttKeyState", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.unstubAllGlobals();
    __resetSttStateForTests();
  });

  it("checks the key against Groq once and caches the answer", async () => {
    process.env.GROQ_API_KEY = "gq";
    const fetchMock = vi.fn(async () => Response.json({ data: [{ id: "whisper-large-v3-turbo" }] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sttKeyState()).toBe("ok");
    expect(await sttKeyState()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://api.groq.com/openai/v1/models");
  });

  it("reports an invalid key, a missing model and a missing key", async () => {
    process.env.GROQ_API_KEY = "revoked";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    expect(await sttKeyState()).toBe("invalid_key");
    __resetSttStateForTests();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "some-other-model" }] })));
    expect(await sttKeyState()).toBe("model_unavailable");
    delete process.env.GROQ_API_KEY;
    expect(await sttKeyState()).toBe("not_configured");
  });
});

describe("Edge TTS protocol", () => {
  it("generates the same Sec-MS-GEC token as the edge-tts Python package", () => {
    // Reference values computed with edge_tts.drm.DRM.generate_sec_ms_gec() logic.
    expect(generateSecMsGec(1760000000123)).toBe("70AED27457006C255086B4F079B9FE44A4D10827C4AFDFC3C45583B6F40D7DDF");
    expect(generateSecMsGec(1791234567900)).toBe("E265E621E83B11D19D95EF3FACC0233BA5D887285314288AC18C8C2362E86857");
  });

  it("escapes XML and strips control characters", () => {
    expect(escapeXml(`Tom & "Jerry" <b>'s\u000b`)).toBe("Tom &amp; &quot;Jerry&quot; &lt;b&gt;&apos;s ");
  });
});

describe("resume parsing helpers", () => {
  it("detects PDF magic bytes", () => {
    expect(isPdf(new TextEncoder().encode("%PDF-1.7 ..."))).toBe(true);
    expect(isPdf(new TextEncoder().encode("hello"))).toBe(false);
  });

  it("normalizes whitespace", () => {
    expect(normalizeResumeText("  Jane   Doe \n\n\n\n Engineer\u0000 ")).toBe("Jane Doe\n\nEngineer");
  });
});

describe("normalizeReport", () => {
  it("normalizes a Chakra-style scorecard on a 1-5 rubric", () => {
    const report = normalizeReport({
      score: 140,
      summary: " Solid. ",
      strengths: ["Clear", "", 3],
      improvements: "not a list",
      competency_scores: [
        { name: "Communication", score: 4.2, rationale: "Structured answers", confidence: 2, evidence: ["e"] },
        { name: "Depth", score: "3" },
        { score: 5 },
      ],
      question_feedback: [{ question: "Q1", answer_summary: "A1", rating: 4, feedback: "good", tip: "add metrics" }, { rating: 3 }],
      hands_on: { summary: "Working solution", rating: 3.5, strengths: ["tests"], gaps: ["edge cases"] },
      evidence: [{ type: "strength", statement: "Explained trade-offs" }, { statement: "" }],
    });
    expect(report.score).toBe(100);
    expect(report.summary).toBe("Solid.");
    expect(report.strengths).toEqual(["Clear", "3"]);
    expect(report.improvements).toEqual([]);
    expect(report.competency_scores.map((c) => [c.name, c.score, c.confidence, c.rationale])).toEqual([
      ["Communication", 4.2, 1, "Structured answers"],
      ["Depth", 3, null, ""],
    ]);
    expect(report.question_feedback).toEqual([{ question: "Q1", answer_summary: "A1", rating: 4, feedback: "good", tip: "add metrics" }]);
    expect(report.hands_on).toEqual({ summary: "Working solution", rating: 3.5, strengths: ["tests"], gaps: ["edge cases"] });
    expect(report.evidence).toEqual([{ type: "strength", statement: "Explained trade-offs" }]);
  });

  it("converts legacy 0-100 and 0-10 competency scales to the 1-5 rubric", () => {
    expect(normalizeReport({ competency_scores: [{ name: "A", score: 80 }, { name: "B", score: 45 }] }).competency_scores.map((c) => c.score)).toEqual([4, 2.3]);
    expect(normalizeReport({ competency_scores: [{ name: "A", score: 8 }, { name: "B", score: 3 }] }).competency_scores.map((c) => c.score)).toEqual([4, 1.5]);
    expect(toFivePoint(0)).toBe(1);
    expect(toFivePoint("4.44")).toBe(4.4);
    expect(toFivePoint("n/a")).toBeNull();
  });

  it("summarizes integrity signals deterministically", () => {
    const at = new Date();
    const summary = summarizeIntegrity([
      { type: "tab_hidden", at },
      { type: "tab_hidden", at },
      { type: "large_paste", at },
      { type: "window_blur", at },
    ]);
    expect(summary).toEqual({
      tab_hidden: 2,
      window_blur: 1,
      large_paste: 1,
      notes: ["Left the interview tab 2 times.", "Pasted large blocks of text 1 time."],
    });
  });

  it("gives the scoring model the whole transcript, not just the recent window", () => {
    const transcripts = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "user" : "ai") as "user" | "ai", content: `message ${i}` }));
    const messages = buildReportMessages(
      { candidate_name: "Jane", target_role: "SRE", resume_text: "", job_description: "", status: "active" } as never,
      transcripts,
      summarizeIntegrity([]),
    );
    const transcriptSection = messages.find((m) => m.content.startsWith("<TRANSCRIPT>"))!.content;
    expect(transcriptSection).toContain("message 0");
    expect(transcriptSection).toContain("message 29");
    expect(messages.at(-1)?.content).toMatch(/scorecard/);
  });
});

describe("readNdjson", () => {
  it("reassembles events split across arbitrary chunk boundaries", async () => {
    const text = '{"type":"ai_start"}\n{"type":"ai_sentence","seq":1,"content":"Hi."}\n{"type":"done"}';
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < text.length; i += 7) controller.enqueue(encoder.encode(text.slice(i, i + 7)));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readNdjson<{ type: string }>(stream)) events.push(event.type);
    expect(events).toEqual(["ai_start", "ai_sentence", "done"]);
  });
});

describe("withoutUnassessedHandsOn", () => {
  it("drops hands-on scores when no exercise happened, keeps them otherwise", async () => {
    const { withoutUnassessedHandsOn } = await import("@/server/report");
    const report = normalizeReport({
      competency_scores: [
        { name: "Communication", score: 4 },
        { name: "Hands-on execution", score: 1 },
        { name: "Problem Solving / Coding", score: 1.5 },
      ],
      hands_on: { summary: "Did not attempt", rating: 1 },
    });
    const filtered = withoutUnassessedHandsOn(report, false);
    expect(filtered.competency_scores.map((c) => c.name)).toEqual(["Communication"]);
    expect(filtered.hands_on).toBeNull();
    expect(withoutUnassessedHandsOn(report, true).competency_scores).toHaveLength(3);
  });
});
