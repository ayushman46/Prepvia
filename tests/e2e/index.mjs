#!/usr/bin/env node
/**
 * One-command end-to-end test: `npm run build && npm run test:e2e`
 *
 * Starts fake LLM/STT providers and the production server against a throwaway
 * MongoDB database (MONGODB_URI from the environment or .env.local), runs the
 * API checks in run-e2e.mjs with real Edge TTS, then drops the database.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";

const APP_PORT = 3100;
const FAKE_PORT = 4010;
const DB_NAME = `interviewai_e2e_${Date.now().toString(36)}`;

function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

function makePdf() {
  const lines = ["Jane Doe - Backend Engineer", "Built a Payments API in Go serving 2M requests/day", "Led a team of 4 engineers"];
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
  return Buffer.from(out, "latin1");
}

function makeWav(seconds = 2, rate = 16_000) {
  const samples = seconds * rate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 8000), 44 + i * 2);
  return buffer;
}

/** Refuse to run against a stray server already bound to a test port. */
async function assertPortFree(port) {
  const net = await import("node:net");
  await new Promise((resolve, reject) => {
    const probe = net.createServer().once("error", () => reject(new Error(`Port ${port} is already in use. Stop that process and retry.`)));
    probe.once("listening", () => probe.close(resolve)).listen(port, "127.0.0.1");
  });
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

loadEnvLocal();
if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI is required (set it or add it to .env.local).");
  process.exit(1);
}
if (!existsSync(".next/BUILD_ID")) {
  console.error("No production build found. Run `npm run build` first.");
  process.exit(1);
}

await assertPortFree(APP_PORT);
await assertPortFree(FAKE_PORT);

const dir = mkdtempSync(join(tmpdir(), "interviewai-e2e-"));
writeFileSync(join(dir, "resume.pdf"), makePdf());
writeFileSync(join(dir, "answer.wav"), makeWav());

const children = [];
const fake = spawn(process.execPath, ["tests/e2e/fake-providers.mjs", String(FAKE_PORT)], { stdio: "inherit" });
children.push(fake);
const app = spawn("npx", ["next", "start", "-p", String(APP_PORT)], {
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    NVIDIA_API_KEY: "fake-nvidia",
    NVIDIA_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`,
    GROQ_API_KEY: "fake-groq",
    GROQ_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/v1`,
    MONGODB_DB_NAME: DB_NAME,
    INTERVIEW_CLOCK_SPEEDUP: "60",
    ANALYSIS_EVERY_N_ANSWERS: "1", // this suite verifies the analysis pipeline on every answer
  },
});
children.push(app);

let code = 1;
try {
  await waitFor(`http://127.0.0.1:${APP_PORT}/api/health`);
  code = await new Promise((resolve) => {
    const run = spawn(process.execPath, ["tests/e2e/run-e2e.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        BASE_URL: `http://127.0.0.1:${APP_PORT}`,
        FAKE_URL: `http://127.0.0.1:${FAKE_PORT}`,
        PDF_PATH: join(dir, "resume.pdf"),
        WAV_PATH: join(dir, "answer.wav"),
        INTERVIEW_CLOCK_SPEEDUP: "60",
      },
    });
    run.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
} finally {
  for (const child of children) child.kill("SIGTERM");
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    await client.db(DB_NAME).dropDatabase();
  } finally {
    await client.close();
  }
}
process.exit(code);
