import { describe, expect, it } from "vitest";
import {
  buildLiveMessages,
  buildInterviewContext,
  defaultInterviewMemory,
  defaultInterviewState,
  isRepeatOf,
  JOIN_MESSAGE,
} from "@/server/interview-context";
import {
  buildTurnInstruction,
  currentSection,
  DEFAULT_PLAN,
  elapsedSince,
  END_MARKER,
  isRepeatRequest,
  normalizePlan,
  OVERTIME_MS,
  sectionsFor,
} from "@/server/interview-plan";

const minutes = (m: number) => m * 60_000;

describe("normalizePlan", () => {
  it("accepts valid input and defaults everything else", () => {
    expect(normalizePlan({ duration_minutes: 45, interview_type: "technical", level: "senior" })).toEqual({
      duration_minutes: 45,
      interview_type: "technical",
      level: "senior",
      canvas_enabled: true,
    });
    expect(normalizePlan({ duration_minutes: 999, interview_type: "chaos", level: "god" })).toEqual(DEFAULT_PLAN);
    expect(normalizePlan(null)).toEqual(DEFAULT_PLAN);
  });

  it("never enables the canvas for behavioral interviews and respects opt-out", () => {
    expect(normalizePlan({ interview_type: "behavioral", canvas_enabled: true }).canvas_enabled).toBe(false);
    expect(normalizePlan({ interview_type: "mixed", canvas_enabled: false }).canvas_enabled).toBe(false);
  });
});

describe("currentSection", () => {
  const plan = normalizePlan({ duration_minutes: 30, interview_type: "mixed" });

  it("walks through the mixed interview sections over 30 minutes", () => {
    const at = (m: number) => currentSection(plan, minutes(m), 3);
    expect(currentSection(plan, 0, 0)).toBe("opening");
    expect([at(2), at(10), at(18), at(25), at(28.5)]).toEqual(["background", "technical", "hands_on", "behavioral", "wrap_up"]);
    expect(at(30)).toBe("wrap_up");
    expect(currentSection(plan, minutes(30) + OVERTIME_MS, 3)).toBe("closing");
  });

  it("uses type-specific plans", () => {
    expect(sectionsFor(normalizePlan({ interview_type: "behavioral" })).map((s) => s.id)).toEqual(["background", "behavioral", "wrap_up"]);
    expect(sectionsFor(normalizePlan({ interview_type: "technical" })).map((s) => s.id)).toContain("hands_on");
    expect(sectionsFor(normalizePlan({ interview_type: "mixed", canvas_enabled: false })).map((s) => s.id)).not.toContain("hands_on");
    for (const type of ["mixed", "technical", "behavioral"] as const) {
      const segments = sectionsFor(normalizePlan({ interview_type: type }));
      expect(segments.at(-1)).toEqual({ id: "wrap_up", until: 1 });
      for (let i = 1; i < segments.length; i++) expect(segments[i].until).toBeGreaterThan(segments[i - 1].until);
    }
  });

  it("scales with the chosen duration", () => {
    const short = normalizePlan({ duration_minutes: 15 });
    expect(currentSection(short, minutes(14), 5)).toBe("wrap_up");
    expect(currentSection(short, minutes(17), 5)).toBe("closing");
  });
});

describe("buildTurnInstruction", () => {
  const plan = normalizePlan({ duration_minutes: 30, level: "senior" });

  it("includes section goal, time remaining, level calibration, and the one-question rule", () => {
    const text = buildTurnInstruction({ plan, section: "technical", elapsedMs: minutes(12), questionNumber: 5, hasNewAnswer: true });
    expect(text).toMatch(/Current section: technical/);
    expect(text).toMatch(/Time remaining: about 18 minutes/);
    expect(text).toMatch(/senior candidate/);
    expect(text).toMatch(/exactly one question mark/);
    expect(text).not.toContain(END_MARKER);
  });

  it("asks for the end marker when closing and in wrap-up", () => {
    expect(buildTurnInstruction({ plan, section: "closing", elapsedMs: minutes(35), questionNumber: 9, hasNewAnswer: true })).toContain(END_MARKER);
    expect(buildTurnInstruction({ plan, section: "wrap_up", elapsedMs: minutes(28), questionNumber: 9, hasNewAnswer: true })).toContain(END_MARKER);
    expect(buildTurnInstruction({ plan, section: "technical", elapsedMs: 0, questionNumber: 1, hasNewAnswer: true, forceClose: true })).toMatch(
      /Current section: closing/,
    );
  });

  it("restates the exact question on a repeat request", () => {
    const text = buildTurnInstruction({ plan, section: "technical", elapsedMs: minutes(10), questionNumber: 4, hasNewAnswer: true, repeatQuestion: "How do you shard?" });
    expect(text).toMatch(/asked you to repeat the question/);
    expect(text).toContain('"How do you shard?"');
  });
});

