import { NextResponse } from "next/server";
import { LIMITS } from "@/lib/protocol";
import { config } from "@/server/config";
import { ApiError, clientIp, handler, readJson } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { normalizePlan } from "@/server/interview-plan";
import { createSession } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StartBody = {
  name?: unknown;
  role?: unknown;
  resume_text?: unknown;
  job_description?: unknown;
  duration_minutes?: unknown;
  interview_type?: unknown;
  level?: unknown;
  canvas_enabled?: unknown;
};

function field(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, max) : "";
}

export const POST = handler("start interview", async (request: Request) => {
  const body = await readJson<StartBody>(request, 512 * 1024);
  const name = field(body.name, LIMITS.name);
  const role = field(body.role, LIMITS.role);
  if (!name) throw new ApiError(400, "name_required", "Please enter your name.");
  if (!role) throw new ApiError(400, "role_required", "Please enter the role you're practicing for.");

  await enforceRateLimit("start", clientIp(request), config.limits.sessionsPerIpPerHour);

  const sessionId = await createSession({
    name,
    role,
    resume_text: field(body.resume_text, LIMITS.resumeChars),
    job_description: field(body.job_description, LIMITS.jobDescriptionChars),
    plan: normalizePlan(body),
  });
  return NextResponse.json({ session_id: sessionId }, { status: 201 });
});
