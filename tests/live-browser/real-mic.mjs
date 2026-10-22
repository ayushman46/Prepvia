#!/usr/bin/env node
/**
 * Manual live test with the REAL microphone (no fake audio device).
 *
 * Opens a visible browser on the interview room and speaks answers out loud
 * through the speakers with macOS `say`, so the real microphone, the browser's
 * audio processing, voice detection, the noise gate and speech-to-text are all
 * exercised. It also measures what the room itself sends: a 10 s silent stretch
 * should produce no requests.
 *
 *   npm run build && npm run test:real-mic -- [options]
 *
 *   --stt=real|fake        real Groq (default) or the local stub (separates "not detected" from "not transcribed")
 *   --mode=answers         two spoken answers in hands-free mode (default)
 *   --mode=ptt             push-to-talk: hold Space while speaking; background sound must send nothing
 *   --mode=sensitivity     the same sentence at 100/50/25/12/6 % volume
 *   --mode=trace           record the detector's own frames ({t, p, rms}) for silence and speech, as JSON
 *   --dev                  test against `next dev` (React StrictMode) instead of the production build
 *   --browser=brave        run in Brave (fresh temporary profile) instead of Chromium
 *   --voice=Samantha       macOS voice used for the spoken answers
 *
 * macOS may ask once to allow microphone access for the browser. Results depend
 * on the room: background voices are real input to the microphone.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const STT = args.get("stt") || "real";
const VOICE = args.get("voice") || "Samantha";
const APP_PORT = 3600;
const FAKE_PORT = 4060;
const BASE = `http://localhost:${APP_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANSWERS = [
  "I led the migration of our payments ledger from a Rails monolith to a Go service on Kafka, and we cut latency by eighty percent.",
  "We used an outbox table in Postgres so the database write and the event were committed in one transaction.",
];

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

loadEnvLocal();
if (!existsSync(join(root, ".next/BUILD_ID"))) throw new Error("Run `npm run build` first");
await assertPortFree(APP_PORT);
const children = [];
const env = { ...process.env, MONGODB_DB_NAME: `interviewai_realmic_${Date.now().toString(36)}` };
if (STT === "fake") {
  await assertPortFree(FAKE_PORT);
  children.push(spawn(process.execPath, [join(root, "tests/e2e/fake-providers.mjs"), String(FAKE_PORT)], { stdio: "ignore", env: { ...process.env, FAKE_STT_STICKY: "1", FAKE_STT_DEFAULT_EMPTY: "1" } }));
  Object.assign(env, { GROQ_API_KEY: "fake", GROQ_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`, LLM_FALLBACK_GROQ: "false" });
}
// --dev runs `next dev` (React StrictMode, as most people test locally) instead of the production build.
const app = spawn("npx", ["next", args.get("dev") ? "dev" : "start", "-p", String(APP_PORT)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
children.push(app);
const serverLog = [];
app.stdout.on("data", (d) => serverLog.push(d.toString()));
app.stderr.on("data", (d) => serverLog.push(d.toString()));

let browser;
try {
  for (let i = 0; i < 60 && !(await fetch(`${BASE}/api/health`).catch(() => null)); i++) await sleep(500);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  console.log("health:", JSON.stringify(health));
  const start = await fetch(`${BASE}/api/interview/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Live Mic", role: "Backend Engineer", resume_text: "Go, Kafka, Postgres. Led a payments ledger migration.", duration_minutes: 15 }),
  }).then((r) => r.json());
  const id = start.session_id;

  const BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  browser = await chromium.launch({
    headless: false,
    // --browser=brave runs the same test in Brave (fresh temporary profile; default Shields).
    ...(args.get("browser") === "brave" ? { executablePath: BRAVE } : {}),
    // Auto-accept the site permission prompt; the audio device itself is the real default microphone.
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1200, height: 820 } });
  if (args.get("mode") === "ptt") await context.addInitScript(() => localStorage.setItem("interviewai:capture-mode", "push"));
  const page = await context.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
  const requests = [];
  const T0 = Date.now();
  const marks = [];
  const mark = (label) => marks.push({ t: Date.now() - T0, label });
  page.on("response", async (res) => {
    const m = res.url().match(/\/api\/interview\/[^/]+\/(turn|transcribe)/);
    if (!m) return;
    const t = Date.now() - T0;
    let detail = "";
    if (m[1] === "turn") {
      const body = await res.text().catch(() => "");
      const events = body.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const user = events.find((e) => e.type === "user_transcript");
      const err = events.find((e) => e.type === "error");
      detail = `[${[...new Set(events.map((e) => e.type))].join(",")}]${user ? ` heard "${user.content.slice(0, 60)}"` : ""}${err ? ` error=${err.code}` : ""}`;
    } else {
      detail = await res.text().then((b) => b.slice(0, 100)).catch(() => "");
    }
    requests.push({ t, line: `${m[1]} → ${res.status()} ${detail}` });
  });

  // Is the real microphone reachable at all, and how loud is it?
  await page.goto(`${BASE}/interview/${id}?debug=1`);
  const devices = await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const track = stream.getAudioTracks()[0];
      const info = { label: track.label, settings: track.getSettings(), muted: track.muted, readyState: track.readyState };
      stream.getTracks().forEach((t) => t.stop());
      return info;
    } catch (error) {
      return { error: `${error.name}: ${error.message}` };
    }
  });
  console.log("microphone:", JSON.stringify(devices));
  if (devices.error) throw new Error(`Microphone not available: ${devices.error}`);

  await page.getByTestId("start").waitFor({ timeout: 90_000 });
  for (let i = 0; i < 90 && !(await page.getByTestId("start").isEnabled()); i++) await sleep(500);
  const lobbyText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  console.log(`lobby: start button "${await page.getByTestId("start").innerText()}"${/couldn.t load/i.test(lobbyText) ? " | VOICE DETECTION FAILED TO LOAD" : ""}`);
  await page.getByTestId("start").click();
  const statusText = () => page.locator('[data-testid="status"]').innerText({ timeout: 2_000 }).catch(() => "(no status)");
  for (let i = 0; i < 120 && !/Your turn/.test(await statusText()); i++) await sleep(500);
  console.log("status before speaking:", await statusText());

  // Raw microphone level sampler (independent of the VAD), same processing constraints.
  // Skipped in trace mode: a second capture with AGC can change the levels being traced.
  if (args.get("mode") !== "trace") await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    window.__rawLevels = [];
    setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      window.__rawLevels.push({ t: performance.now(), rms: Math.sqrt(sum / buf.length) });
    }, 50);
  });

  if (args.get("mode") === "ptt") {
    // Push-to-talk: hold Space while speaking. Background sound must never be sent.
    const setTranscript = (text) =>
      STT === "fake" ? fetch(`http://127.0.0.1:${FAKE_PORT}/set-transcript`, { method: "POST", body: JSON.stringify({ text }) }) : Promise.resolve();
    console.log("status:", await statusText());
    mark("silence start (10 s)");
    await sleep(10_000);
    mark("silence end");
    const sentDuringSilence = requests.length;
    await page.mouse.click(20, 400); // focus the page, not a button
    for (const [n, text] of ANSWERS.entries()) {
      for (let i = 0; i < 120 && !/Your turn/.test(await statusText()); i++) await sleep(500);
      await setTranscript(text);
      const before = await page.getByTestId("msg-user").count();
      await page.keyboard.down("Space");
      await sleep(200);
      console.log(`  holding Space: ${await statusText()}`);
      mark(`say answer ${n + 1} (Space held)`);
      spawnSync("say", ["-v", VOICE, text]);
      await page.keyboard.up("Space");
      mark(`Space released`);
      for (let i = 0; i < 40 && (await page.getByTestId("msg-user").count()) === before; i++) await sleep(250);
      for (let i = 0; i < 40; i++) {
        const last = (await page.getByTestId("msg-user").allInnerTexts()).at(-1) ?? "";
        if (last.trim()) break;
        await sleep(250);
      }
      const users = await page.getByTestId("msg-user").allInnerTexts();
      console.log(`  answer ${n + 1}: ${users.length > before ? `sent → "${(users.at(-1) || "").slice(0, 90)}"` : "NOT SENT"}`);
      for (let i = 0; i < 120 && !/Your turn/.test(await statusText()); i++) await sleep(500);
    }
    console.log(`  requests during 10 s of background sound: ${sentDuringSilence}`);
    const timeline = [...marks.map((m) => ({ t: m.t, line: `── ${m.label}` })), ...requests].sort((a, b) => a.t - b.t);
    console.log("timeline:\n  " + timeline.map((e) => `${String(e.t).padStart(6)}  ${e.line}`).join("\n  "));
    throw new Error("ptt run finished");
  }
  if (args.get("mode") === "trace") {
    // Record the VAD's own frames ({t, p, rms}) for silence and for speech at several loudness levels.
    const sentence = "I designed the outbox table and the idempotent consumers myself.";
    const segments = [];
    const t0 = await page.evaluate(() => performance.now());
    await sleep(15_000);
    segments.push({ label: "silence", from: t0, to: await page.evaluate(() => performance.now()) });
    for (const volume of [1, 0.5, 0.25, 0.12]) {
      for (let i = 0; i < 60 && !/Your turn/.test(await statusText()); i++) await sleep(500);
      await sleep(1_500);
      const a = await page.evaluate(() => performance.now());
      spawnSync("say", ["-v", VOICE, `[[volm ${volume}]] ${sentence}`]);
      segments.push({ label: `speech@${volume}`, from: a, to: await page.evaluate(() => performance.now()) });
    }
    await sleep(2_000);
    const frames = await page.evaluate(() => window.__vadProbs ?? []);
    const { writeFileSync } = await import("node:fs");
    const out = join(process.env.SHOT_DIR || "/tmp", `vad-trace-${args.get("browser") || "chromium"}.json`);
    writeFileSync(out, JSON.stringify({ segments, frames: frames.map((f) => ({ t: Math.round(f.t), p: +f.p.toFixed(4), rms: +f.rms.toFixed(5) })) }));
    for (const seg of segments) {
      const fs = frames.filter((f) => f.t >= seg.from && f.t <= seg.to);
      const pct = (xs, q) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(q * (xs.length - 1))] : 0);
      const speechRms = fs.filter((f) => f.p >= 0.8).map((f) => f.rms);
      const quietRms = fs.filter((f) => f.p < 0.35).map((f) => f.rms);
      console.log(`  ${seg.label.padEnd(12)} frames ${String(fs.length).padStart(4)} | p≥0.5 ${String(fs.filter((f) => f.p >= 0.5).length).padStart(3)} | p≥0.8 ${String(speechRms.length).padStart(3)} | rms(p≥0.8) p10 ${pct(speechRms, 0.1).toFixed(4)} p50 ${pct(speechRms, 0.5).toFixed(4)} | rms(p<0.35) p50 ${pct(quietRms, 0.5).toFixed(4)} p90 ${pct(quietRms, 0.9).toFixed(4)}`);
    }
    console.log(`  trace written to ${out}`);
    throw new Error("trace run finished");
  }
  if (args.get("mode") === "sensitivity") {
    // Same sentence at decreasing loudness: where does detection stop?
    const sentence = "I designed the outbox table and the idempotent consumers myself.";
    for (const volume of [1, 0.5, 0.25, 0.12, 0.06]) {
      for (let i = 0; i < 60 && !/Your turn/.test(await statusText()); i++) await sleep(500);
      await sleep(1_500);
      const before = requests.length;
      const a = await page.evaluate(() => performance.now());
      spawnSync("say", ["-v", VOICE, `[[volm ${volume}]] ${sentence}`]);
      const b = await page.evaluate(() => performance.now());
      await sleep(2_500);
      const st = await page.evaluate(([x, y]) => {
        const probs = (window.__vadProbs ?? []).filter((f) => f.t >= x && f.t <= y).map((f) => f.p);
        const lv = (window.__rawLevels ?? []).filter((f) => f.t >= x && f.t <= y).map((f) => f.rms);
        return { max: Math.max(0, ...probs), over: probs.filter((p) => p >= 0.5).length, frames: probs.length, rms: lv.length ? [...lv].sort((m, n) => m - n)[Math.floor(lv.length / 2)] : 0 };
      }, [a, b]);
      const sent = requests.slice(before).map((r) => r.line.split(" ")[0]);
      console.log(`  volume ${String(volume).padEnd(4)} → VAD max ${st.max.toFixed(2)}, ${st.over}/${st.frames} frames ≥ 0.5, speech RMS p50 ${st.rms.toFixed(4)} | sent: ${sent.join(",") || "nothing"}`);
    }
    throw new Error("sensitivity run finished");
  }
  mark("silence start (10 s)");
  await sleep(10_000);
  mark("silence end");
  for (const [n, text] of ANSWERS.entries()) {
    for (let i = 0; i < 120 && !/Your turn/.test(await statusText()); i++) await sleep(500);
    if (STT === "fake") await fetch(`http://127.0.0.1:${FAKE_PORT}/set-transcript`, { method: "POST", body: JSON.stringify({ text }) });
    const usersBefore = await page.getByTestId("msg-user").count();
    const t0 = await page.evaluate(() => performance.now());
    console.log(`\nspeaking answer ${n + 1} out loud (${VOICE})…`);
    mark(`say answer ${n + 1} start`);
    spawnSync("say", ["-v", VOICE, text]);
    mark(`say answer ${n + 1} end`);
    const t1 = await page.evaluate(() => performance.now());
    await sleep(4_000);
    const stats = await page.evaluate(
      ([a, b]) => {
        const probs = (window.__vadProbs ?? []).filter((f) => f.t >= a && f.t <= b).map((f) => f.p);
        const levels = (window.__rawLevels ?? []).filter((f) => f.t >= a && f.t <= b).map((f) => f.rms);
        const quiet = (window.__rawLevels ?? []).filter((f) => f.t < a).slice(-20).map((f) => f.rms);
        const pct = (xs, p) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(p * (xs.length - 1))] : null);
        return {
          vad_frames: probs.length,
          vad_max: probs.length ? Math.max(...probs) : null,
          vad_frames_over_0_5: probs.filter((p) => p >= 0.5).length,
          raw_rms_p50: pct(levels, 0.5),
          raw_rms_max: levels.length ? Math.max(...levels) : null,
          room_noise_rms: pct(quiet, 0.5),
        };
      },
      [t0, t1],
    );
    console.log("  voice detector:", JSON.stringify(stats));
    for (let i = 0; i < 40 && (await page.getByTestId("msg-user").count()) === usersBefore; i++) await sleep(500);
    for (let i = 0; i < 20 && !((await page.getByTestId("msg-user").allInnerTexts()).at(-1) ?? "").trim(); i++) await sleep(250);
    const users = await page.getByTestId("msg-user").allInnerTexts();
    const detected = users.length > usersBefore && !!(users.at(-1) ?? "").trim();
    console.log(`  answer detected: ${detected}${detected ? ` → "${users.at(-1).slice(0, 120)}"` : ""}`);
    for (let i = 0; i < 30 && !/Your turn/.test(await statusText()); i++) await sleep(500);
    await page.screenshot({ path: join(process.env.SHOT_DIR || "/tmp", `realmic-${STT}-answer${n + 1}.png`) });
    const banner = (await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "")).match(/(Speech recognition[^\n]*|(?:Sorry, )?[Ii] didn't catch that[^\n]*|We couldn't transcribe[^\n]*|The interviewer is having trouble[^\n]*|Microphone[^\n]*blocked[^\n]*)/);
    console.log(`  status: ${await statusText()}${banner ? ` | message: ${banner[0]}` : ""}`);
  }
  const visible = async (id) => page.getByTestId(id).isVisible().catch(() => false);
  console.log(`\nUI: noisy-room hint ${await visible("noisy-hint")}, voice-unavailable banner ${await visible("voice-unavailable")}, mic error ${await visible("mic-error")}`);
  const timeline = [...marks.map((m) => ({ t: m.t, line: `── ${m.label}` })), ...requests].sort((a, b) => a.t - b.t);
  console.log("\ntimeline (ms since page open):\n  " + timeline.map((e) => `${String(e.t).padStart(6)}  ${e.line}`).join("\n  "));
  const errors = consoleLines.filter((l) => /error|warn/i.test(l));
  if (errors.length) console.log("browser console:\n  " + errors.slice(0, 10).join("\n  "));
  const serverErrors = serverLog.join("").split("\n").filter((l) => /"level":"(error|warn)"/.test(l));
  if (serverErrors.length) console.log("server warnings/errors:\n  " + serverErrors.slice(0, 6).map((l) => l.slice(0, 300)).join("\n  "));
} finally {
  await browser?.close();
  for (const c of children) c.kill("SIGTERM");
}
process.exit(0);
