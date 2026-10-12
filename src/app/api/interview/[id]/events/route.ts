import { NextResponse } from "next/server";
import { ApiError, handler, readJson } from "@/server/http";
import { appendIntegrityEvents, isValidSessionId, markStarted } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Record session lifecycle and integrity signals (tab switches, large pastes) for the report. */
export const POST = handler("record events", async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!isValidSessionId(id)) throw new ApiError(404, "session_not_found", "Interview not found.");
  const body = await readJson<{ events?: unknown }>(request, 32 * 1024);
  const events = Array.isArray(body.events)
    ? body.events
        .filter((event): event is { type: string; detail?: string } => !!event && typeof event === "object" && typeof event.type === "string")
        .map((event) => ({ type: event.type, detail: typeof event.detail === "string" ? event.detail : undefined }))
    : [];
  // "started": the candidate pressed Start; the interview clock begins now.
  if (events.some((event) => event.type === "started")) await markStarted(id);
  await appendIntegrityEvents(id, events);
  return NextResponse.json({ recorded: events.length });
});
