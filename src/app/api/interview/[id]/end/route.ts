import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { ApiError, clientIp, handler } from "@/server/http";
import { logger } from "@/server/logger";
import { enforceRateLimit } from "@/server/rate-limit";
import { getReport } from "@/server/report";
import { markCompleted, requireSession } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The report starts generating in the background of this request (see the report route).
export const maxDuration = 120;

export const POST = handler("end interview", async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await requireSession(id);
  await markCompleted(id);
  // Start the report now so it is often ready by the time the report page opens.
  // Ending always succeeds; any problem surfaces on the report page instead.
  let report: "generating" | "ready" | "unavailable" = "unavailable";
  try {
    const view = await getReport(id, {
      beforeGenerate: () => enforceRateLimit("report", clientIp(request), config.limits.reportsPerIpPerHour),
      schedule: waitUntil,
    });
    report = view.status;
  } catch (error) {
    if (!(error instanceof ApiError)) logger.warn("Couldn't start the report when the interview ended", error, { sessionId: id });
  }
  return NextResponse.json({ status: "completed", report });
});
