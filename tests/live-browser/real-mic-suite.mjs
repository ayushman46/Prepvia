#!/usr/bin/env node
/**
 * Real-microphone test suite: every voice path a candidate can hit, with the
 * Mac's REAL microphone and speakers. Answers are spoken out loud with macOS
 * `say`; transcription is real Groq Whisper (or the stub with --stt=fake).
 *
 *   npm run build && node tests/live-browser/real-mic-suite.mjs [--stt=real|fake] [--browser=chromium|brave] [--dev] [--only=A,B,C]
 *
 * Sessions: A permission denied · B hands-free (greeting, silence, normal/short/
 * long/quiet answers, barge-in, mute, refresh, end + mic release) · C push-to-talk.
 * Results depend on the room: background voices are real input to the microphone.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { MongoClient } from "mongodb";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const STT = args.get("stt") || "real";
const BROWSER = args.get("browser") || "chromium";
const DEV = args.has("dev");
const ONLY = (args.get("only") || "A,B,C").split(",");
const VOICE = args.get("voice") || "Samantha";
const APP_PORT = 3610;
const FAKE_PORT = 4070;
const BASE = `http://localhost:${APP_PORT}`;
const DB_NAME = `interviewai_micsuite_${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

const TEXT = {
  normal: "I led the migration of our payments ledger from a Rails monolith to a Go service on Kafka, and we cut latency by eighty percent.",
  short1: "Yes.",
  short2: "No, I haven't.",
  long:
    "Let me walk you through the whole project. We started by mapping every write path in the monolith. Then we built an outbox table so each database write and its event were committed together. " +
    "Next we ran both systems in parallel for six weeks and compared the ledgers every night. When the drift dropped below one in a million, we moved merchants over in small batches. " +
    "Finally we turned off the old code path and deleted the cron jobs that had been patching data by hand.",
  quiet: "We used an outbox table in Postgres so the database write and the event were committed in one transaction.",
  barge: "Sorry to interrupt, can I add one more detail about the rollout?",
  afterRefresh: "After an incident we wrote a short report and added a load test for the hot path.",
  muted: "This sentence is spoken while the microphone is muted and must never be sent.",
  ptt: "I would alert on consumer lag and page the on call engineer if it keeps growing for five minutes.",
  pttButton: "For capacity planning we load tested at three times the peak traffic every quarter.",
  afterSwitch: "Our on call rotation had five engineers and a weekly handover meeting.",
};

function loadEnvLocal() {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer().once("error", () => reject(new Error(`Port ${port} in use`)));
    probe.once("listening", () => probe.close(resolve)).listen(port, "127.0.0.1");
  });
}
const words = (t) => (t.toLowerCase().match(/[a-z0-9']+/g) ?? []).map((w) => w.replace(/'/g, ""));
/** Share of the expected words found in the transcript (numbers may be written as digits). */
function recall(expected, actual) {
  const got = new Set(words(actual));
  const want = words(expected).filter((w) => !/^(eighty|percent|one|three|five|six|million)$/.test(w));
  return want.length ? want.filter((w) => got.has(w)).length / want.length : 1;
}

