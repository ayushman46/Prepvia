import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, TranscriptEntry } from "@/server/interview-context";
import type { CompletionOptions, CompletionResult } from "@/server/llm";
import type { EvaluationClaim, EvaluationDoc } from "@/server/sessions";

// In-memory stand-ins for MongoDB and the model, so the generation state machine runs for real.
const db = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  transcripts: [] as { role: "user" | "ai"; content: string }[],
  evaluation: null as Record<string, unknown> | null,
  completed: 0,
  onSessionRead: null as null | ((reads: number) => void),
  sessionReads: 0,
  tick: 0,
}));

vi.mock("@/server/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/sessions")>();
  const now = () => new Date(Date.now() + db.tick++);
  return {
    ...actual,
    requireSession: vi.fn(async () => {
      db.sessionReads += 1;
      db.onSessionRead?.(db.sessionReads);
      return structuredClone(db.session);
    }),
    getEvaluation: vi.fn(async () => (db.evaluation ? { ...db.evaluation } : null)),
    countAnswers: vi.fn(async () => db.transcripts.filter((t) => t.role === "user").length),
    getTranscripts: vi.fn(async () => db.transcripts.map((t) => ({ ...t }))),
    lastTranscriptAt: vi.fn(async () => null),
    markCompleted: vi.fn(async () => {
      db.completed += 1;
      if (db.session) db.session.status = "completed";
    }),
    claimEvaluation: vi.fn(async (_id: string, claim: EvaluationClaim) => {
      const doc = db.evaluation;
      const at = now();
      if (claim.mode === "new") {
        if (doc) return null;
        db.evaluation = { session_id: "s1", status: "generating", started_at: at, attempts: 1 };
        return at;
      }
      const expected = { takeover: "generating", retry: "failed", regenerate: "ready" }[claim.mode];
      if (doc?.status !== expected) return null;
      const reset = claim.mode === "regenerate" || (claim.mode === "retry" && claim.resetAttempts);
      db.evaluation = { ...doc, status: "generating", started_at: at, attempts: reset ? 1 : Number(doc.attempts ?? 1) + 1 };
      return at;
    }),
    saveEvaluation: vi.fn(async (_id: string, data: Record<string, unknown>) => {
      db.evaluation = { ...data, session_id: "s1", status: "ready", created_at: now() };
    }),
    failEvaluation: vi.fn(async (_id: string, startedAt: Date, failure: { code: string; retryable: boolean; retryAt: Date }) => {
      const doc = db.evaluation;
      if (doc?.status !== "generating" || (doc.started_at as Date).getTime() !== startedAt.getTime()) return;
      db.evaluation = { ...doc, status: "failed", error_code: failure.code, retryable: failure.retryable, failed_at: now(), retry_at: failure.retryAt };
    }),
  };
});

const model = vi.hoisted(() => ({
  report: [] as (CompletionResult | Error)[],
  verify: { text: '{"remove": []}', finishReason: "stop" } as CompletionResult,
  calls: [] as { messages: ChatMessage[]; options: CompletionOptions }[],
}));

vi.mock("@/server/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/llm")>();
  return {
    ...actual,
    completeWithDetails: vi.fn(async (messages: ChatMessage[], _purpose: string, options: CompletionOptions = {}) => {
      model.calls.push({ messages, options });
      if (messages[0].content.startsWith("You are double-checking")) return model.verify;
      const next = model.report.shift();
      if (!next) throw new Error("no scripted report response");
      if (next instanceof Error) throw next;
      return next;
    }),
  };
});

const report = await import("@/server/report");
const { LlmError } = await import("@/server/llm");
const { canvasWorkSubmitted } = await import("@/server/interview-context");
const format = await import("@/components/report/report-format");

const {
  applyHandsOnGuards,
  applyVerification,
  buildReportMessages,
  checkQuotes,
  competencyBasedScore,
  decideReportAction,
  draftReport,
  evidenceIndex,
  finalizeReport,
  getReport,
  interviewFacts,
  isCandidateQuote,
  isCodeQuote,
  isStaleReport,
  listItemText,
  majorityScale,
  mergeHandsOnCompetencies,
  normalizeOverallScore,
  normalizeReport,
  parseReportOutput,
  summarizeIntegrity,
  toFivePoint,
  turnLockHeld,
  verifyReportEvidence,
  withoutExecutionClaims,
  withoutUnassessedHandsOn,
} = report;

