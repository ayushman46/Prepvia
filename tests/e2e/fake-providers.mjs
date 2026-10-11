#!/usr/bin/env node
/**
 * Minimal OpenAI-compatible stand-in for NVIDIA (chat) and Groq (chat + Whisper)
 * used by the end-to-end test, so the full pipeline can be exercised without
 * provider keys or quota. Usage: node tests/e2e/fake-providers.mjs [port]
 */
import http from "node:http";

const port = Number(process.argv[2] || 4010);
const stats = { chat: 0, analysis: 0, report: 0, stt: 0, canvasTask: 0, failNextChat: 0, lastSystem: "", nextTranscripts: [] };

function sse(res, text, delayMs = 15) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const parts = text.match(/.{1,12}/gs) || [];
  let i = 0;
  const tick = () => {
    if (i < parts.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
      setTimeout(tick, delayMs);
    } else {
      res.end("data: [DONE]\n\n");
    }
  };
  tick();
}

const REPORT = {
  score: 72,
  question_feedback: [{ question: "Walk me through a project", answer_summary: "Payments API in Go", rating: 4, feedback: "Clear and specific.", tip: "Add a metric." }],
  hands_on: { summary: "Reasonable approach with a dictionary cache.", rating: 3.5, strengths: ["Handled duplicates"], gaps: ["No locking"] },
  summary: "You communicated clearly and grounded answers in real projects. Add more measurable outcomes.",
  strengths: ["Clear explanation of the payments API design", "Good ownership of testing"],
  improvements: ["Quantify impact with metrics", "Discuss trade-offs before choosing a solution"],
  competency_scores: [
    { name: "Communication", score: 3.9, rationale: "Structured, specific answers.", confidence: 0.7, evidence: ["Structured answer about the API"], positive_signals: ["clear"], negative_signals: [] },
    { name: "Technical depth", score: 3.3, rationale: "Solid idempotency design; light on metrics.", confidence: 0.6, evidence: ["Mentioned Postgres indexing"], positive_signals: [], negative_signals: ["few metrics"] },
  ],
  evidence: [{ type: "strength", statement: "Described end-to-end ownership of the payments API." }],
};

const CANVAS_TASK = {
  title: "Idempotent payment endpoint",
  instructions: "Implement charge(request_id, amount) so that retries with the same request_id never charge twice.\nReturn the original result for duplicates.",
  language: "python",
  starter_code: "def charge(request_id: str, amount: int) -> dict:\n    pass\n",
  focus: ["idempotency", "concurrency", "testing"],
};

const ANALYSIS = {
  summary: "Candidate described building a payments API.",
  strong_areas: ["API design"],
  weak_areas: ["metrics"],
  competencies: [{ name: "Communication", score: 75, confidence: 0.6, evidence: ["clear answer"], positive_signals: ["structured"], negative_signals: [] }],
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (req.url === "/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(stats));
    }
    if (req.url === "/fail-next-chat") {
      const count = raw.length ? Number(JSON.parse(raw.toString("utf8")).count || 1) : 1;
      stats.failNextChat += count;
      res.writeHead(204);
      return res.end();
    }
    if (req.url === "/clear-transcripts") {
      stats.nextTranscripts = [];
      stats.stickyTranscript = null;
      res.writeHead(204);
      return res.end();
    }
    if (req.url === "/set-transcript") {
      // Queue the text the next transcription request should return. In sticky mode
      // (live browser tests) every request returns it until the next one is set,
      // because the app transcribes speculatively at each pause.
      const scripted = String(JSON.parse(raw.toString("utf8")).text ?? "");
      if (process.env.FAKE_STT_STICKY) stats.stickyTranscript = scripted;
      else stats.nextTranscripts.push(scripted);
      res.writeHead(204);
      return res.end();
    }
    if (!String(req.headers.authorization || "").startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "missing key" } }));
    }
    if (req.url?.endsWith("/audio/transcriptions")) {
      stats.stt += 1;
      const queued = stats.stickyTranscript ?? (stats.nextTranscripts.length ? stats.nextTranscripts.shift() : null);
      const fallback = process.env.FAKE_STT_DEFAULT_EMPTY ? "" : raw.includes(Buffer.from("RIFF")) ? " I built a payments API in Go with Postgres." : "";
      const text = queued ?? fallback;
      // Simulate Groq Whisper latency (configurable) so browser latency numbers stay honest.
      const sttDelay = Number(process.env.FAKE_STT_DELAY_MS || 0);
      return setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text, segments: [{ text, no_speech_prob: 0.01, avg_logprob: -0.2 }] }));
      }, sttDelay);
    }
    if (req.url?.endsWith("/chat/completions")) {
      const body = JSON.parse(raw.toString("utf8"));
      const all = body.messages.map((m) => m.content).join("\n");
      const last = body.messages.at(-1).content;
      const isBackground = /Write the scorecard|Analyze the latest candidate answer|Design ONE hands-on exercise/.test(all);
      if (stats.failNextChat > 0 && !isBackground) {
        stats.failNextChat -= 1;
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
      }
      if (/Write the scorecard/.test(last)) {
        stats.report += 1;
        return sse(res, `<think>scoring</think>\`\`\`json\n${JSON.stringify(REPORT)}\n\`\`\``, 2);
      }
      if (/Analyze the latest candidate answer/.test(last)) {
        stats.analysis += 1;
        return sse(res, JSON.stringify(ANALYSIS), 2);
      }
      if (/Design ONE hands-on exercise/.test(last)) {
        stats.canvasTask = (stats.canvasTask || 0) + 1;
        return sse(res, JSON.stringify(CANVAS_TASK), 2);
      }
      stats.chat += 1;
      stats.lastSystem = body.messages[0].content;
      const delay = Number(process.env.FAKE_LLM_DELAY_MS || 0);
      const reply = (text) => setTimeout(() => sse(res, text), delay);
      if (/Current section: opening/.test(all)) {
        return reply("Hi there, I'm Aria, and I'll be your interviewer today. Can you walk me through a project you're proud of?");
      }
      if (/Current section: closing/.test(all) || /<<END>>/.test(all.split("TURN_GUIDANCE").at(-1) || "") && /no further questions/i.test(last)) {
        return reply("Thank you, that completes our interview. You can end the session to see your report. <<END>>");
      }
      if (/asked you to repeat the question/.test(all)) {
        return reply("Sure. How did you make sure the payments API stayed reliable under load?");
      }
      if (/opened a canvas on their screen/.test(all)) {
        return reply("I've opened a canvas on your screen with a problem. Take a moment to read it, then talk me through your approach?");
      }
      const followUps = [
        "Got it. How did you make sure the payments API stayed reliable under load?",
        "Okay. What would you change about that design if traffic grew tenfold?",
        "Interesting. How did you test the failure modes before going live?",
        "Makes sense. Which metric told you the migration was actually working?",
        "Right. How did you handle a consumer crashing halfway through a batch?",
        "Understood. What trade-off did you make that you'd revisit today?",
        "Thanks. How did you bring the rest of the team along on that decision?",
        "Okay. What was the hardest bug you hit in production there?",
      ];
      return reply(followUps[(stats.chat - 1) % followUps.length]);
    }
    res.writeHead(404);
    res.end();
  });
});

server.listen(port, "127.0.0.1", () => console.log(`fake providers listening on ${port}`));
