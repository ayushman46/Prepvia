#!/usr/bin/env node
/**
 * LIVE browser test — real Chromium, real Silero VAD, real NVIDIA LLM, real Edge
 * TTS, real MongoDB, real Web Audio playback. A programmable fake microphone
 * (fake-mic.js) "speaks" recorded answers (macOS `say`) into the app. Speech-to-
 * text is simulated with realistic latency (set GROQ_API_KEY_LIVE to use real Groq).
 *
 *   npm run build && node tests/live-browser/run.mjs [--scenario=conversation|canvas|all] [--headed]
 *
 * Writes a JSON summary to test-results/live-browser-*.json.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_PORT = 3300;
const FAKE_PORT = 4020;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const DB_NAME = `interviewai_live_${Date.now().toString(36)}`;
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const SCENARIO = args.get("scenario") || "all";
const HEADED = args.get("headed") === "true";
const STT_DELAY_MS = Number(process.env.FAKE_STT_DELAY_MS || 450);

const results = [];
const latencyRows = [];
const notes = [];

// ---------------------------------------------------------------- utilities

function loadEnvLocal() {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, { timeout = 30_000, interval = 100, message = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${message}`);
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer().once("error", () => reject(new Error(`Port ${port} is in use; stop that process first.`)));
    probe.once("listening", () => probe.close(resolve)).listen(port, "127.0.0.1");
  });
}

let currentPage = null;
async function step(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ✓ ${name} (${Date.now() - started}ms)${detail ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
    return true;
  } catch (error) {
    let screenshot;
    if (currentPage) {
      mkdirSync(join(root, "test-results"), { recursive: true });
      screenshot = join(root, "test-results", `failure-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}.png`);
      await currentPage.screenshot({ path: screenshot, fullPage: false }).catch(() => (screenshot = undefined));
    }
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message || error), screenshot });
    console.log(`  ✗ ${name}\n    ${error?.stack?.split("\n").slice(0, 3).join("\n    ") || error}`);
    return false;
  }
}

const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};
const postJson = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const setTranscript = (text) =>
  fetch(`${FAKE}/set-transcript`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });

function speak(dir, name, text) {
  const out = join(dir, `${name}.wav`);
  try {
    execFileSync("say", ["-v", "Samantha", "-o", out, "--data-format=LEI16@24000", text]);
  } catch {
    execFileSync("say", ["-o", out, "--data-format=LEI16@24000", text]);
  }
  return readFileSync(out).toString("base64");
}

// ------------------------------------------------------------ page helpers

const statusText = (page) => page.getByTestId("status").innerText().catch(() => "");
async function waitForStatus(page, pattern, timeout = 60_000) {
  return waitUntil(async () => pattern.test(await statusText(page)), { timeout, interval: 80, message: `status ${pattern}` });
}
const appAudioStarts = (page) => page.evaluate(() => window.__audioStarts.filter((s) => !s.mic));
const lastAiText = (page) => page.getByTestId("msg-ai").last().innerText().catch(() => "");
const metrics = (page) => page.evaluate(() => window.__interviewMetrics ?? []);
const playAnswer = (page, wav) => page.evaluate((b64) => window.__fakeMic.play(b64), wav);

/** Sample the orb's live level while the interviewer speaks (proves audio flows through the analyser). */
async function sampleOrbLevel(page, ms = 1200) {
  let max = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const level = await page.evaluate(() => Number(getComputedStyle(document.querySelector(".orb")).getPropertyValue("--level") || 0));
    max = Math.max(max, level);
    await sleep(60);
  }
  return max;
}

/**
 * Speak an answer and measure, from ground truth, the time between the end of
 * the candidate's speech and the first interviewer audio sample being played.
 */
