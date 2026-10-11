# InterviewAI — Test & Performance Report

**Date:** 2026-10-11 · **Build:** Next.js 16.4 production build (`next build && next start`) · **Branch:** this branch

This document records every test suite, benchmark, and measurement taken while rebuilding InterviewAI as a single Vercel application, the bugs those tests caught, and the limits that remain. All numbers below were measured, not estimated, unless marked as an estimate.

## Summary (final build)

| Suite | What runs for real | Result |
|---|---|---|
| Unit tests (`npm test`) | Pure logic + orchestration with mocked I/O | **109 / 109 pass** |
| API end-to-end (`npm run test:e2e`) | Production server, MongoDB Atlas, Microsoft Edge TTS; LLM/STT simulated | **28 / 28 pass** |
| Live browser (`npm run test:live-browser`) | Chromium, Silero VAD, NVIDIA LLM, Edge TTS, MongoDB, Web Audio playback (STT simulated) | **18 / 18 pass** (conversation 12/12 re-run on the final build) |
| Load (`tests/load/run.mjs`) | 30 concurrent candidates with real Edge TTS; 50 without TTS | **0 errors, 0 5xx, consistent data** |
| Interview quality (`npm run test:quality`) | 5 LLM-simulated candidate personas vs the real interviewer, LLM judge | See [§6](#6-interview-quality-evaluation) |
| Edge TTS live (`npm run test:live`) | Real Edge TTS socket pool | **4 / 4 pass** |
| Lint · typecheck · `npm audit --omit=dev` | — | **clean · clean · 0 vulnerabilities** |

**Headline latency (real browser, final build):** candidate stops talking → interviewer audible in **1.83–2.18 s** (includes the fixed 800 ms end-of-speech silence window) · greeting audible **188 ms** after pressing Start · barge-in silences the interviewer **367 ms** after the candidate starts talking.

## Test environment

- MacBook (Apple Silicon), Node.js 24.9, test machine in India.
- MongoDB Atlas **M0 (free)** in AWS `ap-south-1` (Mumbai): connect 485 ms, ping RTT 23–29 ms from the test machine.
- NVIDIA API Catalog **free tier**; Microsoft Edge "Read Aloud" TTS (free, no key).
- Playwright 1.63.0 with headless Chromium (build 1243).
- **Speech-to-text was simulated** with a fixed 450 ms delay in all live tests because the Groq key in `.env.local` was invalid. Real Groq Whisper has not been exercised; see [Known limitations](#9-known-limitations).
- Nothing was measured from a Vercel deployment (no deploy was performed). Production adds the network path between the candidate and Vercel `bom1`.

---

## 1. Live latency in a real browser

**Method.** `tests/live-browser/run.mjs` launches Chromium with an injected programmable microphone (`tests/live-browser/fake-mic.js`). It plays macOS `say` recordings of spoken answers into the app's real VAD at the moment it is the candidate's turn. `AudioBufferSourceNode.start/stop` are instrumented so timings come from ground truth: when the candidate's audio ended, and when the interviewer's first audio sample actually started playing. Server timings come from the per-turn `metrics` event.

### Final build (per turn)

| Turn | End of speech → interviewer audible | LLM first token* | First sentence released* | First audio ready* | Caption visible when audio starts |
|---|---|---|---|---|---|
| Opening (prefetched in lobby) | **188 ms** after Start | — | — | — | — |
| Voice answer 1 | **1,828 ms** | 657 ms | 689 ms | 926 ms | "Okay." |
| Voice answer 2 | **2,088 ms** | 597 ms | 775 ms | 1,070 ms | "Got it." |
| Voice answer 3 ("I don't know") | **2,180 ms** | 867 ms | 934 ms | 1,255 ms | "No problem." |
| Barge-in (talk → interviewer silent) | **367 ms** | — | — | — | — |

\* server-side, measured from the moment the turn request arrived. Every voice number includes the fixed **800 ms** silence window the VAD uses to decide the candidate has finished; speculative STT ran inside that window on 3/3 turns. Captions were verified to be synchronized: when the first audio started, only the first sentence was visible.

### Progression across optimizations (same scenario)

| Step | Voice turns (end → audible) | Barge-in | Greeting after Start |
|---|---|---|---|
| Migrated app, before latency work | p50 2,946 ms (2,443–2,984) | 1,006 ms | 561 ms |
| + speculative STT during the pause | p50 2,215 ms (1,957–2,222) | 528 ms | 450 ms |
| + sliding-window barge-in, speculative TTS during the repeat check | p50 2,110 ms (1,748–2,122) | 472 ms | 492 ms |
| + "speaking" outranks "processing" in the UI state | p50 1,924 ms (1,618–2,054) | 464 ms | 267 ms |
| + TTS socket recycling at 25 s and TTS hedging (fixed a 7.3 s TTS outlier) | 1,674 ms best (one 4.2 s LLM-side outlier) | 365 ms | 175 ms |
| **+ acknowledgements released immediately (final)** | **1,828–2,180 ms** | **367 ms** | **188 ms** |

Run-to-run variation is dominated by NVIDIA's time-to-first-token (450–870 ms across runs).

---

## 2. LLM benchmarks (NVIDIA free tier)

### Realtime model selection (streaming, realistic interviewer prompt with a 40-line resume)

| Model | Trials | Median TTFT | Median first sentence | Notes |
|---|---|---|---|---|
| **nvidia/nemotron-3-super-120b-a12b** (reasoning off) | 6 | **392 ms** | **501 ms** | chosen as primary |
| nvidia/nemotron-3.5-lightning-30b-a3b | 3 | 496 ms | 665 ms | chosen as hedge/backup |
| openai/gpt-oss-20b | 3 | 2,014 ms | 2,194 ms | one 4.6 s outlier |
| z-ai/glm-5.3-flash | 3 | 1,796 ms | 1,930 ms | |
| google/gemma-4-31b-it | 6 | 14,895 ms | — | one 30 s timeout |
| deepseek-ai/deepseek-v4.1-flash | 3 | — | — | 3 / 3 timed out at 30 s |
| nemotron-nano-3, mistral-nemo-12b, llama-3.1-nemotron-70b, gemma-3-12b, mistral-large-2 | — | — | — | HTTP 404 (not available to this account) |

### Head-to-head (interleaved A/B, 12 trials each, same 4 dialogue situations)

| | p50 TTFT | p90 | max | Avg words | Multi-question replies |
|---|---|---|---|---|---|
| Nemotron 3.5 Lightning | 372 ms | 580 ms | 2,517 ms | 9 | 0 / 12 |
| **Nemotron 3 Super** | **246 ms** | **302 ms** | **315 ms** | 12 | 0 / 12 |

Super was both faster and gave sharper, more specific follow-ups, so it replaced Lightning as the live interviewer.

### Analysis / report models (full-interview scorecard prompt, non-streaming)

| Model | Time | Valid JSON |
|---|---|---|
| Nemotron 3 Super, reasoning on (budget 1,024) | 9.4 s (23 s for a 12-question interview) | yes |
| Nemotron 3 Super, reasoning off | 3.9 s | yes (but scored on a 0–10 scale) |
| Nemotron 3.5 Lightning, reasoning off | 12.3 s | yes |
| Nemotron 3 Ultra 550B, reasoning off | 12.3 s | yes |

### Tail latency and rate limits

- Observed free-tier queueing spikes of **7.0 s and 12.5 s** to first token on single requests, which is why live turns are **hedged**: after 800 ms without a token, a second request races on Lightning (an independent queue).
- Concurrency is not serialized per account: Lightning answered in 320 ms *while* a long Super reasoning request ran; 4 parallel Lightning requests answered in 377–411 ms.
- **Rate-limit probe:** 30 Super + 30 Lightning requests in 15 s → **60 / 60 succeeded**; 30 more Super requests immediately after → **10 succeeded, 20 returned HTTP 429**. Conclusion: the free tier allows **~40 requests/minute per model** (not per account). Per-answer background analysis therefore runs on Lightning, leaving Super's budget for live turns.

---

## 3. Microsoft Edge TTS

| Measurement | Result |
|---|---|
| Cold connection (TLS + WebSocket) | handshake 380–486 ms; first audio 500–690 ms; short sentence done 600–830 ms |
| Reused warm socket | first audio chunk 150–240 ms; short sentence done 250–470 ms |
| Live pool test (final) | cold 689 ms · warm **222–263 ms** · 4 parallel 667 ms |
| Socket idle tolerance | alive after 2, 5, 10, 20, 25, 30 s idle; **closed by the server at ~35.0 s** (code 1006) → pool recycles at 25 s |
| Output formats | MP3 48/96 kbps and WebM/Opus supported; raw/RIFF PCM and Ogg/Opus rejected |
| Under load | 420 clips for 30 concurrent candidates, **0 failures** |

---

## 4. Database (MongoDB Atlas M0)

- Free clusters are capped at **100 operations/second** (Atlas documentation); exceeding it throttles with a 1 s cooldown.
- Operations per turn were reduced from **~13 to ~8** by collapsing the turn counter, question bookkeeping, clock start, and canvas flag into the single lock-release write, handing already-loaded state to background analysis, and moving the speculative-STT echo check to the turn.
- Effect at 50 concurrent candidates (TTS off): **8.0 → 11.5 turns/s**, turn total p50 **5,206 → 3,307 ms**, first sentence p50 **2,714 → 2,043 ms**.

---

## 5. Load tests

Simulated LLM (350 ms) and STT (400 ms); real MongoDB; per-candidate client IPs; integrity verified directly in MongoDB afterwards (alternating transcripts, no leaked turn locks, `turn_count` correct, exactly one report per session).

| Scenario | Turns | Throughput | First audio p50 / p95 / p99 | Turn total p50 / p95 | Errors | Integrity |
|---|---|---|---|---|---|---|
| 20 candidates × 6 turns, real TTS | 140 | 7.6 turns/s | 1,246 / 1,755 / 1,913 ms | 1,756 / 2,399 ms | 0 | ✓ |
| **30 candidates × 6 turns, real TTS (final)** | 210 | 11.8 turns/s | **1,166 / 2,018 / 2,092 ms** | 1,620 / 2,309 ms | 0 (420 audio clips, 0 fallbacks) | ✓ |
| 50 candidates × 8 turns, TTS off (before DB consolidation) | 450 | 8.0 turns/s | — (first sentence p50 2,714 ms) | 5,206 / 5,665 ms | 0 | ✓ |
| 50 candidates × 8 turns, TTS off (after DB consolidation) | 450 | **11.5 turns/s** | — (first sentence p50 2,043 ms) | 3,307 / 3,761 ms | 0 | ✓ |

---

## 6. Interview quality evaluation

**Method.** `tests/quality/eval.mjs` runs complete, time-boxed interviews (accelerated clock, realistic answer pacing) against the real interviewer through the HTTP API. Candidates are simulated by an LLM on separate models (`gpt-oss-20b`, falling back to `glm-5.3-flash`) or scripted:

| Persona | Role / plan | Purpose |
|---|---|---|
| strong | Senior Backend Engineer, mixed, senior | specific answers with metrics and trade-offs |
| vague | Software Engineer, technical, entry | scripted vague answers (calibration) |
| edge | Backend Engineer, mixed, mid | scripted probes: repeat request, "I don't know", prompt injection, off-topic, wanting to stop |
| pm | Product Manager, mixed, mid | non-engineering role, written canvas exercise |
| behavioral | Engineering Manager, behavioral, senior | no canvas; behavioral depth |

Every interviewer turn is checked deterministically (one question per turn, length, no markdown, no filler praise, no repeats, no coding before the canvas opens, no leaked internals, no promised follow-ups, correct handling of each scripted probe), then an LLM judge (Nemotron 3 Super with reasoning) scores the interview 1–5 on grounding, adaptivity, question quality, conversation, edge cases, structure, and report accuracy.

### Results by round

| Round | Build state | strong | vague | edge | pm | behavioral | Mean judge score |
|---|---|---|---|---|---|---|---|
| 1 | first evaluator run | 4 | 4 | 4 | 4 | 4 | **4.00 / 5** (4 of 5 reports broken) |
| 2 | report parser fixed, praise/question rules | 4.7 | judge rate-limited | 3 | **5** | **5** | **4.42 / 5** |
| 3 | canvas hidden until introduced, regeneration ×2, notes on separate model | **5** (every dimension) | — | — | — | — | run interrupted by a harness bug (fixed) |
| Final | this build | in progress | | | | | results appended in a follow-up commit |

Deterministic checks across rounds: filler-praise openers **22 % → 0 %**; stacked questions **2 / 12 → 0** per interview (now enforced); broken reports **4 / 5 → 0 / 5**; scripted edge-case probes (repeat, "I don't know", prompt injection, off-topic, wanting to stop) all handled.

### What each round caught

- **Scripted runs before the evaluator existed:** the interviewer fell into a loop ("could you finish that thought?") after one ambiguous answer; echoed "Could you repeat the question?" back; promised an email follow-up; ignored "I don't know".
- **Round 1 (mean judge 4.0 / 5):** 4 of 5 reports were broken (see bug 5); long turns (up to 108 words) and stacked questions; the interviewer read a coding task aloud before the canvas existed; closing exchanges looped ("Take care." ×4).
- **Round 2 (mean 4.42 / 5; strong 4.7, pm 5, behavioral 5, edge 3):** reports fixed (85 / 45 / 78 / 82); filler praise 22 % → 0 %; stacked questions → 0. Found verbatim copies of earlier replies under rate-limit failover and NVIDIA's per-model rate limit.
- **Round 3 (strong persona):** judge **5 / 5 in every dimension**, report 85, 0 regenerations, 0 % backup-model turns. (The run was then interrupted by a harness bug, fixed by moving the simulated candidate to separate models.)

---

## 7. Bugs found by testing (all fixed)

| # | Found by | Bug | Fix |
|---|---|---|---|
| 1 | scripted real-LLM run | Interviewer stuck repeating "could you finish that thought?" | Dialogue sent as real chat turns; stricter "seems cut off" rule |
| 2 | quality eval | Verbatim copies of earlier replies | Opening of each reply checked against all earlier replies + the candidate's last message; up to 2 regenerations with the rejected draft quoted |
| 3 | scripted run | Echoed "Could you repeat the question?" | Deterministic repeat-request handling (exact question restated, not scored) |
| 4 | benchmarks | 7–12 s free-tier queueing spikes | Super as primary + hedged request on Lightning after 800 ms |
| 5 | quality eval | 4 of 5 reports broken: malformed model JSON made the parser return a nested competency object as the report | JSON repair (trailing commas, raw newlines, truncation) + required keys + one retry |
| 6 | code review | Report only saw the last 8 messages | Full transcript (60k chars) sent to the scorer |
| 7 | quality eval | Interviewer saw and read out the canvas exercise before it was on screen | Exercise hidden from the interviewer until introduced |
| 8 | live + quality | "Let's move to the coding exercise" in early sections (negative-instruction priming) | Positive guidance that never mentions a later exercise |
| 9 | quality eval | Early goodbye followed by "Take care." loops | Rule against wrapping up early + deterministic farewell detection in wrap-up |
| 10 | quality eval | Filler praise on 22 % of turns | No-praise instruction moved into per-turn guidance (→ 0 %) |
| 11 | live + quality | Unassessed competencies (no coding, unanswered questions) scored low | Rubric rule + deterministic removal of hands-on scores when no exercise happened |
| 12 | live browser | Status showed "Thinking…" and a thinking orb while the interviewer was already speaking | Audible speech outranks "processing" |
| 13 | code review of barge-in | Late audio from an interrupted turn could resume playback | Player discards the rest of an interrupted turn |
| 14 | code review of barge-in | Interrupting while the reply was still streaming silently dropped the candidate's answer | Answers during an in-flight turn are queued and sent when it finishes |
| 15 | live browser | Barge-in took ~1 s (a strict consecutive-frames counter reset on dips between words) | Sliding window: 7 of the last 10 frames ≥ 0.7 → 367 ms |
| 16 | live browser | 7.3 s outlier: Edge drops idle TTS sockets at ~35 s | Pool recycles at 25 s; slow syntheses hedged on a fresh socket after 1.5 s |
| 17 | live browser | Repeat-check hold delayed first audio by up to 2.6 s | Short acknowledgements released immediately; speculative TTS for held sentences |
| 18 | load test | Free Atlas cluster's 100 ops/s capped throughput at 8 turns/s | Per-turn writes collapsed into one; 11.5 turns/s |
| 19 | rate-limit probe | One NVIDIA model's 40 req/min shared by live turns and background work | Background notes on a separate model; analysis sampled; 429 backoff for background calls |
| 20 | `npm audit` | Next.js 14.2 had 23 advisories (1 critical) | Upgraded to Next.js 16.4 / React 19 (0 vulnerabilities) |
| 21 | production build | Tailwind opacity modifiers (`text-vast/70`, …) silently generated no CSS | Theme colors as hex values |

---

## 8. Capacity on the free tiers (estimates)

| Resource | Limit | Approximate capacity |
|---|---|---|
| NVIDIA API Catalog | ~40 requests/min **per model** (measured) | Super serves ~40 live turns/min ≈ 15–20 simultaneous interviews at speaking pace; overflow fails over to Lightning |
| Groq Whisper (STT) | 20 requests/min, 7,200 audio-seconds/hour (published base limits) | **The tightest limit**: roughly 3–5 simultaneous voice interviews per free key; paid Whisper Turbo costs about $0.04 per audio hour |
| MongoDB Atlas M0 | 100 ops/s, 500 connections, 0.5 GB | ~11.5 turns/s measured ≈ several hundred simultaneous interviews; 30-day TTL bounds storage |
| Microsoft Edge TTS | unpublished | 420 clips for 30 simultaneous candidates with 0 failures |
| Vercel Hobby | 300 s max duration, 4.5 MB bodies, personal use | Turns use ≤ 120 s; uploads capped at 4 MB |

---

## 9. Known limitations

- **Real speech-to-text is untested here.** The local Groq key was rejected, so live tests simulate STT (450 ms). Set a valid `GROQ_API_KEY` and re-run `npm run test:live-browser` with `GROQ_API_KEY_LIVE` set to verify.
- **Not measured from Vercel.** All latency numbers are from a local production build talking to Atlas (Mumbai), NVIDIA, and Edge TTS from India.
- **No real microphone or speakers.** Echo cancellation with laptop speakers is untested; the speaker-echo filter and the "let me interrupt by speaking" toggle exist for that case.
- **Quality is LLM-judged**, not rated by humans; the simulated candidates are approximations.

## 10. Reproducing these results

```bash
npm install && npm run build
npm run check                                   # typecheck + lint + unit tests
npm run test:e2e                                # needs MONGODB_URI
npm run test:live                               # Edge TTS against the real service
npm run test:live-browser                       # needs NVIDIA_API_KEY + MONGODB_URI (macOS `say` for fixtures)
npm run test:quality                            # needs NVIDIA_API_KEY + MONGODB_URI (~20 min)
node tests/load/run.mjs --users=30 --turns=6 --tts=on
```

Each live run writes a JSON report to `test-results/` (git-ignored) with per-turn timings and transcripts. All suites create throwaway MongoDB databases and drop them afterwards.
