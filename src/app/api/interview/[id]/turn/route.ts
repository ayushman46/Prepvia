import { waitUntil } from "@vercel/functions";
import type { TurnEvent } from "@/lib/protocol";
import { analyzeAnswer } from "@/server/analysis";
import { ensureCanvasTask } from "@/server/canvas-task";
import { config } from "@/server/config";
import { ApiError, clientIp, jsonError, readJson } from "@/server/http";
import { logger } from "@/server/logger";
import { enforceLocalRateLimit, enforceRateLimit } from "@/server/rate-limit";
import { acquireTurnLock, finishTurn, isValidSessionId, releaseTurnLock, type SessionDoc, type TurnSessionUpdate } from "@/server/sessions";
import { MAX_AUDIO_BYTES } from "@/server/stt";
import { prewarmTts } from "@/server/tts";
import { runTurn, type TurnInput } from "@/server/turn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A turn is STT + LLM + TTS (~2-6s); background answer analysis continues
// after the response via waitUntil and shares this budget.
export const maxDuration = 120;

/** What the candidate heard of an interrupted reply (header for audio bodies, URI-encoded). */
function heardHeader(request: Request): string | undefined {
  const raw = request.headers.get("x-interrupted-heard");
  if (raw === null) return undefined;
  try {
    return decodeURIComponent(raw).slice(0, 4_000);
  } catch {
    return undefined;
  }
}

async function parseInput(request: Request): Promise<TurnInput> {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (contentType.startsWith("audio/") || contentType.startsWith("application/octet-stream")) {
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_AUDIO_BYTES) {
      throw new ApiError(413, "audio_too_large", "That answer was too long to process. Please answer in shorter segments.");
    }
    // Audio turns use speech-to-text too. They are the fallback when speculative
    // transcription was throttled, so they get their own per-IP budget.
    enforceLocalRateLimit("stt-turn", clientIp(request), Math.ceil(config.limits.transcriptionsPerIpPerHour / 60), 60);
    return {
      kind: "audio",
      audio: new Uint8Array(await request.arrayBuffer()),
      amend: request.headers.get("x-answer-continues") === "1",
      heard: heardHeader(request),
    };
  }
  if (contentType.includes("application/json")) {
    const body = await readJson<{ text?: unknown; voice?: unknown; amend?: unknown; heard?: unknown }>(request, 64 * 1024);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const heard = typeof body.heard === "string" ? body.heard.slice(0, 4_000) : undefined;
    return text ? { kind: "text", text, voice: body.voice === true, amend: body.amend === true, heard } : { kind: "continue", heard };
  }
  return { kind: "continue" };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestStartedAt = Date.now();
  const { id: sessionId } = await params;
  let lockId: string | null = null;
  let input: TurnInput;
  let session: SessionDoc;

  try {
    if (!isValidSessionId(sessionId)) throw new ApiError(404, "session_not_found", "Interview not found.");
    // Open TTS sockets now so they are ready by the time the first sentence exists.
    prewarmTts(2);

    // Independent work runs concurrently: body upload, rate limit, lease lock.
    const lockPromise = acquireTurnLock(sessionId);
    const [parsed, , lock] = await Promise.all([
      parseInput(request),
      enforceRateLimit("turn", clientIp(request), config.limits.turnsPerIpPerHour),
      lockPromise,
    ]).catch(async (error) => {
      // Never leave a lease behind if parsing or rate limiting failed.
      const acquired = await lockPromise.catch(() => null);
      if (acquired && "lockId" in acquired) await releaseTurnLock(sessionId, acquired.lockId).catch(() => undefined);
      throw error;
    });

    if ("error" in lock) {
      if (lock.error === "not_found") throw new ApiError(404, "session_not_found", "Interview not found. It may have expired.");
      if (lock.error === "completed") {
        throw new ApiError(409, "interview_completed", "This interview has ended. Open the report to see your feedback.");
      }
      throw new ApiError(409, "turn_in_progress", "The interviewer is still responding. Please wait a moment.");
    }
    lockId = lock.lockId;
    session = lock.session;
    input = parsed;

    if (input.kind !== "continue" && (session.turn_count ?? 0) >= config.limits.maxTurnsPerSession) {
      await releaseTurnLock(sessionId, lockId);
      throw new ApiError(409, "turn_limit", "This interview has reached its question limit. End it to see your report.");
    }
  } catch (error) {
    return jsonError(error, "interview turn");
  }

  const encoder = new TextEncoder();
  let closed = false;
  const sink: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null };

  const emit = (event: TurnEvent) => {
    if (closed || !sink.controller) return;
    try {
      sink.controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      closed = true; // Client went away; keep working so the turn is still persisted.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink.controller = controller;
    },
    cancel() {
      closed = true;
    },
  });

  const work = (async () => {
    let outcome: Awaited<ReturnType<typeof runTurn>> | null = null;
    const sessionUpdate: TurnSessionUpdate = {};
    try {
      outcome = await runTurn(sessionId, session, input, emit, requestStartedAt, sessionUpdate);
    } catch (error) {
      logger.error("Interview turn failed", error, { sessionId });
      emit({
        type: "error",
        code: error instanceof ApiError ? error.code : "turn_failed",
        message: error instanceof ApiError ? error.message : "Something went wrong during this turn. Please try again.",
        retryable: true,
      });
    } finally {
      // One write: release the lease and persist the turn's session changes.
      await finishTurn(sessionId, lockId as string, sessionUpdate).catch((error) =>
        logger.error("Failed to finish turn", error, { sessionId }),
      );
      if (!closed) {
        closed = true;
        try {
          sink.controller?.close();
        } catch {
          // already closed
        }
      }
    }
    // Background work after the response has been delivered. Answer analysis is
    // sampled (see ANALYSIS_EVERY_N_ANSWERS) to conserve the shared LLM rate limit.
    const answered = (session.turn_count ?? 0) + (sessionUpdate.incrementTurn ? 1 : 0);
    const every = config.analysis.everyNAnswers;
    const analyzeThis = every > 0 && answered > 0 && answered % every === 0;
    await Promise.all([
      outcome?.prepareCanvas ? ensureCanvasTask(sessionId) : null,
      outcome?.analysis && analyzeThis ? analyzeAnswer(sessionId, outcome.analysis.question, outcome.analysis.answer, outcome.context) : null,
    ]);
  })();

  // Keep the invocation alive until persistence and background work finish,
  // even if the browser disconnects mid-turn.
  waitUntil(work);

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