async function answerByVoice(page, label, text, wav) {
  await setTranscript(text);
  const startsBefore = (await appAudioStarts(page)).length;
  const aiBefore = await page.getByTestId("msg-ai").count();
  const speechEndedAt = await playAnswer(page, wav);
  await page.getByTestId("msg-user").filter({ hasText: text.slice(0, 32) }).last().waitFor({ timeout: 25_000 });
  const firstAudio = await waitUntil(
    async () => (await appAudioStarts(page)).slice(startsBefore).find((s) => s.t > speechEndedAt),
    { timeout: 40_000, interval: 25, message: `interviewer audio after ${label}` },
  );
  const captionAtStart = await lastAiText(page);
  const orbLevel = await sampleOrbLevel(page, 900);
  await waitForStatus(page, /Your turn/, 120_000);
  const finalText = await lastAiText(page);
  const record = (await metrics(page)).at(-1) ?? {};
  const row = {
    label,
    speech_end_to_audio_ms: Math.round(firstAudio.t - speechEndedAt),
    app_reported_ms: record.response_latency_ms,
    stt_ms: record.server?.stt_ms,
    speculative_stt: !!record.speculative_stt,
    llm_first_token_ms: record.server?.llm_first_token_ms,
    first_sentence_server_ms: record.server?.first_sentence_ms,
    first_audio_server_ms: record.server?.first_audio_ms,
    model: record.server?.model,
    section: record.server?.section,
    caption_chars_at_audio_start: captionAtStart.length,
    reply_chars: finalText.length,
    orb_peak_level: Number(orbLevel.toFixed(2)),
    new_ai_bubbles: (await page.getByTestId("msg-ai").count()) - aiBefore,
    reply: finalText,
  };
  latencyRows.push(row);
  return row;
}

async function answerByText(page, text) {
  if (!(await page.locator("#answer").isVisible().catch(() => false))) await page.getByLabel("Type an answer").click();
  await page.locator("#answer").fill(text);
  await page.locator("#answer").press("Enter");
  await page.getByTestId("msg-user").filter({ hasText: text.slice(0, 32) }).last().waitFor({ timeout: 15_000 });
  await waitForStatus(page, /Your turn|Interview complete/, 120_000);
  return lastAiText(page);
}

function watchPage(page, label) {
  const problems = [];
  page.on("pageerror", (error) => problems.push(`[${label}] pageerror: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/favicon|Download the React DevTools/i.test(msg.text())) problems.push(`[${label}] console.error: ${msg.text().slice(0, 300)}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 500) problems.push(`[${label}] HTTP ${res.status()} ${res.url()}`);
  });
  return problems;
}

// --------------------------------------------------------------- scenarios

