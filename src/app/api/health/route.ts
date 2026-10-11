import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { pingDb } from "@/server/db";
import { llmConfigured } from "@/server/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/readiness probe. Reports configuration state, never secret values. */
export async function GET() {
  let database: "ok" | "unavailable" | "not_configured" = "not_configured";
  if (config.mongo.uri) {
    database = await pingDb().then(
      () => "ok" as const,
      () => "unavailable" as const,
    );
  }
  const checks = {
    database,
    llm: llmConfigured() ? "configured" : "not_configured",
    llm_primary: config.nvidia.apiKey ? "nvidia" : config.groq.apiKey ? "groq" : "none",
    stt: config.groq.apiKey ? "configured" : "not_configured",
    tts: config.tts.enabled ? "edge" : "browser",
  };
  const healthy = database === "ok" && checks.llm === "configured" && checks.stt === "configured";
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: database === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
