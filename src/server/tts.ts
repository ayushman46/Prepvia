import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { config } from "./config";

/**
 * Microsoft Edge "Read Aloud" neural TTS over WebSocket (free, no API key).
 * Port of the protocol implemented by the `edge-tts` Python package (v7.2.x).
 */

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH_SECONDS = 11_644_473_600n;
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

const HEADERS: Record<string, string> = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent":
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
};

export class TtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsError";
  }
}

let clockSkewSeconds = 0;

/** Sec-MS-GEC: SHA-256 of Windows file-time ticks (rounded down to 5 minutes) + client token. */
export function generateSecMsGec(nowMs = Date.now() + clockSkewSeconds * 1000): string {
  let seconds = BigInt(Math.floor(nowMs / 1000)) + WIN_EPOCH_SECONDS;
  seconds -= seconds % 300n;
  const ticks = seconds * 10_000_000n;
  return createHash("sha256").update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, "ascii").digest("hex").toUpperCase();
}

function dateToString(): string {
  // JavaScript-style UTC date string expected by the service.
  return new Date().toUTCString().replace("GMT", "GMT+0000 (Coordinated Universal Time)");
}

export function escapeXml(text: string): string {
  return text
    // The service rejects some control characters (commonly found in OCR'd text).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSsml(text: string, voice: string, rate: string): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
    `${escapeXml(text)}</prosody></voice></speak>`
  );
}

function parseTextHeaders(message: string): Record<string, string> {
  const headerBlock = message.slice(0, message.indexOf("\r\n\r\n"));
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return headers;
}

class SkewError extends Error {}

const POOL_MAX_IDLE = 4;
/** Edge drops idle sockets after ~35 s (measured, close code 1006): recycle well before that. */
const IDLE_TTL_MS = 25_000;
/** If a sentence hasn't synthesized by now, race a second attempt on a fresh socket. */
const TTS_HEDGE_MS = 1_500;
const MAX_AGE_MS = 4 * 60_000;

/**
 * One Edge TTS WebSocket. A connection can serve many sequential synthesis
 * requests and stays usable while idle, so warm connections remove the
 * ~350-450 ms TLS + WebSocket handshake from the time-to-first-audio.
 */
class EdgeConnection {
  readonly ws: WebSocket;
  readonly ready: Promise<void>;
  readonly createdAt = Date.now();
  lastUsed = Date.now();
  busy = false;
  dead = false;
  /** True once the connection has served at least one request. */
  used = false;