async function scenarioConversation(browser, fixtures) {
  console.log("\nScenario: live voice conversation (real NVIDIA + Edge TTS, real browser playback)");
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 860 } });
  await context.addInitScript({ path: join(root, "tests/live-browser/fake-mic.js") });
  const page = await context.newPage();
  currentPage = page;
  const problems = watchPage(page, "conversation");
  const created = await postJson("/api/interview/start", {
    name: "Jane Doe",
    role: "Senior Backend Engineer",
    resume_text: fixtures.resume,
    job_description: "Senior Backend Engineer, Payments: reliable distributed systems in Go, Postgres, Kafka; mentor engineers.",
    duration_minutes: 30,
    interview_type: "mixed",
    level: "senior",
  });
  const id = created.body.session_id;
  let clickAt = 0;

  await step("interview room loads and voice detection (Silero VAD + ONNX WASM) becomes ready", async () => {
    const t0 = Date.now();
    await page.goto(`${BASE}/interview/${id}?debug=1`);
    await waitUntil(() => page.getByTestId("start").isEnabled(), { timeout: 45_000, message: "Start button enabled (VAD loaded)" });
    return `VAD ready in ${Date.now() - t0}ms`;
  });

  await step("the opening is prefetched in the lobby and plays instantly on Start", async () => {
    await waitUntil(async () => (await api(`/api/interview/${id}`)).body.transcript?.length >= 1, { timeout: 30_000, message: "prefetched opening" });
    assert.equal((await appAudioStarts(page)).length, 0, "nothing plays before the candidate presses Start");
    await sleep(400); // let the client finish receiving buffered audio
    clickAt = await page.evaluate(() => performance.now());
    await page.getByTestId("start").click();
    const first = await waitUntil(async () => (await appAudioStarts(page))[0], { timeout: 15_000, interval: 10, message: "greeting audio" });
    const latency = Math.round(first.t - clickAt);
    latencyRows.push({ label: "opening (prefetched)", speech_end_to_audio_ms: latency });
    assert.ok(latency < 600, `greeting should start almost instantly after Start, took ${latency}ms`);
    const started = (await api(`/api/interview/${id}`)).body.started_at;
    assert.ok(started, "clock starts when the candidate presses Start");
    return `greeting audible ${latency}ms after Start`;
  });

  await step("captions are synchronized with speech and the orb reacts to real audio", async () => {
    const orb = await sampleOrbLevel(page, 1500);
    assert.ok(orb > 0.04, `orb level ${orb}`);
    await waitForStatus(page, /Your turn/, 60_000);
    const greeting = await lastAiText(page);
    assert.ok(greeting.length > 20, "greeting text shown");
    return `orb peak ${orb.toFixed(2)}; greeting: "${greeting.slice(0, 90)}…"`;
  });

  const answers = [
    ["answer 1", fixtures.answers[0].text, fixtures.answers[0].wav],
    ["answer 2", fixtures.answers[1].text, fixtures.answers[1].wav],
    ["answer 3 (I don't know)", fixtures.answers[2].text, fixtures.answers[2].wav],
  ];
  for (const [label, text, wav] of answers) {
    await step(`voice ${label}: transcribed, answered, and played back live`, async () => {
      const row = await answerByVoice(page, label, text, wav);
      assert.ok(row.new_ai_bubbles === 1, "exactly one interviewer reply");
      assert.ok(row.orb_peak_level > 0.04, "audio actually played (orb level)");
      assert.ok(row.reply_chars > 10, "reply shown");
      assert.ok((row.reply.match(/\?/g) || []).length >= 1, "interviewer asked a question");
      return `${row.speech_end_to_audio_ms}ms speech→audio (${row.speculative_stt ? "speculative STT hidden in pause" : `stt ${row.stt_ms}`}, llm ${row.llm_first_token_ms}, server 1st audio ${row.first_audio_server_ms}) | "${row.reply.slice(0, 80)}…"`;
    });
  }

  await step("barge-in: talking over the interviewer stops playback and is answered", async () => {
    await setTranscript(fixtures.answers[3].text);
    await playAnswer(page, fixtures.answers[3].wav);
    await waitForStatus(page, /Aria is speaking/, 60_000);
    await sleep(500);
    const startsAtBarge = (await appAudioStarts(page)).length;
    const stopsBefore = await page.evaluate(() => window.__audioStops.filter((s) => !s.mic).length);
    await setTranscript(fixtures.barge.text);
    const playing = playAnswer(page, fixtures.barge.wav);
    await waitUntil(async () => !(await statusText(page)).includes("Aria is speaking"), { timeout: 6_000, interval: 40, message: "playback to stop" });
    await playing;
    // Ground truth: candidate's audio started -> interviewer's audio source stopped.
    const stopMs = await page.evaluate((before) => {
      const stop = window.__audioStops.filter((s) => !s.mic)[before];
      return stop ? Math.round(stop.t - window.__fakeMic.lastPlayStartedAt) : null;
    }, stopsBefore);
    const probs = await page.evaluate(() => {
      const start = window.__fakeMic.lastPlayStartedAt;
      return (window.__vadProbs ?? []).filter((f) => f.t >= start && f.t <= start + 1500).map((f) => Number(f.p.toFixed(2)));
    });
    notes.push({ barge_in_vad_probabilities_first_1500ms: probs });
    assert.ok(stopMs !== null, "interviewer audio source was stopped");
    latencyRows.push({ label: "barge-in (talk → interviewer silent)", speech_end_to_audio_ms: stopMs });
    await page.locator('[data-testid="msg-ai"][data-interrupted="true"]').first().waitFor({ timeout: 6_000 });
    await page.getByTestId("msg-user").filter({ hasText: fixtures.barge.text.slice(0, 25) }).last().waitFor({ timeout: 30_000 });
    // No stale audio from the interrupted turn may resume afterwards.
    const afterBarge = (await appAudioStarts(page)).slice(startsAtBarge);
    await waitForStatus(page, /Your turn/, 120_000);
    const reply = await lastAiText(page);
    return `stopped ${stopMs}ms after the candidate started talking; ${afterBarge.length} audio starts after barge-in (new reply only); reply: "${reply.slice(0, 70)}…"`;
  });

  await step("muting the mic ignores speech; unmuting restores it", async () => {
    await page.getByLabel("Mute microphone").click();
    await waitForStatus(page, /muted|type your answer/i, 5_000);
    const usersBefore = await page.getByTestId("msg-user").count();
    await setTranscript("This should never be sent.");
    await playAnswer(page, fixtures.answers[0].wav);
    await sleep(2_500);
    assert.equal(await page.getByTestId("msg-user").count(), usersBefore, "no turn sent while muted");
    await fetch(`${FAKE}/clear-transcripts`, { method: "POST" });
    await page.getByLabel("Unmute microphone").click();
    await waitForStatus(page, /Your turn/, 10_000);
  });

  await step("typed answers work alongside voice", async () => {
    const reply = await answerByText(page, "I'd add a token bucket per merchant in Redis and return Retry-After when the limit is hit.");
    assert.ok(reply.length > 10);
    return `"${reply.slice(0, 80)}…"`;
  });

  await step("refreshing mid-interview resumes with the full transcript and no repeated greeting", async () => {
    const serverTranscript = (await api(`/api/interview/${id}`)).body.transcript.length;
    await page.reload();
    await waitUntil(() => page.getByTestId("start").isEnabled(), { timeout: 45_000, message: "resume button" });
    assert.match(await page.getByTestId("start").innerText(), /Resume/);
    await page.getByTestId("start").click();
    await sleep(2_500);
    assert.equal((await appAudioStarts(page)).length, 0, "no audio replayed after resume");
    const bubbles = (await page.getByTestId("msg-ai").count()) + (await page.getByTestId("msg-user").count());
    assert.equal(bubbles, serverTranscript);
    await waitForStatus(page, /Your turn/, 10_000);
    return `${bubbles} messages restored`;
  });

  await step("ending the interview produces a real scorecard report", async () => {
    await page.getByRole("button", { name: "End interview" }).click();
    await page.getByRole("button", { name: /End & get report/ }).click();
    await page.waitForURL(/\/report\//, { timeout: 15_000 });
    const t0 = Date.now();
    await page.getByTestId("scorecard").waitFor({ timeout: 150_000 });
    const report = (await api(`/api/report/${id}`)).body;
    assert.equal(report.status, "ready");
    assert.ok(report.competency_scores.length >= 3, "several competencies");
    assert.ok(report.competency_scores.every((c) => c.score >= 1 && c.score <= 5 && c.rationale), "1-5 rubric with a why");
    assert.ok(report.question_feedback.length >= 2, "per-question feedback");
    notes.push({ conversation_report: { score: report.score, summary: report.summary, competencies: report.competency_scores.map((c) => `${c.name} ${c.score}`) } });
    return `generated in ${Date.now() - t0}ms; score ${report.score}; ${report.competency_scores.map((c) => `${c.name} ${c.score}`).join(", ")}`;
  });

  await step("no client errors or server 5xx during the conversation", async () => {
    assert.deepEqual(problems, []);
  });
  await context.close();
}

