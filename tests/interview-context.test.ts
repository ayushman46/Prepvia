import { describe, expect, it } from "vitest";
import {
  applyQuestionUpdate,
  buildInterviewContext,
  buildInterviewMessages,
  defaultInterviewMemory,
  defaultInterviewState,
  LIVE_MAX_RECENT_MESSAGES,
  LIVE_MAX_RESUME_CHARS,
  mergeAnswerAnalysis,
  parseJsonObject,
  phaseForQuestion,
  repairJson,
  recordQuestion,
  stateFromSession,
  topicForQuestion,
  unique,
} from "@/server/interview-context";

const session = {
  candidate_name: "Jane Doe",
  target_role: "Backend Engineer",
  resume_text: "- Built a payments API in Go\n• Reduced latency by 40%\n\nLed a team of 4",
  job_description: "Own distributed systems\nPython and Go",
  interview_state: defaultInterviewState(),
  interview_memory: defaultInterviewMemory(),
};

describe("buildInterviewContext", () => {
  it("separates candidate, resume, job description, state, memory and conversation", () => {
    const context = buildInterviewContext(session, [
      { role: "ai", content: "Hello" },
      { role: "user", content: "Hi" },
    ]);
    expect(context.candidate).toEqual({ name: "Jane Doe", target_role: "Backend Engineer" });
    expect(context.resume.source_lines).toEqual(["Built a payments API in Go", "Reduced latency by 40%", "Led a team of 4"]);
    expect(context.job_description.source_lines).toEqual(["Own distributed systems", "Python and Go"]);
    expect(context.recent_conversation).toEqual([
      { role: "interviewer", content: "Hello" },
      { role: "candidate", content: "Hi" },
    ]);
  });

  it("clips sources and history for live turns", () => {
    const long = { ...session, resume_text: "x".repeat(LIVE_MAX_RESUME_CHARS + 500) };
    const history = Array.from({ length: 10 }, (_, i) => ({ role: (i % 2 ? "user" : "ai") as "user" | "ai", content: `m${i}` }));
    const context = buildInterviewContext(long, history, true);
    expect(context.resume.source_text.endsWith("[truncated]")).toBe(true);
    expect(context.resume.source_text.length).toBeLessThan(LIVE_MAX_RESUME_CHARS + 20);
    expect(context.recent_conversation).toHaveLength(LIVE_MAX_RECENT_MESSAGES);
    expect(context.recent_conversation.at(-1)?.content).toBe("m9");
  });

  it("tolerates missing or malformed stored state", () => {
    const state = stateFromSession({ interview_state: { question_number: "3", current_difficulty: 99, topics_covered: "bad" } });
    expect(state.question_number).toBe(3);
    expect(state.current_difficulty).toBe(5);
    expect(state.topics_covered).toEqual([]);
  });
});

describe("buildInterviewMessages", () => {
  it("isolates sources in system sections and ends with the instruction", () => {
    const messages = buildInterviewMessages(buildInterviewContext(session, []), "Ask a question.");
    expect(messages[0].content).toContain("Never invent");
    expect(messages.slice(1, -1).every((m) => m.role === "system")).toBe(true);
    expect(messages[2].content.startsWith("<RESUME>")).toBe(true);
    expect(messages.at(-1)).toEqual({ role: "user", content: "Ask a question." });
  });
});

describe("question bookkeeping", () => {
  it("maps question numbers to interview phases", () => {
    expect([1, 2, 4, 8, 10].map(phaseForQuestion)).toEqual(["opening", "experience", "technical", "behavioral", "closing"]);
  });

  it("detects topics from question text", () => {
    expect(topicForQuestion("How would you scale this architecture?")).toBe("system design");
    expect(topicForQuestion("Tell me about a conflict with a stakeholder")).toBe("communication and ownership");
    expect(topicForQuestion("What do you enjoy?")).toBe("general role fit");
  });

  it("records questions and raises difficulty every three questions", () => {
    let state = defaultInterviewState();
    for (let i = 0; i < 4; i++) state = applyQuestionUpdate(state, recordQuestion(state, `How would you test feature ${i}?`));
    expect(state.question_number).toBe(4);
    expect(state.current_difficulty).toBe(2);
    expect(state.phase).toBe("technical");
    expect(state.topics_covered).toEqual(["testing and quality"]);
    expect(state.questions_asked).toHaveLength(4);
  });
});

