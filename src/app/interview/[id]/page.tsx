"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type MutableRefObject, type ReactNode } from "react";
import { Hand, Keyboard, Mic, MicOff, RotateCcw, Send, X } from "lucide-react";
import { CanvasPanel } from "@/components/CanvasPanel";
import { InterviewerOrb, type OrbMode } from "@/components/InterviewerOrb";
import { TranscriptPane } from "@/components/TranscriptPane";
import { useIntegrity } from "@/hooks/useIntegrity";
import { useInterview } from "@/hooks/useInterview";
import { useVAD } from "@/hooks/useVAD";
import { endInterview, transcribeSpeculative, type SpeculativeTranscript } from "@/lib/api";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/protocol";
import { encodeWav } from "@/lib/wav";

const SECTION_LABELS: Record<string, string> = {
  opening: "Introduction",
  background: "Your background",
  technical: "Technical",
  hands_on: "Hands-on",
  behavioral: "Behavioral",
  wrap_up: "Wrap-up",
  closing: "Closing",
};

/**
 * Barge-in detector: of the last BARGE_IN_WINDOW frames (~32 ms each), at least
 * BARGE_IN_FRAMES must be confident speech. A sliding window tolerates the brief
 * dips between words that reset a strict "consecutive frames" counter.
 */
const BARGE_IN_WINDOW = 10;
const BARGE_IN_FRAMES = 7;
const BARGE_IN_PROBABILITY = 0.7;

