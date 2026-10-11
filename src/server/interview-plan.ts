/**
 * Time-boxed interview plan: which section the interview is in, what the
 * interviewer should do next, and when to wrap up. Pure functions only.
 */

export type InterviewType = "mixed" | "technical" | "behavioral";
export type InterviewLevel = "entry" | "mid" | "senior";

export type SectionId = "opening" | "background" | "technical" | "hands_on" | "behavioral" | "wrap_up" | "closing";

export type InterviewPlan = {
  duration_minutes: number;
  interview_type: InterviewType;
  level: InterviewLevel;
  canvas_enabled: boolean;
};

export const DURATIONS = [15, 30, 45] as const;
export const DEFAULT_PLAN: InterviewPlan = { duration_minutes: 30, interview_type: "mixed", level: "mid", canvas_enabled: true };

/** Normalize user/stored input into a valid plan. */
export function normalizePlan(input: Partial<Record<keyof InterviewPlan, unknown>> | null | undefined): InterviewPlan {
  const duration = Number(input?.duration_minutes);
  const type = String(input?.interview_type ?? "");
  const level = String(input?.level ?? "");
  const interview_type: InterviewType = (["mixed", "technical", "behavioral"] as const).includes(type as InterviewType)
    ? (type as InterviewType)
    : DEFAULT_PLAN.interview_type;
  return {
    duration_minutes: (DURATIONS as readonly number[]).includes(duration) ? duration : DEFAULT_PLAN.duration_minutes,
    interview_type,
    level: (["entry", "mid", "senior"] as const).includes(level as InterviewLevel) ? (level as InterviewLevel) : DEFAULT_PLAN.level,
    // Behavioral interviews have no hands-on exercise.
    canvas_enabled: interview_type !== "behavioral" && input?.canvas_enabled !== false,
  };
}

type Segment = { id: SectionId; until: number };

/** Fraction-of-duration boundaries for each section, by interview type. */
export function sectionsFor(plan: InterviewPlan): Segment[] {
  const canvas = plan.canvas_enabled;
  switch (plan.interview_type) {
    case "technical":
      return canvas
        ? [
            { id: "background", until: 0.2 },
            { id: "technical", until: 0.45 },
            { id: "hands_on", until: 0.88 },
            { id: "wrap_up", until: 1 },
          ]
        : [
            { id: "background", until: 0.2 },
            { id: "technical", until: 0.88 },
            { id: "wrap_up", until: 1 },
          ];
    case "behavioral":
      return [
        { id: "background", until: 0.3 },
        { id: "behavioral", until: 0.88 },
        { id: "wrap_up", until: 1 },
      ];
    default:
      return canvas
        ? [
            { id: "background", until: 0.22 },
            { id: "technical", until: 0.48 },
            { id: "hands_on", until: 0.75 },
            { id: "behavioral", until: 0.9 },
            { id: "wrap_up", until: 1 },
          ]
        : [
            { id: "background", until: 0.25 },
            { id: "technical", until: 0.62 },
            { id: "behavioral", until: 0.9 },
            { id: "wrap_up", until: 1 },
          ];
  }
}

/** Grace period after the scheduled end before the interviewer must close. */
export const OVERTIME_MS = 90_000;

export function currentSection(plan: InterviewPlan, elapsedMs: number, questionNumber: number): SectionId {
  if (questionNumber === 0) return "opening";
  const durationMs = plan.duration_minutes * 60_000;
  if (elapsedMs >= durationMs + OVERTIME_MS) return "closing";
  const fraction = elapsedMs / durationMs;
  for (const segment of sectionsFor(plan)) {
    if (fraction < segment.until) return segment.id;
  }
  return "wrap_up";
}

const LEVEL_GUIDANCE: Record<InterviewLevel, string> = {
  entry: "Calibrate for an entry-level candidate: focus on fundamentals, learning ability, and projects; be encouraging.",
  mid: "Calibrate for a mid-level candidate: expect independent ownership, sound trade-offs, and concrete results.",
  senior:
    "Calibrate for a senior candidate: expect system-level thinking, ambiguity handling, leadership, mentoring, and business impact.",
};