describe("isRepeatRequest", () => {
  it("detects short requests to repeat or rephrase", () => {
    for (const text of ["Could you repeat the question?", "Sorry, I didn't catch that.", "Can you say that again", "Pardon?", "Could you rephrase?", "What was the question again?"]) {
      expect(isRepeatRequest(text)).toBe(true);
    }
  });

  it("ignores real answers that happen to contain similar words", () => {
    expect(isRepeatRequest("I built a payments API with idempotency keys.")).toBe(false);
    expect(isRepeatRequest(`${"We had to repeat the migration twice because the first cutover failed, so I wrote a runbook ".repeat(2)}`)).toBe(false);
  });
});

describe("elapsedSince", () => {
  it("handles dates, strings and missing values", () => {
    const now = Date.now();
    expect(elapsedSince(new Date(now - 5_000), now)).toBe(5_000);
    expect(elapsedSince(new Date(now - 5_000).toISOString(), now)).toBe(5_000);
    expect(elapsedSince(null, now)).toBe(0);
    expect(elapsedSince(new Date(now + 5_000), now)).toBe(0);
  });
});

describe("buildLiveMessages", () => {
  const session = {
    candidate_name: "Jane",
    target_role: "SRE",
    resume_text: "Kubernetes",
    job_description: "",
    interview_state: { ...defaultInterviewState(), questions_asked: [{ number: 1, phase: "opening", topic: "x", question: "What brings you here?" }] },
    interview_memory: defaultInterviewMemory(),
  };

  it("puts rules, data and guidance in one system message, then real alternating turns", () => {
    const transcript = [
      { role: "ai" as const, content: "What brings you here?" },
      { role: "user" as const, content: "I love reliability work." },
    ];
    const messages = buildLiveMessages(buildInterviewContext(session, transcript, true), "GUIDANCE-TEXT", transcript);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[0].content).toContain("You are Aria");
    expect(messages[0].content).toContain("<TURN_GUIDANCE>\nGUIDANCE-TEXT\n</TURN_GUIDANCE>");
    expect(messages[0].content).toContain("What brings you here?"); // questions_asked for no-repeat
    expect(messages[1].content).toBe(JOIN_MESSAGE);
    expect(messages.at(-1)?.content).toBe("I love reliability work.");
  });

  it("merges consecutive same-role messages and handles the opening", () => {
    const opening = buildLiveMessages(buildInterviewContext(session, [], true), "G", []);
    expect(opening.map((m) => m.role)).toEqual(["system", "user"]);
    const transcript = [
      { role: "ai" as const, content: "Q?" },
      { role: "user" as const, content: "part one" },
      { role: "user" as const, content: "part two" },
    ];
    const merged = buildLiveMessages(buildInterviewContext(session, transcript, true), "G", transcript);
    expect(merged.at(-1)).toEqual({ role: "user", content: "part one\npart two" });
  });

  it("includes the canvas exercise and the candidate's live work once introduced", () => {
    const canvas = { task: { title: "LRU cache", instructions: "Implement get/put", language: "python", starter_code: "", focus: [] }, content: "class LRU: pass", language: "python" };
    const introduced = buildLiveMessages(buildInterviewContext({ ...session, canvas: { ...canvas, introduced_at: new Date() } }, [], true), "G", []);
    expect(introduced[0].content).toContain("<CANVAS>");
    expect(introduced[0].content).toContain("class LRU: pass");
    // Generated but not yet on screen: hidden unless explicitly included (the introducing turn).
    expect(buildLiveMessages(buildInterviewContext({ ...session, canvas }, [], true), "G", [])[0].content).not.toContain("<CANVAS>");
    expect(buildLiveMessages(buildInterviewContext({ ...session, canvas }, [], true, { includeCanvas: true }), "G", [])[0].content).toContain("<CANVAS>");
  });
});