async function scenarioCanvas(browser, fixtures) {
  console.log("\nScenario: full UI flow with hands-on canvas (accelerated clock)");
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1360, height: 880 } });
  await context.addInitScript({ path: join(root, "tests/live-browser/fake-mic.js") });
  const page = await context.newPage();
  currentPage = page;
  const problems = watchPage(page, "canvas");
  let id;

  await step("upload → setup (plan options) → interview room through the real UI", async () => {
    await page.goto(`${BASE}/upload`);
    await page.locator('input[type="file"]').setInputFiles(fixtures.pdfPath);
    await page.waitForURL(/\/setup/, { timeout: 20_000 });
    await page.getByText("Resume attached").waitFor();
    await page.locator("#full-name").fill("Tim Canvas");
    await page.locator("#target-role").fill("Backend Engineer");
    await page.getByText("Technical", { exact: true }).click();
    await page.getByText("15 min", { exact: true }).click();
    await page.getByRole("button", { name: "Start interview" }).click();
    await page.waitForURL(/\/interview\//, { timeout: 20_000 });
    id = page.url().split("/interview/")[1].split("?")[0];
    const view = (await api(`/api/interview/${id}`)).body;
    assert.equal(view.interview_type, "technical");
    assert.equal(view.duration_minutes, 15);
    assert.equal(view.has_resume, true);
    await waitUntil(() => page.getByTestId("start").isEnabled(), { timeout: 45_000, message: "Start enabled" });
    await page.getByTestId("start").click();
    await waitForStatus(page, /Your turn/, 60_000);
  });

  const sectionsSeen = new Set();
  await step("sections advance and the canvas opens with a generated exercise at hands-on time", async () => {
    const answers = [
      "I've spent five years on payment systems, mostly Go services on Kafka and Postgres.",
      "Idempotency keys stored with a unique constraint, plus an outbox table for events.",
      "I'd shard by merchant and keep hot keys in Redis with a short TTL.",
      "I'd add contract tests and run chaos experiments on the consumers.",
      "We tracked p95 latency, error budget burn, and reconciliation drift.",
      "I'd start by clarifying the requirements and the failure modes.",
    ];
    for (const answer of answers) {
      sectionsSeen.add(await page.getByTestId("section").innerText());
      if (await page.getByLabel("Hands-on canvas").isVisible().catch(() => false)) break;
      await answerByText(page, answer);
      await sleep(1_500);
    }
    sectionsSeen.add(await page.getByTestId("section").innerText());
    await page.getByLabel("Hands-on canvas").waitFor({ timeout: 30_000 });
    const title = await page.getByLabel("Hands-on canvas").locator("h2").innerText();
    assert.ok(title.length > 3, "exercise title");
    return `sections seen: ${[...sectionsSeen].join(" → ")}; exercise: "${title}"`;
  });

  await step("canvas edits autosave and are shared with the interviewer", async () => {
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\n# LIVE-TEST-MARKER: cache results keyed by request id\n");
    await page.getByText("Shared with interviewer").waitFor({ timeout: 10_000 });
    await waitUntil(async () => (await api(`/api/interview/${id}`)).body.canvas.content.includes("LIVE-TEST-MARKER"), {
      timeout: 10_000,
      message: "canvas saved on server",
    });
    const reply = await answerByText(page, "I've added a cache keyed by request id; next I'd handle concurrent duplicates with a lock.");
    return `interviewer: "${reply.slice(0, 100)}…"`;
  });

  await step("large pastes and leaving the tab are recorded as session signals", async () => {
    await page.locator(".cm-content").evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/plain", "x = 1\n".repeat(80));
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    // Headless Chromium doesn't change visibility on tab switches, so drive the
    // same browser events the app listens to: hidden for ~1.6 s, then visible.
    const setVisibility = (state) =>
      page.evaluate((value) => {
        Object.defineProperty(document, "visibilityState", { value, configurable: true });
        Object.defineProperty(document, "hidden", { value: value === "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    await setVisibility("hidden");
    await sleep(1_600);
    await setVisibility("visible");
    await sleep(800);
  });

  await step("the interview closes itself when time is up and the report includes the hands-on exercise", async () => {
    for (let i = 0; i < 12; i++) {
      if (await page.getByTestId("view-report").isVisible().catch(() => false)) break;
      await answerByText(page, i % 2 ? "I'd log the outcome and alert on anomalies." : "I'd write unit tests for duplicate and concurrent requests.");
      await sleep(4_000);
    }
    await page.getByTestId("view-report").click();
    await page.waitForURL(/\/report\//, { timeout: 15_000 });
    await page.getByTestId("scorecard").waitFor({ timeout: 150_000 });
    const report = (await api(`/api/report/${id}`)).body;
    assert.ok(report.hands_on, "hands-on evaluation present");
    assert.ok(report.integrity.large_paste >= 1, "large paste recorded");
    assert.ok(report.integrity.tab_hidden >= 1, "leaving the tab recorded");
    notes.push({ canvas_report: { score: report.score, hands_on: report.hands_on, integrity: report.integrity } });
    return `score ${report.score}; hands-on ${report.hands_on.rating}/5; signals: ${report.integrity.notes.join(" ") || "none"}`;
  });

  await step("no client errors or server 5xx during the canvas flow", async () => {
    assert.deepEqual(problems, []);
  });
  await context.close();
}

// --------------------------------------------------------------------- main

loadEnvLocal();
if (!process.env.NVIDIA_API_KEY || !process.env.MONGODB_URI) {
  console.error("NVIDIA_API_KEY and MONGODB_URI are required (in .env.local).");
  process.exit(1);
}
if (!existsSync(join(root, ".next/BUILD_ID"))) {
  console.error("No production build. Run `npm run build` first.");
  process.exit(1);
}
await assertPortFree(APP_PORT);
await assertPortFree(FAKE_PORT);

const dir = mkdtempSync(join(tmpdir(), "interviewai-live-"));
console.log("Generating spoken answers with macOS `say`…");
const fixtureTexts = [
  "Sure. At Acme Pay I led the migration of our payments ledger from a Rails monolith to a Go service on Kafka. We ran both systems in parallel for six weeks, and reconciliation errors dropped by about seventy percent.",
  "We used an outbox table in Postgres, so the database write and the event were committed in one transaction. Consumers were idempotent, using the payment ID as a dedupe key.",
  "Honestly, I'm not sure about the internals of exactly once delivery in Kafka.",
  "To keep latency low I added a read through cache in Redis for merchant settings, with a short time to live, and we monitored the hit rate closely.",
];
const fixtures = {
  resume:
    "Jane Doe, Senior Backend Engineer (6 years). Acme Pay: led migration of payments ledger from Rails monolith to Go on Kafka; reconciliation errors down 70%. Idempotent payment APIs at 2M requests/day. Mentored 3 engineers. Go, Python, PostgreSQL, Kafka, Redis, Kubernetes.",
  answers: fixtureTexts.map((text, i) => ({ text, wav: speak(dir, `answer${i}`, text) })),
  barge: { text: "Sorry to interrupt, can I add one more detail about the rollout?", wav: speak(dir, "barge", "Sorry to interrupt, can I add one more detail about the rollout?") },
  pdfPath: join(dir, "resume.pdf"),
};
// Minimal one-page PDF resume for the upload flow.
{
  const lines = ["Tim Canvas - Backend Engineer", "Built payment APIs in Go and Postgres", "Owned on-call and incident reviews"];
  const content = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(fixtures.pdfPath, Buffer.from(out, "latin1"));
}

const children = [];
function startApp(extraEnv) {
  const app = spawn("npx", ["next", "start", "-p", String(APP_PORT)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Real NVIDIA LLM + Edge TTS; STT goes to the fake (no valid Groq key locally).
      GROQ_API_KEY: process.env.GROQ_API_KEY_LIVE || "fake-groq",
      GROQ_BASE_URL: process.env.GROQ_API_KEY_LIVE ? "https://api.groq.com/openai/v1" : `${FAKE}/v1`,
      LLM_FALLBACK_GROQ: "false",
      MONGODB_DB_NAME: DB_NAME,
      ...extraEnv,
    },
  });
  const logs = [];
  app.stdout.on("data", (d) => logs.push(d.toString()));
  app.stderr.on("data", (d) => logs.push(d.toString()));
  children.push(app);
  return { app, logs };
}
async function stopApp(handle) {
  handle.app.kill("SIGTERM");
  await new Promise((resolve) => handle.app.once("exit", resolve));
}

const fake = spawn(process.execPath, [join(root, "tests/e2e/fake-providers.mjs"), String(FAKE_PORT)], {
  stdio: "ignore",
  env: { ...process.env, FAKE_STT_DELAY_MS: String(STT_DELAY_MS), FAKE_STT_DEFAULT_EMPTY: "1", FAKE_STT_STICKY: "1" },
});
children.push(fake);

const browser = await chromium.launch({
  headless: !HEADED,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
});

let exitCode = 1;
const serverLogs = [];
try {
  if (SCENARIO === "all" || SCENARIO === "conversation") {
    const handle = startApp({ INTERVIEW_CLOCK_SPEEDUP: "1" });
    await waitUntil(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok, { timeout: 60_000, message: "app health" });
    await scenarioConversation(browser, fixtures);
    serverLogs.push(...handle.logs);
    await stopApp(handle);
  }
  if (SCENARIO === "all" || SCENARIO === "canvas") {
    const handle = startApp({ INTERVIEW_CLOCK_SPEEDUP: "20" });
    await waitUntil(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok, { timeout: 60_000, message: "app health" });
    await scenarioCanvas(browser, fixtures);
    serverLogs.push(...handle.logs);
    await stopApp(handle);
  }
  exitCode = results.every((r) => r.ok) ? 0 : 1;
} finally {
  await browser.close();
  for (const child of children) child.kill("SIGTERM");
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    await client.db(DB_NAME).dropDatabase();
  } finally {
    await client.close();
  }
}

// ------------------------------------------------------------------ report
const voiceRows = latencyRows.filter((r) => /^answer/.test(r.label));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
console.log("\nLatency (candidate stops talking → interviewer audio audible), real browser playback:");
console.table(
  latencyRows.map(({ label, speech_end_to_audio_ms, stt_ms, speculative_stt, llm_first_token_ms, first_audio_server_ms, caption_chars_at_audio_start, reply_chars }) => ({
    turn: label,
    "end-to-end ms": speech_end_to_audio_ms,
    "stt*": speculative_stt ? "hidden (speculative)" : stt_ms,
    "llm 1st token ms": llm_first_token_ms,
    "server 1st audio ms": first_audio_server_ms,
    "caption chars @audio start": caption_chars_at_audio_start,
    "reply chars": reply_chars,
  })),
);
if (voiceRows.length) {
  const e2e = voiceRows.map((r) => r.speech_end_to_audio_ms);
  console.log(
    `voice turns: p50 ${percentile(e2e, 0.5)}ms, max ${Math.max(...e2e)}ms, speculative STT used on ${voiceRows.filter((r) => r.speculative_stt).length}/${voiceRows.length} (includes the 800 ms end-of-speech silence window; * STT simulated at ${STT_DELAY_MS} ms)`,
  );
}
const errorLines = serverLogs.join("").split("\n").filter((l) => /"level":"error"/.test(l));
if (errorLines.length) console.log(`\nServer error log lines:\n${errorLines.slice(0, 10).join("\n")}`);

mkdirSync(join(root, "test-results"), { recursive: true });
const outFile = join(root, "test-results", `live-browser-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(outFile, JSON.stringify({ results, latency: latencyRows, notes, stt_simulated_ms: process.env.GROQ_API_KEY_LIVE ? null : STT_DELAY_MS }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed · details: ${outFile}`);
process.exit(exitCode);
