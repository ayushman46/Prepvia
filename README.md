# InterviewAI

InterviewAI is a voice-first AI interview practice platform for candidates who want to rehearse the interview they are actually preparing for, not a generic list of questions.

Give it a resume, a target role, and an optional job description. InterviewAI conducts a spoken interview, adapts its follow-up questions to the candidate's answers, and produces an evidence-backed report on what was demonstrated and what to improve.

## The Problem

Interview preparation is usually fragmented:

- Question banks teach recall, but do not simulate thinking aloud under pressure.
- Generic mock interviews ignore the candidate's actual experience and the requirements of the role.
- Peer and mentor practice can be valuable, but it depends on finding the right person, scheduling a session, and receiving consistent feedback.
- A final score without supporting evidence does not tell a candidate which answer, explanation, or gap affected the result.
- Live interview copilots may help someone get through a conversation, but they do not necessarily build the communication, reasoning, and self-awareness needed to perform independently.

Candidates need a repeatable practice loop that is realistic enough to expose weak answers, personalized enough to be relevant, and structured enough to turn each attempt into measurable improvement.

## Why It Is Needed

Interview performance is more than knowing the right fact. Candidates must explain decisions clearly, connect their experience to a role, handle follow-up questions, defend trade-offs, and recover when an answer is incomplete.

InterviewAI makes that practice available on demand:

1. The candidate brings the same resume and job description they are using in their search.
2. The interviewer asks questions grounded in those materials and the selected role.
3. The candidate answers aloud, which exposes clarity, structure, confidence, and depth that written practice can hide.
4. The next question responds to the quality and specificity of the previous answer.
5. The report connects strengths and improvements to observed interview evidence instead of presenting an unexplained number.

The goal is not to predict whether someone will get hired. The goal is to give candidates a self-directed, repeatable rehearsal environment that helps them become better interviewers of their own experience.

## What InterviewAI Does

### Personalized Setup

Candidates can upload a PDF resume, enter their name and target role, and paste the job description, then choose the interview focus (mixed, technical, or behavioral), seniority (entry, mid, senior), and length (15, 30, or 45 minutes). The application uses those inputs as grounding material throughout the session.

### Voice-First Practice

The browser uses local Silero voice activity detection to capture natural utterances. Candidates speak (typing is available as a fallback), hear the interviewer respond, and see a live transcript.

### Adaptive, Time-Boxed Interviewing

The interviewer, Aria, runs a structured interview against the clock: introduction, resume deep-dive, technical depth, a hands-on canvas exercise, behavioral questions, and a wrap-up where the candidate can ask questions. Each session keeps compact interview state and evidence memory (claims, strong and weak areas, competencies), so follow-ups build on what the candidate actually said.

### Hands-On Canvas

Mid-interview, a role-specific exercise opens in a code/notes editor (a coding task for engineers, SQL for data roles, a written exercise for product or other roles). The candidate works while thinking out loud; the interviewer sees the live canvas and asks about their choices.

### Evidence-Based Scorecard

The final report is a scorecard: competencies rated on a 1-5 rubric, each with the reason ("why") and quotes from the interview, per-question feedback with a tip for next time, an evaluation of the hands-on exercise, and neutral session signals (leaving the tab, large pastes). Competencies the interview never assessed are left out rather than scored low.

## How We Are Different

InterviewAI sits between static preparation, human mock interviews, AI practice tools, and live interview assistance. The distinction is the complete preparation loop rather than one isolated feature.

| Dimension | InterviewAI | Typical alternative |
| --- | --- | --- |
| Starting point | The candidate's resume, target role, and optional job description | A fixed question bank, a generic role, or a manually prepared prompt |
| Interview behavior | Adaptive follow-ups based on the answer, topic, difficulty, and stored evidence | Fixed questions or broad role-based practice |
| Practice format | Spoken, self-serve, repeatable sessions in the browser | Text-only practice, scheduled peers, or scheduled mentors |
| Feedback | A report tied to observed answer evidence and competency signals | A score, general advice, or feedback that depends on another person |
| Product purpose | Build independent interview ability through rehearsal and reflection | Match with a peer, coach a live session, or provide private assistance during an interview |
| Candidate experience | Bring your own materials and start immediately | Search for a partner, schedule a session, or configure a separate workspace |

This is a positioning difference, not a claim that other products lack useful features:

