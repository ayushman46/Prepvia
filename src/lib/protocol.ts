/**
 * Wire protocol shared by the browser and the API routes.
 *
 * Each interview turn is a single POST to /api/interview/:id/turn whose
 * response is streamed as newline-delimited JSON (NDJSON) events. This works on
 * any serverless host (no WebSockets needed) and keeps turns stateless.
 */

export type TurnEvent =
  /** The candidate's utterance was transcribed. */
  | { type: "user_transcript"; content: string }
  /** The audio contained no intelligible speech; no AI turn follows. */
  | { type: "no_speech" }
  /** The interviewer started generating a response. */
  | { type: "ai_start" }
  /** One speakable sentence of the interviewer's response, in order. */
  | { type: "ai_sentence"; seq: number; content: string }
  /** MP3 audio for sentence `seq` (base64). May arrive out of order. */
  | { type: "audio"; seq: number; data: string; mime: string }
  /** Server-side TTS failed for `seq`; the client should speak the sentence itself. */
  | { type: "audio_error"; seq: number }
  /** The interviewer finished this turn. */
  | { type: "ai_done"; content: string; question_number: number }
  /** A recoverable or fatal error for this turn. */
  | { type: "error"; code: string; message: string; retryable: boolean }
  /** The interviewer opened the hands-on canvas with this exercise. */
  | { type: "canvas_task"; task: CanvasTaskView }
  /** Server-side timings for this turn (milliseconds since the request arrived). */
  | { type: "metrics"; metrics: TurnMetrics }
  /** End of stream. `limit_reached`: the interview is over and the report can be opened. */
  | { type: "done"; limit_reached?: boolean };

export type TurnMetrics = {
  stt_ms?: number;
  llm_first_token_ms?: number;
  first_sentence_ms?: number;
  first_audio_ms?: number;
  total_ms: number;
  section?: string;
  /** Which model served the reply, and how many drafts were regenerated (repeat guard). */
  model?: string;
  regenerated?: number;
};

export type CanvasTaskView = {
  title: string;
  instructions: string;
  language: string;
  starter_code: string;
};

export type InterviewType = "mixed" | "technical" | "behavioral";
export type InterviewLevel = "entry" | "mid" | "senior";

export type TranscriptMessage = { role: "user" | "ai"; content: string };

export type SessionView = {
  id: string;
  candidate_name: string;
  target_role: string;
  status: "active" | "completed";
  has_resume: boolean;
  has_job_description: boolean;
  question_number: number;
  turn_count: number;
  max_turns: number;
  created_at: string;
  started_at: string | null;
  duration_minutes: number;
  interview_type: InterviewType;
  level: InterviewLevel;
  canvas_enabled: boolean;
  canvas: { task: CanvasTaskView | null; content: string; language: string };
  transcript: TranscriptMessage[];
  /** Aria closed the interview (the candidate only has to open the report). */
  ended?: boolean;
};

/** Rubric rating on a 1-5 scale with the reason ("why") behind it. */
export type CompetencyScore = {
  name: string;
  score: number | null;
  rationale: string;
  confidence: number | null;
  evidence: string[];
  positive_signals: string[];
  negative_signals: string[];
};

export type QuestionFeedback = {
  question: string;
  answer_summary: string;
  rating: number | null;
  feedback: string;
  tip: string;
};

export type HandsOnFeedback = {
  summary: string;
  rating: number | null;
  strengths: string[];
  gaps: string[];
};

export type IntegritySummary = {
  tab_hidden: number;
  window_blur: number;
  large_paste: number;
  notes: string[];
};

export type ReportView =
  | { status: "generating" }
  | {
      status: "ready";
      score: number;
      summary: string;
      strengths: string[];
      improvements: string[];
      competency_scores: CompetencyScore[];
      question_feedback: QuestionFeedback[];
      hands_on: HandsOnFeedback | null;
      integrity: IntegritySummary;
      evidence: { type: string; statement: string }[];
    };

export type ApiErrorBody = { error: { code: string; message: string } };

export const LIMITS = {
  name: 120,
  role: 200,
  resumeChars: 60_000,
  jobDescriptionChars: 40_000,
  answerChars: 4_000,
  canvasChars: 20_000,
  resumeBytes: 4 * 1024 * 1024,
} as const;