describe("isRepeatOf", () => {
  it("flags verbatim and near-verbatim repeats", () => {
    const previous = "You mentioned owning the design and cutover plan. Can you walk me through one specific decision?";
    expect(isRepeatOf("You mentioned owning the design and cutover plan. Can you walk me", previous)).toBe(true);
    expect(isRepeatOf("you mentioned owning the design & the cutover plan, can you walk me through", previous)).toBe(true);
  });

  it("does not flag different questions that share a generic opener", () => {
    expect(isRepeatOf("Thanks for sharing that. How did you detect drift between ledgers?", "Thanks for sharing that. You mentioned the migration. What was hardest?")).toBe(false);
    expect(isRepeatOf("Sure.", "Sure, let's continue.")).toBe(false);
  });
});

describe("isEndRequest", () => {
  it("detects explicit requests to end the interview", async () => {
    const { isEndRequest } = await import("@/server/interview-plan");
    for (const text of [
      "End interview.",
      "end the interview",
      "Let's end the interview now.",
      "I want to stop the interview.",
      "I'm done.",
      "Let's finish here.",
      "Thank you for the time. I'll end the interview now.",
      "Thank you for the opportunity; I'm ending the interview now.",
      "Can we wrap up the interview here?",
      "End session.",
      "I'd like to end this session.",
    ]) {
      expect(isEndRequest(text)).toBe(true);
    }
  });

  it("does not end the interview on technical answers about sessions", async () => {
    const { isEndRequest } = await import("@/server/interview-plan");
    for (const text of [
      "When the user logs out, we end the session and revoke the token.",
      "I'd end the session after 30 minutes of inactivity.",
      "We stop the session timer when the tab is hidden.",
    ]) {
      expect(isEndRequest(text)).toBe(false);
    }
  });

  it("ignores answers and softer questions", async () => {
    const { isEndRequest } = await import("@/server/interview-plan");
    for (const text of [
      "Can we just stop here? I'm kind of tired.",
      "I'd stop the consumer, drain the queue, then end the migration window.",
      "We decided to end support for the old API after the interview loop with customers showed low usage.",
      "",
    ]) {
      expect(isEndRequest(text)).toBe(false);
    }
  });
});

describe("PREMATURE_WRAP_UP", () => {
  it("catches goodbyes and wrap-up language but not ordinary interview phrasing", async () => {
    const { PREMATURE_WRAP_UP } = await import("@/server/interview-plan");
    for (const text of ["You're welcome. Take care.", "You too. Have a great day.", "That concludes our interview.", "Goodbye, Jane!"]) {
      expect(PREMATURE_WRAP_UP.test(text)).toBe(true);
    }
    for (const text of ["Take care to handle duplicate requests: how would you do it?", "How do you take care of retries?", "What did you learn from that day?"]) {
      expect(PREMATURE_WRAP_UP.test(text)).toBe(false);
    }
  });
});

describe("live prompt question history", () => {
  it("lists every question asked so far, not just the most recent ten", () => {
    const asked = Array.from({ length: 15 }, (_, i) => ({ number: i + 1, phase: "technical", topic: "x", question: `Distinct question number ${i + 1}?` }));
    const session = {
      candidate_name: "Jane",
      target_role: "SRE",
      interview_state: { ...defaultInterviewState(), questions_asked: asked },
      interview_memory: defaultInterviewMemory(),
    };
    const system = buildLiveMessages(buildInterviewContext(session, [], true), "G", [])[0].content;
    expect(system).toContain("Distinct question number 1?");
    expect(system).toContain("Distinct question number 15?");
  });
});
