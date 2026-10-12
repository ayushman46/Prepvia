#!/usr/bin/env node
/**
 * AUDIO CAPTURE COMPLETENESS — does the app take the candidate's whole answer?
 *
 * Real Chromium, real Silero VAD and noise gate, real server, real Groq Whisper
 * (default) and real Edge TTS. The interviewer LLM is the fake provider (instant,
 * canned questions) so dozens of answers can be tested without NVIDIA quota.
 *
 * Each clip is composed from macOS `say` segments (voices, speeds, volumes,
 * thinking pauses, background noise) and played into a programmable microphone.
 * For every clip the harness measures, from ground truth:
 *   - audio coverage: which of the clip's voiced 10 ms frames are inside the audio
 *     the app actually transcribed (captured request bodies, aligned by
 *     cross-correlation), with head / tail / gap loss in ms;
 *   - word recall and WER of what the server transcribed (the candidate's bubbles)
 *     against the script, and whether the first and last words survived;
 *   - how many turns the answer became and any "please repeat" notices.
 *
 *   npm run build && node tests/live-browser/audio-capture.mjs [--stt=real|fake] [--only=id,id] [--headed]
 *
 * Writes test-results/audio-capture-<timestamp>.json.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const APP_PORT = Number(args.get("port") || 3310);
const FAKE_PORT = APP_PORT + 720;
const BASE = `http://localhost:${APP_PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const DB_NAME = `interviewai_audio_${Date.now().toString(36)}`;
const STT = args.get("stt") || "real";
const ONLY = args.get("only")?.split(",");
const HEADED = args.get("headed") === "true";
const DEV = args.get("dev") === "true";
const RATE = 16_000;

function loadEnvLocal() {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
loadEnvLocal();
if (STT === "real" && !process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY missing (.env.local) for --stt=real");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, { timeout = 30_000, interval = 100, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${message}`);
}
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer().once("error", () => reject(new Error(`Port ${port} is in use.`)));
    probe.once("listening", () => probe.close(resolve)).listen(port, "127.0.0.1");
  });
}

// ------------------------------------------------------------- audio fixtures

const work = mkdtempSync(join(tmpdir(), "audio-capture-"));
let synthCount = 0;

function readWav(buffer) {
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("latin1", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") format = { channels: buffer.readUInt16LE(offset + 10), rate: buffer.readUInt32LE(offset + 12), bits: buffer.readUInt16LE(offset + 22) };
    if (id === "data") {
      const end = Math.min(buffer.length, offset + 8 + size);
      const samples = new Float32Array(Math.floor((end - offset - 8) / 2 / (format?.channels ?? 1)));
      for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(offset + 8 + i * 2 * (format?.channels ?? 1)) / 32768;
      return { rate: format?.rate ?? RATE, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk");
}

function writeWav(samples, rate = RATE) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return out;
}

function say(text, voice = "Samantha", rate) {
  const file = join(work, `s${synthCount++}.wav`);
  const sayArgs = ["-v", voice, "-o", file, `--data-format=LEI16@${RATE}`];
  if (rate) sayArgs.push("-r", String(rate));
  execFileSync("say", [...sayArgs, text]);
  const wav = readWav(readFileSync(file));
  if (wav.rate !== RATE) throw new Error(`say produced ${wav.rate} Hz`);
  // Trim say's own leading/trailing silence so pauses are exactly what the clip specifies.
  const threshold = 0.004;
  let start = 0;
  let end = wav.samples.length;
  while (start < end && Math.abs(wav.samples[start]) < threshold) start++;
  while (end > start && Math.abs(wav.samples[end - 1]) < threshold) end--;
  return wav.samples.slice(Math.max(0, start - 80), Math.min(wav.samples.length, end + 80));
}

/** Deterministic noise so runs are comparable. */
function noiseSource(seed = 7) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/**
 * Compose a clip. Segments: { text, voice?, rate?, gain? } or { pause: ms }.
 * Options: { lead: ms of silence before, tail: ms after, noise: RMS of a noise bed }.
 */
