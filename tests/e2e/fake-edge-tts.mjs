#!/usr/bin/env node
/**
 * Stand-in for Microsoft's Edge read-aloud WebSocket, speaking the same protocol the
 * app's TTS client uses (speech.config, then one ssml request per sentence, answered
 * with binary audio frames and a turn.end). Audio is real speech: macOS `say` rendered
 * to AAC/MP4, so the browser decodes and plays it through the same Web Audio path as
 * Edge's MP3. Used when Microsoft's service refuses the connection (HTTP 403).
 *
 *   node tests/e2e/fake-edge-tts.mjs [port]      then run the app with
 *   TTS_WSS_URL="ws://127.0.0.1:<port>/edge?fake=1"
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] || 4090);
const dir = mkdtempSync(join(tmpdir(), "fake-edge-"));
const cache = new Map();
let counter = 0;

/** Real speech for a sentence (cached: the same sentence is rendered once). */
function speech(text) {
  if (cache.has(text)) return cache.get(text);
  const aiff = join(dir, `s${counter++}.aiff`);
  const m4a = aiff.replace(/\.aiff$/, ".m4a");
  execFileSync("say", ["-v", "Samantha", "-r", "185", "-o", aiff, text]);
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac", aiff, m4a]);
  const bytes = readFileSync(m4a);
  cache.set(text, bytes);
  return bytes;
}

function textFrame(headers) {
  return Buffer.from(Object.entries(headers).map(([k, v]) => `${k}:${v}`).join("\r\n") + "\r\n\r\n");
}

function audioFrame(requestId, audio) {
  const header = textFrame({ "X-RequestId": requestId, "Content-Type": "audio/mpeg", "X-StreamId": "1", Path: "audio" });
  const length = Buffer.alloc(2);
  length.writeUInt16BE(header.length, 0);
  return Buffer.concat([length, header, audio]);
}

const server = new WebSocketServer({ port, host: "127.0.0.1" });
let requests = 0;
server.on("connection", (socket) => {
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const message = data.toString("utf8");
    const headers = Object.fromEntries(
      message
        .slice(0, message.indexOf("\r\n\r\n"))
        .split("\r\n")
        .map((line) => {
          const i = line.indexOf(":");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    if (headers.Path !== "ssml") return;
    requests += 1;
    const requestId = headers["X-RequestId"];
    // The sentence is the text between the prosody tags (the client escapes XML entities).
    const body = message.slice(message.indexOf("\r\n\r\n") + 4);
    const raw = body.match(/<prosody[^>]*>([\s\S]*)<\/prosody>/)?.[1] ?? "";
    const text = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    socket.send(textFrame({ "X-RequestId": requestId, "Content-Type": "application/json; charset=utf-8", Path: "turn.start" }).toString("utf8"));
    socket.send(audioFrame(requestId, speech(text)));
    socket.send(textFrame({ "X-RequestId": requestId, "Content-Type": "application/json; charset=utf-8", Path: "turn.end" }).toString("utf8"));
  });
});

console.log(`fake Edge TTS listening on ws://127.0.0.1:${port}/edge?fake=1`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`fake Edge TTS served ${requests} sentences`);
    server.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
}