// ------------------------------------------------------------ reporting
const results = [];
let currentPage = null;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)${detail ? `  ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(error?.message ?? error).slice(0, 500) });
    console.log(`  ✗ ${name}\n    ${String(error?.message ?? error).split("\n").slice(0, 3).join("\n    ")}`);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    await currentPage?.screenshot({ path: join(root, "test-results", `realmic-${BROWSER}${DEV ? "-dev" : ""}-${slug}.png`) }).catch(() => undefined);
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

// ------------------------------------------------------------ page helpers
const INSTRUMENT = () => {
  // Ground truth for audio playback and microphone streams (no fake microphone).
  window.__appAudio = { starts: [], stops: [], clips: [] };
  const start = AudioBufferSourceNode.prototype.start;
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function (...a) {
    const t = performance.now();
    window.__appAudio.starts.push(t);
    window.__appAudio.clips.push({ t, d: this.buffer ? this.buffer.duration * 1000 : 0 });
    return start.apply(this, a);
  };
  AudioBufferSourceNode.prototype.stop = function (...a) {
    window.__appAudio.stops.push(performance.now());
    return stop.apply(this, a);
  };
  window.__streams = [];
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await gum(constraints);
    window.__streams.push(stream);
    return stream;
  };
};

function pageHelpers(page, requests) {
  const now = () => page.evaluate(() => performance.now());
  const status = () => page.locator('[data-testid="status"]').innerText({ timeout: 2_000 }).catch(() => "(no status)");
  const waitStatus = async (re, timeout = 60_000) => {
    const end = Date.now() + timeout;
    let last = "";
    while (Date.now() < end) {
      last = await status();
      if (re.test(last)) return last;
      await sleep(250);
    }
    throw new Error(`status never matched ${re} (last: "${last}")`);
  };
  const userTexts = async () => (await page.getByTestId("msg-user").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  const aiCount = () => page.getByTestId("msg-ai").count();
  const sayAsync = (text, volume = 1) =>
    new Promise((resolve) => {
      const child = spawn("say", ["-v", VOICE, volume === 1 ? text : `[[volm ${volume}]] ${text}`]);
      child.on("exit", () => resolve());
    });
  /** Speak, then wait for a NEW confirmed user bubble; returns {text, recall, ms}. */
  const speakAnswer = async (text, { volume = 1, timeout = 30_000 } = {}) => {
    const before = await userTexts();
    const reqBefore = requests.length;
    await sayAsync(text, volume);
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const after = await userTexts();
      if (after.length > before.length) {
        const got = after.at(-1);
        return { text: got, recall: recall(text, got), requests: requests.slice(reqBefore).map((r) => r.kind) };
      }
      await sleep(250);
    }
    throw new Error(`no transcribed bubble within ${timeout / 1000}s (requests: ${requests.slice(reqBefore).map((r) => `${r.kind}:${r.status}`).join(",") || "none"})`);
  };
  const appAudio = () => page.evaluate(() => window.__appAudio);
  return { now, status, waitStatus, userTexts, aiCount, sayAsync, speakAnswer, appAudio };
}

async function openRoom(browser, { permissions = ["microphone"], pushToTalk = false, label }) {
  const start = await fetch(`${BASE}/api/interview/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Mic Test",
      role: "Backend Engineer",
      resume_text: "Senior backend engineer. Led a payments ledger migration from Rails to Go on Kafka; outbox pattern; on call lead.",
      duration_minutes: 30,
    }),
  }).then((r) => r.json());
  const context = await browser.newContext({ permissions, viewport: { width: 1200, height: 820 } });
  await context.addInitScript(INSTRUMENT);
  await context.addInitScript((push) => localStorage.setItem("interviewai:capture-mode", push ? "push" : "auto"), pushToTalk);
  const page = await context.newPage();
  currentPage = page;
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|favicon|DevTools/i.test(m.text()) && problems.push(`console: ${m.text().slice(0, 200)}`));
  const requests = [];
  const T0 = Date.now();
  page.on("response", (res) => {
    const m = res.url().match(/\/api\/interview\/[^/]+\/(turn|transcribe)/);
    if (m) requests.push({ t: Date.now() - T0, kind: m[1], status: res.status() });
  });
  await page.goto(`${BASE}/interview/${start.session_id}?debug=1`);
  console.log(`\n${label}`);
  return { context, page, id: start.session_id, requests, problems, h: pageHelpers(page, requests) };
}

async function startInterview(page, h) {
  await page.getByTestId("start").waitFor({ timeout: 90_000 });
  for (let i = 0; i < 120 && !(await page.getByTestId("start").isEnabled()); i++) await sleep(500);
  await page.getByTestId("start").click();
  await h.waitStatus(/Your turn|Aria is speaking|Thinking/, 30_000);
  await h.waitStatus(/Your turn/, 90_000);
}

// ------------------------------------------------------------ sessions
async function sessionA(browserNoAutoAllow) {
  const { context, page, h, problems } = await openRoom(browserNoAutoAllow, { permissions: [], label: "Session A: microphone permission denied" });
  await step("A1 denied microphone: specific message, typing offered, retry button", async () => {
    await page.getByTestId("start").waitFor({ timeout: 90_000 });
    for (let i = 0; i < 120 && !(await page.getByTestId("start").isEnabled()); i++) await sleep(500);
    await page.getByTestId("start").click();
    await page.getByTestId("mic-error").waitFor({ timeout: 20_000 });
    const message = await page.getByTestId("mic-error").innerText();
    assert(/denied|blocking|permission/i.test(message), `unexpected message: ${message}`);
    await h.waitStatus(/type your answer/, 60_000);
    assert(await page.locator("#answer").isVisible(), "typing box not shown");
    assert(await page.getByText("Try the microphone again").isVisible(), "no retry button");
    return `"${message.split("\n")[0].slice(0, 90)}…"`;
  });
  await step("A2 no page errors", async () => assert(problems.length === 0, problems.join(" | ")));
  await context.close();
}

