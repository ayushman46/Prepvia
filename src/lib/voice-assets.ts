/**
 * The interview room needs ~5.6 MB of voice-detection runtime (Silero model and the
 * ONNX Runtime WASM) before its Start button works. The upload and setup screens take
 * the candidate many seconds, so the same files are fetched into the browser's HTTP
 * cache there; the room then finds them cached. Skipped on data-saver and 2G links.
 */
const VOICE_FILES = [
  "silero_vad_v5.onnx",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "vad.worklet.bundle.min.js",
];

let started = false;

/** Whether a background download of the voice runtime is worth it on this connection. */
export function shouldPrefetchVoice(connection?: { saveData?: boolean; effectiveType?: string } | null): boolean {
  if (!connection) return true;
  if (connection.saveData) return false;
  return connection.effectiveType !== "slow-2g" && connection.effectiveType !== "2g";
}

/** Start fetching the voice runtime into the HTTP cache (once per page load). */
export function prefetchVoiceAssets(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } };
  if (!shouldPrefetchVoice(nav.connection)) return;
  const base = process.env.NEXT_PUBLIC_VAD_ASSET_PATH || "/vad/";
  // Reading the body is what stores the response in the cache; failures are harmless (the room fetches again).
  for (const file of VOICE_FILES) {
    fetch(`${base}${file}`, { cache: "force-cache", priority: "low" } as RequestInit)
      .then((response) => response.arrayBuffer())
      .catch(() => undefined);
  }
}
