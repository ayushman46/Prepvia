import { NextResponse } from "next/server";
import type { SessionView } from "@/lib/protocol";
import { config } from "@/server/config";
import { handler } from "@/server/http";
import { normalizePlan } from "@/server/interview-plan";
import { getTranscripts, requireSession } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler("get interview", async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const session = await requireSession(id);
  const transcript = await getTranscripts(id, { asSaved: true });
  const plan = normalizePlan(session);
  const task = session.canvas?.task ?? null;
  const view: SessionView = {
    id: id,
    candidate_name: session.candidate_name,
    target_role: session.target_role,
    status: session.status === "completed" ? "completed" : "active",
    has_resume: Boolean(session.resume_text),
    has_job_description: Boolean(session.job_description),
    question_number: session.interview_state?.question_number ?? 0,
    turn_count: session.turn_count ?? transcript.filter((m) => m.role === "user").length,
    max_turns: config.limits.maxTurnsPerSession,
    created_at: (session.created_at ?? new Date()).toISOString(),
    started_at: session.started_at ? session.started_at.toISOString() : null,
    ...plan,
    canvas: {
      // Only reveal the exercise once the interviewer has introduced it.
      task:
        task && session.canvas?.introduced_at
          ? { title: task.title, instructions: task.instructions, language: task.language, starter_code: task.starter_code }
          : null,
      content: session.canvas?.introduced_at ? session.canvas?.content ?? "" : "",
      language: session.canvas?.language ?? "text",
    },
    transcript,
    ended: Boolean(session.ended_at),
  };
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
});