async function sessionB(browser) {
  const { context, page, h, requests, problems, id } = await openRoom(browser, { label: "Session B: hands-free" });
  const latencies = [];

  await step("B1 greeting plays and Aria's own voice doesn't interrupt her or create turns", async () => {
    await startInterview(page, h);
    const audio = await h.appAudio();
    const turns = requests.filter((r) => r.kind === "turn").length;
    assert(audio.starts.length > 0, "no interviewer audio played");
    assert(audio.stops.length === 0, `interviewer audio was stopped ${audio.stops.length}× (self-interruption)`);
    assert(turns === 1, `${turns} turn requests during the greeting (expected only the opening)`);
    return `${audio.starts.length} audio clips played, 0 stopped early`;
  });

  await step("B2 8 s of silence sends nothing", async () => {
    const before = requests.length;
    await sleep(8_000);
    const sent = requests.slice(before);
    assert(sent.length === 0, `room sound sent ${sent.map((r) => r.kind).join(",")}`);
    return "0 requests";
  });

  const answerAndReply = async (key, opts = {}) => {
    await h.waitStatus(/Your turn/, 90_000);
    const aiBefore = await h.aiCount();
    const t0 = Date.now();
    const result = await h.speakAnswer(TEXT[key], opts);
    await h.waitStatus(/Aria is speaking|Your turn/, 60_000);
    for (let i = 0; i < 120 && (await h.aiCount()) === aiBefore; i++) await sleep(250);
    await h.waitStatus(/Your turn/, 120_000);
    return { ...result, totalMs: Date.now() - t0 };
  };

  await step("B3 normal answer: transcribed and answered", async () => {
    const audioBefore = (await h.appAudio()).starts.length;
    const saidAt = await h.now();
    const r = await answerAndReply("normal");
    const audio = await h.appAudio();
    const firstReplyAudio = audio.starts[audioBefore];
    assert(r.recall >= 0.85, `transcript recall ${(r.recall * 100).toFixed(0)}%: "${r.text}"`);
    const speechSeconds = words(TEXT.normal).length / 3; // ~180 wpm
    if (firstReplyAudio) latencies.push(Math.round(firstReplyAudio - saidAt - speechSeconds * 1000));
    return `recall ${(r.recall * 100).toFixed(0)}% "${r.text.slice(0, 70)}…" | requests ${r.requests.join(",")}`;
  });

  await step("B4 very short answers are detected (\"Yes.\", \"No, I haven't.\")", async () => {
    const r1 = await answerAndReply("short1");
    assert(/\byes\b/i.test(r1.text), `got "${r1.text}"`);
    const r2 = await answerAndReply("short2");
    assert(/\bno\b/i.test(r2.text) && /haven/i.test(r2.text), `got "${r2.text}"`);
    return `"${r1.text}" · "${r2.text}"`;
  });

  await step("B5 a ~30 s answer with pauses arrives as one complete turn", async () => {
    await h.waitStatus(/Your turn/, 90_000);
    const before = (await h.userTexts()).length;
    const turnsBefore = requests.filter((r) => r.kind === "turn").length;
    const r = await answerAndReply("long", { timeout: 40_000 });
    const after = (await h.userTexts()).length;
    const turns = requests.filter((r) => r.kind === "turn").length - turnsBefore;
    assert(after - before === 1, `${after - before} bubbles for one long answer`);
    assert(turns === 1, `${turns} turns for one long answer`);
    assert(/walk you through/i.test(r.text) && /patching data by hand/i.test(r.text), `incomplete: "${r.text.slice(0, 60)}…${r.text.slice(-60)}"`);
    assert(r.recall >= 0.85, `recall ${(r.recall * 100).toFixed(0)}%`);
    return `1 turn, recall ${(r.recall * 100).toFixed(0)}%, ${words(r.text).length} words`;
  });

  await step("B6 a quiet answer (25 % speaker volume) is transcribed", async () => {
    const r = await answerAndReply("quiet", { volume: 0.25 });
    assert(r.recall >= 0.8, `recall ${(r.recall * 100).toFixed(0)}%: "${r.text}"`);
    return `recall ${(r.recall * 100).toFixed(0)}%`;
  });

  await step("B7 barge-in: talking over Aria stops her and the interruption is answered", async () => {
    await h.waitStatus(/Your turn/, 90_000);
    // Give an answer, then interrupt Aria's reply.
    await h.speakAnswer("We also mentored three junior engineers during the migration.");
    await h.waitStatus(/Aria is speaking/, 60_000);
    await sleep(700);
    const stopsBefore = (await h.appAudio()).stops.length;
    const usersBefore = (await h.userTexts()).length;
    const t0 = await h.now();
    const speaking = h.sayAsync(TEXT.barge);
    let stoppedAt = null;
    for (let i = 0; i < 40 && stoppedAt === null; i++) {
      const stops = (await h.appAudio()).stops;
      if (stops.length > stopsBefore) stoppedAt = stops[stopsBefore];
      else await sleep(100);
    }
    await speaking;
    assert(stoppedAt !== null, "Aria was not interrupted");
    const stopMs = Math.round(stoppedAt - t0);
    for (let i = 0; i < 80 && (await h.userTexts()).length === usersBefore; i++) await sleep(250);
    const texts = await h.userTexts();
    assert(texts.length > usersBefore, "the interruption was not transcribed");
    await h.waitStatus(/Your turn/, 120_000);
    return `Aria stopped ${stopMs} ms after the candidate started talking; heard "${texts.at(-1).slice(0, 60)}"`;
  });

  await step("B8 muted: speech is ignored; unmuted: voice works again", async () => {
    await h.waitStatus(/Your turn/, 90_000);
    await page.getByLabel("Mute microphone").click();
    await h.waitStatus(/muted|type your answer/i, 5_000);
    const before = requests.length;
    await h.sayAsync(TEXT.muted);
    await sleep(2_500);
    assert(requests.length === before, `sent ${requests.slice(before).map((r) => r.kind).join(",")} while muted`);
    await page.getByLabel("Unmute microphone").click();
    await h.waitStatus(/speak naturally/, 10_000);
    const live = await page.evaluate(() => window.__streams.filter((s) => s.getAudioTracks().some((t) => t.readyState === "live")).length);
    assert(live >= 1, "no live microphone stream after unmute");
    return "0 requests while muted; mic live again";
  });

  await step("B9 refresh mid-interview: resume, and the next spoken answer works", async () => {
    await page.reload();
    await page.getByTestId("start").waitFor({ timeout: 90_000 });
    for (let i = 0; i < 120 && !(await page.getByTestId("start").isEnabled()); i++) await sleep(500);
    await page.getByTestId("start").click();
    await h.waitStatus(/Your turn/, 30_000);
    const r = await h.speakAnswer(TEXT.afterRefresh);
    assert(r.recall >= 0.85, `recall ${(r.recall * 100).toFixed(0)}%: "${r.text}"`);
    await h.waitStatus(/Your turn/, 120_000);
    return `recall ${(r.recall * 100).toFixed(0)}%`;
  });

  await step("B10 ending the interview releases the microphone and produces a report", async () => {
    await page.getByRole("button", { name: "End interview" }).click();
    await page.getByRole("button", { name: /End & get report/ }).click();
    await page.waitForURL(/\/report\//, { timeout: 20_000 });
    await sleep(1_500);
    const live = await page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);
    assert(live === 0, `${live} microphone track(s) still live after ending`);
    await page.getByTestId("scorecard").waitFor({ timeout: 150_000 });
    const report = await fetch(`${BASE}/api/report/${id}`).then((r) => r.json());
    return `mic released; report score ${report.score}`;
  });

  await step("B11 no page errors during the session", async () => assert(problems.length === 0, problems.join(" | ")));
  await context.close();
  return latencies;
}

