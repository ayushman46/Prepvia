#!/usr/bin/env node
/**
 * Load test: many concurrent candidates against the production server.
 * LLM/STT are simulated with realistic delays (no provider quota used); MongoDB
 * is real; Edge TTS is real unless --tts=off.
 *
 *   npm run build && node tests/load/run.mjs [--users=20] [--turns=6] [--tts=on|off]
 *
 * Reports p50/p95/p99 turn latencies, throughput, error rates, and verifies data
 * integrity afterwards (alternating transcripts, no leaked locks, one report each).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const USERS = Number(args.get("users") || 20);
const TURNS = Number(args.get("turns") || 6);
const TTS = (args.get("tts") || "on") !== "off";
const APP_PORT = 3500;
const FAKE_PORT = 4030;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DB_NAME = `interviewai_load_${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadEnvLocal() {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer().once("error", () => reject(new Error(`Port ${port} in use`)));
    probe.once("listening", () => probe.close(resolve)).listen(port, "127.0.0.1");
  });
}

const latencies = { first_sentence: [], first_audio: [], total: [], start: [], report: [] };
const counters = { turns: 0, errors: 0, http409: 0, http5xx: 0, audioErrors: 0, audioEvents: 0, network: 0 };

async function timedTurn(id, payload) {
  const t0 = performance.now();
  let res;
  try {
    // Each simulated candidate has its own IP so per-IP rate limits behave like production.
    res = await fetch(`${BASE}/api/interview/${id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify(payload),
    });
  } catch {
    counters.network++;
    return null;
  }
  if (res.status === 409) counters.http409++;
  if (res.status >= 500) counters.http5xx++;
  if (!res.ok) {
    counters.errors++;
    return null;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstSentence = null;
  let firstAudio = null;
  let error = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const event = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (event.type === "ai_sentence" && firstSentence === null) firstSentence = performance.now() - t0;
      if (event.type === "audio") {
        counters.audioEvents++;
        if (firstAudio === null) firstAudio = performance.now() - t0;
      }
      if (event.type === "audio_error") counters.audioErrors++;
      if (event.type === "error") error = true;
    }
  }
  counters.turns++;
  if (error) counters.errors++;
  if (firstSentence !== null) latencies.first_sentence.push(firstSentence);
  if (firstAudio !== null) latencies.first_audio.push(firstAudio);
  latencies.total.push(performance.now() - t0);
  return true;
}

async function candidate(index) {
  const ip = `10.1.${Math.floor(index / 250)}.${index % 250}`;
  const t0 = performance.now();
  const start = await fetch(`${BASE}/api/interview/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ name: `Load ${index}`, role: "Backend Engineer", resume_text: "Go, Postgres, Kafka", duration_minutes: 30 }),
  }).then((r) => r.json());
  latencies.start.push(performance.now() - t0);
  const id = start.session_id;
  await timedTurn(id, {});
  for (let t = 0; t < TURNS; t++) {
    await sleep(200 + Math.random() * 800); // think time
    await timedTurn(id, { text: `Answer ${t} from candidate ${index}: I used idempotency keys and an outbox table.` });
  }
  const r0 = performance.now();
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${BASE}/api/report/${id}`, { headers: { "X-Forwarded-For": ip } });
    if (res.status === 200) break;
    await sleep(500);
  }
  latencies.report.push(performance.now() - r0);
  return id;
}

const pct = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
};

loadEnvLocal();
if (!existsSync(join(root, ".next/BUILD_ID"))) throw new Error("Run `npm run build` first");
await assertPortFree(APP_PORT);
await assertPortFree(FAKE_PORT);

const fake = spawn(process.execPath, [join(root, "tests/e2e/fake-providers.mjs"), String(FAKE_PORT)], {
  stdio: "ignore",
  env: { ...process.env, FAKE_LLM_DELAY_MS: "350", FAKE_STT_DELAY_MS: "400" },
});
const app = spawn("npx", ["next", "start", "-p", String(APP_PORT)], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    NVIDIA_API_KEY: "fake",
    NVIDIA_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`,
    GROQ_API_KEY: "fake",
    GROQ_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`,
    MONGODB_DB_NAME: DB_NAME,
    TTS_ENABLED: TTS ? "true" : "false",
    RATE_LIMIT_SESSIONS_PER_HOUR: "1000",
    RATE_LIMIT_TURNS_PER_HOUR: "10000",
    RATE_LIMIT_REPORTS_PER_HOUR: "1000",
  },
});
const stderr = [];
app.stderr.on("data", (d) => stderr.push(d.toString()));

let exitCode = 1;
try {
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${BASE}/api/health`).catch(() => null))?.ok) break;
    await sleep(500);
  }
  console.log(`Load test: ${USERS} concurrent candidates × ${TURNS} turns, TTS ${TTS ? "real Edge" : "off"}, fake LLM 350 ms`);
  const t0 = performance.now();
  const ids = await Promise.all(Array.from({ length: USERS }, (_, i) => candidate(i)));
  const seconds = (performance.now() - t0) / 1000;

  // Integrity checks straight from MongoDB.
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const problems = [];
  for (const id of ids) {
    const transcripts = await db.collection("transcripts").find({ session_id: id }).sort({ timestamp: 1, _id: 1 }).toArray();
    const roles = transcripts.map((t) => t.role);
    const expected = 1 + TURNS * 2;
    if (roles.length !== expected) problems.push(`${id}: ${roles.length} transcript entries (expected ${expected})`);
    for (let i = 1; i < roles.length; i++) if (roles[i] === roles[i - 1]) problems.push(`${id}: consecutive ${roles[i]} at ${i}`);
    const session = await db.collection("sessions").findOne({ _id: id });
    if (session?.turn_lock_until) problems.push(`${id}: leaked turn lock`);
    if (session?.turn_count !== TURNS) problems.push(`${id}: turn_count ${session?.turn_count}`);
    const evaluations = await db.collection("evaluations").countDocuments({ session_id: id });
    if (evaluations !== 1) problems.push(`${id}: ${evaluations} evaluations`);
  }
  await db.dropDatabase();
  await client.close();

  const totalTurns = counters.turns;
  console.log(`\nCompleted ${totalTurns} turns in ${seconds.toFixed(1)}s (${(totalTurns / seconds).toFixed(1)} turns/s)`);
  console.table({
    "first sentence (ms)": { p50: pct(latencies.first_sentence, 0.5), p95: pct(latencies.first_sentence, 0.95), p99: pct(latencies.first_sentence, 0.99) },
    "first audio (ms)": { p50: pct(latencies.first_audio, 0.5), p95: pct(latencies.first_audio, 0.95), p99: pct(latencies.first_audio, 0.99) },
    "turn total (ms)": { p50: pct(latencies.total, 0.5), p95: pct(latencies.total, 0.95), p99: pct(latencies.total, 0.99) },
    "session start (ms)": { p50: pct(latencies.start, 0.5), p95: pct(latencies.start, 0.95), p99: pct(latencies.start, 0.99) },
    "report ready (ms)": { p50: pct(latencies.report, 0.5), p95: pct(latencies.report, 0.95), p99: pct(latencies.report, 0.99) },
  });
  console.log(
    `errors ${counters.errors}, 409 ${counters.http409}, 5xx ${counters.http5xx}, network ${counters.network}, audio ok ${counters.audioEvents}, audio fallbacks ${counters.audioErrors}`,
  );
  console.log(problems.length ? `Integrity problems (${problems.length}):\n  ${problems.slice(0, 15).join("\n  ")}` : "Integrity: all sessions consistent (alternating transcripts, no leaked locks, exactly one report each)");
  exitCode = counters.errors === 0 && counters.http5xx === 0 && problems.length === 0 ? 0 : 1;
} finally {
  app.kill("SIGTERM");
  fake.kill("SIGTERM");
  const errorLines = stderr.join("").split("\n").filter((l) => /"level":"error"/.test(l));
  if (errorLines.length) console.log(`\nServer error lines (${errorLines.length}):\n${errorLines.slice(0, 5).join("\n")}`);
}
process.exit(exitCode);
