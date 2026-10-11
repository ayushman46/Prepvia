import "server-only";
import { config } from "./config";
import { ApiError } from "./http";
import { logger } from "./logger";

/** 16 kHz mono 16-bit PCM: 32,000 bytes per second of audio. */
const BYTES_PER_SECOND = 32_000;
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // Stays under Vercel's 4.5 MB request limit.
const MIN_AUDIO_SECONDS = 0.25;

// Whisper commonly hallucinates these on silence or background noise.
const HALLUCINATIONS = new Set([
  "thank you",
  "thank you.",
  "thanks for watching",
  "thanks for watching!",
  "thank you for watching",
  "thank you for watching.",
  "you",
  "bye",
  "bye.",
  ".",
  "...",
  "subtitles by the amara.org community",
]);

export class SttError extends Error {
  constructor(message: string, public readonly retryable = true) {
    super(message);
    this.name = "SttError";
  }
}

/** Validate a RIFF/WAVE payload and return its approximate duration in seconds. */
export function validateWav(bytes: Uint8Array): number {
  if (bytes.byteLength < 44) throw new ApiError(400, "invalid_audio", "Audio payload is too short.");
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw new ApiError(413, "audio_too_large", "That answer was too long to process. Please answer in shorter segments.");
  }
  const ascii = (offset: number, length: number) => Buffer.from(bytes.subarray(offset, offset + length)).toString("latin1");
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    throw new ApiError(415, "unsupported_audio", "Audio must be a WAV file.");
  }
  return (bytes.byteLength - 44) / BYTES_PER_SECOND;
}

type VerboseSegment = { text?: string; no_speech_prob?: number; avg_logprob?: number };

export function cleanTranscript(text: string, segments?: VerboseSegment[]): string {
  let result = text;
  if (segments && segments.length > 0) {
    const kept = segments.filter(
      (segment) => !((segment.no_speech_prob ?? 0) > 0.6 && (segment.avg_logprob ?? 0) < -0.8),
    );
    result = kept.map((segment) => segment.text ?? "").join(" ");
  }
  result = result.replace(/\s+/g, " ").trim();
  if (HALLUCINATIONS.has(result.toLowerCase())) return "";
  return result;
}

async function requestTranscription(audio: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "answer.wav");
  form.append("model", config.groq.sttModel);
  form.append("response_format", "verbose_json");
  form.append("language", "en");
  form.append("temperature", "0");

  const response = await fetch(`${config.groq.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new SttError(`Groq STT HTTP ${response.status}: ${detail}`, response.status === 429 || response.status >= 500);
  }
  const data = (await response.json()) as { text?: string; segments?: VerboseSegment[] };
  return cleanTranscript(data.text ?? "", data.segments);
}

/** Transcribe a candidate utterance with Groq Whisper. Returns "" for silence/noise. */
export async function transcribeAudio(audio: Uint8Array): Promise<string> {
  if (!config.groq.apiKey) {
    throw new SttError("Speech recognition is not configured. Set GROQ_API_KEY.", false);
  }
  const seconds = validateWav(audio);
  if (seconds < MIN_AUDIO_SECONDS) return "";

  try {
    return await requestTranscription(audio);
  } catch (error) {
    const retryable = !(error instanceof SttError) || error.retryable;
    if (!retryable) throw error;
    logger.warn("STT failed; retrying once", error);
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      return await requestTranscription(audio);
    } catch (retryError) {
      throw retryError instanceof SttError ? retryError : new SttError(String(retryError));
    }
  }
}