function compose(segments, { lead = 400, tail = 300, noise = 0, defaultVoice = "Samantha" } = {}) {
  const parts = [];
  const words = [];
  let total = Math.round((lead / 1000) * RATE);
  const speechRanges = [];
  parts.push(new Float32Array(total));
  for (const segment of segments) {
    if (segment.pause) {
      const n = Math.round((segment.pause / 1000) * RATE);
      parts.push(new Float32Array(n));
      total += n;
      continue;
    }
    const audio = say(segment.text, segment.voice ?? defaultVoice, segment.rate);
    if (segment.gain) for (let i = 0; i < audio.length; i++) audio[i] *= segment.gain;
    speechRanges.push([total, total + audio.length]);
    parts.push(audio);
    total += audio.length;
    words.push(segment.text);
  }
  const tailN = Math.round((tail / 1000) * RATE);
  parts.push(new Float32Array(tailN));
  total += tailN;
  const samples = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  if (noise) {
    const rand = noiseSource();
    // Brown-ish noise bed (more like a room than white hiss), scaled to the requested RMS.
    let last = 0;
    const bed = new Float32Array(samples.length);
    for (let i = 0; i < bed.length; i++) {
      last = last * 0.97 + rand() * 0.3;
      bed[i] = last;
    }
    const bedRms = Math.sqrt(bed.reduce((n, v) => n + v * v, 0) / bed.length);
    for (let i = 0; i < samples.length; i++) samples[i] += (bed[i] / bedRms) * noise;
  }
  return { samples, text: words.join(" "), speechRanges, seconds: samples.length / RATE };
}

const ANSWER_A =
  "In my last role I owned the payments ledger service. We were seeing duplicate charges during retries, so I introduced idempotency keys stored in Postgres with a unique index, and the duplicate rate dropped to zero within a week.";
const ANSWER_B =
  "I would start by profiling the slow endpoint, because guessing usually wastes time. Once I found the hot query, I added a covering index and cached the merchant settings in Redis with a five minute expiry.";
const ANSWER_C =
  "Honestly I have not used Kafka in production, but I understand the model: partitions give you ordering per key, and consumer groups let you scale reads horizontally.";

