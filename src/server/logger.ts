/**
 * Minimal structured logger. Vercel captures stdout/stderr per invocation, so
 * single-line JSON keeps logs searchable without an external dependency.
 * Never pass resume text, transcripts, or secrets in `meta`.
 */

type Level = "info" | "warn" | "error";

function serializeError(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack?.split("\n").slice(0, 6).join("\n") };
  }
  return { message: String(error) };
}

function write(level: Level, message: string, error?: unknown, meta?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" && !process.env.DEBUG_LOGS) return;
  const line = JSON.stringify({
    level,
    message,
    time: new Date().toISOString(),
    ...(meta || {}),
    ...(error !== undefined ? { error: serializeError(error) } : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, undefined, meta),
  warn: (message: string, error?: unknown, meta?: Record<string, unknown>) => write("warn", message, error, meta),
  error: (message: string, error?: unknown, meta?: Record<string, unknown>) => write("error", message, error, meta),
};
