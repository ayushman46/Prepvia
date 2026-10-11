import "server-only";
import { buildInterviewContext, buildInterviewMessages, mergeAnswerAnalysis, parseJsonObject, type TranscriptEntry } from "./interview-context";
import { complete } from "./llm";
import { logger } from "./logger";
import { getSession, getTranscripts, updateAnalysis, type SessionDoc } from "./sessions";

const ANALYSIS_PROMPT = (question: string) => `Analyze the latest candidate answer internally. The preceding interviewer question was:
${question || "(opening of the interview)"}

Return ONLY valid JSON with these keys:
{
  "classification": {"fact": [], "claim": [], "explanation": [], "example": [], "technical_detail": [], "uncertainty": [], "contradiction": [], "evasion": []},
  "summary": "brief evidence-based summary",
  "facts": [],
  "claims": [],
  "technical_details": [],
  "important_claims": [],
  "strong_areas": [],
  "weak_areas": [],
  "unverified_claims": [],
  "topics_to_probe": [],
  "uncertainties": [],
  "contradictions": [],
  "competencies": [
    {"name": "competency", "score": 0, "confidence": 0.0, "evidence": [], "positive_signals": [], "negative_signals": []}
  ]
}

Scores are 0-100 and confidence is 0.0-1.0. Only record candidate-specific facts that are present in the resume or answer.
Do not treat a preferred solution as the only valid solution. Do not include hidden reasoning.`;

/**
 * Capture evidence about one answer for future turns and the final report.
 * Runs after the turn response has been delivered (via waitUntil), so it never
 * adds latency to the live conversation. Failures are logged, never surfaced.
 */
export async function analyzeAnswer(
  sessionId: string,
  question: string,
  answer: string,
  /** State the turn already loaded (saves two database reads per answer). */
  preloaded?: { session: SessionDoc; transcripts: TranscriptEntry[] },
): Promise<void> {
  try {
    const [session, transcripts] = preloaded
      ? [preloaded.session, preloaded.transcripts]
      : await Promise.all([getSession(sessionId), getTranscripts(sessionId)]);
    if (!session) return;
    const context = buildInterviewContext(session, transcripts);
    const messages = buildInterviewMessages(context, ANALYSIS_PROMPT(question));
    // Background work: wait out free-tier rate limits rather than dropping the analysis.
    // Runs on the separate "notes" model (own rate limit) and waits out 429s.
    const analysis = parseJsonObject(await complete(messages, "notes", { retryForMs: 30_000 }));
    if (!analysis) {
      logger.warn("Answer analysis returned invalid JSON", undefined, { sessionId });
      return;
    }
    const saved = await updateAnalysis(sessionId, (competencies, memory) =>
      mergeAnswerAnalysis(competencies, memory, question, answer, analysis),
    );
    if (!saved) logger.warn("Answer analysis could not be saved after retries", undefined, { sessionId });
  } catch (error) {
    logger.warn("Answer analysis failed", error, { sessionId });
  }
}