const CLIPS = [
  { id: "short-yes", what: "one-word answer", segments: [{ text: "Yes." }] },
  { id: "short-no", what: "one-word answer (male UK voice)", segments: [{ text: "No.", voice: "Daniel" }] },
  { id: "short-phrase", what: "short phrase", segments: [{ text: "Around two years." }] },
  { id: "short-unsure", what: "short phrase, quiet", segments: [{ text: "I'm not sure, sorry.", gain: 0.45 }] },
  { id: "normal-us", what: "15 s answer, US female", segments: [{ text: ANSWER_A }] },
  { id: "normal-uk", what: "15 s answer, UK male", segments: [{ text: ANSWER_B, voice: "Daniel" }] },
  { id: "normal-in", what: "12 s answer, Indian English", segments: [{ text: ANSWER_C, voice: "Rishi" }] },
  { id: "normal-au", what: "15 s answer, Australian", segments: [{ text: ANSWER_B, voice: "Karen" }] },
  { id: "fast", what: "fast talker (260 wpm)", segments: [{ text: ANSWER_A, rate: 260 }] },
  { id: "slow", what: "slow talker (120 wpm)", segments: [{ text: ANSWER_C, rate: 120 }] },
  { id: "quiet", what: "quiet speaker (-14 dB)", segments: [{ text: ANSWER_B, gain: 0.2 }] },
  { id: "noisy-room", what: "answer over a room-noise bed", segments: [{ text: ANSWER_A }], noise: 0.012 },
  { id: "soft-ends", what: "soft first and last words", segments: [{ text: "So,", gain: 0.3 }, { pause: 250 }, { text: "I think the main issue was the connection pool size" }, { pause: 300 }, { text: "honestly.", gain: 0.3 }] },
  { id: "pause-1.0", what: "1.0 s thinking pause mid-answer", segments: [{ text: "The first thing I would check is the database" }, { pause: 1000 }, { text: "and then the cache hit rate for the merchant lookups." }] },
  { id: "pause-1.5", what: "1.5 s thinking pause mid-answer", segments: [{ text: "I chose Postgres because we needed transactions" }, { pause: 1500 }, { text: "and the team already knew it well, which mattered for on call." }] },
  { id: "pause-2.0", what: "2.0 s thinking pause after a conjunction", segments: [{ text: "We split the monolith into three services, and" }, { pause: 2000 }, { text: "the hardest part was migrating the shared user table without downtime." }] },
  { id: "pause-3.0", what: "3.0 s thinking pause, two thoughts", segments: [{ text: "My biggest weakness is probably delegation." }, { pause: 3000 }, { text: "Lately I have been pairing junior engineers on design reviews to get better at it." }] },
  { id: "think-3s", what: "\"Let me think.\" then 3 s of silence", segments: [{ text: "Let me think." }, { pause: 3000 }, { text: "I would keep a min heap of size k and compare each new element with the root." }] },
  { id: "two-continuations", what: "finished sentence, then two more after 1.2 s pauses", segments: [
    { text: "I would add a cache in front of the database." }, { pause: 1200 },
    { text: "Probably Redis, with a short expiry." }, { pause: 1200 },
    { text: "And I would watch the hit rate closely after launch." },
  ] },
  { id: "long-110s", what: "~110 s answer with natural pauses", segments: [
    { text: ANSWER_A }, { pause: 700 }, { text: ANSWER_B }, { pause: 600 }, { text: ANSWER_C }, { pause: 700 },
    { text: "Beyond the technical side, I spent a lot of time on reviews. I tried to make every review a teaching moment rather than a gate, and I wrote short design notes so new engineers could see why decisions were made." }, { pause: 600 },
    { text: "Looking back, the thing I am proudest of is that the on call load went down every quarter, because we fixed root causes instead of patching data by hand." },
    { pause: 600 }, { text: ANSWER_A, voice: "Daniel" }, { pause: 600 }, { text: "That is the full story, and the final lesson was to measure everything before optimizing." },
  ] },
].filter((clip) => !ONLY || ONLY.includes(clip.id));

// ------------------------------------------------------------- measurement

const FRAME = 160; // 10 ms at 16 kHz

function envelope(samples) {
  const out = new Float32Array(Math.floor(samples.length / FRAME));
  for (let f = 0; f < out.length; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += samples[i] * samples[i];
    out[f] = Math.sqrt(sum / FRAME);
  }
  return out;
}

/**
 * Offset (in frames) of `piece` inside `clip`: the lag with the highest Pearson
 * correlation of their envelopes, over overlaps of at least half the piece (short
 * overlaps of silence against silence would otherwise win).
 */
function align(clipEnv, pieceEnv) {
  const minOverlap = Math.max(20, Math.floor(Math.min(pieceEnv.length, clipEnv.length) / 2));
  let best = { lag: 0, score: -Infinity };
  for (let lag = -pieceEnv.length + minOverlap; lag <= clipEnv.length - minOverlap; lag++) {
    const from = Math.max(0, -lag);
    const to = Math.min(pieceEnv.length, clipEnv.length - lag);
    const n = to - from;
    if (n < minOverlap) continue;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let j = from; j < to; j++) {
      const x = clipEnv[j + lag];
      const y = pieceEnv[j];
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    const cov = sab - (sa * sb) / n;
    const score = cov / Math.sqrt(Math.max(1e-12, (saa - (sa * sa) / n) * (sbb - (sb * sb) / n)));
    if (score > best.score) best = { lag, score };
  }
  return best.lag;
}

