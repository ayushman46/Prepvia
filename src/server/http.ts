import "server-only";
import { NextResponse } from "next/server";
import { logger } from "./logger";

/** An error that is safe to show to the client, with an HTTP status and stable code. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function jsonError(error: unknown, context: string): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: error.headers },
    );
  }
  logger.error(`${context} failed`, error);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Something went wrong. Please try again." } },
    { status: 500 },
  );
}

/** Wrap a route handler so every unexpected failure becomes a consistent JSON error. */
export function handler<Args extends unknown[]>(
  context: string,
  fn: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (error) {
      return jsonError(error, context);
    }
  };
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function readJson<T = unknown>(request: Request, maxBytes = 256 * 1024): Promise<T> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) {
    throw new ApiError(413, "payload_too_large", "Request body is too large.");
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new ApiError(413, "payload_too_large", "Request body is too large.");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}
