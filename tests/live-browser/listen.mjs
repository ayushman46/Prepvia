#!/usr/bin/env node
/**
 * DIAGNOSTIC with the candidate's own voice: opens the real interview room in a
 * visible browser on the real microphone, starts an interview (real Groq Whisper,
 * fake interviewer so it costs no LLM quota), and prints every voice-detection
 * decision live while you talk: speech heard, gate rejections and why, end of
 * answer, what was transcribed. Writes the full trace to test-results/.
 *
 *   npm run build && node tests/live-browser/listen.mjs [--seconds=75] [--browser=brave]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const SECONDS = Number(args.get("seconds") || 75);
const APP_PORT = 3610;
const FAKE_PORT = 4070;
const BASE = `http://localhost:${APP_PORT}`;
const DB_NAME = `interviewai_listen_${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const line of existsSync(join(root, ".env.local")) ? readFileSync(join(root, ".env.local"), "utf8").split("\n") : []) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const fake = spawn(process.execPath, [join(root, "tests/e2e/fake-providers.mjs"), String(FAKE_PORT)], {
  stdio: "ignore",
  env: { ...process.env, FAKE_LLM_DELAY_MS: "400" },
});
const app = spawn("npx", ["next", "start", "-p", String(APP_PORT)], {
  cwd: root,
  stdio: "ignore",
  env: { ...process.env, NVIDIA_API_KEY: "fake", NVIDIA_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`, LLM_FALLBACK_GROQ: "false", MONGODB_DB_NAME: DB_NAME },
});
const executablePath =
  args.get("browser") === "brave" ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" : undefined;
const browser = await chromium.launch({ headless: false, executablePath, args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const trace = { events: [], frames: [], transcripts: [] };
try {
  for (let i = 0; i < 90; i++) {
    if ((await fetch(`${BASE}/api/health`).catch(() => null))?.ok) break;
    await sleep(1_000);
  }
  const { session_id: id } = await (
    await fetch(`${BASE}/api/interview/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Mic Test", role: "Software Engineer", resume_text: "", job_description: "", duration_minutes: 15, interview_type: "behavioral", level: "mid" }),
    })
  ).json();
  const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1200, height: 820 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/interview/${id}?debug=1`);
  await page.getByTestId("start").waitFor();
  for (let i = 0; i < 60 && !(await page.getByTestId("start").isEnabled()); i++) await sleep(500);
  await page.getByTestId("start").click();
  console.log(`\n🎙  Recording ${SECONDS} s. When the status says "Your turn", answer out loud as you normally would`);
  console.log("    (2–3 answers, normal voice, normal distance). Watch this log.\n");

  let seenEvents = 0;
  let seenUsers = 0;
  const started = Date.now();
  while (Date.now() - started < SECONDS * 1000) {
    await sleep(1_500);
    const state = await page.evaluate(() => ({
      events: window.__vadEvents ?? [],
      frames: (window.__vadProbs ?? []).slice(-47),
      status: document.querySelector("[data-testid='status']")?.textContent ?? "",
      users: [...document.querySelectorAll("[data-testid='msg-user']")].map((el) => el.textContent ?? ""),
      notice: document.querySelector("[data-testid='notice']")?.textContent ?? null,
    }));
    for (const event of state.events.slice(seenEvents)) {
      console.log(`  ${String(Math.round((event.t ?? 0) / 100) / 10).padStart(7)}s  ${event.event.padEnd(10)} ${JSON.stringify({ ...event, t: undefined, event: undefined })}`);
    }
    seenEvents = state.events.length;
    trace.events = state.events;
    trace.frames.push(...state.frames);
    for (const text of state.users.slice(seenUsers)) console.log(`  ➜ transcribed: "${text}"`);
    seenUsers = state.users.length;
    trace.transcripts = state.users;
    const f = state.frames;
    if (f.length) {
      const maxP = Math.max(...f.map((x) => x.p));
      const loud = Math.max(...f.map((x) => x.rms));
      console.log(`  · status "${state.status}" | last 1.5 s: max speech prob ${maxP.toFixed(2)}, peak level ${loud.toFixed(3)}, room floor ${f.at(-1).floor.toFixed(3)}${state.notice ? ` | notice: ${state.notice}` : ""}`);
    }
  }
} finally {
  mkdirSync(join(root, "test-results"), { recursive: true });
  const out = join(root, "test-results", `listen-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify(trace));
  console.log(`\ntrace: ${out}`);
  await browser.close();
  app.kill("SIGTERM");
  fake.kill("SIGTERM");
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect().then(() => client.db(DB_NAME).dropDatabase()).catch(() => undefined);
  await client.close();
}