function coverage(clip, pieces) {
  const clipEnv = envelope(clip.samples);
  const voiced = new Uint8Array(clipEnv.length);
  for (const [start, end] of clip.speechRanges) {
    for (let f = Math.floor(start / FRAME); f < Math.ceil(end / FRAME) && f < voiced.length; f++) if (clipEnv[f] > 0.003) voiced[f] = 1;
  }
  const covered = new Uint8Array(clipEnv.length);
  const spans = [];
  for (const piece of pieces) {
    const env = envelope(piece);
    if (env.length < 20) continue;
    const lag = align(clipEnv, env);
    spans.push([lag, lag + env.length]);
    for (let f = Math.max(0, lag); f < Math.min(covered.length, lag + env.length); f++) covered[f] = 1;
  }
  let total = 0;
  let hit = 0;
  let firstVoiced = -1;
  let lastVoiced = -1;
  for (let f = 0; f < voiced.length; f++) {
    if (!voiced[f]) continue;
    total++;
    if (covered[f]) hit++;
    if (firstVoiced < 0) firstVoiced = f;
    lastVoiced = f;
  }
  const firstCovered = covered.indexOf(1);
  const lastCovered = covered.lastIndexOf(1);
  let headLoss = 0;
  let tailLoss = 0;
  for (let f = firstVoiced; f <= lastVoiced; f++) {
    if (!voiced[f] || covered[f]) continue;
    if (firstCovered < 0 || f < firstCovered) headLoss++;
    else if (f > lastCovered) tailLoss++;
  }
  return {
    voiced_ms: total * 10,
    coverage: total ? hit / total : 0,
    lost_ms: (total - hit) * 10,
    head_loss_ms: headLoss * 10,
    tail_loss_ms: tailLoss * 10,
    gap_loss_ms: (total - hit - headLoss - tailLoss) * 10,
    spans_ms: spans.map(([a, b]) => [a * 10, b * 10]),
  };
}

const wordsOf = (text) =>
  (text.toLowerCase().replace(/(\d),(\d)/g, "$1$2").match(/[a-z0-9']+/g) ?? []).map((w) => w.replace(/'/g, "")).map((w) => NUMBER_WORDS[w] ?? w);
const NUMBER_WORDS = { "2": "two", "3": "three", "5": "five", "10": "ten", zero: "zero", "0": "zero" };

/** Word error rate (Levenshtein over words) and in-order recall of reference words. */
function wordStats(reference, hypothesis) {
  const ref = wordsOf(reference);
  const hyp = wordsOf(hypothesis);
  const d = Array.from({ length: ref.length + 1 }, (_, i) => [i, ...Array(hyp.length).fill(0)]);
  for (let j = 1; j <= hyp.length; j++) d[0][j] = j;
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
  }
  // Longest common subsequence = reference words recovered in order.
  const l = Array.from({ length: ref.length + 1 }, () => Array(hyp.length + 1).fill(0));
  for (let i = 1; i <= ref.length; i++) {
    for (let j = 1; j <= hyp.length; j++) l[i][j] = ref[i - 1] === hyp[j - 1] ? l[i - 1][j - 1] + 1 : Math.max(l[i - 1][j], l[i][j - 1]);
  }
  const has = (word) => hyp.includes(word);
  return {
    wer: ref.length ? d[ref.length][hyp.length] / ref.length : 0,
    recall: ref.length ? l[ref.length][hyp.length] / ref.length : 0,
    first_word: has(ref[0]),
    last_words: ref.slice(-2).every(has),
  };
}

// ------------------------------------------------------------- browser hooks

/** Records every audio body the app uploads, and every notice it shows. */
const INSTRUMENT = () => {
  window.__uploads = [];
  window.__notices = [];
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const match = /\/api\/interview\/[^/]+\/(turn|transcribe)/.exec(url);
    if (match && init?.body instanceof Blob && /wav/.test(init.body.type)) {
      const bytes = new Uint8Array(await init.body.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      window.__uploads.push({ t: performance.now(), kind: match[1], b64: btoa(binary) });
    } else if (match && typeof init?.body === "string") {
      window.__uploads.push({ t: performance.now(), kind: `${match[1]}-text`, text: init.body });
    }
    return originalFetch(input, init);
  };
  new MutationObserver(() => {
    const notice = document.querySelector("[data-testid='notice']")?.textContent?.trim();
    if (notice && window.__notices.at(-1) !== notice) window.__notices.push(notice);
  }).observe(document, { subtree: true, childList: true, characterData: true });
};

