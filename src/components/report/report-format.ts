/**
 * Pure helpers for the report page: labels, progress copy, citation parsing
 * and retry policy. No React, so they are unit-testable.
 */

import type { InterviewLevel, InterviewType } from "@/lib/protocol";

export type Tone = { label: string; text: string; ring: string; bar: string };

/**
 * The overall 0-100 score in the words of the 1-5 rubric (0 → 1, 50 → 3, 100 → 5), so the
 * hero verdict never contradicts the competency labels. Colours use rubricBar's cut points.
 */
export function scoreTone(score: number): Tone {
  const rubric = 1 + Math.max(0, Math.min(100, score)) / 25;
  const label = rubricLabel(rubric);
  if (rubric >= 3.5) return { label, text: "text-forest", ring: "#034f46", bar: "bg-forest" };
  if (rubric >= 2.5) return { label, text: "text-[#9a5b00]", ring: "#ffa946", bar: "bg-ember" };
  return { label, text: "text-red-700", ring: "#b91c1c", bar: "bg-red-700" };
}

/** The 1-5 rubric in words. */
export function rubricLabel(score: number | null): string {
  if (score === null) return "Not rated";
  if (score >= 4.5) return "Exceptional";
  if (score >= 3.5) return "Strong";
  if (score >= 2.5) return "Meets the bar";
  if (score >= 1.5) return "Below the bar";
  return "Major gaps";
}

/** Bar colour for a 1-5 score (the number is always shown too). */
export function rubricBar(score: number | null): string {
  if (score === null) return "bg-fog";
  if (score >= 3.5) return "bg-forest";
  if (score >= 2.5) return "bg-ember";
  return "bg-red-700";
}

export function confidenceLabel(confidence: number | null): string | null {
  if (confidence === null) return null;
  const level = confidence >= 0.7 ? "High" : confidence >= 0.4 ? "Medium" : "Low";
  return `${level} confidence`;
}

const TYPE_LABELS: Record<InterviewType, string> = { mixed: "Mixed interview", technical: "Technical interview", behavioral: "Behavioral interview" };
const LEVEL_LABELS: Record<InterviewLevel, string> = { entry: "Entry level", mid: "Mid level", senior: "Senior level" };

export const interviewTypeLabel = (type: InterviewType) => TYPE_LABELS[type] ?? "Interview";
export const levelLabel = (level: InterviewLevel) => LEVEL_LABELS[level] ?? "";

export function formatMinutes(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return null;
  if (minutes < 1) return "Under a minute";
  return `${Math.round(minutes)} min`;
}

export function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ------------------------------------------------------------- progress

export const GENERATION_STEPS = ["Reading your answers…", "Scoring competencies…", "Writing feedback…"] as const;

/** Which step to show after `elapsedMs` of generation (a reasoning model takes ~30-120 s). */
export function generationStep(elapsedMs: number): number {
  if (elapsedMs < 10_000) return 0;
  if (elapsedMs < 35_000) return 1;
  return 2;
}

const STEP_DETAILS = [
  "Going through every answer you gave. This usually takes one to two minutes.",
  "Rating each competency against the rubric, with evidence.",
  "Writing feedback and tips for each question.",
];

export function generationDetail(elapsedMs: number, retrying: boolean): string {
  if (retrying) return "The AI service was busy, so we're trying again automatically.";
  if (elapsedMs > 75_000) return "Almost there. Detailed reports can take up to two minutes.";
  return STEP_DETAILS[generationStep(elapsedMs)];
}

/** An estimate for the progress bar: eases toward 95% over about two minutes, never reaching it. */
export function estimatedProgress(elapsedMs: number): number {
  return Math.round(95 * (1 - Math.exp(-Math.max(0, elapsedMs) / 45_000)));
}

// ------------------------------------------------------------ citations

export type CitedPart = { text: string } | { turns: number[] };

const CITATION = /\[#\s*(\d{1,4})((?:\s*,\s*#?\s*\d{1,4})*)\s*\]/g;

/** Split report text into plain text and [#n] transcript citations. */
export function splitCitations(value: string): CitedPart[] {
  const parts: CitedPart[] = [];
  let last = 0;
  for (const match of value.matchAll(CITATION)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: value.slice(last, at) });
    parts.push({ turns: (match[0].match(/\d+/g) ?? []).map(Number) });
    last = at + match[0].length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}

// ------------------------------------------------------------- retries

export type RetryableError = { status: number; code: string; retryAfterMs?: number };

export const MAX_TRANSIENT_RETRIES = 6;

/**
 * How long to wait before polling again after a failed request, or null when
 * the error is final. Network errors, gateway timeouts, overloaded servers and
 * short rate limits are retried with exponential backoff (2, 4, 8, 16, 30 s),
 * honouring Retry-After.
 */
export function transientRetryDelay(error: RetryableError | null, failures: number): number | null {
  if (!error || failures >= MAX_TRANSIENT_RETRIES) return null;
  const backoff = Math.min(30_000, 2_000 * 2 ** failures);
  if (error.status === 429) {
    if (error.retryAfterMs !== undefined && error.retryAfterMs > 60_000) return null;
    return Math.max(backoff, error.retryAfterMs ?? 0);
  }
  if (["report_failed", "llm_not_configured", "database_not_configured", "session_not_found"].includes(error.code)) return null;
  if (error.status === 0 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504) {
    return error.code === "aborted" ? null : backoff;
  }
  return null;
}
