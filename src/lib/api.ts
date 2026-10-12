import type { ApiErrorBody, ReportView, SessionView, TurnEvent } from "./protocol";

/** An API failure with a stable `code` and a message safe to show users. */
export class ClientApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** From Retry-After on 429 responses. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ClientApiError";
  }
}

async function toError(response: Response): Promise<ClientApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await response.json()) as Partial<ApiErrorBody>;
  } catch {
    // non-JSON error (e.g. platform 413/504 page)
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  if (body?.error?.message) return new ClientApiError(response.status, body.error.code || "error", body.error.message, retryAfterMs);
  if (response.status === 413) return new ClientApiError(413, "payload_too_large", "That file or recording is too large.");
  if (response.status === 504) return new ClientApiError(504, "timeout", "The server took too long to respond. Please try again.");
  return new ClientApiError(response.status, "http_error", `Request failed (${response.status}). Please try again.`);
}

function networkError(error: unknown): ClientApiError {
  if (error instanceof ClientApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new ClientApiError(0, "aborted", "Request cancelled.");
  return new ClientApiError(0, "network_error", "Can't reach the server. Check your connection and try again.");
}

async function request<T>(input: string, init?: RequestInit): Promise<{ status: number; data: T }> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok) throw await toError(response);
  return { status: response.status, data: (await response.json()) as T };
}

export async function uploadResume(file: File): Promise<{ text: string; pages: number; chars: number }> {
  const form = new FormData();
  form.append("file", file);
  return (await request<{ text: string; pages: number; chars: number }>("/api/resume/upload", { method: "POST", body: form })).data;
}

export async function startInterview(input: {
  name: string;
  role: string;
  resume_text: string;
  job_description: string;
  duration_minutes?: number;
  interview_type?: string;
  level?: string;
  canvas_enabled?: boolean;
}): Promise<string> {
  const { data } = await request<{ session_id: string }>("/api/interview/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.session_id;
}

export async function getInterview(id: string, signal?: AbortSignal): Promise<SessionView> {
  return (await request<SessionView>(`/api/interview/${encodeURIComponent(id)}`, { cache: "no-store", signal })).data;
}

export async function endInterview(id: string): Promise<void> {
  await request(`/api/interview/${encodeURIComponent(id)}/end`, { method: "POST" });
}

export async function saveCanvas(id: string, content: string, language: string): Promise<void> {
  await request(`/api/interview/${encodeURIComponent(id)}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, language }),
    keepalive: content.length < 60_000,
  });
}

export type SessionEvent = { type: string; detail?: string };

export async function sendEvents(id: string, events: SessionEvent[]): Promise<void> {
  if (events.length === 0) return;
  await request(`/api/interview/${encodeURIComponent(id)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
    keepalive: true,
  });
}

/** Best-effort delivery while the page is being hidden or closed. */
export function beaconEvents(id: string, events: SessionEvent[]): void {
  if (events.length === 0 || typeof navigator === "undefined" || !navigator.sendBeacon) return;
  const blob = new Blob([JSON.stringify({ events })], { type: "application/json" });
  navigator.sendBeacon(`/api/interview/${encodeURIComponent(id)}/events`, blob);
}

export async function getReport(id: string, signal?: AbortSignal): Promise<ReportView> {
  return (await request<ReportView>(`/api/report/${encodeURIComponent(id)}`, { cache: "no-store", signal })).data;
}

export type SpeculativeTranscript = { text: string; echo: boolean };

/** A speculative transcript that hasn't arrived by then is abandoned: the audio is uploaded instead. */
export const SPECULATION_DEADLINE_MS = 6_000;

/** Resolve with the promise's value, or null if it fails or takes longer than `ms`. */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** Transcribe an answer while the candidate is still within the end-of-turn pause. */
export async function transcribeSpeculative(id: string, audio: Blob, signal?: AbortSignal): Promise<SpeculativeTranscript> {
  return (
    await request<SpeculativeTranscript>(`/api/interview/${encodeURIComponent(id)}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: audio,
      signal,
    })
  ).data;
}

/**
 * `audio` with `transcript`: a speculative transcript is in flight; use it if it
 * succeeds, otherwise fall back to sending the audio.
 */
export type TurnPayload = (
  | { audio: Blob; transcript?: Promise<SpeculativeTranscript | null> }
  | { text: string }
  | { continue: true }
) & {
  /** The candidate kept talking before Aria's reply was heard: add this to their last answer and replace that reply. */
  amend?: boolean;
  /** Aria's previous reply was interrupted: what the candidate actually heard of it. */
  heard?: string;
};

/** Parse a stream of newline-delimited JSON objects. */
export async function* readNdjson<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as T;
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) yield JSON.parse(rest) as T;
  } finally {
    reader.releaseLock();
  }
}

/** Run one interview turn, invoking `onEvent` for each streamed event. */
export async function streamTurn(
  sessionId: string,
  payload: TurnPayload,
  onEvent: (event: TurnEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const init: RequestInit = { method: "POST", signal, cache: "no-store" };
  const extra = { ...(payload.amend ? { amend: true } : {}), ...(payload.heard !== undefined ? { heard: payload.heard } : {}) };
  // Audio bodies carry the same flags as headers (the heard text URI-encoded, capped).
  const audioHeaders = (): Record<string, string> => ({
    "Content-Type": "audio/wav",
    ...(payload.amend ? { "X-Answer-Continues": "1" } : {}),
    ...(payload.heard !== undefined ? { "X-Interrupted-Heard": encodeURIComponent(payload.heard.slice(0, 1_500)) } : {}),
  });
  if ("audio" in payload && payload.transcript) {
    const speculative = await withDeadline(payload.transcript, SPECULATION_DEADLINE_MS);
    if (speculative?.echo) {
      onEvent({ type: "no_speech" });
      return;
    }
    if (speculative?.text) {
      // STT already happened during the pause: submit the transcript as text. The
      // server re-applies the speaker-echo filter for voice-derived text.
      init.body = JSON.stringify({ text: speculative.text, voice: true, ...extra });
      init.headers = { "Content-Type": "application/json" };
    } else {
      init.body = payload.audio;
      init.headers = audioHeaders();
    }
  } else if ("audio" in payload) {
    init.body = payload.audio;
    init.headers = audioHeaders();
  } else {
    init.body = JSON.stringify("text" in payload ? { text: payload.text, ...extra } : extra);
    init.headers = { "Content-Type": "application/json" };
  }

  let response: Response;
  try {
    response = await fetch(`/api/interview/${encodeURIComponent(sessionId)}/turn`, init);
  } catch (error) {
    throw networkError(error);
  }
  if (!response.ok || !response.body) throw await toError(response);

  try {
    for await (const event of readNdjson<TurnEvent>(response.body)) onEvent(event);
  } catch (error) {
    throw networkError(error);
  }
}