const statusText = (page) => page.getByTestId("status").innerText().catch(() => "");
async function waitForTurn(page, timeout = 90_000) {
  await waitUntil(async () => /Your turn/.test(await statusText(page)), { timeout, interval: 100, message: "candidate's turn" });
}

/** Wait until the conversation is quiet: candidate's turn, nothing pending, stable for `stableMs`. */
async function settle(page, stableMs = 3_000, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let since = 0;
  let last = "";
  while (Date.now() < deadline) {
    const status = await statusText(page);
    const count = await page.getByTestId("msg-user").count();
    const pending = await page.locator("[data-testid='msg-user'][data-pending='true'], [data-testid='msg-ai'][data-pending='true']").count();
    const key = `${status}|${count}`;
    if (/Your turn/.test(status) && !pending && key === last) {
      if (!since) since = Date.now();
      if (Date.now() - since >= stableMs) return;
    } else {
      since = 0;
    }
    last = key;
    await sleep(150);
  }
  throw new Error("conversation never settled");
}

// ------------------------------------------------------------------- run

const children = [];
const evidence = join(root, "test-results", "audio-capture");
mkdirSync(evidence, { recursive: true });
await assertPortFree(APP_PORT);
await assertPortFree(FAKE_PORT);

console.log(`Synthesizing ${CLIPS.length} clips…`);
for (const clip of CLIPS) {
  Object.assign(clip, compose(clip.segments, { noise: clip.noise }));
  clip.b64 = writeWav(clip.samples).toString("base64");
}

const fake = spawn(process.execPath, [join(root, "tests/e2e/fake-providers.mjs"), String(FAKE_PORT)], {
  stdio: "ignore",
  env: { ...process.env, FAKE_LLM_DELAY_MS: "350", FAKE_STT_DELAY_MS: "350", FAKE_STT_DEFAULT_EMPTY: "1", FAKE_STT_STICKY: "1" },
});
children.push(fake);
const app = spawn("npx", ["next", DEV ? "dev" : "start", "-p", String(APP_PORT)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NVIDIA_API_KEY: "fake-nvidia",
    NVIDIA_BASE_URL: `${FAKE}/v1`,
    LLM_FALLBACK_GROQ: "false",
    ANALYSIS_EVERY_N_ANSWERS: "0",
    GROQ_API_KEY: STT === "real" ? process.env.GROQ_API_KEY : "fake-groq",
    GROQ_BASE_URL: STT === "real" ? "https://api.groq.com/openai/v1" : `${FAKE}/v1`,
    MONGODB_DB_NAME: DB_NAME,
    RATE_LIMIT_TURNS_PER_HOUR: "2000",
    MAX_TURNS_PER_SESSION: "200",
  },
});
const serverLogs = [];
app.stdout.on("data", (d) => serverLogs.push(d.toString()));
app.stderr.on("data", (d) => serverLogs.push(d.toString()));
children.push(app);

