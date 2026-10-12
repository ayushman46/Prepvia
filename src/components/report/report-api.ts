import { ClientApiError } from "@/lib/api";
import type { ApiErrorBody } from "@/lib/protocol";

/** "Try again": ask the server to restart a failed report generation. */
export async function restartReport(id: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`/api/report/${encodeURIComponent(id)}`, { method: "POST", cache: "no-store" });
  } catch {
    throw new ClientApiError(0, "network_error", "Can't reach the server. Check your connection and try again.");
  }
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as Partial<ApiErrorBody> | null;
  const retryAfter = Number(response.headers.get("retry-after"));
  throw new ClientApiError(
    response.status,
    body?.error?.code ?? "http_error",
    body?.error?.message ?? `Request failed (${response.status}). Please try again.`,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
  );
}
