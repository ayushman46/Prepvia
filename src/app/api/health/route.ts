import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { pingDb } from "@/server/db";
import { llmConfigured } from "@/server/llm";
import { sttKeyState } from "@/server/stt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/readiness probe. Reports configuration state, never secret values. */
export async function GET() {
  const sttKeyPromise = sttKeyState();
  let database: "ok" | "unavailable" | "not_configured" = "not_configured";
  if (config.mongo.uri) {
    database = await pingDb().then(
      () => "ok" as const,
      () => "unavailable" as const,
    );
  }
  // A key that is present but rejected by Groq is reported as such ("invalid_key"),
  // since every spoken answer would fail.
  const sttKey = await sttKeyPromise;
  const checks = {
    database,
    llm: llmConfigured() ? "configured" : "not_configured",
    llm_primary: config.nvidia.apiKey ? "nvidia" : config.groq.apiKey ? "groq" : "none",
    stt: sttKey === "ok" ? "configured" : sttKey,
    tts: config.tts.enabled ? "edge" : "browser",
  };
  const healthy = database === "ok" && checks.llm === "configured" && checks.stt === "configured";
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: database === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