const browser = await chromium.launch({ headless: !HEADED, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
const rows = [];
let exitCode = 1;
try {
  await waitUntil(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok, { timeout: 90_000, message: "app health" });
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 860 } });
  await context.addInitScript({ path: join(root, "tests/live-browser/fake-mic.js") });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

  const newSession = async () => {
    const res = await fetch(`${BASE}/api/interview/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Audio Tester",
        role: "Backend Engineer",
        resume_text: "Backend engineer, 6 years. Go, Postgres, Kafka, Redis. Built a payments ledger with idempotency keys.",
        job_description: "Backend Engineer, Payments.",
        duration_minutes: 45,
        interview_type: "behavioral",
        level: "mid",
      }),
    });
    const { session_id: id } = await res.json();
    await page.goto(`${BASE}/interview/${id}?debug=1`);
    await waitUntil(() => page.getByTestId("start").isEnabled(), { timeout: 60_000, message: "Start enabled" });
    await page.getByTestId("start").click();
    await waitForTurn(page);
    return id;
  };

  let sessionId = await newSession();
  let turnsInSession = 0;
  for (const clip of CLIPS) {
    if (turnsInSession >= 12) {
      sessionId = await newSession();
      turnsInSession = 0;
    }
    if (STT === "fake") await fetch(`${FAKE}/set-transcript`, { method: "POST", body: JSON.stringify({ text: clip.text }) });
    await settle(page, 1_500);
    const usersBefore = await page.getByTestId("msg-user").count();
    const uploadsBefore = await page.evaluate(() => window.__uploads.length);
    const noticesBefore = await page.evaluate(() => window.__notices.length);
    const started = Date.now();
    const playStartedAt = await page.evaluate(() => performance.now());
    const audioBefore = await page.evaluate(() => window.__audioStarts.length);
    const clipEndedAt = await page.evaluate((b64) => window.__fakeMic.play(b64), clip.b64);
    await settle(page, 3_500);
    // Speech end → first interviewer audio (the clip ends with its own trailing silence).
    const replyStart = await page.evaluate(
      ({ from, after }) => window.__audioStarts.slice(from).find((s) => !s.mic && s.t > after)?.t ?? null,
      { from: audioBefore, after: clipEndedAt - 300 },
    );
    const aiReplies = await page.evaluate((from) => window.__audioStarts.slice(from).filter((s) => !s.mic).length, audioBefore);
    const bubbles = (await page.getByTestId("msg-user").allInnerTexts()).slice(usersBefore).map((t) => t.trim());
    const uploads = await page.evaluate((from) => window.__uploads.slice(from), uploadsBefore);
    const notices = await page.evaluate((from) => window.__notices.slice(from), noticesBefore);

    // The audio each turn was transcribed from: an uploaded turn, or the speculation a text turn used.
    const effective = [];
    let lastSpeculation = null;
    for (const upload of uploads) {
      if (upload.kind === "transcribe") lastSpeculation = upload.b64;
      else if (upload.kind === "turn") effective.push(upload.b64);
      else if (upload.kind === "turn-text" && lastSpeculation) effective.push(lastSpeculation);
    }
    const pieces = effective.map((b64) => readWav(Buffer.from(b64, "base64")).samples);
    const cov = coverage(clip, pieces);
    // Keep the evidence: the clip, what the app transcribed from, and the VAD trace.
    writeFileSync(join(evidence, `${clip.id}.clip.wav`), writeWav(clip.samples));
    pieces.forEach((piece, i) => writeFileSync(join(evidence, `${clip.id}.captured-${i + 1}.wav`), writeWav(piece)));
    const trace = await page.evaluate((from) => (window.__vadProbs ?? []).filter((f) => f.t >= from).map((f) => [Math.round(f.t - from), +f.p.toFixed(3), +f.rms.toFixed(4), +f.floor.toFixed(4)]), playStartedAt);
    writeFileSync(join(evidence, `${clip.id}.vad.json`), JSON.stringify(trace));
    const words = wordStats(clip.text, bubbles.join(" "));
    const row = {
      id: clip.id,
      what: clip.what,
      clip_s: Number(clip.seconds.toFixed(1)),
      turns: bubbles.length,
      coverage: Number(cov.coverage.toFixed(3)),
      head_loss_ms: cov.head_loss_ms,
      tail_loss_ms: cov.tail_loss_ms,
      gap_loss_ms: cov.gap_loss_ms,
      captured_s: Number((pieces.reduce((n, p) => n + p.length, 0) / RATE).toFixed(1)),
      recall: Number(words.recall.toFixed(3)),
      wer: Number(words.wer.toFixed(3)),
      first_word: words.first_word,
      last_words: words.last_words,
      notices,
      transcript: bubbles,
      reference: clip.text,
      uploads: uploads.map((u) => u.kind),
      reply_ms: replyStart === null ? null : Math.round(replyStart - (clipEndedAt - 300)),
      ai_audio_starts: aiReplies,
      ms: Date.now() - started,
    };
    // Complete = every word reached the interviewer, in one turn, with no "please repeat".
    row.complete = row.coverage >= 0.98 && row.recall >= 0.9 && row.first_word && row.last_words && row.turns === 1 && !notices.some((n) => /repeat|didn't catch/i.test(n));
    rows.push(row);
    turnsInSession += Math.max(1, bubbles.length);
    console.log(
      `${row.complete ? "✓" : "✗"} ${clip.id.padEnd(17)} ${String(row.clip_s).padStart(5)}s  turns ${row.turns}  coverage ${(row.coverage * 100).toFixed(1)}% (head ${row.head_loss_ms} tail ${row.tail_loss_ms} gap ${row.gap_loss_ms} ms)  recall ${(row.recall * 100).toFixed(0)}%  WER ${(row.wer * 100).toFixed(0)}%  reply ${row.reply_ms ?? "-"} ms${notices.length ? `  notices: ${notices.join(" | ")}` : ""}`,
    );
    if (!row.complete) console.log(`    heard: ${bubbles.map((b) => `"${b}"`).join(" + ") || "(nothing)"}`);
    if (STT === "real") await sleep(2_500); // stay well inside Groq's 20 requests/minute
  }
  // Ending the interview right after speaking (before the end-of-turn silence) must
  // still save that answer, so the report covers it.
  if (!ONLY || ONLY.includes("end-right-after")) {
    sessionId = await newSession();
    await settle(page, 1_500);
    const clip = compose([{ text: "My last answer is that I would add tracing first, and" }]);
    await page.evaluate((b64) => window.__fakeMic.play(b64), writeWav(clip.samples).toString("base64"));
    await page.getByRole("button", { name: "End interview" }).click();
    await page.getByRole("button", { name: /End & get report|End anyway/ }).click();
    await page.waitForURL(/\/report\//, { timeout: 30_000 });
    const view = await (await fetch(`${BASE}/api/interview/${sessionId}`)).json();
    const saved = view.transcript.filter((m) => m.role === "user").map((m) => m.content).join(" ");
    const words = wordStats(clip.text, saved);
    const row = { id: "end-right-after", what: "End clicked ~0.3 s after an unfinished sentence", turns: view.transcript.filter((m) => m.role === "user").length, recall: Number(words.recall.toFixed(3)), transcript: [saved], reference: clip.text };
    row.complete = row.recall >= 0.9;
    rows.push(row);
    console.log(`${row.complete ? "✓" : "✗"} ${row.id.padEnd(17)} saved before ending: "${saved}" (recall ${(row.recall * 100).toFixed(0)}%)`);
  }
  if (problems.length) console.log(`\nPage errors:\n${problems.join("\n")}`);
  await context.close();
  exitCode = rows.every((r) => r.complete) ? 0 : 1;
} finally {
  await browser.close();
  for (const child of children) child.kill("SIGTERM");
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    await client.db(DB_NAME).dropDatabase();
  } catch {
    // best effort
  } finally {
    await client.close();
  }
}

const errors = serverLogs.join("").split("\n").filter((l) => /"level":"error"/.test(l));
if (errors.length) console.log(`\nServer errors:\n${errors.slice(0, 8).join("\n")}`);
mkdirSync(join(root, "test-results"), { recursive: true });
const out = join(root, "test-results", `audio-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ stt: STT, rows }, null, 2));
const complete = rows.filter((r) => r.complete).length;
const covered = rows.filter((r) => typeof r.coverage === "number");
console.log(`\n${complete}/${rows.length} answers captured completely · mean coverage ${((covered.reduce((n, r) => n + r.coverage, 0) / covered.length) * 100).toFixed(1)}% · details: ${out}`);
process.exit(exitCode);