const SECTION_GOALS: Record<SectionId, string> = {
  opening:
    "Introduce yourself as Aria, the interviewer, in one short sentence, mention that the interview takes about {duration} minutes, then ask one warm, open opening question grounded in their background or the role.",
  background:
    "Explore the candidate's real experience. Pick specific items from the RESUME (projects, roles, claims) and probe what they personally did, decisions they made, and measurable results.",
  technical:
    "Assess role-relevant technical or functional depth. Ask about concepts, design trade-offs, debugging, and scenarios tied to the JOB_DESCRIPTION and the candidate's stack. Raise difficulty when answers are strong.",
  hands_on:
    "Run the hands-on exercise shown in the CANVAS. Ask the candidate to talk through their approach, then ask about specific choices in their current canvas work (edge cases, complexity, testing, alternatives). Do not write the solution for them.",
  behavioral:
    "Assess collaboration, ownership, conflict, failure, and prioritization with behavioral questions. Push for a specific situation, their own actions, and the outcome.",
  wrap_up:
    "Start wrapping up. If you haven't yet, ask whether the candidate has any questions for you, and answer their questions briefly and honestly (you only know what is in the job description; say so if asked about specifics you don't know). When they have no more questions, close the interview.",
  closing:
    "Time is up. Briefly thank the candidate by name, tell them the interview is complete and that their feedback report is ready when they end the session. Do not ask another question.",
};

export const END_MARKER = "<<END>>";

/** Short candidate messages that ask the interviewer to repeat or rephrase. */
const REPEAT_REQUEST =
  /\b(repeat|say (that|it) again|come again|didn'?t (catch|hear|get|understand)|pardon|rephrase|what was the question|one more time|missed (that|the question))\b/i;

export function isRepeatRequest(message: string): boolean {
  const text = message.trim();
  return text.length > 0 && text.length <= 120 && REPEAT_REQUEST.test(text);
}

export type TurnInstructionInput = {
  plan: InterviewPlan;
  section: SectionId;
  elapsedMs: number;
  questionNumber: number;
  hasNewAnswer: boolean;
  /** True on the turn that introduces the canvas exercise. */
  introduceCanvas?: { title: string } | null;
  forceClose?: boolean;
  /** The candidate asked to hear the last question again. */
  repeatQuestion?: string | null;
};

/** The per-turn instruction (the final user message in the prompt). */
export function buildTurnInstruction(input: TurnInstructionInput): string {
  const { plan, elapsedMs, questionNumber } = input;
  const section: SectionId = input.forceClose ? "closing" : input.section;
  const remaining = Math.max(0, Math.round(plan.duration_minutes - elapsedMs / 60_000));
  const lines: string[] = [];

  lines.push(`Interview: ${plan.interview_type}, about ${plan.duration_minutes} minutes. ${LEVEL_GUIDANCE[plan.level]}`);
  lines.push(
    `Current section: ${section.replace("_", " ")}. Questions asked so far: ${questionNumber}. Time remaining: about ${remaining} minute${remaining === 1 ? "" : "s"}.`,
  );
  lines.push(`Section goal: ${SECTION_GOALS[section].replace("{duration}", String(plan.duration_minutes))}`);

  if (section !== "hands_on" && !input.introduceCanvas) {
    // Phrased positively and without mentioning any later exercise: negative
    // instructions about "the coding exercise" primed the model to bring it up.
    lines.push(
      "Ask questions the candidate answers out loud by talking through their experience and reasoning; do not ask them to write or type anything.",
    );
  }

  if (input.introduceCanvas) {
    lines.push(
      `Transition to the hands-on exercise now. Tell the candidate you've opened a canvas on their screen with a problem titled "${input.introduceCanvas.title}", ask them to read it and talk you through their approach as they work. Do not read the whole problem aloud.`,
    );
  }

  if (input.repeatQuestion && section !== "closing") {
    lines.push(
      `The candidate asked you to repeat the question. Briefly say sure, then restate your last question in simpler words (do not ask a new one). Your last question was: "${input.repeatQuestion.slice(0, 600)}"`,
    );
    lines.push("Reply with only the words you will say aloud.");
    return lines.join("\n");
  }

  if (section === "closing") {
    lines.push(`End your reply with the exact marker ${END_MARKER} so the app knows the interview is over.`);
  } else if (input.hasNewAnswer) {
    lines.push(
      "Respond to the candidate's latest message following the conversation rules, then ask exactly one question that moves this section forward. " +
        "If the candidate asked you to repeat or clarify, do that instead of asking something new.",
    );
    if (section === "wrap_up") {
      lines.push(`If the candidate has no further questions, close the interview warmly and end your reply with ${END_MARKER}.`);
    }
  }
  if (section !== "closing") lines.push("Your reply must contain exactly one question mark: one single question, asked once.");
  lines.push('Start directly with your point or a brief neutral acknowledgement such as "Got it." or "Okay." Never open with praise like "Great answer" or "That\'s a strong result."');
  lines.push("Reply with only the words you will say aloud.");
  return lines.join("\n");
}

/** Elapsed interview time, measured from when the interviewer first spoke. */
export function elapsedSince(startedAt: Date | string | null | undefined, now = Date.now()): number {
  if (!startedAt) return 0;
  const start = startedAt instanceof Date ? startedAt.getTime() : Date.parse(startedAt);
  return Number.isFinite(start) ? Math.max(0, now - start) : 0;
}