  constructor() {
    const url =
      `${WSS_URL}&ConnectionId=${randomUUID().replace(/-/g, "")}` +
      `&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    this.ws = new WebSocket(url, {
      headers: { ...HEADERS, Cookie: `muid=${randomBytes(16).toString("hex").toUpperCase()};` },
      handshakeTimeout: config.tts.timeoutMs,
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once("unexpected-response", (_request, response) => {
        this.dead = true;
        const serverDate = response.headers.date ? Date.parse(response.headers.date) : NaN;
        if (response.statusCode === 403 && Number.isFinite(serverDate)) {
          clockSkewSeconds += (serverDate - (Date.now() + clockSkewSeconds * 1000)) / 1000;
          reject(new SkewError("Clock skew adjusted"));
        } else {
          reject(new TtsError(`TTS handshake failed with HTTP ${response.statusCode}`));
        }
      });
      this.ws.once("open", () => {
        this.ws.send(
          `X-Timestamp:${dateToString()}\r\n` +
            "Content-Type:application/json; charset=utf-8\r\n" +
            "Path:speech.config\r\n\r\n" +
            '{"context":{"synthesis":{"audio":{"metadataoptions":{' +
            '"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
            `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`,
        );
        resolve();
      });
      this.ws.once("error", (error) => {
        this.dead = true;
        reject(new TtsError(`TTS socket error: ${error.message}`));
      });
    });
    // Avoid unhandled rejections for prewarmed connections nobody awaited.
    this.ready.catch(() => undefined);
    this.ws.on("close", () => {
      this.dead = true;
    });
    this.ws.on("error", () => {
      this.dead = true;
    });
  }

  get healthy(): boolean {
    const state = this.ws.readyState;
    return (
      !this.dead &&
      (state === WebSocket.OPEN || state === WebSocket.CONNECTING) &&
      Date.now() - this.createdAt < MAX_AGE_MS &&
      Date.now() - this.lastUsed < IDLE_TTL_MS
    );
  }

  synthesize(text: string): Promise<Buffer> {
    const requestId = randomUUID().replace(/-/g, "");
    this.used = true;
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.ws.off("message", onMessage);
        this.ws.off("close", onClose);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.lastUsed = Date.now();
        if (error) {
          this.dead = true;
          reject(error);
        } else if (chunks.length === 0) {
          reject(new TtsError("No audio was received"));
        } else {
          resolve(Buffer.concat(chunks));
        }
      };
      const timer = setTimeout(() => finish(new TtsError("TTS timed out")), config.tts.timeoutMs);
      const onClose = () => finish(new TtsError("TTS socket closed before audio"));
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        if (!isBinary) {
          const headers = parseTextHeaders(buffer.toString("utf8"));
          if (headers.Path === "turn.end" && (!headers["X-RequestId"] || headers["X-RequestId"] === requestId)) finish();
          return;
        }
        if (buffer.length < 2) return finish(new TtsError("Malformed binary frame"));
        const headerLength = buffer.readUInt16BE(0);
        if (headerLength + 2 > buffer.length) return finish(new TtsError("Malformed binary frame header"));
        const headers = parseTextHeaders(`${buffer.subarray(2, 2 + headerLength).toString("utf8")}\r\n\r\n`);
        if (headers.Path !== "audio") return;
        if (headers["X-RequestId"] && headers["X-RequestId"] !== requestId) return;
        const audio = buffer.subarray(2 + headerLength);
        if (audio.length > 0 && headers["Content-Type"] === "audio/mpeg") chunks.push(Buffer.from(audio));
      };
      this.ws.on("message", onMessage);
      this.ws.once("close", onClose);
      try {
        this.ws.send(
          `X-RequestId:${requestId}\r\n` +
            "Content-Type:application/ssml+xml\r\n" +
            `X-Timestamp:${dateToString()}Z\r\n` +
            "Path:ssml\r\n\r\n" +
            buildSsml(text, config.tts.voice, config.tts.rate),
        );
      } catch (error) {
        finish(new TtsError(`TTS send failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  close(): void {
    this.dead = true;
    try {
      this.ws.terminate();
    } catch {
      // ignore
    }
  }
}

// Module-level pool: shared by every request handled by a warm instance.
const pool: EdgeConnection[] = [];

function sweep(): void {
  for (let i = pool.length - 1; i >= 0; i--) {
    if (!pool[i].busy && !pool[i].healthy) pool.splice(i, 1)[0].close();
  }
}

/**
 * Open connections ahead of time (call at the start of a turn, while STT and
 * the LLM are still running) so the first sentence can be synthesized at once.
 */
export function prewarmTts(count = 2): void {
  if (!config.tts.enabled) return;
  sweep();
  const idle = pool.filter((c) => !c.busy).length;
  for (let i = idle; i < Math.min(count, POOL_MAX_IDLE); i++) pool.push(new EdgeConnection());
}

function acquire(): EdgeConnection {
  sweep();
  // Prefer an already-open connection, then one that is still connecting.
  const open = pool.find((c) => !c.busy && c.ws.readyState === WebSocket.OPEN);
  const connection = open ?? pool.find((c) => !c.busy) ?? new EdgeConnection();
  if (!pool.includes(connection)) pool.push(connection);
  connection.busy = true;
  return connection;
}

function release(connection: EdgeConnection): void {
  connection.busy = false;
  connection.lastUsed = Date.now();
  if (!connection.healthy || pool.filter((c) => !c.busy).length > POOL_MAX_IDLE) {
    const index = pool.indexOf(connection);
    if (index !== -1) pool.splice(index, 1);
    connection.close();
  }
}

/** Close every pooled connection (tests and graceful shutdown). */
export function closeTtsPool(): void {
  while (pool.length) pool.pop()?.close();
}

export function ttsPoolSize(): number {
  return pool.length;
}

/** One synthesis on a pooled connection, retrying once on a fresh socket if it fails. */
async function synthesizePooled(clean: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const connection = acquire();
    try {
      await connection.ready;
      const audio = await connection.synthesize(clean);
      release(connection);
      return audio;
    } catch (error) {
      lastError = error;
      connection.busy = false;
      const index = pool.indexOf(connection);
      if (index !== -1) pool.splice(index, 1);
      connection.close();
      // A stale pooled socket or a skew correction deserves one fresh attempt;
      // a timeout does not (it would double an already long wait).
      if (error instanceof TtsError && /timed out/.test(error.message)) break;
    }
  }
  throw lastError instanceof Error ? lastError : new TtsError("TTS failed");
}

/** A synthesis on a brand-new, unpooled connection (used to hedge a slow attempt). */
async function synthesizeFresh(clean: string): Promise<Buffer> {
  const connection = new EdgeConnection();
  try {
    await connection.ready;
    return await connection.synthesize(clean);
  } finally {
    connection.close();
  }
}

/**
 * Synthesize one sentence to MP3 bytes on a warm pooled connection. Tail
 * latency is bounded by hedging: if the pooled attempt is still running after
 * TTS_HEDGE_MS, a second attempt races it on a fresh socket.
 */
export async function synthesizeSentence(text: string): Promise<Buffer> {
  const clean = text.trim();
  if (!clean) throw new TtsError("Empty text");
  const primary = synthesizePooled(clean);
  const early = await Promise.race([
    primary.then(
      (audio) => ({ audio }),
      (error) => ({ error }),
    ),
    new Promise<"slow">((resolve) => setTimeout(() => resolve("slow"), TTS_HEDGE_MS)),
  ]);
  if (early !== "slow") {
    if ("error" in early) throw early.error;
    return early.audio;
  }
  const hedge = synthesizeFresh(clean);
  hedge.catch(() => undefined);
  primary.catch(() => undefined);
  try {
    return await Promise.any([primary, hedge]);
  } catch (error) {
    const reasons = error instanceof AggregateError ? error.errors : [error];
    throw reasons[0] instanceof Error ? reasons[0] : new TtsError("TTS failed");
  }
}

/** Test-only hook: simulate the remote side dropping pooled sockets. */
export function __dropPooledSocketsForTests(): number {
  let dropped = 0;
  for (const connection of pool) {
    if (!connection.busy) {
      connection.ws.terminate(); // leaves `dead` to be discovered via the close event
      dropped++;
    }
  }
  return dropped;
}