async function sessionC(browser) {
  const { context, page, h, requests, problems } = await openRoom(browser, { pushToTalk: true, label: "Session C: push-to-talk" });
  const hold = async (text, { via = "space" } = {}) => {
    await h.waitStatus(/hold Space/, 120_000);
    const before = (await h.userTexts()).length;
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    if (via === "space") await page.keyboard.down("Space");
    else {
      const box = await page.getByTestId("push-to-talk").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
    }
    await h.waitStatus(/Recording/, 3_000);
    await h.sayAsync(text);
    if (via === "space") await page.keyboard.up("Space");
    else await page.mouse.up();
    for (let i = 0; i < 80 && (await h.userTexts()).length === before; i++) await sleep(250);
    const texts = await h.userTexts();
    assert(texts.length > before, "held answer was not transcribed");
    return texts.at(-1);
  };

  await step("C1 push-to-talk chosen in the lobby; background sound sends nothing", async () => {
    await startInterview(page, h);
    await h.waitStatus(/hold Space/, 10_000);
    const before = requests.length;
    await sleep(6_000);
    assert(requests.length === before, `room sound sent ${requests.slice(before).map((r) => r.kind).join(",")}`);
    return "0 requests in 6 s";
  });

  await step("C2 holding Space records the answer and it is transcribed", async () => {
    const text = await hold(TEXT.ptt);
    assert(recall(TEXT.ptt, text) >= 0.85, `recall low: "${text}"`);
    return `"${text.slice(0, 70)}…"`;
  });

  await step("C3 holding during \"Thinking…\" is refused", async () => {
    // Right after a held answer the room is thinking.
    await h.waitStatus(/Thinking|Aria is speaking/, 30_000);
    const s = await h.status();
    if (/Thinking/.test(s)) {
      await page.keyboard.down("Space");
      await sleep(400);
      const during = await h.status();
      await page.keyboard.up("Space");
      assert(!/Recording/.test(during), `recording started while thinking (${during})`);
      return "refused while thinking";
    }
    return "reply was already playing (thinking state too short to test this time)";
  });

  await step("C4 a quick tap of Space sends nothing", async () => {
    await h.waitStatus(/hold Space/, 120_000);
    const before = requests.length;
    await page.keyboard.down("Space");
    await sleep(150);
    await page.keyboard.up("Space");
    await sleep(2_000);
    assert(requests.length === before, `a tap sent ${requests.slice(before).map((r) => r.kind).join(",")}`);
    return "0 requests";
  });

  await step("C5 the on-screen button works with press-and-hold", async () => {
    const text = await hold(TEXT.pttButton, { via: "button" });
    assert(recall(TEXT.pttButton, text) >= 0.8, `recall low: "${text}"`);
    return `"${text.slice(0, 70)}…"`;
  });

  await step("C6 switching to hands-free mid-hold ends the hold; hands-free then works", async () => {
    await h.waitStatus(/hold Space/, 120_000);
    await page.keyboard.down("Space");
    await h.waitStatus(/Recording/, 3_000);
    await page.getByTestId("capture-mode").click();
    await page.keyboard.up("Space");
    await h.waitStatus(/speak naturally|Your turn|Thinking|Aria is speaking/, 10_000);
    await h.waitStatus(/speak naturally/, 120_000);
    const r = await h.speakAnswer(TEXT.afterSwitch);
    assert(r.recall >= 0.8, `recall low: "${r.text}"`);
    await h.waitStatus(/Your turn/, 120_000);
    return `hands-free answer: "${r.text.slice(0, 60)}"`;
  });

  await step("C7 no page errors during the session", async () => assert(problems.length === 0, problems.join(" | ")));
  await context.close();
}