type Ready = ReturnType<typeof normalizeReport>;

const TRANSCRIPT: TranscriptEntry[] = [
  { role: "ai", content: "Tell me about a project you're proud of." }, // #1
  { role: "user", content: "I built a payments API in Go, and we cut p99 latency by 40% using idempotency keys." }, // #2
  { role: "ai", content: "How did you guarantee exactly-once delivery?" }, // #3
  { role: "user", content: "Honestly, I've never done that at scale. We relied on Kafka retries and a dedupe table." }, // #4
  { role: "ai", content: "Walk me through the charge function in the canvas." }, // #5
  { role: "user", content: "It checks whether the request id was seen before and returns the stored result." }, // #6
];
const WORK = "def charge(request_id, amount):\n    if request_id in seen:\n        return seen[request_id]\n    seen[request_id] = pay(amount)";

function ready(overrides: Partial<Ready> = {}): Ready {
  return { ...normalizeReport({ score: 60, summary: "S" }), ...overrides };
}

function competency(name: string, score: number | null, extra: Record<string, unknown> = {}) {
  return {
    name,
    score,
    rationale: "r",
    confidence: 0.8,
    evidence: ["e [#2]"],
    positive_signals: [],
    negative_signals: [],
    ...extra,
  } as Ready["competency_scores"][number];
}

function ctx(overrides: Partial<Parameters<typeof finalizeReport>[2]> = {}): Parameters<typeof finalizeReport>[2] {
  return {
    plan: { duration_minutes: 30, interview_type: "technical", level: "mid", canvas_enabled: true },
    integrity: summarizeIntegrity([]),
    exerciseHappened: false,
    workSubmitted: null,
    facts: interviewFacts({}, TRANSCRIPT),
    index: evidenceIndex(TRANSCRIPT, ""),
    ...overrides,
  };
}

// ------------------------------------------------------------------ scales

describe("score normalization", () => {
  it("detects the scale per competency, so one out-of-scale score doesn't drag the rest to 1.0", () => {
    const scores = (values: unknown[]) =>
      normalizeReport({ competency_scores: values.map((score, i) => ({ name: `C${i}`, score })) }).competency_scores.map((c) => c.score);
    expect(scores([4, 3.5, 75])).toEqual([4, 3.5, 3.8]);
    expect(scores([80, 45, 4])).toEqual([4, 2.3, 1]); // a 0-100 majority: 4 is 4/100
    expect(majorityScale([4, 3.5, 75])).toBeUndefined();
    expect(majorityScale([8, 7, 3])).toBe("ten");
    expect(toFivePoint(8, "hundred")).toBe(1);
    expect(toFivePoint(75, "ten")).toBe(3.8); // a hint never lowers a value's own scale
  });

  it("maps the competency mean to 0-100 so the bands match the rubric", () => {
    expect(competencyBasedScore([3, 3])).toBe(50); // meets the bar
    expect(competencyBasedScore([4, 4])).toBe(75); // strong
    expect(competencyBasedScore([3, 4])).toBe(63);
    expect(competencyBasedScore([null])).toBeNull();
  });

  it("ties the overall score to within 8 points of the competency score", () => {
    expect(normalizeOverallScore(90, [3, 4])).toBe(71);
    expect(normalizeOverallScore(30, [3, 4])).toBe(55);
    expect(normalizeOverallScore(60, [3, 4])).toBe(60);
    expect(normalizeOverallScore(undefined, [5, 5])).toBe(100);
  });

  it("converts overall-score scale slips before tying", () => {
    expect(normalizeOverallScore(4, [4, 4])).toBe(75); // 4 on the 1-5 rubric
    expect(normalizeOverallScore(7, [3, 4])).toBe(70); // 7 out of 10
    expect(normalizeOverallScore(72, [])).toBe(72); // nothing to tie to
    expect(normalizeOverallScore("n/a", [])).toBe(0);
  });
});

// ------------------------------------------------------------ list items

