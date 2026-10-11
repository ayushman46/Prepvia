import "server-only";
import { createHash } from "node:crypto";
import { getDb } from "./db";
import { ApiError } from "./http";

/**
 * Fixed-window rate limiting backed by MongoDB (works across serverless
 * instances with no extra infrastructure). IPs are hashed before storage.
 * Protects the free provider quotas from abuse of a public deployment.
 */
export async function enforceRateLimit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSeconds = 3600,
): Promise<void> {
  if (limit <= 0) return;
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const hashed = createHash("sha256").update(`interviewai:${identifier}`).digest("hex").slice(0, 32);
  const key = `${bucket}:${hashed}:${windowStart}`;
  const collection = (await getDb()).collection<{ _id: string; count: number; expires_at: Date }>("rate_limits");

  const doc = await collection.findOneAndUpdate(
    { _id: key },
    { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date((windowStart + windowSeconds) * 1000) } },
    { upsert: true, returnDocument: "after" },
  );

  if (doc && doc.count > limit) {
    const retryAfter = Math.max(1, windowStart + windowSeconds - Math.floor(Date.now() / 1000));
    throw new ApiError(
      429,
      "rate_limited",
      "You're doing that too often. Please wait a little and try again.",
      { "Retry-After": String(retryAfter) },
    );
  }
}

/**
 * Per-instance in-memory limiter for cheap, high-frequency endpoints (speculative
 * transcription) where a database round trip per call would be wasteful. Warm
 * serverless instances are reused, so this still bounds abuse effectively.
 */
const localWindows = new Map<string, { count: number; resetAt: number }>();

export function enforceLocalRateLimit(bucket: string, identifier: string, limit: number, windowSeconds = 60): void {
  const now = Date.now();
  if (localWindows.size > 10_000) {
    for (const [key, value] of localWindows) if (value.resetAt <= now) localWindows.delete(key);
  }
  const key = `${bucket}:${identifier}`;
  const entry = localWindows.get(key);
  if (!entry || entry.resetAt <= now) {
    localWindows.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return;
  }
  entry.count += 1;
  if (entry.count > limit) {
    throw new ApiError(429, "rate_limited", "You're doing that too often. Please wait a moment.", {
      "Retry-After": String(Math.ceil((entry.resetAt - now) / 1000)),
    });
  }
}
