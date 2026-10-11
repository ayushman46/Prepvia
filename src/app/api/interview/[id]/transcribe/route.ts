import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { ApiError, clientIp, handler } from "@/server/http";
import { enforceLocalRateLimit } from "@/server/rate-limit";
import { isValidSessionId } from "@/server/sessions";
import { logger } from "@/server/logger";
import { MAX_AUDIO_BYTES, SttError, transcribeAudio } from "@/server/stt";
import { prewarmTts } from "@/server/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Speculative transcription: the browser sends the answer as soon as the
 * candidate pauses, so STT runs inside the end-of-turn silence window. The
 * transcript is then submitted as the turn's text (flagged `voice`), removing
 * STT from the critical path. The turn applies the speaker-echo filter, so this
 * endpoint needs no database access; it is rate limited in memory per instance.
 */
export const POST = handler("speculative transcription", async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!isValidSessionId(id)) throw new ApiError(404, "session_not_found", "Interview not found.");
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_AUDIO_BYTES) throw new ApiError(413, "audio_too_large", "That answer was too long to process.");
  // The turn request usually follows within a second: warm its TTS sockets now.
  prewarmTts(2);
  enforceLocalRateLimit("stt", clientIp(request), Math.ceil(config.limits.transcriptionsPerIpPerHour / 60), 60);
  const audio = new Uint8Array(await request.arrayBuffer());
  try {
    const text = await transcribeAudio(audio, { speculative: true });
    return NextResponse.json({ text, echo: false });
  } catch (error) {
    if (error instanceof SttError) throw sttApiError(error, id);
    throw error;
  }
});

/** Map an STT failure to a client error the browser can act on (stop, back off, or fall back). */
function sttApiError(error: SttError, sessionId: string): ApiError {
  if (error.reason === "rate_limited") {
    return new ApiError(429, "stt_busy", "Speech recognition is busy. Please wait a moment.", {
      "Retry-After": String(Math.max(1, Math.ceil((error.retryAfterMs ?? 2_000) / 1000))),
    });
  }
  logger.warn("Speculative transcription failed", error, { sessionId, reason: error.reason });
  if (error.retryable) return new ApiError(502, "stt_failed", "Speech recognition failed.");
  return new ApiError(503, "stt_unavailable", "Speech recognition isn't available on this server.");
}