async function sessionE(browser) {
  const { context, page, h, problems } = await openRoom(browser, { label: "Session E: echo of Aria's voice through the laptop speakers" });
  await step("E1 Aria's own voice from the speakers is not detected as speech (would not interrupt her)", async () => {
    await page.getByTestId("start").waitFor({ timeout: 90_000 });
    await page.getByLabel(/Let me interrupt by speaking/).uncheck(); // record without letting her be cut off
    for (let i = 0; i < 120 && !(await page.getByTestId("start").isEnabled()); i++) await sleep(500);
    await page.getByTestId("start").click();
    await h.waitStatus(/Your turn/, 90_000);
    const typed = ["I mostly worked on payment systems in Go.", "We used Kafka and Postgres with an outbox table.", "I led a team of four engineers."];
    for (const text of typed) {
      if (!(await page.locator("#answer").isVisible())) await page.getByLabel("Type an answer").click();
      await page.locator("#answer").fill(text);
      await page.locator("#answer").press("Enter");
      await h.waitStatus(/Aria is speaking/, 60_000);
      await h.waitStatus(/Your turn/, 120_000);
      await sleep(3_000); // silence baseline after her reply
    }
    const { frames, clips } = await page.evaluate(() => ({ frames: window.__vadProbs ?? [], clips: window.__appAudio.clips }));
    // Merge clips into playback windows.
    const windows = [];
    for (const c of [...clips].sort((a, b) => a.t - b.t)) {
      const last = windows.at(-1);
      if (last && c.t <= last.end + 150) last.end = Math.max(last.end, c.t + c.d);
      else windows.push({ start: c.t, end: c.t + c.d });
    }
    const stats = (inside) => {
      const fs = frames.filter((f) => inside(f.t));
      let triggers = 0;
      const recent = [];
      for (const f of fs) {
        recent.push(f.p >= 0.7);
        if (recent.length > 10) recent.shift();
        if (recent.filter(Boolean).length >= 7) {
          triggers++;
          recent.length = 0;
        }
      }
      return { frames: fs.length, speechy: fs.filter((f) => f.p >= 0.7).length, triggers, maxP: Math.max(0, ...fs.map((f) => f.p)) };
    };
    const during = stats((t) => windows.some((w) => t >= w.start && t <= w.end));
    const firstSecond = stats((t) => windows.some((w) => t >= w.start && t <= w.start + 1_000));
    const after = stats((t) => windows.some((w) => t > w.end + 300 && t <= w.end + 3_000));
    const detail = `during Aria's speech: ${during.speechy}/${during.frames} frames p≥0.7, ${during.triggers} barge-in triggers (first second of each reply: ${firstSecond.triggers}) | silence after: ${after.speechy}/${after.frames} frames, ${after.triggers} triggers`;
    writeFileSync(join(root, "test-results", `echo-trace-${BROWSER}.json`), JSON.stringify({ windows, frames: frames.map((f) => ({ t: Math.round(f.t), p: +f.p.toFixed(3), rms: +f.rms.toFixed(5) })) }));
    assert(during.triggers === 0, `Aria's own voice would trigger barge-in: ${detail}`);
    return detail;
  });
  await step("E2 no page errors", async () => assert(problems.length === 0, problems.join(" | ")));
  await context.close();
}

