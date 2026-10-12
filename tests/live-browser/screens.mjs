#!/usr/bin/env node
/**
 * UI SCREENSHOTS — every screen and interview state, desktop and phone, for review.
 *
 * Production build, fake LLM/STT providers (fast, deterministic), real Edge TTS,
 * real MongoDB (throwaway database), programmable fake microphone.
 *
 *   npm run build && node tests/live-browser/screens.mjs [--out=test-results/screens]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const APP_PORT = 3320;
const FAKE_PORT = 4040;
const BASE = `http://localhost:${APP_PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const OUT = join(root, args.get("out") || "test-results/screens");
const DB_NAME = `interviewai_screens_${Date.now().toString(36)}`;
mkdirSync(OUT, { recursive: true });

for (const line of existsSync(join(root, ".env.local")) ? readFileSync(join(root, ".env.local"), "utf8").split("\n") : []) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(100);
  }
  throw new Error("timed out");
}

function say(text) {
  const file = join(tmpdir(), `screens-${Date.now()}.wav`);
  execFileSync("say", ["-v", "Samantha", "-o", file, "--data-format=LEI16@24000", text]);
  return readFileSync(file).toString("base64");
}

const fake = spawn(process.execPath, [join(root, "tests/e2e/fake-providers.mjs"), String(FAKE_PORT)], {
  stdio: "ignore",
  env: { ...process.env, FAKE_LLM_DELAY_MS: "900", FAKE_STT_DELAY_MS: "300", FAKE_STT_STICKY: "1", FAKE_STT_DEFAULT_EMPTY: "1" },
});
const app = spawn("npx", ["next", "start", "-p", String(APP_PORT)], {
  cwd: root,
  stdio: "ignore",
  env: {
    ...process.env,
    NVIDIA_API_KEY: "fake",
    NVIDIA_BASE_URL: `${FAKE}/v1`,
    GROQ_API_KEY: "fake",
    GROQ_BASE_URL: `${FAKE}/v1`,
    LLM_FALLBACK_GROQ: "false",
    MONGODB_DB_NAME: DB_NAME,
    INTERVIEW_CLOCK_SPEEDUP: "20",
  },
});

const shots = [];
async function shot(page, name, note) {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push({ name, note });
  console.log(`  📸 ${name} — ${note}`);
}
const setTranscript = (text) => fetch(`${FAKE}/set-transcript`, { method: "POST", body: JSON.stringify({ text }) });
const status = (page) => page.getByTestId("status").innerText().catch(() => "");

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
try {
  await waitUntil(async () => (await fetch(`${BASE}/api/health`)).ok, 90_000);
  for (const device of [
    { tag: "desktop", viewport: { width: 1366, height: 860 } },
    { tag: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  ]) {
    console.log(`\n${device.tag}`);
    const context = await browser.newContext({ ...device, permissions: ["microphone"] });
    await context.addInitScript({ path: join(root, "tests/live-browser/fake-mic.js") });
    const page = await context.newPage();
    const t = (name) => `${device.tag}-${name}`;

    await page.goto(BASE);
    await shot(page, t("01-landing"), "landing page");
    await page.goto(`${BASE}/upload`);
    await shot(page, t("02-upload"), "resume upload");
    await page.goto(`${BASE}/setup`);
    await shot(page, t("03-setup"), "interview setup form");

    const created = await (
      await fetch(`${BASE}/api/interview/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Priya Raman",
          role: "Senior Backend Engineer",
          resume_text: "Senior backend engineer, 7 years. Go, Kafka, Postgres, Redis. Led the ledger migration; idempotent payment APIs at 3M requests/day.",
          job_description: "Senior Backend Engineer, Payments.",
          duration_minutes: 15,
          interview_type: "mixed",
          level: "senior",
        }),
      })
    ).json();
    const id = created.session_id;
    await page.goto(`${BASE}/interview/${id}`);
    await waitUntil(() => page.getByTestId("start").isEnabled(), 60_000);
    await shot(page, t("04-lobby"), "lobby before the microphone check");
    await page.getByTestId("mic-check").click();
    await page.getByTestId("mic-check-panel").waitFor();
    await setTranscript("");
    await page.evaluate((b64) => window.__fakeMic.play(b64), say("Testing, one two three."));
    await page.getByText("We can hear you").waitFor({ timeout: 10_000 }).catch(() => undefined);
    await shot(page, t("05-lobby-mic-ok"), "lobby after the microphone check heard speech");

    await page.getByTestId("start").click();
    await waitUntil(async () => /Aria is speaking/.test(await status(page)), 30_000);
    await sleep(700);
    await shot(page, t("06-aria-speaking"), "Aria speaking the greeting (captions/transcript, orb)");
    await waitUntil(async () => /Your turn/.test(await status(page)), 60_000);
    await shot(page, t("07-your-turn"), "candidate's turn, idle");

    const answer = "I led the migration of our payments ledger to an event driven Go service on Kafka, and reconciliation errors dropped by seventy percent.";
    await setTranscript(answer);
    const playing = page.evaluate((b64) => window.__fakeMic.play(b64), say(answer));
    await waitUntil(async () => /Listening/.test(await status(page)), 10_000);
    await shot(page, t("08-listening"), "candidate speaking (Listening…)");
    await playing;
    await waitUntil(async () => /Thinking/.test(await status(page)), 10_000).catch(() => undefined);
    await shot(page, t("09-thinking"), "answer sent, Aria thinking");
    await waitUntil(async () => /Your turn/.test(await status(page)), 60_000);

    await page.getByLabel("Type an answer").click();
    await page.locator("#answer").fill("I'd use idempotency keys with a unique index and an outbox table.");
    await shot(page, t("10-typing"), "typing an answer");
    await page.locator("#answer").press("Enter");
    await waitUntil(async () => /Your turn/.test(await status(page)), 60_000);
    await page.getByLabel("Type an answer").click(); // back to voice

    await page.getByTestId("capture-mode").click();
    await sleep(300);
    await shot(page, t("11-push-to-talk"), "push-to-talk mode");
    await page.getByTestId("capture-mode").click();

    // Drive the clock to the hands-on canvas.
    for (let i = 0; i < 8 && !(await page.getByLabel("Hands-on canvas").isVisible().catch(() => false)); i++) {
      if (device.tag === "phone" && (await page.getByRole("button", { name: "canvas" }).isVisible().catch(() => false))) break;
      if (!(await page.locator("#answer").isVisible().catch(() => false))) await page.getByLabel("Type an answer").click();
      await page.locator("#answer").fill("We tracked p95 latency and error budget burn on every deploy.");
      await page.locator("#answer").press("Enter");
      await waitUntil(async () => /Your turn|complete/.test(await status(page)), 60_000).catch(() => undefined);
      await sleep(1_500);
    }
    await sleep(1_000);
    await shot(page, t("12-canvas"), "hands-on canvas open");
    if (device.tag === "phone" && (await page.getByRole("button", { name: "interview" }).isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "interview" }).click();
      await shot(page, t("13-canvas-interview-tab"), "phone: interview tab while the canvas is open");
    }

    await page.getByRole("button", { name: "End interview" }).click();
    await shot(page, t("14-end-confirm"), "end interview confirmation");
    await page.getByRole("button", { name: /End & get report|End anyway/ }).click();
    await page.waitForURL(/\/report\//, { timeout: 30_000 });
    await sleep(1_500);
    await shot(page, t("15-report-loading"), "report generating");
    await page.getByTestId("scorecard").waitFor({ timeout: 150_000 }).catch(() => undefined);
    await sleep(800);
    await shot(page, t("16-report-top"), "report (top)");
    await page.screenshot({ path: join(OUT, `${t("17-report-full")}.png`), fullPage: true });
    shots.push({ name: t("17-report-full"), note: "report (full page)" });
    if (device.tag === "desktop") {
      await page.emulateMedia({ media: "print" });
      await page.screenshot({ path: join(OUT, `${t("18-report-print")}.png`), fullPage: true });
      shots.push({ name: t("18-report-print"), note: "report in print (Save as PDF) styles" });
      await page.pdf({ path: join(OUT, "report.pdf"), printBackground: true }).catch(() => undefined);
      await page.emulateMedia({ media: "screen" });
    }
    await context.close();
  }
} finally {
  await browser.close();
  app.kill("SIGTERM");
  fake.kill("SIGTERM");
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect().then(() => client.db(DB_NAME).dropDatabase()).catch(() => undefined);
  await client.close();
}
console.log(`\n${shots.length} screenshots in ${OUT}`);
