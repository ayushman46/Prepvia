import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { clientIp, handler } from "@/server/http";
import { enforceRateLimit } from "@/server/rate-limit";
import { getOrCreateReport } from "@/server/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Report generation uses the larger analysis model with reasoning enabled.
export const maxDuration = 120;

export const GET = handler("get report", async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  // Only actual generations count toward the limit; polling and cached reads are free.
  const report = await getOrCreateReport(id, () =>
    enforceRateLimit("report", clientIp(request), config.limits.reportsPerIpPerHour),
  );
  return NextResponse.json(report, {
    status: report.status === "generating" ? 202 : 200,
    headers: { "Cache-Control": "no-store" },
  });
});