// ------------------------------------------------------------ main
loadEnvLocal();
if (!DEV && !existsSync(join(root, ".next/BUILD_ID"))) throw new Error("Run `npm run build` first");
await assertPortFree(APP_PORT);
const children = [];
const env = { ...process.env, MONGODB_DB_NAME: DB_NAME };
if (STT === "fake") {
  await assertPortFree(FAKE_PORT);
  children.push(spawn(process.execPath, [join(root, "tests/e2e/fake-providers.mjs"), String(FAKE_PORT)], { stdio: "ignore", env: { ...process.env } }));
  Object.assign(env, { GROQ_API_KEY: "fake", GROQ_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`, LLM_FALLBACK_GROQ: "false" });
}
const app = spawn("npx", ["next", DEV ? "dev" : "start", "-p", String(APP_PORT)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
children.push(app);
const serverLog = [];
app.stdout.on("data", (d) => serverLog.push(d.toString()));
app.stderr.on("data", (d) => serverLog.push(d.toString()));
mkdirSync(join(root, "test-results"), { recursive: true });

let latencies = [];
try {
  for (let i = 0; i < 120 && !(await fetch(`${BASE}/api/health`).catch(() => null)); i++) await sleep(500);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  console.log(`Real-microphone suite · ${BROWSER}${DEV ? " · next dev" : " · production build"} · STT ${STT} · health ${JSON.stringify(health.checks)}`);
  const launch = (autoAllow) =>
    chromium.launch({
      headless: false,
      ...(BROWSER === "brave" ? { executablePath: BRAVE } : {}),
      args: [...(autoAllow ? ["--use-fake-ui-for-media-stream"] : []), "--autoplay-policy=no-user-gesture-required"],
    });
  if (ONLY.includes("A")) {
    const b = await launch(false);
    await sessionA(b);
    await b.close();
  }
  const browser = await launch(true);
  if (ONLY.includes("B")) latencies = await sessionB(browser);
  if (ONLY.includes("C")) await sessionC(browser);
  if (ONLY.includes("E")) await sessionE(browser);
  await browser.close();
} finally {
  for (const c of children) c.kill("SIGTERM");
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    await client.db(DB_NAME).dropDatabase();
  } finally {
    await client.close();
  }
}

const errors = serverLog.join("").split("\n").filter((l) => /"level":"error"/.test(l));
if (errors.length) console.log(`\nServer error lines:\n  ${errors.slice(0, 5).map((l) => l.slice(0, 240)).join("\n  ")}`);
const out = join(root, "test-results", `real-mic-suite-${BROWSER}${DEV ? "-dev" : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ browser: BROWSER, dev: DEV, stt: STT, results, latencies, serverErrors: errors.slice(0, 20) }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed · ${out}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
