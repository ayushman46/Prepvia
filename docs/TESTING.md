# InterviewAI — Test & Performance Report

**Date:** 2026-10-11 · **Build:** Next.js 16.4 production build (`next build && next start`) · **Branch:** this branch

This document records every test suite, benchmark, and measurement taken while rebuilding InterviewAI as a single Vercel application, the bugs those tests caught, and the limits that remain. All numbers below were measured, not estimated, unless marked as an estimate.

## Summary (final build)

| Suite | What runs for real | Result |
|---|---|---|
| Unit tests (`npm test`) | Pure logic + orchestration with mocked I/O | **161 / 161 pass** |
| API end-to-end (`npm run test:e2e`) | Production server, MongoDB Atlas, Microsoft Edge TTS; LLM/STT simulated | **29 / 29 pass** |
| Live browser (`npm run test:live-browser`) | Chromium, Silero VAD, NVIDIA LLM, Edge TTS, MongoDB, Web Audio playback (STT simulated) | **21 / 21 pass** on the voice-input fix (adds push-to-talk and microphone-reconnect steps; earlier: 19 / 19 three runs in a row) |
| Complete audio input (`npm run test:audio-capture`) | Chromium, Silero VAD + noise gate, real Groq Whisper, Edge TTS, MongoDB (LLM simulated); 21 spoken scenarios incl. thinking pauses, 1-word and 76 s answers | **21 / 21 complete, mean audio coverage 100 %** (baseline: "No." unheard, every ≥1 s pause split the answer) ([details](#complete-audio-input-npm-run-testaudio-capture)) |
| Real microphone (`npm run test:real-mic`) | The Mac's built-in microphone and speakers, Chromium and Brave, `next start` and `next dev` | Voice works under `next dev` (was disabled); background voices send nothing; an invalid key switches to typing after one request (see [real microphone](#real-microphone-live-voice-input)) |
| Load (`tests/load/run.mjs`) | 30 concurrent candidates with real Edge TTS; 50 without TTS | **0 errors, 0 5xx, consistent data** |
| Interview quality (`npm run test:quality`) | 5 LLM-simulated candidate personas vs the real interviewer, LLM judge | **4.78 / 5** mean judge score on the final build (4.86 on the previous one); strong vs vague candidate reports 78 vs 28 ([§6](#6-interview-quality-evaluation)) |
| Edge TTS live (`npm run test:live`) | Real Edge TTS socket pool | **4 / 4 pass** |
| Lint · typecheck · `npm audit --omit=dev` | — | **clean · clean · 0 vulnerabilities** |

**Headline latency (real browser, 5 runs on the final latency path):** candidate stops talking → interviewer audible in **1.64–2.27 s, median 1.88 s** over 15 voice turns (includes the fixed 800 ms end-of-speech silence window) · greeting audible **175–308 ms** after pressing Start · barge-in silences the interviewer **366–469 ms** after the candidate starts talking.

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
| Opening (prefetched in lobby) | **271 ms** after Start | — | — | — | — |
| Voice answer 1 | **1,920 ms** | 575 ms | 1,005 ms | 1,006 ms | "Thanks for that overview." |
| Voice answer 2 | **1,792 ms** | 471 ms | 485 ms | 768 ms | "Okay." |
| Voice answer 3 ("I don't know") | **1,763 ms** | 477 ms | 492 ms | 856 ms | "No problem." |
| Barge-in (talk → interviewer silent) | **366 ms** | — | — | — | — |

\* server-side, measured from the moment the turn request arrived. Every voice number includes the fixed **800 ms** silence window the VAD uses to decide the candidate has finished; speculative STT ran inside that window on 3/3 turns. Captions were verified to be synchronized: when the first audio started, only the first sentence was visible. This is the last 19/19 run on the final build. The four other runs on the same latency path measured voice turns of 1,882 / 2,080 / 2,082, 1,899 / 2,271 / 1,684, 2,240 / 1,874 / 2,178 and 1,636 / 1,678 / 1,694 ms, greetings of 175–308 ms and barge-ins of 383–469 ms.

### Progression across optimizations (same scenario)

| Step | Voice turns (end → audible) | Barge-in | Greeting after Start |
|---|---|---|---|
| Migrated app, before latency work | p50 2,946 ms (2,443–2,984) | 1,006 ms | 561 ms |
| + speculative STT during the pause | p50 2,215 ms (1,957–2,222) | 528 ms | 450 ms |
| + sliding-window barge-in, speculative TTS during the repeat check | p50 2,110 ms (1,748–2,122) | 472 ms | 492 ms |
| + "speaking" outranks "processing" in the UI state | p50 1,924 ms (1,618–2,054) | 464 ms | 267 ms |
| + TTS socket recycling at 25 s and TTS hedging (fixed a 7.3 s TTS outlier) | 1,674 ms best (one 4.2 s LLM-side outlier) | 365 ms | 175 ms |
| + acknowledgements released immediately | 1,828–2,180 ms | 367 ms | 188 ms |
| **Final build (closing, pacing and resilience fixes; 5 runs)** | **1,636–2,271 ms, median 1,882 ms** | **366–469 ms** | **175–308 ms** |

Run-to-run variation is dominated by NVIDIA's time-to-first-token (450–870 ms across runs).

### Real microphone (live voice input)

**Why.** A user reported "when I speak, nothing is detected". Every suite above feeds a programmable fake microphone, so `tests/live-browser/real-mic.mjs` was written to test the real thing: a visible browser on the MacBook Air's built-in microphone, answers spoken out loud through its speakers with macOS `say`, and the app's own debug counters read back.

**What it found** (MacBook Air, macOS input volume 27 / 100, Chromium and Brave):

- **Capture and voice detection work.** Silero's speech probability reached 0.99–1.00 for every spoken sentence, from 100 % down to 12 % speaker volume, in both Chromium and Brave. Chrome's automatic gain control compensates for the low input volume.
- **Under `npm run dev` voice was disabled before the interview started** (bug 41): the lobby said "Voice detection couldn't load" and the detector processed no frames. Production builds were unaffected, which is why every earlier suite passed.
- **The local Groq key is invalid (HTTP 401).** Every spoken answer failed, and the app kept sending audio: about 25 failing requests in one run, until its own rate limit answered 429 (bugs 43, 44). `/api/health` still said speech-to-text was "configured".
- **The room was not quiet.** During a 15 s "silent" stretch, 60 % of frames (282 of 469) were confident speech, and louder (median RMS 0.048) than the test voice at full volume (0.023): people talking near the laptop. Background voices produced 8 transcription calls and 2 turns in 10 s, which kept the app busy so real answers were dropped (bugs 45–47).

**After the fixes** (bugs 41–52):

| Check | Before | After |
|---|---|---|
| Voice under `next dev` | disabled ("couldn't load") | works: 100 %–12 % volume detected and sent |
| Requests from 10 s of room sound (hands-free) | 8 transcriptions + 2 turns | 0 in each later run |
| Transcriptions per spoken answer | 3–4 | 1 |
| Invalid Groq key | ~25 failing requests, then 429 | 1 request, then the app switches to typing with an explanation; `/api/health` reports `"stt": "invalid_key"` |
| Push-to-talk (hold Space) with voices in the room | (did not exist) | both answers sent with the right text; 0 requests from background sound |
| Full hands-free answer (stub transcript) | – | bubble with the spoken text, interviewer reply, back to "Your turn" |

Speech that only *resembles* the candidate's (loud voices next to the laptop) can't be told apart acoustically; push-to-talk is the answer there, and the room suggests it after repeated background-noise events.

**With real Groq Whisper** (after the key was replaced):

| Check | Result |
|---|---|
| `/api/health` | `"status": "ok"`, `"stt": "configured"` (the key is verified with Groq) |
| Real microphone, hands-free, two spoken answers | both transcribed word for word ("…to a Go service on Kafka, and we cut latency by 80%."); 1 transcription each; 0 requests from 10 s of room sound |
| Real microphone, push-to-talk | both answers transcribed correctly |
| Speculative transcript ready | ~840 ms after the speech ended, i.e. ~40 ms after the 800 ms end-of-speech window: STT stays hidden in the pause |
| Browser suite with real Groq (`GROQ_API_KEY_LIVE`) | conversation 14 / 14, canvas 7 / 7; voice turns 1,683–1,833 ms end to end (median 1,719–1,765 ms over two runs), the same as with simulated STT |

One harness fix came out of this: the suite now matches spoken answers by words rather than exact text, since Whisper writes its own punctuation and spellings ("post-mortem" for "postmortem").

### Complete audio input (`npm run test:audio-capture`)

**Why.** "Does the app take the candidate's whole answer?" can't be judged from transcripts alone. `tests/live-browser/audio-capture.mjs` composes 21 spoken answers with macOS `say` (5 voices, fast and slow talkers, quiet speech at −14 dB, a room-noise bed, soft first and last words, thinking pauses of 1–3 s, "let me think", a 1-word "No.", a 76 s answer, and ending the interview mid-sentence), plays each into the real app (real Silero VAD and noise gate, real server, **real Groq Whisper**, real Edge TTS; fake LLM so dozens of turns don't use NVIDIA quota) and measures from ground truth:

- **audio coverage**: which of the clip's voiced 10 ms frames are inside the audio the app actually transcribed (request bodies captured in the page, aligned by envelope correlation), with head / tail / gap loss;
- **word recall and WER** of what the server transcribed against the script, first and last words, and how many turns the answer became.

**What the baseline showed** (before this round): a 1-word "No." was never heard (7 confident frames, the noise gate wanted 8); every thinking pause of 1 s or more split the answer in two — the first half was sent at 0.8 s of silence and the rest only survived because it happened to overlap Aria's reply (with a slower reply it was dropped with "Aria is still thinking. Please repeat that"); and Whisper wrote "item potency keys" for "idempotency keys".

**Fixes** (bugs 53–60 below): semantic end of turn (the speculative transcript of each pause decides the silence: finished sentence 0.8 s, unpunctuated 1.4 s, "…and"/"um" 2.2 s, "let me think" 5 s); continuations merged into the answer (Aria's reply is held while the candidate keeps talking, the server merges the continuation and withdraws the unheard reply; a barge-in within 2 s of her reply is a false start and merges too); short crisp words accepted; answers over 2 minutes sent in parts; End delivers an answer in progress; Whisper primed with the interview's vocabulary.

| Scenario | Baseline | Final |
|---|---|---|
| "Yes." / "Around two years." / quiet "I'm not sure, sorry." | ✓ | ✓ |
| **"No."** (UK voice, 1 syllable) | **not heard** | ✓ |
| 15 s answers: US, UK, Indian, Australian voices; fast (260 wpm); slow (120 wpm) | ✓ (one had "item potency" for idempotency) | ✓, 0 % WER |
| Quiet speaker (−14 dB), room-noise bed, soft first/last words | ✓ | ✓ |
| **1.0 s pause** mid-sentence | 2 turns | **1 turn**, 100 % |
| **1.5 s pause** after a finished sentence | 2 turns | **1 turn**, 100 % |
| **2.0 s pause** after "…and" | 2 turns | **1 turn**, 100 % |
| **3.0 s pause** between two thoughts | 2 turns | **1 turn**, 100 % |
| "Let me think." + 3 s silence | (new) | 1 turn, 100 % |
| A finished sentence + two more after 1.2 s pauses | (new) | 1 turn, 100 % audio ("re-dis" for Redis) |
| 76 s answer with natural pauses | ✓ | ✓, 0 % WER |
| End clicked 0.3 s after an unfinished sentence | (new) | answer saved before the interview closed |

**Final: 21 / 21 scenarios complete, mean audio coverage 100 %** (runs 3 and 4, real Whisper). Speech end → interviewer audio for finished answers stayed at **1.58–1.83 s** (baseline run 1.46–1.77 s; fake LLM + real Edge TTS + real Groq), so the longer pauses cost nothing when the candidate is done; answers that continue after a pause are answered 2.3–2.6 s after they finish (one extra transcription of the merged audio); the 76 s answer 4.4 s.

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
- **Incident seen during final testing (2026-10-11, about 15:38 IST, a few minutes):** Super answered HTTP 429 to back-to-back requests while Lightning accepted requests but never responded (30 s timeouts). One live turn failed after the 15 s stall timeout. Live turns now abandon a provider that hasn't started streaming within 6 s and retry once when every provider failed quickly ([bug 35](#7-bugs-found-by-testing-all-fixed)); the API e2e suite covers a brief outage of every provider being absorbed.

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
| 30 candidates × 6 turns, real TTS | 210 | 11.8 turns/s | 1,166 / 2,018 / 2,092 ms | 1,620 / 2,309 ms | 0 (420 audio clips, 0 fallbacks) | ✓ |
| **30 candidates × 6 turns, real TTS (final build)** | 210 | 11.5 turns/s | **1,059 / 2,099 / 2,157 ms** | 1,602 / 2,414 ms | 0 (420 audio clips, 0 fallbacks) | ✓ |
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
| 4 | full run after round 3 | 4.5 | 3 | 4 | 5 | 3.5 | **4.00 / 5** · calibration 82 vs 45 |
| 5 | end requests, early wrap-up guard, full question history | 4.9 | 5 | 5 | 4 | 5 | **4.78 / 5** · calibration 88 vs 22 |
| 6 | report canvas grounding, last regeneration without the copied dialogue | 5 | 4 | 5 | 4.9 | judge failed (NVIDIA) | **4.72 / 5** over 4 · calibration 88 vs 30 |
| 7 | closing guarantee, farewell/empty-reply guards, company grounding, report repair | 5 | 5 | 5 | 4.3 | 5 | **4.86 / 5** · calibration 88 vs 40 |
| **Final** | **this build**: every sentence checked, repeats found anywhere in earlier replies | **5** | 4 | **5** | **4.9** | **5** | **4.78 / 5** · calibration 78 vs 28 |

Candidates are simulated by LLMs, so a persona's score can move by about half a point between runs of the same build; read the rounds as a trend, not exact deltas.

Deterministic checks across rounds: filler-praise openers **22 % → 0 %**; stacked questions **2 / 12 → 0** per interview (now enforced); broken reports **4 / 5 → 0 / 5**; scripted edge-case probes (repeat, "I don't know", prompt injection, off-topic, wanting to stop) all handled.

### What each round caught

- **Scripted runs before the evaluator existed:** the interviewer fell into a loop ("could you finish that thought?") after one ambiguous answer; echoed "Could you repeat the question?" back; promised an email follow-up; ignored "I don't know".
- **Round 1 (mean judge 4.0 / 5):** 4 of 5 reports were broken (see bug 5); long turns (up to 108 words) and stacked questions; the interviewer read a coding task aloud before the canvas existed; closing exchanges looped ("Take care." ×4).
- **Round 2 (mean 4.42 / 5; strong 4.7, pm 5, behavioral 5, edge 3):** reports fixed (85 / 45 / 78 / 82); filler praise 22 % → 0 %; stacked questions → 0. Found verbatim copies of earlier replies under rate-limit failover and NVIDIA's per-model rate limit.
- **Round 3 (strong persona):** judge **5 / 5 in every dimension**, report 85, 0 regenerations, 0 % backup-model turns. (The run was then interrupted by a harness bug, fixed by moving the simulated candidate to separate models.)
- **Round 4 (mean 4.00):** repetition with weak answers: the vague persona was asked the same question again and again (judge: the for-loop question at turns 8–10, 26–28 and 38–40), the interviewer carried on after the candidate asked to end, and the behavioral interview fell into an "end the interview" loop. Fixed by explicit end requests (bug 24), the early wrap-up guard (bug 22) and listing every question asked (bug 30).
- **Round 5 (mean 4.78; strong 4.9, vague 5, edge 5, pm 4, behavioral 5):** calibration widened to 88 vs 22. The pm interview still had verbatim repeats accepted after two regenerations, and a report credited canvas code that wasn't written. Fixed by the last-attempt regeneration without the copied dialogue (bug 29) and canvas grounding in the rubric (bug 33).
- **Round 6 (mean 4.72 over 4 judged; strong 5, vague 4, edge 5, pm 4.9):** repeated questions fell from 10+ per weak interview to at most 1. Still found: a goodbye exchange in the middle of the behavioral interview, started by the candidate, plus an invented answer about the company (bugs 23, 31); a closing turn with nothing speakable (bug 27); a report naming `SELECT FOR UPDATE` that wasn't in the canvas (bug 33); the interviewer offering to run code (bug 32). The Mac went to sleep for 90 minutes mid-run (during the edge persona's report step), and NVIDIA was degraded after it woke (see the incident in [§2](#2-llm-benchmarks-nvidia-free-tier)): the pm interview ran so slowly that its first answer arrived in the behavioral section, and the behavioral judge call failed. Round 6 is indicative only.
- **Round 7 (mean 4.86; strong, vague, edge and behavioral 5 in every dimension, pm 4.3):** report accuracy 5 / 5 in all five interviews; no stacked questions; filler praise on 1 turn in total; every interview closed itself (the vague one through the time limit, the edge one on the candidate's explicit end request). Remaining gap: the repeat and early wrap-up guards only inspect the opening of a reply (about 50 characters), so the pm interviewer re-asked one question after a different preamble (judge adaptivity 3), and one behavioral reply ended a section with "That's all the time we have for this section. You can now press End interview" in its third sentence, after which the candidate ended the interview early. Both fixed in the final build (bugs 38, 39).
- **Final (mean 4.78; strong, edge and behavioral 5, pm 4.9, vague 4):** the two targeted problems are gone: the pm interview had no repeated questions (adaptivity 3 → 5) and the behavioral interview ran through its wrap-up instead of closing early. The mean moved within run-to-run noise because the vague persona scored 4 this time (5 in round 7): the judge wanted harder adjustment after repeated non-answers. The remaining repeat flags are last-attempt fallbacks, where the third draft is accepted rather than stalling: "Do you have any questions for me?" asked again in wrap-up after a non-answer, and "anything else you'd like to add?" asked twice after the simulated candidate started saying goodbye. This run used the build just before bug 40's fix (it only changes the first words of a regenerated draft and is unit-tested); the live-browser and e2e suites ran on the final build.

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
| 22 | quality eval | Interviewer started wrapping up mid-interview ("we've reached the end of this section, press End interview") | Wrap-up language before the wrap-up section is rejected and regenerated with the minutes remaining |
| 23 | quality eval | Goodbye exchanges mid-interview ("Take care." / "Have a great day.") after a candidate said thanks | Farewells added to the same guard |
| 24 | quality eval | "End the interview" was treated as an answer and the interview carried on | Explicit end requests close the interview at once, including "I'm ending the interview now" |
| 25 | code review | A technical answer such as "we end the session on logout" would have ended the interview | "Session" only counts as "this/our session" or as the whole message |
| 26 | live browser | When time ran out mid-exercise, the closing turn asked a question and the interview ended with it unanswered | The final turn never asks a question; a fixed closing line is spoken if the model asks one, says nothing, or fails |
| 27 | quality eval | A closing turn with nothing speakable (only the end marker) failed with an error and left the interview open | Same closing guarantee; the end marker only counts from wrap-up on and never right after a question |
| 28 | quality eval | An empty reply mid-interview failed the turn | Empty drafts are regenerated with a note |
| 29 | quality eval | A verbatim copy of the previous reply survived two regenerations | The last regeneration sees only the candidate's latest message and a short excerpt of the rejected draft |
| 30 | quality eval | Long interviews re-asked early questions (only the last 10 questions were in the prompt) | Every question asked so far is listed (each clipped to 220 characters) |
| 31 | quality eval | Interviewer invented company practices when the candidate asked about the team | Answers only from the job description and says when it doesn't know |
| 32 | quality eval | Interviewer offered to "run" the candidate's code | It is told it can read the canvas but cannot execute code |
| 33 | quality eval | Report credited code the candidate never wrote ("uses SELECT FOR UPDATE") | Rubric names only constructs literally present in the canvas; spoken ideas count as reasoning, not implementation |
| 34 | live browser | Leaving the tab just before the interview ended lost the signal | Recorded when tracking stops while the tab is hidden |
| 35 | live browser | During an NVIDIA incident (Super returning 429, Lightning not responding) a turn waited 15 s and then failed | A live provider that hasn't started streaming within 6 s is abandoned, and a turn whose providers all failed quickly is retried once |
| 36 | live browser + report probe | About 1 in 6 scorecards generated without reasoning had malformed JSON (for example `;` between array items); when both server attempts failed, the report page showed an error | JSON repair now handles stray semicolons, missing commas and unescaped quotations (every probe output parses); the report page retries a failed generation once automatically |
| 37 | live browser | A barge-in during the interviewer's last sentence wasn't marked "interrupted" in the transcript (only cuts before a later sentence started were) | Any barge-in marks the reply as interrupted |
| 38 | quality eval (final) | The repeat check compared a new reply only with the *start* of earlier replies, so a question asked again after a different preamble got through (the pm interviewer asked one question three times) | New text is compared with every part of earlier replies, and each question in a reply is checked, not only the opening |
| 39 | quality eval (final) | Only a reply's opening was checked, so "That's all the time we have for this section. You can now press End interview" in a third sentence was spoken, and the candidate ended the interview at minute 10 of 15 | Every sentence is checked before it is spoken; a later sentence that wraps up early or re-asks a question is dropped and the reply continues with a new question |
| 40 | live browser | After a rejected draft whose acknowledgement was already spoken, the new draft could open with another one ("Okay. Okay, you're suggesting…") | A regenerated draft's leading acknowledgement is dropped when one was already spoken |
| 41 | real microphone | Under `next dev` (React StrictMode) vad-react destroyed a never-started detector, whose `destroy()` throws; the error disabled voice for the whole session | The app drives the detector directly with a StrictMode-safe lifecycle |
| 42 | real microphone | A failed microphone start (permission, device busy) left the detector permanently errored, with one generic "blocked" message and no way back without reloading | Specific messages per cause (denied, blocked by macOS, not found, busy, insecure origin) and "Try the microphone again", which builds a fresh detector |
| 43 | real microphone | An invalid Groq key failed every spoken answer while the app kept sending audio and told the candidate to "type" without switching | After one `stt_unavailable` the room stops listening, switches to typing and says why; the server remembers the bad key and stops calling Groq |
| 44 | real microphone | `/api/health` reported speech-to-text "configured" for a key Groq rejects | A cached `GET /models` check reports `invalid_key`, `rate_limited`, `model_unavailable` or `unreachable` |
| 45 | real microphone | Any sound scored as speech for 224 ms in total became an answer (no loudness or confidence check) | Noise gate: 256 ms of confident speech, 128 ms unbroken, 9 dB above an adaptive room-noise floor |
| 46 | real microphone | Speculative transcription fired on every pause and was never cancelled; an empty (noise) transcript was then transcribed again through the turn | Only gated utterances speculate, superseded ones are aborted, at most 8 per minute with back-off after a 429; an empty transcript never becomes a turn |
| 47 | real microphone | Loud voices near the laptop are indistinguishable from the candidate | Push-to-talk mode (hold Space or the on-screen button), offered automatically after repeated background-noise events |
| 48 | code review | A microphone that disconnected, stalled or went silent mid-interview was never noticed | Track `ended`/`mute` and device changes restart capture automatically; a watchdog shows "Restart microphone" for dead, muted or silent input |
| 49 | code review | Groq 429s were retried immediately, 400s looked like outages, and the speculative and audio-turn paths shared one per-IP budget | Errors classified (`stt_unavailable`, `stt_busy`, `stt_failed`); rate limits honour Retry-After; only undecodable clips count as "nothing heard"; audio turns have their own budget |
| 50 | code review | Whisper noise outputs such as "Thank you. Thank you.", "[Music]" or "Bye bye." were saved as answers | Normalized, sentence-level hallucination filter that keeps real short answers ("Yes.", "Okay.") |
| 51 | adversarial review | Overlapping microphone restarts could wire two live streams into the detector; a recovered detector leaked on unmount | Start, pause and restart run one at a time; restarts coalesce; every detector and stream is released on unmount |
| 52 | adversarial review | Push-to-talk edge cases: no length cap (413 after ~131 s), taps sent as answers, a re-press during the tail was lost, Space hijacked focused buttons | 2-minute cap with auto-send, minimum hold length, re-press support, Space left to focused controls |
| 53 | audio-capture harness + audit | A thinking pause of ≥0.8 s ended the answer; what the candidate said next was dropped ("please repeat") or became a separate turn | Semantic end of turn from the pause's speculative transcript (0.8 / 1.4 / 2.2 / 5 s); the tracker drives vad-web's redemption via `setOptions`, verified frame-for-frame against vad-web's own frame processor |
| 54 | audio-capture harness | Speech after the answer was sent (before Aria's reply was heard) was discarded | Aria's reply is held while the candidate talks; the continuation is sent as an amend turn; the server merges it into the last answer and withdraws the unheard reply (question count rolled back); a barge-in within 2 s of her reply is a false start |
| 55 | audio-capture harness | A 1-word "No." was rejected by the noise gate (7 confident frames, 8 required) | Short crisp words pass with a 160 ms unbroken run 18 dB over the room floor |
| 56 | audio-capture harness | Whisper wrote "item potency keys" for "idempotency keys" (and the report would quote it) | Whisper prompt with the interview's vocabulary from the role, job description and resume (cached per session) |
| 57 | audit | Ending the interview right after answering lost that answer, or the report was built before it was saved and cached without it | End delivers the answer in progress (`submitUserSpeechOnPause`) and waits for answers in flight; the report waits for the turn lock and regenerates if a late answer arrives |
| 58 | audit | A Groq 429 on a speculative call made the real answer's transcription fail at once; any STT/network failure threw the recording away | Speculative and real calls are separated (real answers wait out a short limit); one automatic resend; Retry resends the kept audio/text |
| 59 | audit | The echo filter discarded real answers that restated the question ("I would design a rate limiter for the payments API") | Echo needs the interviewer's word order (LCS) and no first-person words of its own |
| 60 | audit | Interrupted replies were saved in full, so the interviewer and the report treated unheard questions as asked | The client sends what was heard; the transcript reads the reply as heard ("…[interrupted]") for the interviewer, analysis and report |
| 61 | report accuracy audit | Reports: 69 % of 545 claims supported, 9 % contradicted (tips for things already done, interviewer words attributed to the candidate, "runs/passes all cases" without execution), overall scores +7 on average | Numbered transcript with citations, quote verification, score tied to competencies (±8), hands-on guards, calibration anchors and rules (see §6) |

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

- **Real speech-to-text was tested late.** Most latency tables above simulate STT (450 ms) because the first Groq key was invalid. With a valid key, real Groq Whisper was verified on the real microphone and in the browser suite (see [real microphone](#real-microphone-live-voice-input)): transcripts were exact and end-to-end voice turns were unchanged.
- **Not measured from Vercel.** All latency numbers are from a local production build talking to Atlas (Mumbai), NVIDIA, and Edge TTS from India.
- **Real microphone tested on one Mac only.** The built-in microphone and speakers of one MacBook Air, in Chromium and Brave. Windows, Safari, Firefox, phones and Bluetooth headsets are untested; the device-change and error handling are exercised by the fake-microphone suite.
- **Quality is LLM-judged**, not rated by humans; the simulated candidates are approximations.

## 10. Reproducing these results

```bash
npm install && npm run build
npm run check                                   # typecheck + lint + unit tests
npm run test:e2e                                # needs MONGODB_URI
npm run test:live                               # Edge TTS against the real service
npm run test:live-browser                       # needs NVIDIA_API_KEY + MONGODB_URI (macOS `say` for fixtures)
npm run test:real-mic -- --stt=fake             # real microphone + speakers (macOS); see the script header for modes
npm run test:quality                            # needs NVIDIA_API_KEY + MONGODB_URI (~20 min)
node tests/load/run.mjs --users=30 --turns=6 --tts=on
```

Each live run writes a JSON report to `test-results/` (git-ignored) with per-turn timings and transcripts. All suites create throwaway MongoDB databases and drop them afterwards.