describe("list item text", () => {
  it("extracts a sensible text field from object items instead of raw JSON", () => {
    expect(listItemText({ area: "Testing", detail: "Add integration tests" })).toBe("Testing: Add integration tests");
    expect(listItemText({ title: "Metrics", description: "Metrics were missing" })).toBe("Metrics were missing");
    expect(listItemText({ text: "Clear structure" })).toBe("Clear structure");
    expect(listItemText({ weight: 2, note: "Fallback string" })).toBe("Fallback string");
    expect(listItemText([1, 2])).toBe("");
    expect(listItemText(3)).toBe("3");
    const normalized = normalizeReport({ strengths: [{ point: "Owns outcomes" }, "Owns outcomes", { nothing: 1 }], summary: "x" });
    expect(normalized.strengths).toEqual(["Owns outcomes"]);
    expect(JSON.stringify(normalized)).not.toContain('{\\"');
  });

  it("accepts competencies as a name-keyed map", () => {
    const normalized = normalizeReport({ competency_scores: { Communication: { score: 4, rationale: "clear" }, Depth: 3 } });
    expect(normalized.competency_scores.map((c) => [c.name, c.score])).toEqual([
      ["Communication", 4],
      ["Depth", 3],
    ]);
  });
});

// ------------------------------------------------------------- truncation

describe("parseReportOutput", () => {
  const complete = JSON.stringify({
    score: 60,
    summary: "You did well [#2].",
    strengths: [],
    improvements: [],
    competency_scores: [{ name: "Communication", score: 3 }],
    question_feedback: [],
  });

  it("accepts a complete report", () => {
    expect(parseReportOutput({ text: complete, finishReason: "stop" }).ok).toBe(true);
    expect(parseReportOutput({ text: complete, finishReason: null }).ok).toBe(true);
  });

  it("rejects output cut off by max_tokens even when repairJson could close it", () => {
    expect(parseReportOutput({ text: complete, finishReason: "length" })).toEqual({ ok: false, reason: "truncated" });
    const cut = complete.slice(0, complete.indexOf('"question_feedback"') + 10);
    expect(parseReportOutput({ text: cut, finishReason: null })).toEqual({ ok: false, reason: "incomplete" });
  });

  it("requires every essential key and at least one named competency", () => {
    expect(parseReportOutput({ text: '{"score": 80, "competency_scores": [{"name": "A", "score": 4}]}', finishReason: "stop" })).toEqual({
      ok: false,
      reason: "incomplete",
    });
    const noCompetencies = complete.replace('[{"name":"Communication","score":3}]', "[]");
    expect(parseReportOutput({ text: noCompetencies, finishReason: "stop" })).toEqual({ ok: false, reason: "incomplete" });
    expect(parseReportOutput({ text: "I can't do that.", finishReason: "stop" })).toEqual({ ok: false, reason: "invalid_json" });
  });
});

// ----------------------------------------------------------- starter code

describe("canvas starter code", () => {
  const task = { title: "Idempotent charge", instructions: "Implement charge()", language: "python", starter_code: "def charge(request_id, amount):\n    pass\n", focus: [] };

  it("treats untouched (whitespace-insensitive) starter code or an empty editor as no work", () => {
    expect(canvasWorkSubmitted("def charge(request_id,amount):\n  pass", task.starter_code)).toBe(false);
    expect(canvasWorkSubmitted("   ", task.starter_code)).toBe(false);
    expect(canvasWorkSubmitted("def charge(request_id, amount):\n    return seen.get(request_id)", task.starter_code)).toBe(true);
  });

  it("passes the starter code separately and never as the candidate's work", () => {
    const session = {
      candidate_name: "Jane",
      target_role: "SRE",
      resume_text: "",
      job_description: "",
      canvas: { task, content: task.starter_code, introduced_at: new Date() },
    };
    const messages = buildReportMessages(session as never, TRANSCRIPT, summarizeIntegrity([]));
    const canvas = JSON.parse(messages.find((m) => m.content.startsWith("<CANVAS>"))!.content.replace(/^<CANVAS>\n|\n<\/CANVAS>$/g, ""));
    expect(canvas).toMatchObject({ work_status: "no_work_submitted", candidate_work: "", starter_code: task.starter_code.trim() });
    expect(messages[0].content).toMatch(/starter_code came with the exercise/);
  });
});

// ------------------------------------------------------------- the prompt

