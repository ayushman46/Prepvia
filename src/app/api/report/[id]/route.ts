import { waitUntil } from "@vercel/functions";
import { NextResponse } from "next/server";
import type { ReportView } from "@/lib/protocol";
import { config } from "@/server/config";
import { clientIp, handler } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { getReport, type ReportOptions } from "@/server/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A request that starts generation keeps running it in the background
// (waitUntil) under a hard 100 s deadline (REPORT_DEADLINE_MS), inside this limit.
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

function options(request: Request, force: boolean): ReportOptions {
  return {
    force,
    // Only new generations count toward the limit; polling and cached reads are free.
    beforeGenerate: () => enforceRateLimit("report", clientIp(request), config.limits.reportsPerIpPerHour),
    schedule: waitUntil,
  };
}

function respond(report: ReportView): NextResponse {
  return NextResponse.json(report, {
    status: report.status === "generating" ? 202 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}

/** The report, or `{status: "generating"}` (202) while it is being written: poll every few seconds. */
export const GET = handler("get report", async (request: Request, { params }: Params) => {
  const { id } = await params;
  return respond(await getReport(id, options(request, false)));
});

/** "Try again": restart a generation that failed. */
export const POST = handler("retry report", async (request: Request, { params }: Params) => {
  const { id } = await params;
  return respond(await getReport(id, options(request, true)));
});