- [Huru](https://huru.ai/) focuses on AI-powered video interview practice, job-specific questions, and feedback on answers, body language, and vocal delivery.
- [interviewing.io](https://interviewing.io/) combines AI interviewing with anonymous technical interviews and mentor sessions.
- [Pramp / Exponent Practice](https://www.pramp.com/) emphasizes live peer-to-peer practice, matching, scheduling, and collaborative interview environments.
- [Final Round AI](https://www.finalroundai.com/) focuses on interview assistance and private, real-time answer guidance, in addition to preparation tools.

InterviewAI's intended wedge is candidate-owned preparation: use the exact materials for the role, practice aloud whenever needed, receive adaptive probing, and understand the evidence behind the debrief. It is not designed to covertly answer a real interview on the candidate's behalf.

## Product Workflow

### 1. Prepare

Upload a resume or start without one. Add the target role and paste the job description when role-specific preparation is needed.

### 2. Practice

The candidate speaks (or types, or talks over Aria to interrupt). Answers are transcribed while the candidate is still pausing, and Aria responds sentence by sentence, with captions synchronized to her voice.

### 3. Review

End the session to generate a structured report. Review what was strong, what was unclear, which competencies were demonstrated, and which topics deserve another practice round.

## Technical Architecture

InterviewAI is a **single Next.js 16 application** deployed entirely on **Vercel's free Hobby plan** (functions pinned to Mumbai, `bom1`, next to the MongoDB Atlas cluster). The UI and the API (App Router route handlers) ship together: one deploy, one domain, no CORS, no separately hosted backend to cold-start.

```
Browser                                       Vercel Functions (Node.js, bom1)               Free providers
───────                                       ───────────────────────────────               ──────────────
Silero VAD (WASM) ─ pause ─► /transcribe ───► speculative STT ─────────────────────────────► Groq Whisper
           └─ end of turn ─► /turn (text) ──► lock · prompt · stream ───────────────────────► NVIDIA Nemotron 3 Super
                                              │   hedge after 800 ms ────────────────────────► Nemotron 3.5 Lightning
Sequenced player ◄── text + MP3 (NDJSON) ──── │   sentence → warm TTS socket pool ───────────► Microsoft Edge neural TTS
Captions / orb / canvas                       ▼   waitUntil: answer analysis, canvas task
                                          MongoDB Atlas M0 (sessions, transcripts, evaluations, rate limits)
```

### Why HTTP streaming instead of WebSockets

Serverless functions can't hold a 20-minute WebSocket open (Vercel's beta WebSockets close at the function's maximum duration, 300 s on Hobby). Each interview turn is therefore **one POST whose response streams newline-delimited JSON events** (`src/lib/protocol.ts`): `user_transcript`, `ai_sentence {seq}`, `audio {seq}` / `audio_error {seq}`, `canvas_task`, `metrics`, `error {code, retryable}`, `done {limit_reached}`. Turns are stateless, so refreshes, network changes, and different function instances all just work.

### What makes it feel live (measured)

| Technique | Effect |
|---|---|
| Opening prefetched while the candidate is in the lobby | Greeting audible **~190 ms** after pressing Start |
| **Speculative STT**: the browser mirrors the VAD state machine and transcribes after 250 ms of silence, inside the 800 ms end-of-turn window | STT removed from the critical path |
| Realtime model chosen by benchmark: Nemotron 3 Super, reasoning off (p50 ~250 ms, p90 ~300 ms to first token on a realistic prompt) | Fast *and* strongest replies |
| **Hedged requests**: if no token after 800 ms, a second request races on a different model's queue | Free-tier queueing spikes (7-12 s seen) no longer stall the conversation |
| **Warm Edge TTS socket pool**, opened at the start of each turn; reused across sentences; recycled before Edge's ~35 s idle cutoff; slow syntheses hedged on a fresh socket | ~400 ms handshake removed; warm sentence synthesis ~220-260 ms |
| Short acknowledgements ("Got it.") spoken immediately while the rest of the reply is checked | First audio ~250-400 ms after the model's first token |
| First clause spoken early; sentences synthesized concurrently, played strictly in order | Audio starts on the first clause |
| Database round trips in parallel; per-turn writes collapsed into one | Low latency and ~44% more throughput on the free cluster |

Measured end to end in a real Chromium browser (real VAD, NVIDIA, Edge TTS, MongoDB; STT simulated at 450 ms because no Groq key was available locally): **candidate stops talking → interviewer audible in 1.8-2.2 s**, *including* the 800 ms silence window that decides the candidate has finished. Barge-in silences the interviewer **~370 ms** after the candidate starts talking. Full methodology, every benchmark, load and quality results: **[docs/TESTING.md](docs/TESTING.md)**.

### Interview quality guards

- **One question per turn, enforced**: generation stops after the first sentence ending in a question mark (max 4 sentences).
- **No repetition**: the opening of each reply is held back and compared with every earlier interviewer reply and the candidate's last message; a repeat or parroting is regenerated once before anything is spoken (its speech is synthesized speculatively, so the check costs no latency).
- **Deterministic edge cases**: "repeat the question" restates the exact question (and isn't scored); speaker echo (the interviewer's own words picked up by the mic) is discarded; farewell-without-question in wrap-up ends the interview even if the model forgets the end marker.
- **Grounding**: source material is isolated in system sections; the dialogue is sent as real chat turns; the canvas exercise stays hidden from the interviewer until it is on the candidate's screen.
- **Report robustness**: model JSON is repaired (trailing commas, raw newlines, truncation) and validated against required keys, with one retry; hands-on scores are dropped when no exercise happened.

### Report generation

`GET /api/report/:id` generates the scorecard **at most once** (claimed in MongoDB; concurrent callers get `202` and poll) from the **full** transcript, the canvas work, analyst notes, and session signals, using Nemotron 3 Super with reasoning.

### Provider responsibilities (all free tiers)

| Provider | Used for | Key |
|---|---|---|
| NVIDIA API Catalog | Interviewer (Super), hedge/failover and per-answer notes (Lightning), canvas tasks and reports (Super with reasoning). Free tier ≈ 40 requests/minute **per model** (measured), so work is spread across models | `NVIDIA_API_KEY` |
| Groq | Whisper speech-to-text; LLM fallback | `GROQ_API_KEY` |
| Microsoft Edge TTS | Neural voice (`en-US-AriaNeural`) | none |
| MongoDB Atlas M0 | Sessions, transcripts, evaluations, rate limits | `MONGODB_URI` |
| Vercel Hobby | Hosting, CDN, serverless functions | — |

## Project Structure

```
src/
  app/                          Pages (landing, upload, setup, interview room, report) and API routes
    api/health                  GET  readiness: database + provider configuration (never secrets)
    api/resume/upload           POST PDF → text (unpdf, 4 MB max)
    api/interview/start         POST create session with plan → { session_id }
    api/interview/[id]          GET  session view + transcript (resume after refresh)
    api/interview/[id]/turn     POST one streamed interview turn (audio/wav or JSON { text, voice })
    api/interview/[id]/transcribe POST speculative STT during the candidate's pause
    api/interview/[id]/canvas   PUT  autosave canvas work
    api/interview/[id]/events   POST start event + integrity signals
    api/interview/[id]/end      POST mark completed
    api/report/[id]             GET  generate-once, cached scorecard
  server/                       Server-only modules
    turn.ts                     Turn orchestration: STT → guarded LLM stream → TTS → one-write persist
    interview-plan.ts           Timed sections, per-turn guidance, repeat detection
    interview-context.ts        Prompt/context/memory logic, JSON repair (pure, unit tested)
    llm.ts                      SSE streaming, hedging, provider failover, sentence splitting
    tts.ts / stt.ts             Edge TTS protocol + warm socket pool; Groq Whisper
    sessions.ts                 Repository: lease lock, single-write turn finish, CAS analysis merge
    analysis.ts / report.ts / canvas-task.ts   Background analysis, scorecard, exercise generation
    rate-limit.ts               MongoDB fixed-window + in-memory limiters
  hooks/                        useInterview (turn state machine, captions, barge-in, canvas), useVAD, useIntegrity
  lib/                          Protocol, API client, sequenced audio player, utterance tracker, WAV
tests/                          Unit (vitest), e2e/, live-browser/, quality/, load/, live/
```

## Deploy to Vercel (free)

1. **MongoDB Atlas.** Create a free M0 cluster and a database user. Under **Network Access**, add `0.0.0.0/0` (Vercel uses dynamic IPs). Copy the connection string.
2. **Keys.** Create a free [Groq key](https://console.groq.com/keys) (required for speech-to-text) and a free [NVIDIA API Catalog key](https://build.nvidia.com).
3. **Import the repo in Vercel** (Add New → Project). Framework preset **Next.js**; **Root Directory must be the repository root** (`./`). If the project previously pointed at `frontend/`, change it under Settings → General.
4. **Environment variables**: `MONGODB_URI`, `MONGODB_DB_NAME`, `GROQ_API_KEY`, `NVIDIA_API_KEY` (see `.env.example` for tuning). Remove the old `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL`.
5. **Region.** `vercel.json` pins functions to `bom1` (Mumbai) because the Atlas cluster is in AWS `ap-south-1`; each database round trip is ~25 ms instead of ~200 ms from the default US region. If your cluster is elsewhere, change `regions` to the nearest Vercel region.
6. **Deploy**, then open `https://<your-app>.vercel.app/api/health`; it should report `"status": "ok"`.

Fluid compute (default for new projects) is required; routes declare `maxDuration` up to 120 s (Hobby limit 300 s). The Hobby plan is for personal, non-commercial use.

## Local Development

```bash
npm install
cp .env.example .env.local   # fill in MONGODB_URI, GROQ_API_KEY, NVIDIA_API_KEY
npm run dev                  # http://localhost:3000  (microphone requires localhost or HTTPS)
```

## Verification

```bash
npm run check             # typecheck + lint + 109 unit tests
npm run build             # production build (what Vercel runs)
npm run test:e2e          # API e2e: production server + real MongoDB + real Edge TTS + simulated LLM/STT, timed sections at 60x
npm run test:live-browser # LIVE: Chromium + fake mic + real VAD/NVIDIA/Edge TTS/MongoDB; latency, captions, barge-in, canvas, report
npm run test:quality      # LIVE: LLM-simulated candidates (5 personas) + deterministic checks + LLM judge on real NVIDIA
node tests/load/run.mjs --users=50 --turns=8 --tts=off   # concurrency, tail latency, data integrity
npm run test:live         # Edge TTS pool against the real service
```

Latest results on this codebase (details, methodology and every metric in **[docs/TESTING.md](docs/TESTING.md)**):

| Suite | Result |
|---|---|
| Unit | 109 / 109 |
| API end-to-end | 28 / 28 |
| Live browser (real Chromium, VAD, NVIDIA, Edge TTS, MongoDB) | 18 / 18 · voice turn 1.8-2.2 s end to end · greeting 188 ms · barge-in 367 ms |
| Load | 30 concurrent candidates with real TTS: 210 turns, 0 errors, 420 clips, first audio p50 1.17 s · 50 concurrent: 450 turns, 0 errors, 11.5 turns/s |
| Interview quality (LLM judge, 5 personas) | see docs/TESTING.md |
| Lint · typecheck · production audit | clean · clean · 0 vulnerabilities |

## Reliability, Security, and Privacy

- **No cold-start backend**; static pages from Vercel's CDN.
- **Graceful degradation**: hedging and failover across two NVIDIA models and Groq; STT retry; per-sentence browser speech when TTS fails; a stall guard in the player; typed answers without a microphone; retryable errors that never lose a saved answer; refresh-safe resume.
- **Never speaks errors or internals**: provider failures become structured `error` events; control markers are stripped.
- **Abuse protection**: per-IP limits on sessions, uploads, turns, reports, and transcriptions; per-session turn cap; 4 MB body limits; input length limits.
- **Private links**: 128-bit random interview IDs; interview and report pages are `noindex`.
- **Retention**: sessions, transcripts, and reports expire after 30 days (TTL); rate-limit keys store hashed IPs only.
- **Headers**: `nosniff`, `X-Frame-Options: DENY`, HSTS, strict referrer policy, microphone limited to this origin.
- **Dependencies**: Next.js 16.4 / React 19; `npm audit --omit=dev` reports 0 vulnerabilities.

For use with sensitive candidate data at scale, add authentication, a privacy policy, and review each provider's data terms.

## Product Boundaries

InterviewAI is a practice and feedback tool. It does not make hiring decisions, guarantee an offer, verify every candidate claim, or replace professional coaching. AI feedback can be incomplete or incorrect; candidates should treat the report as a coaching signal and review the underlying transcript.
