import "server-only";
import { clip, parseJsonObject, type CanvasTask } from "./interview-context";
import { normalizePlan } from "./interview-plan";
import { complete } from "./llm";
import { logger } from "./logger";
import { claimCanvasTask, getSession, saveCanvasTask, type SessionDoc } from "./sessions";

export const CANVAS_LANGUAGES = ["python", "javascript", "typescript", "java", "go", "cpp", "sql", "text"] as const;

const LEVEL_SCOPE = {
  entry: "small, well-defined problem solvable in about 10 minutes",
  mid: "realistic problem with a couple of edge cases, solvable in about 12 minutes",
  senior: "realistic problem with design trade-offs and edge cases, solvable in about 15 minutes",
} as const;

function taskPrompt(session: SessionDoc): string {
  const plan = normalizePlan(session);
  return `Design ONE hands-on exercise for a live practice interview.

Role: ${clip(session.target_role, 200)}
Level: ${plan.level}
Job description (may be empty): ${clip(session.job_description, 3_000)}
Resume highlights (may be empty): ${clip(session.resume_text, 2_000)}

Requirements:
- A ${LEVEL_SCOPE[plan.level]}.
- Make it realistic for the role (for engineers: a practical coding task such as implementing a function, fixing a bug, or designing a small API; for data roles: SQL or analysis; for non-engineering roles such as product, design, or marketing: a written exercise like prioritizing, planning, or critiquing, with language "text").
- Instructions in plain text (no markdown), 3 to 8 short lines, with one concrete example where useful.
- starter_code: a minimal skeleton in the chosen language (or a short outline for "text"), at most 25 lines, without the solution.

Return ONLY valid JSON:
{"title": "short title", "instructions": "...", "language": one of ${JSON.stringify(CANVAS_LANGUAGES)}, "starter_code": "...", "focus": ["what a strong answer demonstrates", "..."]}`;
}

export function normalizeTask(raw: Record<string, unknown> | null): CanvasTask | null {
  if (!raw) return null;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 120) : "";
  const instructions = typeof raw.instructions === "string" ? raw.instructions.trim().slice(0, 3_000) : "";
  if (!title || !instructions) return null;
  const language = (CANVAS_LANGUAGES as readonly string[]).includes(String(raw.language)) ? String(raw.language) : "text";
  return {
    title,
    instructions,
    language,
    starter_code: typeof raw.starter_code === "string" ? raw.starter_code.slice(0, 4_000) : "",
    focus: Array.isArray(raw.focus) ? raw.focus.map(String).slice(0, 6) : [],
  };
}

/**
 * Generate and store the canvas exercise once per session. Called in the
 * background right after the interview opens, so it is ready long before the
 * hands-on section begins.
 */
export async function ensureCanvasTask(sessionId: string): Promise<CanvasTask | null> {
  try {
    const session = await getSession(sessionId);
    if (!session || !normalizePlan(session).canvas_enabled) return null;
    if (session.canvas?.task) return session.canvas.task;
    if (!(await claimCanvasTask(sessionId))) return null;
    const text = await complete([{ role: "user", content: taskPrompt(session) }], "analysis", { retryForMs: 30_000 });
    const task = normalizeTask(parseJsonObject(text));
    await saveCanvasTask(sessionId, task);
    if (!task) logger.warn("Canvas task generation returned invalid JSON", undefined, { sessionId });
    return task;
  } catch (error) {
    logger.warn("Canvas task generation failed", error, { sessionId });
    await saveCanvasTask(sessionId, null).catch(() => undefined);
    return null;
  }
}
