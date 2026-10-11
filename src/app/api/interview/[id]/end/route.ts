import { NextResponse } from "next/server";
import { handler } from "@/server/http";
import { markCompleted, requireSession } from "@/server/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler("end interview", async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  await requireSession(id);
  await markCompleted(id);
  return NextResponse.json({ status: "completed" });
});