function formatClock(totalSeconds: number) {
  const sign = totalSeconds < 0 ? "+" : "";
  const s = Math.abs(totalSeconds);
  return `${sign}${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function InterviewRoom() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const search = useSearchParams();
  const debug = search.get("debug") === "1";
  const sessionId = params.id;
  const interview = useInterview(sessionId);
  const { session, messages, turnStatus, error, notice, limitReached, questionNumber, sendTurn, started, canvas } = interview;

  const [muted, setMuted] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [allowInterrupt, setAllowInterrupt] = useState(true);
  const [mobileTab, setMobileTab] = useState<"interview" | "canvas">("interview");
  const [now, setNow] = useState(() => Date.now());
  const micLevel = useRef(0);
  const bargeWindow = useRef<boolean[]>([]);
  /** Speculative transcripts started during the candidate's pauses, by tracker id. */
  const speculations = useRef(new Map<number, Promise<SpeculativeTranscript | null>>());

  const integrity = useIntegrity(sessionId, started && !limitReached && !ending);

  const accepting = started && turnStatus === "ready" && !muted && !limitReached && !ending;

  const vadCallbacks = useMemo(
    () => ({
      onSpeculate: (audio: Float32Array, id: number) => {
        speculations.current.set(
          id,
          transcribeSpeculative(sessionId, encodeWav(audio)).catch(() => null),
        );
      },
      onUtterance: (audio: Float32Array, endedAt: number, speculationId: number | null) => {
        const transcript = speculationId !== null ? speculations.current.get(speculationId) : undefined;
        speculations.current.clear();
        void sendTurn({ audio: encodeWav(audio), transcript }, { inputAt: endedAt });
      },
      onFrame: (probability: number, level: number) => {
        micLevel.current = level;
        if (debug) {
          const w = window as unknown as { __vadProbs?: { t: number; p: number }[] };
          (w.__vadProbs ??= []).push({ t: performance.now(), p: probability });
          if (w.__vadProbs.length > 3_000) w.__vadProbs.splice(0, 1_000);
        }
        // Barge-in: sustained, confident speech while the interviewer is talking.
        if (allowInterrupt && turnStatus === "speaking") {
          const recent = bargeWindow.current;
          recent.push(probability >= BARGE_IN_PROBABILITY);
          if (recent.length > BARGE_IN_WINDOW) recent.shift();
          if (recent.filter(Boolean).length >= BARGE_IN_FRAMES) {
            bargeWindow.current = [];
            interview.interrupt();
          }
        } else if (bargeWindow.current.length) {
          bargeWindow.current = [];
        }
      },
    }),
    [sendTurn, allowInterrupt, turnStatus, interview, sessionId, debug],
  );
  const vad = useVAD(vadCallbacks, accepting);
  const micAvailable = !micError && !vad.errored;

  // Clock
  useEffect(() => {
    if (!started) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [started]);

  // Space bar interrupts the interviewer (unless typing).
  const interruptRef = useRef(interview.interrupt);
  useEffect(() => {
    interruptRef.current = interview.interrupt;
  }, [interview.interrupt]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code !== "Space" || target?.closest("input, textarea, select, [contenteditable='true'], .cm-editor")) return;
      if (interruptRef.current()) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Show the canvas tab on mobile as soon as an exercise arrives (derived state).
  const hasCanvas = !!canvas.task;
  const [hadCanvas, setHadCanvas] = useState(hasCanvas);
  if (hasCanvas !== hadCanvas) {
    setHadCanvas(hasCanvas);
    if (hasCanvas) setMobileTab("canvas");
  }

  const begin = async (withMic: boolean) => {
    if (withMic && !vad.errored) {
      try {
        await vad.start();
        setMicError(null);
      } catch {
        setMicError("Microphone access was blocked. Allow it in your browser's site settings, or continue by typing.");
        setTextMode(true);
      }
    } else {
      setTextMode(true);
    }
    await interview.begin();
  };

  const toggleMute = async () => {
    if (muted) {
      await vad.start().catch(() => setMicError("Couldn't re-enable the microphone."));
      setMuted(false);
    } else {
      await vad.pause();
      setMuted(true);
    }
  };

  const submitText = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || turnStatus === "processing" || limitReached) return;
    if (turnStatus === "speaking") interview.interrupt();
    setDraft("");
    void sendTurn({ text });
  };

  const retry = () => {
    if (error?.retryContinues) void sendTurn({ continue: true });
    else interview.reload();
  };

  const finish = async () => {
    setEnding(true);
    interview.stopAudio();
    await interview.flushCanvas().catch(() => undefined);
    await vad.pause().catch(() => undefined);
    try {
      await endInterview(sessionId);
    } catch {
      // The report endpoint also marks the session completed; navigate regardless.
    }
    router.push(`/report/${sessionId}`);
  };

  const getOutputLevel = interview.getOutputLevel;

  // ------------------------------------------------------------------ states

  if (interview.loadState === "loading") return <FullScreenMessage title="Preparing your interview room…" />;
  if (interview.loadState === "not_found") {
    return (
      <FullScreenMessage title="Interview not found" body="This link is invalid or the interview has expired.">
        <Link href="/upload" className="btn-primary">Start a new interview</Link>
      </FullScreenMessage>
    );
  }
  if (interview.loadState === "error" || !session) {
    return (
      <FullScreenMessage title="Couldn't load the interview" body={interview.loadError ?? undefined}>
        <button onClick={() => interview.reload()} className="btn-primary">Try again</button>
      </FullScreenMessage>
    );
  }
  if (session.status === "completed" && !started) {
    return (
      <FullScreenMessage title="This interview has ended" body="Your feedback report is ready to view.">
        <Link href={`/report/${sessionId}`} className="btn-primary">View report</Link>
      </FullScreenMessage>
    );
  }

  const hasAnswers = messages.some((m) => m.role === "user" && m.content);
  const resuming = session.transcript.length > 1;
  const remaining = interview.startedAt ? session.duration_minutes * 60 - (now - interview.startedAt) / 1000 : session.duration_minutes * 60;
  const sectionLabel = SECTION_LABELS[interview.section ?? (questionNumber === 0 ? "opening" : "background")] ?? "Interview";
  const userSpeaking = vad.userSpeaking && (accepting || turnStatus === "speaking");

  const orbMode: OrbMode = !started
    ? "idle"
    : turnStatus === "speaking"
      ? "speaking"
      : turnStatus === "processing"
        ? "thinking"
        : userSpeaking
          ? "listening"
          : "idle";

  const statusLabel = !started
    ? "Waiting to start"
    : turnStatus === "processing"
      ? "Thinking…"
      : turnStatus === "speaking"
        ? allowInterrupt && micAvailable && !muted
          ? "Aria is speaking · talk or press Space to interrupt"
          : "Aria is speaking"
        : limitReached
          ? "Interview complete"
          : muted || !micAvailable
            ? textMode
              ? "Your turn · type your answer"
              : "Microphone muted"
            : userSpeaking
              ? "Listening…"
              : "Your turn · speak naturally";

  const stage = (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border-2 border-vast bg-vast p-4 text-cream md:rounded-[40px] md:p-6">
      <div className="flex flex-col items-center gap-2 pb-2">
        <InterviewerOrb mode={orbMode} getOutputLevel={getOutputLevel} micLevelRef={micLevel} className="w-24 md:w-32" />
        <p className="font-serif text-lg">Aria</p>
        <p className="rounded-full border-2 border-vast bg-forest px-4 py-1 text-center text-sm font-bold" aria-live="polite" data-testid="status">
          {statusLabel}
        </p>
      </div>

      <div className="relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden">
        <TranscriptPane messages={messages} candidateName={session.candidate_name} />
      </div>

      <footer className="z-10 flex flex-col items-center gap-2 pt-2">
        {error && (
          <div role="alert" className="flex w-full max-w-2xl items-center justify-between gap-3 rounded-2xl border-2 border-vast bg-ember px-4 py-3 text-vast">
            <span className="font-medium">{error.message}</span>
            {error.retryable && (
              <button onClick={retry} className="flex shrink-0 items-center gap-1 rounded-lg border-2 border-vast bg-cream px-3 py-1 font-bold">
                <RotateCcw size={16} /> Retry
              </button>
            )}
          </div>
        )}
        {micError && <p className="max-w-2xl text-center text-sm text-ember">{micError}</p>}
        {notice && <p className="text-sm font-medium text-lavender">{notice}</p>}
        {integrity.tabSwitches === 1 && !limitReached && (
          <p className="text-xs text-cream/60">Leaving the interview tab is noted in your report.</p>
        )}

        {limitReached && (
          <button onClick={finish} disabled={ending} className="btn-primary" data-testid="view-report">
            {ending ? "Opening report…" : "Interview complete · view your report"}
          </button>
        )}

        {started && !limitReached && (
          <>
            <div className="flex items-center gap-2">
              {turnStatus === "speaking" && (
                <button
                  onClick={() => interview.interrupt()}
                  className="flex items-center gap-1.5 rounded-full border-2 border-vast bg-cream px-4 py-1.5 text-sm font-bold text-vast"
                  title="Interrupt (Space)"
                >
                  <Hand size={15} /> Interrupt
                </button>
              )}
              {micAvailable && !muted && turnStatus !== "speaking" && <MicMeter levelRef={micLevel} active={accepting} />}
            </div>
            {textMode && (
              <form onSubmit={submitText} className="flex w-full max-w-2xl gap-2">
                <label htmlFor="answer" className="sr-only">Type your answer</label>
                <textarea
                  id="answer"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) submitText(e);
                  }}
                  onPaste={(e) => {
                    const length = e.clipboardData.getData("text").length;
                    if (length >= 200) integrity.reportLargePaste(length);
                  }}
                  maxLength={LIMITS.answerChars}
                  rows={2}
                  placeholder={turnStatus === "processing" ? "Wait for the interviewer…" : "Type your answer and press Enter…"}
                  className="flex-1 resize-none rounded-2xl border-2 border-vast bg-cream px-4 py-3 text-vast outline-none focus:bg-white"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || turnStatus === "processing"}
                  className="rounded-2xl border-2 border-vast bg-lavender px-4 text-vast transition-transform hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0"
                  aria-label="Send answer"
                >
                  <Send size={20} />
                </button>
              </form>
            )}
          </>
        )}
      </footer>
    </section>
  );

  return (
    <div className="flex h-[100dvh] flex-col gap-2 bg-cream p-2 md:gap-3 md:p-4">
      {/* Top bar */}
      <header className="flex flex-wrap items-center justify-between gap-2 rounded-[22px] border-2 border-vast bg-cream px-4 py-2">
        <div className="min-w-0">
          <h1 className="truncate font-serif text-xl md:text-2xl">{session.target_role}</h1>
          <p className="text-xs text-vast/60">
            {session.interview_type[0].toUpperCase() + session.interview_type.slice(1)} interview · {session.level} level · Question {Math.max(questionNumber, 1)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden rounded-full border-2 border-vast bg-lavender px-3 py-1 text-xs font-bold sm:inline" data-testid="section">
            {sectionLabel}
          </span>
          <span
            className={cn(
              "rounded-full border-2 border-vast px-3 py-1 font-mono text-sm font-bold tabular-nums",
              remaining < 180 ? "bg-ember" : "bg-cream",
            )}
            title="Time remaining"
            data-testid="timer"
          >
            {formatClock(Math.round(remaining))}
          </span>
          {started && micAvailable && (
            <button
              onClick={toggleMute}
              className={cn("icon-btn", muted && "bg-ember")}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          )}
          {started && (
            <button onClick={() => setTextMode((v) => !v)} className={cn("icon-btn", textMode && "bg-lavender")} aria-label="Type an answer" title="Type instead">
              <Keyboard size={18} />
            </button>
          )}
          {confirmEnd ? (
            <div className="flex items-center gap-2">
              <button onClick={finish} disabled={ending} className="rounded-xl border-2 border-vast bg-ember px-3 py-2 text-sm font-bold">
                {ending ? "Ending…" : hasAnswers ? "End & get report" : "End anyway"}
              </button>
              <button onClick={() => setConfirmEnd(false)} className="icon-btn" aria-label="Cancel">
                <X size={18} />
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmEnd(true)} className="rounded-xl border-2 border-vast bg-vast px-3 py-2 text-sm font-bold text-cream">
              End interview
            </button>
          )}
        </div>
      </header>
      {confirmEnd && !hasAnswers && (
        <p className="text-right text-sm text-red-700">You haven&apos;t answered any questions yet, so there won&apos;t be a report.</p>
      )}

      {/* Mobile tab switcher when a canvas is open */}
      {hasCanvas && (
        <div className="flex gap-2 md:hidden">
          {(["interview", "canvas"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setMobileTab(tab)}
              className={cn("flex-1 rounded-xl border-2 border-vast py-1.5 text-sm font-bold capitalize", mobileTab === tab ? "bg-lavender" : "bg-cream")}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      <main className={cn("flex min-h-0 flex-1 gap-3", hasCanvas && "md:grid md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]")}>
        <div className={cn("flex min-h-0 flex-1 flex-col", hasCanvas && mobileTab !== "interview" && "hidden md:flex")}>{stage}</div>
        {hasCanvas && (
          <CanvasPanel
            canvas={canvas}
            onChange={interview.updateCanvas}
            onLargePaste={integrity.reportLargePaste}
            disabled={limitReached || ending}
            className={cn("flex-1", mobileTab !== "canvas" && "hidden md:flex")}
          />
        )}
      </main>

      {debug && <LatencyOverlay records={interview.latency} />}

      {/* Lobby */}
      {!started && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-vast/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[32px] border-2 border-vast bg-cream p-8 text-vast">
            <h2 className="mb-2 font-serif text-3xl">{resuming ? "Welcome back" : `Ready, ${session.candidate_name.split(" ")[0]}?`}</h2>
            <p className="mb-5 text-vast/75">
              {resuming
                ? "Pick up where you left off. Aria remembers the conversation so far."
                : `A ${session.duration_minutes}-minute ${session.interview_type} interview for ${session.target_role}. Aria speaks first; answer out loud when it's your turn.`}
            </p>
            <ul className="mb-7 space-y-2 text-sm">
              <li>🎧 Headphones give the best experience (no echo).</li>
              <li>🎙️ Your browser will ask for microphone access.</li>
              <li>✋ Talk over Aria (or press Space) to interrupt.</li>
              {session.canvas_enabled && <li>💻 A canvas opens later for a hands-on exercise.</li>}
            </ul>
            <button onClick={() => begin(true)} disabled={vad.loading && !vad.errored} className="btn-primary w-full disabled:opacity-60" data-testid="start">
              {vad.loading && !vad.errored ? "Preparing microphone…" : resuming ? "Resume interview" : "Start interview"}
            </button>
            {vad.errored && <p className="mt-3 text-sm text-red-700">Voice detection couldn&apos;t load on this device. You can still type your answers.</p>}
            <button onClick={() => begin(false)} className="mt-3 w-full text-sm font-semibold underline underline-offset-4" data-testid="start-text">
              Continue without a microphone
            </button>
            <label className="mt-4 flex items-center justify-center gap-2 text-xs text-vast/70">
              <input type="checkbox" checked={allowInterrupt} onChange={(e) => setAllowInterrupt(e.target.checked)} />
              Let me interrupt by speaking (turn off if you use speakers and get cut off)
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

function MicMeter({ levelRef, active }: { levelRef: MutableRefObject<number>; active: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const level = levelRef.current;
      bars.current.forEach((bar, i) => {
        if (!bar) return;
        const threshold = (i + 1) / 8;
        bar.style.opacity = level * 1.4 >= threshold ? "1" : "0.25";
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [levelRef]);
  return (
    <div className={cn("flex h-7 items-end gap-0.5 rounded-full border-2 border-vast bg-cream px-3 py-1", !active && "opacity-50")} aria-label="Microphone level">
      {Array.from({ length: 8 }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="w-1 rounded-full bg-forest transition-opacity duration-75"
          style={{ height: `${30 + i * 9}%`, opacity: 0.25 }}
        />
      ))}
    </div>
  );
}

function LatencyOverlay({ records }: { records: ReturnType<typeof useInterview>["latency"] }) {
  const recent = records.slice(-6);
  return (
    <div className="fixed bottom-3 left-3 z-30 max-w-sm rounded-xl border-2 border-vast bg-white/95 p-3 font-mono text-[11px] leading-snug text-vast shadow-lg">
      <p className="mb-1 font-bold">Latency (ms)</p>
      {recent.length === 0 && <p>No turns yet.</p>}
      {recent.map((r) => (
        <p key={r.turn}>
          #{r.turn} {r.input}: response {r.response_latency_ms ?? "–"} | stt {r.server?.stt_ms ?? "–"} | llm {r.server?.llm_first_token_ms ?? "–"} | 1st audio{" "}
          {r.server?.first_audio_ms ?? "–"}
          {r.interrupted ? " | interrupted" : ""}
        </p>
      ))}
    </div>
  );
}

function FullScreenMessage({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-cream p-6 text-center text-vast">
      <h1 className="font-serif text-3xl md:text-4xl">{title}</h1>
      {body && <p className="max-w-md text-vast/75">{body}</p>}
      {children}
    </main>
  );
}

export default function InterviewRoomPage() {
  // useSearchParams requires a Suspense boundary for static rendering.
  return (
    <Suspense fallback={<FullScreenMessage title="Preparing your interview room…" />}>
      <InterviewRoom />
    </Suspense>
  );
}