describe("mergeAnswerAnalysis", () => {
  it("accumulates evidence and merges competencies by name without losing earlier signals", () => {
    const first = mergeAnswerAnalysis([], defaultInterviewMemory(), "Q1", "A1", {
      strong_areas: ["APIs"],
      competencies: [{ name: "Problem solving", score: 60, evidence: ["e1"], positive_signals: ["p1"] }],
    });
    const second = mergeAnswerAnalysis(first.competencies, first.memory, "Q2", "A2", {
      strong_areas: ["APIs", "Testing"],
      competencies: [{ name: "Problem solving", score: 75, evidence: ["e2"] }],
    });
    expect(second.memory.strong_areas).toEqual(["APIs", "Testing"]);
    expect(second.memory.answer_evidence).toHaveLength(2);
    expect(second.competencies).toHaveLength(1);
    expect(second.competencies[0]).toMatchObject({
      name: "Problem solving",
      score: 75,
      evidence: ["e1", "e2"],
      positive_signals: ["p1"],
      questions_used: ["Q1", "Q2"],
    });
  });

  it("ignores malformed analysis fields", () => {
    const result = mergeAnswerAnalysis("bad", defaultInterviewMemory(), "Q", "A", {
      strong_areas: "not a list",
      competencies: [null, { score: 5 }, "x"],
    });
    expect(result.competencies).toEqual([]);
    expect(result.memory.strong_areas).toEqual([]);
  });
});

describe("unique", () => {
  it("dedupes objects structurally regardless of key order, including nested keys", () => {
    expect(unique([{ a: 1, b: { c: 1 } }, { b: { c: 1 }, a: 1 }, { a: 1, b: { c: 2 } }])).toHaveLength(2);
  });
});

describe("parseJsonObject", () => {
  it("parses fenced JSON", () => {
    expect(parseJsonObject('```json\n{"score": 80}\n```')).toEqual({ score: 80 });
  });

  it("skips reasoning blocks and leading prose", () => {
    expect(parseJsonObject('<think>maybe {"score": 1}</think>Here you go: {"score": 90, "s": "a}b"} trailing')).toEqual({
      score: 90,
      s: "a}b",
    });
  });

  it("returns null when there is no object", () => {
    expect(parseJsonObject("no json here")).toBeNull();
    expect(parseJsonObject("[1, 2]")).toBeNull();
  });
});

describe("parseJsonObject robustness (LLM output defects)", () => {
  it("repairs trailing commas and raw newlines inside strings instead of returning a nested object", () => {
    const text = '{"score": 82, "summary": "Line one\nline two", "competency_scores": [{"name": "Depth", "score": 5,},],}';
    const parsed = parseJsonObject(text, { requiredKeys: ["score", "competency_scores"] });
    expect(parsed?.score).toBe(82);
    expect(parsed?.summary).toBe("Line one\nline two");
    expect((parsed?.competency_scores as unknown[]).length).toBe(1);
  });

  it("never mistakes a nested fragment for the document when required keys are missing", () => {
    const broken = '{"score": 82, "competency_scores": [{"name": "Depth", "score": 5}], "summary": "unescaped "quote" here"}';
    const parsed = parseJsonObject(broken, { requiredKeys: ["score", "competency_scores"] });
    // Either the repaired outer object or nothing, but never {"name":"Depth","score":5}.
    expect(parsed === null || (parsed.score === 82 && Array.isArray(parsed.competency_scores))).toBe(true);
  });

  it("closes truncated output", () => {
    const truncated = '{"score": 70, "competency_scores": [{"name": "Communication", "score": 4}, {"name": "Dep';
    const parsed = parseJsonObject(truncated, { requiredKeys: ["score", "competency_scores"] });
    expect(parsed?.score).toBe(70);
    expect((parsed?.competency_scores as { name: string }[])[0].name).toBe("Communication");
  });

  it("repairJson leaves valid JSON unchanged", () => {
    const valid = '{"a": [1, 2, {"b": "c, d"}], "e": "f}g"}';
    expect(JSON.parse(repairJson(valid))).toEqual(JSON.parse(valid));
  });
});
