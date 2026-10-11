#!/usr/bin/env node
/**
 * End-to-end API test against a running server (e.g. `next start`).
 *   BASE_URL=http://127.0.0.1:3100 FAKE_URL=http://127.0.0.1:4010 node tests/e2e/run-e2e.mjs
 * The server must run with INTERVIEW_CLOCK_SPEEDUP=60 for the timed-sections flow.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3100";
const FAKE = process.env.FAKE_URL || "http://127.0.0.1:4010";
const SPEEDUP = Number(process.env.INTERVIEW_CLOCK_SPEEDUP || 60);
const results = [];

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}\n    ${error?.stack || error}`);
  }
}

async function json(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

const post = (path, body) => json(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const fake = (path, body) =>
  fetch(`${FAKE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const fakeStats = async () => (await fetch(`${FAKE}/stats`)).json();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function turn(id, payload) {
  const init = { method: "POST" };
  if (payload instanceof Uint8Array) {
    init.body = payload;
    init.headers = { "Content-Type": "audio/wav" };
  } else {
    init.body = JSON.stringify(payload ?? {});
    init.headers = { "Content-Type": "application/json" };
  }
  const started = Date.now();
  const res = await fetch(`${BASE}/api/interview/${id}/turn`, init);
  if (!res.ok) return { status: res.status, body: await res.json(), events: [] };
  assert.match(res.headers.get("content-type"), /application\/x-ndjson/);
  const events = [];
  let firstSentenceMs = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "ai_sentence" && firstSentenceMs === null) firstSentenceMs = Date.now() - started;
      events.push(event);
    }
  }
  return { status: res.status, events, firstSentenceMs, totalMs: Date.now() - started };
}

const types = (events) => events.map((e) => e.type);
const spoken = (events) => events.filter((e) => e.type === "ai_sentence").map((e) => e.content).join(" ");

let sessionId;
let resumeText;
let lastAiReply = "";

console.log(`E2E against ${BASE}`);

await step("health reports database and providers", async () => {
  const { status, body } = await json("/api/health");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.checks.database, "ok");
  assert.equal(body.checks.llm, "configured");
  assert.equal(body.checks.stt, "configured");
});

await step("security headers are present", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("permissions-policy"), /microphone=\(self\)/);
  assert.equal(res.headers.get("x-powered-by"), null);
});

await step("VAD assets are served with immutable caching", async () => {
  const version = JSON.parse(readFileSync("node_modules/@ricky0123/vad-web/package.json", "utf8")).version;
  const ort = JSON.parse(readFileSync("node_modules/onnxruntime-web/package.json", "utf8")).version;
  for (const file of ["silero_vad_v5.onnx", "vad.worklet.bundle.min.js", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) {
    const res = await fetch(`${BASE}/vad/${version}-ort${ort}/${file}`, { method: "HEAD" });
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("cache-control"), /immutable/, file);
  }
});

await step("resume upload extracts PDF text", async () => {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(process.env.PDF_PATH)], { type: "application/pdf" }), "resume.pdf");
  const { status, body } = await json("/api/resume/upload", { method: "POST", body: form });
  assert.equal(status, 200, JSON.stringify(body));
  assert.match(body.text, /Payments API/);
  assert.equal(body.pages, 1);
  resumeText = body.text;
});

await step("resume upload rejects non-PDF files", async () => {
  const form = new FormData();
  form.append("file", new Blob(["hello"], { type: "application/pdf" }), "fake.pdf");
  const { status, body } = await json("/api/resume/upload", { method: "POST", body: form });
  assert.equal(status, 415);
  assert.equal(body.error.code, "not_a_pdf");
});

await step("start validates required fields", async () => {
  const { status, body } = await post("/api/interview/start", { name: " ", role: "Engineer" });
  assert.equal(status, 400);
  assert.equal(body.error.code, "name_required");
});

await step("start creates a session with an unguessable id and the chosen plan", async () => {
  const { status, body } = await post("/api/interview/start", {
    name: "Jane Doe",
    role: "Backend Engineer",
    resume_text: resumeText,
    job_description: "Build payment systems",
    duration_minutes: 45,
    interview_type: "technical",
    level: "senior",
    canvas_enabled: true,
  });
  assert.equal(status, 201, JSON.stringify(body));
  assert.match(body.session_id, /^[a-f0-9]{32}$/);
  sessionId = body.session_id;
  const view = await json(`/api/interview/${sessionId}`);
  assert.equal(view.body.duration_minutes, 45);
  assert.equal(view.body.interview_type, "technical");
  assert.equal(view.body.level, "senior");
  assert.equal(view.body.canvas_enabled, true);
  assert.equal(view.body.started_at, null);
});

await step("invalid plan values fall back to safe defaults", async () => {
  const { body } = await post("/api/interview/start", { name: "Sam", role: "PM", duration_minutes: 9999, interview_type: "chaos", level: "god" });
  const view = await json(`/api/interview/${body.session_id}`);
  assert.equal(view.body.duration_minutes, 30);
  assert.equal(view.body.interview_type, "mixed");
  assert.equal(view.body.level, "mid");
});

await step("unknown sessions return 404", async () => {
  const { status, body } = await json(`/api/interview/${"f".repeat(32)}`);
  assert.equal(status, 404);
  assert.equal(body.error.code, "session_not_found");
  assert.equal((await json(`/api/interview/not-an-id`)).status, 404);
  assert.equal((await turn("not-an-id", {})).status, 404);
});

await step("opening turn streams greeting text, MP3 audio and metrics without starting the clock", async () => {
  const { status, events, firstSentenceMs, totalMs } = await turn(sessionId, {});
  assert.equal(status, 200);
  assert.equal(events[0].type, "ai_start");
  const sentences = events.filter((e) => e.type === "ai_sentence");
  assert.ok(sentences.length >= 2, types(events).join(","));
  assert.deepEqual(sentences.map((s) => s.seq), sentences.map((_, i) => i + 1));
  const audio = events.filter((e) => e.type === "audio");
  assert.equal(audio.length, sentences.length, `audio events: ${types(events).join(",")}`);
  for (const a of audio) {
    const bytes = Buffer.from(a.data, "base64");
    assert.ok(bytes.length > 2000);
    assert.ok(bytes[0] === 0xff || bytes.subarray(0, 3).toString() === "ID3", "mp3 frame header");
  }
  const metrics = events.find((e) => e.type === "metrics").metrics;
  assert.equal(metrics.section, "opening");
  assert.ok(metrics.first_audio_ms > 0 && metrics.total_ms >= metrics.first_audio_ms);
  assert.deepEqual(types(events).slice(-3), ["ai_done", "metrics", "done"]);
  lastAiReply = spoken(events);
  const view = await json(`/api/interview/${sessionId}`);
  assert.equal(view.body.started_at, null, "prefetching the opening must not start the clock");
  console.log(`    first sentence ${firstSentenceMs}ms, first audio (server) ${metrics.first_audio_ms}ms, total ${totalMs}ms`);
});

await step("repeating the opening turn is a no-op (refresh-safe)", async () => {
  const { events } = await turn(sessionId, {});
  assert.deepEqual(types(events), ["done"]);
});

await step("the start event starts the interview clock exactly once", async () => {
  const first = await post(`/api/interview/${sessionId}/events`, { events: [{ type: "started" }] });
  assert.equal(first.status, 200);
  const startedAt = (await json(`/api/interview/${sessionId}`)).body.started_at;
  assert.ok(startedAt);
  await sleep(50);
  await post(`/api/interview/${sessionId}/events`, { events: [{ type: "started" }] });
  assert.equal((await json(`/api/interview/${sessionId}`)).body.started_at, startedAt);
});

await step("audio answer is transcribed and answered", async () => {
  const wav = new Uint8Array(readFileSync(process.env.WAV_PATH));
  const { status, events } = await turn(sessionId, wav);
  assert.equal(status, 200);
  assert.deepEqual(events[0], { type: "user_transcript", content: "I built a payments API in Go with Postgres." });
  assert.ok(types(events).includes("ai_done"));
  const metrics = events.find((e) => e.type === "metrics").metrics;
  assert.ok(metrics.stt_ms > 0, "stt timing reported");
  lastAiReply = spoken(events);
});

await step("speaker echo (the interviewer's own words) is discarded, not treated as an answer", async () => {
  await fake("/set-transcript", { text: lastAiReply });
  const wav = new Uint8Array(readFileSync(process.env.WAV_PATH));
  const { events } = await turn(sessionId, wav);
  assert.deepEqual(types(events), ["no_speech"]);
});

await step("'repeat the question' restates the last question", async () => {
  const { events } = await turn(sessionId, { text: "Sorry, could you repeat the question?" });
  assert.match(spoken(events), /^Sure\./);
  const stats = await fakeStats();
  assert.match(stats.lastSystem, /asked you to repeat the question/);
});

await step("concurrent turns are serialized with a 409", async () => {
  const [a, b] = await Promise.all([turn(sessionId, { text: "First concurrent answer" }), turn(sessionId, { text: "Second concurrent answer" })]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const rejected = a.status === 409 ? a : b;
  assert.equal(rejected.body.error.code, "turn_in_progress");
});

await step("LLM outage on every provider is reported and the saved answer is answered on retry", async () => {
  await fake("/fail-next-chat", { count: 3 }); // primary, backup model, and Groq fallback all fail
  const failed = await turn(sessionId, { text: "I used idempotency keys to avoid double charges." });
  assert.equal(failed.events.at(-1).type, "error");
  assert.equal(failed.events.at(-1).code, "llm_failed");
  assert.ok(!failed.events.some((e) => e.type === "ai_sentence"));
  const retry = await turn(sessionId, {});
  assert.ok(types(retry.events).includes("ai_done"), types(retry.events).join(","));
  assert.ok(!types(retry.events).includes("user_transcript"));
});

await step("single-provider failure is invisible to the candidate (failover)", async () => {
  await fake("/fail-next-chat", { count: 1 });
  const { events } = await turn(sessionId, { text: "We monitored p95 latency and error budgets." });
  assert.ok(types(events).includes("ai_done"), types(events).join(","));
  assert.ok(!types(events).includes("error"));
});

await step("session view returns the persisted transcript without leaked error text", async () => {
  const { status, body } = await json(`/api/interview/${sessionId}`);
  assert.equal(status, 200);
  assert.equal(body.candidate_name, "Jane Doe");
  assert.equal(body.has_resume, true);
  const roles = body.transcript.map((m) => m.role);
  for (let i = 1; i < roles.length; i++) assert.ok(!(roles[i] === "ai" && roles[i - 1] === "ai"), "no consecutive interviewer turns");
  assert.ok(!body.transcript.some((m) => /Error:|<<END>>/i.test(m.content)), "no provider errors or control markers persisted");
  assert.equal(body.turn_count, 5);
});

await step("integrity events are recorded", async () => {
  const { status, body } = await post(`/api/interview/${sessionId}/events`, {
    events: [{ type: "tab_hidden", detail: "12s" }, { type: "large_paste", detail: "800 chars" }, { type: "not_allowed", detail: "x" }],
  });
  assert.equal(status, 200);
  assert.equal(body.recorded, 3); // accepted by the route; unknown types are dropped when stored
});

await step("background analysis and canvas task generation ran", async () => {
  await sleep(1500);
  const stats = await fakeStats();
  assert.ok(stats.analysis >= 4, JSON.stringify(stats));
  assert.ok(stats.canvasTask >= 1, JSON.stringify(stats));
});

// ------------------------------------------------------------- timed flow
let timedId;
await step(`timed sections: hands-on canvas is introduced and sees live work (clock x${SPEEDUP})`, async () => {
  const created = await post("/api/interview/start", { name: "Tim", role: "Backend Engineer", duration_minutes: 15, interview_type: "technical", level: "mid" });
  timedId = created.body.session_id;
  await turn(timedId, {}); // opening; schedules canvas task generation
  await post(`/api/interview/${timedId}/events`, { events: [{ type: "started" }] });
  const startedAt = Date.now();
  // technical interview: hands-on spans 45%-88% of 15 minutes
  const handsOnAtMs = (0.5 * 15 * 60_000) / SPEEDUP;
  await sleep(Math.max(0, handsOnAtMs - (Date.now() - startedAt)));
  const intro = await turn(timedId, { text: "Ready for the next part." });
  const canvasEvent = intro.events.find((e) => e.type === "canvas_task");
  assert.ok(canvasEvent, `expected canvas_task, got ${types(intro.events).join(",")} section=${intro.events.find((e) => e.type === "metrics")?.metrics.section}`);
  assert.equal(canvasEvent.task.title, "Idempotent payment endpoint");
  assert.match(canvasEvent.task.starter_code, /def charge/);
  const view = await json(`/api/interview/${timedId}`);
  assert.equal(view.body.canvas.task.title, "Idempotent payment endpoint");

  const save = await json(`/api/interview/${timedId}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "def charge(request_id, amount):\n    seen = {}  # CANDIDATE-CODE-MARKER", language: "python" }),
  });
  assert.equal(save.status, 200);
  const followUp = await turn(timedId, { text: "I'm caching results by request id." });
  assert.ok(!types(followUp.events).includes("canvas_task"), "exercise is only introduced once");
  assert.match((await fakeStats()).lastSystem, /CANDIDATE-CODE-MARKER/);
});

await step("timed sections: the interview closes itself after the scheduled time", async () => {
  const view = await json(`/api/interview/${timedId}`);
  const startedAt = Date.parse(view.body.started_at);
  const closeAtMs = (16.6 * 60_000) / SPEEDUP; // 15 min + grace
  await sleep(Math.max(0, closeAtMs - (Date.now() - startedAt)));
  const { events } = await turn(timedId, { text: "Here's my final thought." });
  assert.equal(events.find((e) => e.type === "metrics").metrics.section, "closing");
  assert.deepEqual(events.at(-1), { type: "done", limit_reached: true });
  assert.ok(!spoken(events).includes("<<"), "end marker never spoken");
});

await step("report is generated once, cached, and normalized as a scorecard", async () => {
  const [first, second] = await Promise.all([json(`/api/report/${sessionId}`), json(`/api/report/${sessionId}`)]);
  const ready = [first, second].find((r) => r.status === 200);
  assert.ok(ready, `statuses ${first.status}/${second.status}`);
  assert.ok([first.status, second.status].every((s) => s === 200 || s === 202));
  const report = ready.body;
  assert.equal(report.status, "ready");
  assert.equal(report.score, 72);
  assert.deepEqual(report.competency_scores.map((c) => c.score), [3.9, 3.3]);
  assert.ok(report.competency_scores.every((c) => c.rationale.length > 5));
  assert.equal(report.question_feedback.length, 1);
  assert.equal(report.hands_on, null, "no hands-on section when no exercise happened (deterministic guard)");
  assert.deepEqual(report.integrity.notes, ["Left the interview tab 1 time.", "Pasted large blocks of text 1 time."]);
  const before = (await fakeStats()).report;
  const again = await json(`/api/report/${sessionId}`);
  assert.equal(again.status, 200);
  assert.equal(again.body.score, 72);
  assert.equal((await fakeStats()).report, before, "cached report does not call the model again");
  assert.ok(before <= 1, `report generated ${before} times`);
});

await step("a report for an interview with a canvas exercise keeps its hands-on evaluation", async () => {
  let report;
  for (let i = 0; i < 20 && !report; i++) {
    const res = await json(`/api/report/${timedId}`);
    if (res.status === 200) report = res.body;
    else await sleep(300);
  }
  assert.ok(report, "timed session report");
  assert.equal(report.hands_on?.rating, 3.5);
});

await step("completed interviews reject new turns and canvas edits", async () => {
  const { status, body } = await turn(sessionId, { text: "one more" });
  assert.equal(status, 409);
  assert.equal(body.error.code, "interview_completed");
  const canvas = await json(`/api/interview/${sessionId}/canvas`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "late edit", language: "python" }),
  });
  assert.equal(canvas.status, 409);
});

await step("report for an unanswered interview explains what to do", async () => {
  const created = await post("/api/interview/start", { name: "Sam", role: "Designer" });
  const { status, body } = await json(`/api/report/${created.body.session_id}`);
  assert.equal(status, 422);
  assert.equal(body.error.code, "not_enough_content");
});

await step("pages render", async () => {
  for (const path of ["/", "/upload", "/setup", `/interview/${sessionId}`, `/report/${sessionId}`]) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, path);
  }
  assert.equal((await fetch(`${BASE}/definitely-missing`)).status, 404);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
