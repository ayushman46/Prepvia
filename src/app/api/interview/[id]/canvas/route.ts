import { NextResponse } from "next/server";
import { LIMITS } from "@/lib/protocol";
import { CANVAS_LANGUAGES } from "@/server/canvas-task";
import { ApiError, handler, readJson } from "@/server/http";
import { isValidSessionId, updateCanvasContent } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Autosave the candidate's canvas work so the interviewer can discuss it. */
export const PUT = handler("save canvas", async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!isValidSessionId(id)) throw new ApiError(404, "session_not_found", "Interview not found.");
  const body = await readJson<{ content?: unknown; language?: unknown }>(request, 128 * 1024);
  const content = typeof body.content === "string" ? body.content.slice(0, LIMITS.canvasChars) : "";
  const language = (CANVAS_LANGUAGES as readonly string[]).includes(String(body.language)) ? String(body.language) : "text";
  if (!(await updateCanvasContent(id, content, language))) {
    throw new ApiError(409, "interview_completed", "This interview has ended.");
  }
  return NextResponse.json({ saved: true, chars: content.length });
});