describe("buildReportMessages", () => {
  it("numbers transcript entries, keeps full typed answers and states the interview length", () => {
    const long = "word ".repeat(780).trim(); // ~3,900 characters: under LIMITS.answerChars
    const transcripts: TranscriptEntry[] = [...TRANSCRIPT, { role: "user", content: long }];
    const session = { candidate_name: "Jane", target_role: "SRE", resume_text: "", job_description: "", duration_minutes: 30 };
    const messages = buildReportMessages(session as never, transcripts, summarizeIntegrity([]));
    const body = (name: string) => JSON.parse(messages.find((m) => m.content.startsWith(`<${name}>`))!.content.split("\n").slice(1, -1).join("\n"));
    const entries = body("TRANSCRIPT");
    expect(entries[1]).toEqual({ n: 2, role: "candidate", content: TRANSCRIPT[1].content });
    expect(entries.at(-1)).toEqual({ n: 7, role: "candidate", content: long });
    expect(body("INTERVIEW").interview_length).toMatchObject({ candidate_answers: 4, substantive_answers: 4, limited_evidence: false });
    expect(body("ANALYST_NOTES").score_scale).toMatch(/0-100/);
    expect(messages[0].content).toMatch(/\[#n\]/);
  });

  it("flags short interviews as limited evidence", () => {
    const facts = interviewFacts({ started_at: new Date(0), duration_minutes: 30 }, [{ role: "user", content: "Short." }], new Date(4 * 60_000));
    expect(facts).toMatchObject({ answers: 1, substantive: 0, minutes: 4, endedEarly: true, limitedEvidence: true });
  });
});

// -------------------------------------------------------- quote checking

describe("quote and citation verification", () => {
  const index = evidenceIndex(TRANSCRIPT, WORK);

  it("accepts the candidate's words regardless of case, punctuation and elisions", () => {
    expect(isCandidateQuote("We cut p99 latency by 40%", index)).toBe(true);
    expect(isCandidateQuote("I built a payments API ... idempotency keys", index)).toBe(true);
    expect(isCandidateQuote("I've never done that", index)).toBe(true);
  });

  it("rejects paraphrases, and words only the interviewer said", () => {
    expect(isCandidateQuote("cut latency by 40%", index)).toBe(false);
    expect(isCandidateQuote("guarantee exactly-once delivery", index)).toBe(false);
    expect(isCandidateQuote("payments API", { ...index, answers: [] })).toBe(false);
  });

  it("matches code quotes against the canvas work", () => {
    expect(isCodeQuote("if request_id in seen:", index)).toBe(true);
    expect(isCodeQuote("with_for_update()", index)).toBe(false);
    expect(isCodeQuote("seen", evidenceIndex(TRANSCRIPT, ""))).toBe(false);
  });

  it("turns failing quotes into paraphrases", () => {
    const checked = checkQuotes('You said "we guaranteed exactly-once delivery" and "we cut p99 latency by 40%" [#2]', index);
    expect(checked.text).toBe('You said we guaranteed exactly-once delivery and "we cut p99 latency by 40%" [#2]');
    expect(checked.failures).toHaveLength(1);
  });

  it("drops prose sentences that put unsaid words in the candidate's mouth, keeping the rest", () => {
    const draft = ready({
      competency_scores: [competency("Communication", 3, { rationale: 'Clear answers [#2]. You said "we always use an outbox" [#4]. Good pacing.' })],
      improvements: ['Say "I led the rollout" instead of "we" when it was you [#2]'],
    });
    const { report: verified } = verifyReportEvidence(draft, index);
    expect(verified.competency_scores[0].rationale).toBe("Clear answers [#2]. Good pacing.");
    // Advice may quote suggested wording: it only loses the quote marks.
    expect(verified.improvements).toEqual(['Say I led the rollout instead of "we" when it was you [#2]']);
  });

  it("drops fabricated or misattributed claims and keeps verified ones", () => {
    const draft = ready({
      summary: 'You said "we always use an outbox" [#2, #99].',
      strengths: ["Framed the problem well [#1]", "Owned the payments API [#2]"],
      competency_scores: [
        competency("Technical depth", 3, {
          rationale: 'You said "we always use an outbox" [#2, #99]',
          evidence: ['"I built a payments API in Go" [#2]', '"We guaranteed exactly-once delivery everywhere" [#4]'],
          positive_signals: ["Clear question framing [#3]", "Used idempotency keys [#2]"],
          negative_signals: ['Admitted "I\'ve never done that at scale" [#4]'],
        }),
      ],
      question_feedback: [
        { question: "Candidate line", question_turn: 2, answer_turns: [], answer_summary: "", rating: 3, technical_issues: [], feedback: "", tip: "" },
        { question: "Exactly-once?", question_turn: 3, answer_turns: [4, 3], answer_summary: "Relied on retries", rating: 2, technical_issues: [], feedback: "", tip: "" },
        { question: "Again", question_turn: 3, answer_turns: [4], answer_summary: "", rating: 2, technical_issues: [], feedback: "", tip: "" },
      ],
      hands_on: {
        summary: "Uses `with_for_update()` for locking",
        rating: 3,
        strengths: ["Locks rows with `with_for_update()`", "Checks `request_id in seen` first [#6]"],
        gaps: [],
      },
    });
    const { report: verified, removed } = verifyReportEvidence(draft, index);
    expect(verified.summary).toBe("You said we always use an outbox [#2].");
    expect(verified.strengths).toEqual(["Owned the payments API [#2]"]);
    const c = verified.competency_scores[0];
    expect(c.evidence).toEqual(['"I built a payments API in Go" [#2]']);
    expect(c.positive_signals).toEqual(["Used idempotency keys [#2]"]);
    expect(c.negative_signals).toHaveLength(1);
    expect(verified.question_feedback.map((q) => [q.question, q.answer_turns])).toEqual([["Exactly-once?", [4]]]);
    expect(verified.hands_on?.summary).toBe("Uses with_for_update() for locking");
    expect(verified.hands_on?.strengths).toEqual(["Checks `request_id in seen` first [#6]"]);
    expect(removed).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------- hands-on

describe("hands-on guards", () => {
  it("keeps legitimate 'Execution' and 'Implementation planning' competencies without an exercise", () => {
    const filtered = withoutUnassessedHandsOn(
      ready({
        competency_scores: [
          competency("Execution", 4),
          competency("Implementation planning", 3),
          competency("Hands-on coding", 2),
          competency("Live coding", 2),
        ],
        hands_on: { summary: "x", rating: 2, strengths: [], gaps: [] },
      }),
      false,
    );
    expect(filtered.competency_scores.map((c) => c.name)).toEqual(["Execution", "Implementation planning"]);
    expect(filtered.hands_on).toBeNull();
  });

  it("merges hands-on competencies into one when an exercise happened", () => {
    const merged = mergeHandsOnCompetencies(
      [competency("Hands-on execution", 4, { confidence: 0.9 }), competency("Communication", 4), competency("Implementation", 3, { confidence: 0.6 })],
      true,
    );
    expect(merged.map((c) => [c.name, c.score, c.confidence])).toEqual([
      ["Hands-on execution", 3.5, 0.6],
      ["Communication", 4, 0.8],
    ]);
  });

  it("caps an un-critiqued rating at 4 and keeps the section within 0.5 of its competency", () => {
    const guarded = applyHandsOnGuards(
      ready({ competency_scores: [competency("Hands-on execution", 3)], hands_on: { summary: "ok", rating: 4.8, strengths: [], gaps: [] } }),
      true,
      true,
    );
    expect(guarded.hands_on?.rating).toBe(3.5);
    const higherCompetency = applyHandsOnGuards(
      ready({ competency_scores: [competency("Coding", 4.6)], hands_on: { summary: "ok", rating: 3, strengths: [], gaps: ["no tests"] } }),
      true,
      true,
    );
    expect(higherCompetency.competency_scores[0].score).toBe(3.5);
    expect(higherCompetency.hands_on?.rating).toBe(3);
  });

  it("rates untouched starter code 2 at most", () => {
    const guarded = applyHandsOnGuards(
      ready({ competency_scores: [competency("Hands-on execution", 3.5)], hands_on: { summary: "ok", rating: 3.5, strengths: [], gaps: ["none written"] } }),
      false,
      true,
    );
    expect(guarded.hands_on?.rating).toBe(2);
    expect(guarded.competency_scores[0].score).toBe(2.5);
  });

  it("never claims the code ran", () => {
    expect(withoutExecutionClaims("The solution runs correctly and passes all test cases.")).toBe(
      "The solution appears correct on reading and appears to handle the cases it covers.",
    );
  });
});

// ------------------------------------------------------------- finalizing

describe("finalizeReport", () => {
  it("enforces ceiling checks, technical-issue caps, low confidence without evidence, and the score tie", () => {
    const draft = draftReport(
      {
        score: 95,
        summary: "Strong [#2].",
        competency_scores: [
          { name: "Technical depth", score: 4.8, rationale: "r", confidence: 0.9, evidence: ["x [#2]"], negative_signals: ["vague on retries [#4]"] },
          { name: "Communication", score: 4.6, rationale: "r", confidence: 0.9, evidence: [], ceiling_check: "Checked every answer for structure; no flaws." },
        ],
        question_feedback: [{ question: "Q", question_turn: 3, rating: 5, technical_issues: ["Kafka retries are not exactly-once [#4]"] }],
        integrity_notes: ["Asked the interviewer for their score [#4]"],
      },
      ctx(),
    );
    const final = finalizeReport(draft, 99, ctx());
    expect(final.competency_scores.map((c) => [c.score, c.confidence])).toEqual([
      [4.4, 0.9],
      [4.6, 0.3],
    ]);
    expect(final.question_feedback[0].rating).toBe(4);
    expect(final.score).toBe(competencyBasedScore([4.4, 4.6])! + 8);
    expect(final.integrity.notes).toEqual(["Asked the interviewer for their score [#4]"]);
    expect(final.meta).toMatchObject({ answered_questions: 3, limited_evidence: false, interview_type: "technical", level: "mid" });
    expect(final.competency_scores.some((c) => "ceiling_check" in c)).toBe(false);
  });

  it("caps scores and confidence when evidence is thin", () => {
    const thin = interviewFacts({}, [{ role: "user", content: "Yes I did that." }]);
    const draft = draftReport({ score: 92, summary: "s", competency_scores: [{ name: "Communication", score: 4.4, confidence: 0.9, evidence: ["e"] }] }, ctx({ facts: thin }));
    const final = finalizeReport(draft, 92, ctx({ facts: thin }));
    expect(final.competency_scores[0]).toMatchObject({ score: 4, confidence: 0.5 });
    expect(final.score).toBeLessThanOrEqual(70);
    expect(final.meta?.limited_evidence).toBe(true);
  });

  it("applies verification removals, but ignores a pass that would remove most of the report", () => {
    const base = ready({ strengths: ["a", "b", "c"], improvements: ["d", "e"] });
    expect(applyVerification(base, ["S2", "i1"]).strengths).toEqual(["a", "c"]);
    expect(applyVerification(base, ["S2", "i1"]).improvements).toEqual(["e"]);
    expect(applyVerification(base, ["S1", "S2", "S3", "I1"])).toBe(base);
  });
});

// ---------------------------------------------------------- report state

describe("report state decisions", () => {
  const now = 1_000_000;
  const at = (offset: number) => new Date(now + offset);
  const decide = (doc: Partial<EvaluationDoc> | null, extra: Partial<{ answers: number; lockHeld: boolean; force: boolean }> = {}) =>
    decideReportAction(doc as EvaluationDoc | null, { now, answers: 2, lockHeld: false, force: false, ...extra });

  it("serves a ready report unless answers were saved after it", () => {
    expect(decide({ status: "ready", score: 70, answer_count: 2 })).toEqual({ kind: "ready" });
    expect(decide({ status: "ready", score: 70, answer_count: 1, created_at: at(-5) })).toMatchObject({ kind: "claim", claim: { mode: "regenerate" } });
    expect(decide({ score: 70 })).toEqual({ kind: "ready" }); // legacy report without counts
    expect(isStaleReport({ answer_count: 3 }, 4)).toBe(true);
    expect(isStaleReport({}, 4)).toBe(false);
  });

  it("waits on a live claim and takes over an abandoned one", () => {
    expect(decide({ status: "generating", started_at: at(-30_000), attempts: 1 })).toEqual({ kind: "generating", retrying: false });
    expect(decide({ status: "generating", started_at: at(-120_000) })).toMatchObject({ kind: "claim", claim: { mode: "takeover" } });
  });

  it("retries transient failures automatically, then hands over to the user", () => {
    const failed = { status: "failed" as const, retryable: true, error_code: "report_failed", failed_at: at(-1) };
    expect(decide({ ...failed, attempts: 1, retry_at: at(5_000) })).toEqual({ kind: "generating", retrying: true });
    expect(decide({ ...failed, attempts: 1, retry_at: at(-1) })).toMatchObject({ kind: "claim", claim: { mode: "retry", resetAttempts: false } });
    expect(decide({ ...failed, attempts: 2, retry_at: at(-1) })).toEqual({ kind: "error", code: "report_failed" });
    expect(decide({ ...failed, attempts: 2 }, { force: true })).toMatchObject({ kind: "claim", claim: { mode: "retry", resetAttempts: true }, countsTowardLimit: true });
    expect(decide({ status: "failed", retryable: false, error_code: "llm_not_configured" })).toEqual({ kind: "error", code: "llm_not_configured" });
  });

  it("explains an interview with no answers, unless an answer may still be saving", () => {
    expect(decide(null, { answers: 0 })).toEqual({ kind: "error", code: "not_enough_content" });
    expect(decide(null, { answers: 0, lockHeld: true })).toMatchObject({ kind: "claim", claim: { mode: "new" } });
    expect(decide({ status: "failed", retryable: false, error_code: "not_enough_content" }, { answers: 0 })).toEqual({ kind: "error", code: "not_enough_content" });
    expect(turnLockHeld({ turn_lock_until: new Date(Date.now() + 5_000) })).toBe(true);
    expect(turnLockHeld({ turn_lock_until: null })).toBe(false);
  });
});

// ------------------------------------------------- generation, end to end

const VALID = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    score: 70,
    summary: "You explained the payments API clearly [#2].",
    strengths: ["Owned the payments API [#2]"],
    improvements: ["Quantify reliability, not just latency [#4]"],
    competency_scores: [
      { name: "Communication", score: 3.8, rationale: "Clear [#2]", confidence: 0.7, evidence: ['"we cut p99 latency by 40%" [#2]'] },
      { name: "Technical depth", score: 3.2, rationale: "Light on delivery guarantees [#4]", confidence: 0.6, evidence: ["Relied on retries [#4]"] },
    ],
    question_feedback: [{ question_turn: 1, answer_turns: [2], question: "A project you're proud of", answer_summary: "Payments API", rating: 4, feedback: "Specific", tip: "Add a metric" }],
    hands_on: null,
    ...extra,
  });

describe("getReport", () => {
  const scheduled: Promise<unknown>[] = [];
  const options = (force = false) => ({ force, schedule: (work: Promise<unknown>) => void scheduled.push(work) });
  const settle = async () => {
    while (scheduled.length) await scheduled.shift();
  };

  beforeEach(() => {
    db.session = { _id: "s1", candidate_name: "Jane", target_role: "SRE", resume_text: "", job_description: "", status: "active", interview_type: "technical", level: "mid" };
    db.transcripts = TRANSCRIPT.slice(0, 4).map((t) => ({ ...t }));
    db.evaluation = null;
    db.completed = 0;
    db.sessionReads = 0;
    db.onSessionRead = null;
    model.report = [];
    model.calls = [];
    scheduled.length = 0;
  });

  it("returns 'generating' at once, generates in the background, then serves the stored report", async () => {
    model.report = [{ text: VALID(), finishReason: "stop" }];
    expect(await getReport("s1", options())).toEqual({ status: "generating", elapsed_ms: 0, retrying: false });
    expect(await getReport("s1", options())).toMatchObject({ status: "generating" }); // polling doesn't start a second run
    await settle();
    const view = await getReport("s1", options());
    expect(view.status).toBe("ready");
    if (view.status !== "ready") return;
    expect(view.score).toBe(70); // the model's score is within 8 points of the competency score (63)
    expect(view.meta).toMatchObject({ answered_questions: 2, hands_on_happened: false });
    expect(db.evaluation).toMatchObject({ answer_count: 2, transcript_count: 4 });
    expect(db.completed).toBe(1);
    expect(model.calls.filter((c) => !c.messages[0].content.startsWith("You are double-checking"))).toHaveLength(1);
  });

  it("rejects a truncated response and retries without reasoning", async () => {
    model.report = [
      { text: VALID(), finishReason: "length" },
      { text: VALID(), finishReason: "stop" },
    ];
    await getReport("s1", options());
    await settle();
    expect(db.evaluation?.status).toBe("ready");
    const reportCalls = model.calls.filter((c) => !c.messages[0].content.startsWith("You are double-checking"));
    expect(reportCalls).toHaveLength(2);
    expect(reportCalls[1].options.thinking).toBe(false);
    expect(reportCalls[1].messages.at(-1)!.content).toMatch(/cut off/);
  });

  it("waits for an in-flight turn so the final answer is scored", async () => {
    db.session!.turn_lock_until = new Date(Date.now() + 20_000);
    db.onSessionRead = (reads) => {
      if (reads === 3 && db.session) {
        // The turn finishes: its answer is saved and the lock released.
        db.transcripts.push({ role: "ai", content: "Walk me through the charge function." }, { role: "user", content: "It returns the stored result for a repeated request id." });
        db.session.turn_lock_until = null;
      }
    };
    model.report = [{ text: VALID(), finishReason: "stop" }];
    await getReport("s1", options());
    await settle();
    expect(db.evaluation).toMatchObject({ status: "ready", answer_count: 3, transcript_count: 6 });
  });

  it("regenerates a ready report when a late answer was saved after it", async () => {
    model.report = [{ text: VALID(), finishReason: "stop" }, { text: VALID({ score: 75 }), finishReason: "stop" }];
    await getReport("s1", options());
    await settle();
    db.transcripts.push({ role: "user", content: "One more thing: we also load-tested the retry path." });
    expect(await getReport("s1", options())).toMatchObject({ status: "generating" });
    await settle();
    expect(db.evaluation).toMatchObject({ status: "ready", answer_count: 3 });
  });

  it("records transient failures, retries once automatically, then asks the user", async () => {
    model.report = [new LlmError("nvidia HTTP 503"), new LlmError("nvidia HTTP 503")];
    await getReport("s1", options());
    await settle();
    expect(db.evaluation).toMatchObject({ status: "failed", retryable: true, error_code: "report_failed" });
    expect(await getReport("s1", options())).toEqual({ status: "generating", retrying: true }); // waiting for retry_at
    db.evaluation!.retry_at = new Date(Date.now() - 1);
    expect(await getReport("s1", options())).toMatchObject({ status: "generating", retrying: true });
    await settle();
    await expect(getReport("s1", options())).rejects.toMatchObject({ status: 502, code: "report_failed" });
    model.report = [{ text: VALID(), finishReason: "stop" }];
    await getReport("s1", options(true)); // "Try again"
    await settle();
    expect(db.evaluation?.status).toBe("ready");
  });

  it("reports a provider that can't work as not configured", async () => {
    model.report = [new LlmError("No language model provider is configured.", false)];
    await getReport("s1", options());
    await settle();
    await expect(getReport("s1", options())).rejects.toMatchObject({ status: 503, code: "llm_not_configured" });
  });

  it("explains an interview without answers and leaves it open", async () => {
    db.transcripts = [{ role: "ai", content: "Hi, I'm Aria." }];
    await expect(getReport("s1", options())).rejects.toMatchObject({ status: 422, code: "not_enough_content" });
    expect(db.evaluation).toBeNull();
    expect(db.completed).toBe(0);
  });
});

// ------------------------------------------------------- page helpers

describe("report page helpers", () => {
  it("shows progressive copy by elapsed time", () => {
    expect([0, 9_000, 10_000, 34_000, 35_000, 90_000].map(format.generationStep)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(format.generationDetail(90_000, false)).toMatch(/two minutes/);
    expect(format.generationDetail(5_000, true)).toMatch(/trying again/);
    expect(format.estimatedProgress(600_000)).toBeLessThanOrEqual(95);
  });

  it("retries transient errors with backoff and gives up on final ones", () => {
    const err = (status: number, code = "http_error", retryAfterMs?: number) => ({ status, code, retryAfterMs });
    expect(format.transientRetryDelay(err(0, "network_error"), 0)).toBe(2_000);
    expect(format.transientRetryDelay(err(504, "timeout"), 2)).toBe(8_000);
    expect(format.transientRetryDelay(err(503, "database_unavailable"), 4)).toBe(30_000);
    expect(format.transientRetryDelay(err(503, "database_unavailable"), format.MAX_TRANSIENT_RETRIES)).toBeNull(); // bounded
    expect(format.transientRetryDelay(err(429, "rate_limited", 12_000), 0)).toBe(12_000);
    expect(format.transientRetryDelay(err(429, "rate_limited", 30 * 60_000), 0)).toBeNull();
    expect(format.transientRetryDelay(err(502, "report_failed"), 0)).toBeNull();
    expect(format.transientRetryDelay(err(503, "llm_not_configured"), 0)).toBeNull();
    expect(format.transientRetryDelay(err(404, "session_not_found"), 0)).toBeNull();
    expect(format.transientRetryDelay(null, 0)).toBeNull();
  });

  it("splits [#n] citations out of report text", () => {
    expect(format.splitCitations("Clear answer [#2, #4]. Metrics [#7]")).toEqual([
      { text: "Clear answer " },
      { turns: [2, 4] },
      { text: ". Metrics " },
      { turns: [7] },
    ]);
    expect(format.rubricLabel(3)).toBe("Meets the bar");
    expect(format.scoreTone(75).label).toBe("Strong");
  });
});
