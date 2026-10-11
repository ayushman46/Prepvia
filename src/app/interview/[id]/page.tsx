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
import { describeMicError, useVAD, type CaptureMode } from "@/hooks/useVAD";
import { ClientApiError, endInterview, transcribeSpeculative, type SpeculativeTranscript } from "@/lib/api";
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
/** Background-noise events (ignored sounds, empty transcripts) within a minute before suggesting push-to-talk. */
const NOISY_ROOM_EVENTS = 4;
const CAPTURE_MODE_KEY = "interviewai:capture-mode";

function readCaptureMode(): CaptureMode {
  try {
    return window.localStorage.getItem(CAPTURE_MODE_KEY) === "push" ? "push" : "auto";
  } catch {
    return "auto";
  }
}

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
  const { session, messages, turnStatus, error, notice, limitReached, questionNumber, sendTurn, started, canvas, voiceUnavailable } = interview;

  const [muted, setMuted] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [allowInterrupt, setAllowInterrupt] = useState(true);
  /** "auto": hands-free voice detection; "push": hold Space or the button while answering (noisy rooms). */
  // The room renders a loading screen first on both server and client, so reading
  // storage in the initializer can't cause a hydration mismatch.
  const [captureMode, setCaptureModeState] = useState<CaptureMode>(readCaptureMode);
  const [holding, setHolding] = useState(false);
  const [noisyRoom, setNoisyRoom] = useState(false);
  const noiseEvents = useRef<number[]>([]);
  const lastHintAt = useRef<Record<string, number>>({});
  const [mobileTab, setMobileTab] = useState<"interview" | "canvas">("interview");
  const [now, setNow] = useState(() => Date.now());
  const micLevel = useRef(0);
  const bargeWindow = useRef<boolean[]>([]);
  /** Speculative transcripts started during the candidate's pauses, by tracker id. */
  const speculations = useRef(new Map<number, { promise: Promise<SpeculativeTranscript | null>; controller: AbortController }>());
  /** After a 429 from /transcribe, skip speculation until then (performance.now()). */
  const speculationBlockedUntil = useRef(0);
  const flashNotice = interview.flashNotice;
  const claimFloorRef = useRef<() => void>(() => undefined);
  const pushEndRef = useRef<() => Promise<void>>(async () => undefined);
  const markVoiceUnavailable = interview.markVoiceUnavailable;

  const integrity = useIntegrity(sessionId, started && !limitReached && !ending);

  const accepting = started && turnStatus === "ready" && !muted && !limitReached && !ending && !voiceUnavailable;

  const setCaptureMode = (next: CaptureMode) => {
    void pushEndRef.current(); // a hold in progress is sent, never left running
    setCaptureModeState(next);
    setNoisyRoom(false);
    try {
      window.localStorage.setItem(CAPTURE_MODE_KEY, next);
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  };

  /** Show a hint at most once per `everyMs` per kind. */
  const hint = (kind: string, message: string, everyMs: number) => {
    const now = performance.now();
    if (now - (lastHintAt.current[kind] ?? -Infinity) < everyMs) return;
    lastHintAt.current[kind] = now;
    flashNotice(message);
  };
  const noteNoise = () => {
    const now = performance.now();
    noiseEvents.current = [...noiseEvents.current.filter((t) => now - t < 60_000), now];
    if (noiseEvents.current.length >= NOISY_ROOM_EVENTS) setNoisyRoom(true);
  };

  const vadCallbacks = useMemo(
    () => ({
      onSpeculate: (audio: Float32Array, id: number) => {
        if (performance.now() < speculationBlockedUntil.current) return;
        const controller = new AbortController();
        const promise = transcribeSpeculative(sessionId, encodeWav(audio), controller.signal).catch((error: unknown) => {
          if (error instanceof ClientApiError) {
            if (error.status === 429) speculationBlockedUntil.current = performance.now() + (error.retryAfterMs ?? 5_000);
            if (error.code === "stt_unavailable") markVoiceUnavailable();
          }
          return null; // the turn falls back to uploading the audio
        });
        speculations.current.set(id, { promise, controller });
      },
      onCancelSpeculation: (id: number) => {
        speculations.current.get(id)?.controller.abort();
        speculations.current.delete(id);
      },
      onUtterance: (audio: Float32Array, endedAt: number, speculationId: number | null) => {
        const transcript = speculationId !== null ? speculations.current.get(speculationId)?.promise : undefined;
        for (const [id, speculation] of speculations.current) if (id !== speculationId) speculation.controller.abort();
        speculations.current.clear();
        void sendTurn({ audio: encodeWav(audio), transcript }, { inputAt: endedAt });
      },
      onRejected: (reason: "short" | "quiet") => {
        noteNoise();
        if (reason === "quiet") hint("faint", "I can hear you only faintly. Move closer to the microphone or reduce background noise.", 20_000);
      },
      onHoldLimit: () => {
        hint("hold-limit", "Answers are limited to 2 minutes, so I've sent what you said so far.", 10_000);
        void pushEndRef.current();
      },
      onDropped: () => {
        if (turnStatus !== "processing") return; // while Aria speaks, talking over her is barge-in's job
        noteNoise();
        hint("busy", "Aria is still thinking. Please repeat that once she has replied.", 10_000);
      },
      onFrame: (probability: number, level: number, rms: number, noiseFloor: number) => {
        micLevel.current = level;
        if (debug) {
          const w = window as unknown as { __vadProbs?: { t: number; p: number; rms: number; floor: number }[] };
          (w.__vadProbs ??= []).push({ t: performance.now(), p: probability, rms, floor: noiseFloor });
          if (w.__vadProbs.length > 3_000) w.__vadProbs.splice(0, 1_000);
        }
        // Barge-in: sustained, confident speech while the interviewer is talking (hands-free mode only).
        if (allowInterrupt && captureMode === "auto" && turnStatus === "speaking") {
          const recent = bargeWindow.current;
          recent.push(probability >= BARGE_IN_PROBABILITY);
          if (recent.length > BARGE_IN_WINDOW) recent.shift();
          if (recent.filter(Boolean).length >= BARGE_IN_FRAMES) {
            bargeWindow.current = [];
            if (interview.interrupt()) claimFloorRef.current();
          }
        } else if (bargeWindow.current.length) {
          bargeWindow.current = [];
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hint/noteNoise only touch refs and stable setters
    [sendTurn, allowInterrupt, captureMode, turnStatus, interview, sessionId, debug, flashNotice, markVoiceUnavailable],
  );
  const vad = useVAD(vadCallbacks, accepting, captureMode);
  useEffect(() => {
    claimFloorRef.current = vad.claimFloor;
  }, [vad.claimFloor]);
  const micAvailable = !micError && !vad.errored;
  const micLive = vad.listening && !muted && micAvailable && !voiceUnavailable;

  // Speech-to-text can't work on this server: stop listening (typing is shown instead).
  useEffect(() => {
    if (voiceUnavailable) void vad.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vad.pause is stable
  }, [voiceUnavailable]);
  const typing = textMode || voiceUnavailable;

  // Empty transcripts count as background noise too.
  const noSpeechCount = interview.noSpeechCount;
  useEffect(() => {
    if (noSpeechCount > 0) noteNoise();
  }, [noSpeechCount]);

  // Clock
  useEffect(() => {
    if (!started) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [started]);

  // Push-to-talk: record while Space or the on-screen button is held.
  const holdingRef = useRef(false);
  /** Returns true when a hold began (the caller then owns the key/button press). */
  const pushStart = (): boolean => {
    if (captureMode !== "push" || !started || limitReached || ending || !micLive || holdingRef.current) return false;
    if (turnStatus === "processing") {
      hint("busy", "Aria is still thinking. Hold to answer once she has replied.", 5_000);
      return false;
    }
    if (turnStatus === "speaking") interview.interrupt();
    if (!vad.beginHold()) return false;
    holdingRef.current = true;
    setHolding(true);
    return true;
  };
  const pushEnd = async (): Promise<void> => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    const audio = await vad.endHold();
    if (!audio) {
      hint("hold", "Hold the button (or Space) while you speak, then release it.", 5_000);
      return;
    }
    void sendTurn({ audio: encodeWav(audio) });
  };

  // Space bar: interrupts the interviewer (hands-free) or is the push-to-talk key (unless typing).
  const keysRef = useRef({ interrupt: interview.interrupt, mode: captureMode, pushStart, pushEnd });
  useEffect(() => {
    keysRef.current = { interrupt: interview.interrupt, mode: captureMode, pushStart, pushEnd };
    pushEndRef.current = pushEnd;
  });
  useEffect(() => {
    const typing = (event: KeyboardEvent) =>
      (event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true'], .cm-editor");
    // In push mode Space still activates a focused control (accessibility), except the talk button.
    const control = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      return !!target?.closest("button, a, [role='button'], input, select") && !target.closest("[data-testid='push-to-talk']");
    };
    const onDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || typing(event)) return;
      if (keysRef.current.mode === "push") {
        if (control(event)) return;
        event.preventDefault();
        if (!event.repeat) keysRef.current.pushStart();
        return;
      }
      if (keysRef.current.interrupt()) event.preventDefault();
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !holdingRef.current) return;
      event.preventDefault();
      void keysRef.current.pushEnd();
    };
    // Releasing outside the window must not leave the recorder running.
    const onBlur = () => void keysRef.current.pushEnd();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
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
      } catch (error) {
        setMicError(describeMicError(error).message);
        setTextMode(true);
      }
    } else {
      setTextMode(true);
    }
    await interview.begin();
  };

  /** Turn the microphone (back) on: after a failure, "Continue without a microphone", or mute. */
  const enableMic = async () => {
    try {
      await vad.start();
      setMicError(null);
      setMuted(false);
    } catch (error) {
      setMicError(describeMicError(error).message);
      setTextMode(true);
    }
  };

  const toggleMute = async () => {
    if (muted || !vad.listening) {
      await enableMic();
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
        ? captureMode === "push" && micLive
          ? "Aria is speaking · hold Space to interrupt and answer"
          : allowInterrupt && micLive
            ? "Aria is speaking · talk or press Space to interrupt"
            : "Aria is speaking"
        : limitReached
          ? "Interview complete"
          : !micLive
            ? typing
              ? "Your turn · type your answer"
              : muted
                ? "Microphone muted"
                : "Microphone off"
            : captureMode === "push"
              ? holding
                ? "Recording… release to send"
                : "Your turn · hold Space or the button to answer"
              : userSpeaking
                ? "Listening…"
                : "Your turn · speak naturally";

  const captureIssueText: Record<string, string> = {
    ended: "Your microphone stopped. It may have been disconnected.",
    muted: "Your microphone is muted by the system or another app.",
    silent: "No sound is coming from your microphone. Check it isn't muted or set to the wrong device.",
    stalled: "The microphone paused.",
  };

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
        {started && !limitReached && voiceUnavailable && !error && (
          <p role="alert" className="max-w-2xl text-center text-sm font-medium text-ember" data-testid="voice-unavailable">
            Voice answers aren&apos;t available right now: speech recognition isn&apos;t working on this server. Please type your answers.
          </p>
        )}
        {started && !limitReached && micLive && vad.captureIssue && (
          <div role="alert" className="flex w-full max-w-2xl items-center justify-between gap-3 rounded-2xl border-2 border-vast bg-ember px-4 py-2 text-sm text-vast">
            <span className="font-medium">{captureIssueText[vad.captureIssue]}</span>
            <button
              onClick={() => void (vad.captureIssue === "ended" ? enableMic() : vad.restart())}
              className="flex shrink-0 items-center gap-1 rounded-lg border-2 border-vast bg-cream px-3 py-1 font-bold"
            >
              <RotateCcw size={14} /> Restart microphone
            </button>
          </div>
        )}
        {micError && (
          <div className="flex max-w-2xl flex-col items-center gap-1 text-center text-sm text-ember" data-testid="mic-error">
            <p>{micError}</p>
            {started && !voiceUnavailable && (
              <button onClick={() => void enableMic()} className="font-bold underline underline-offset-4">
                Try the microphone again
              </button>
            )}
          </div>
        )}
        {started && !limitReached && noisyRoom && captureMode === "auto" && micLive && (
          <div className="flex w-full max-w-2xl flex-wrap items-center justify-center gap-2 rounded-2xl border-2 border-lavender px-4 py-2 text-sm" data-testid="noisy-hint">
            <span>There&apos;s a lot of background sound. Push-to-talk works better in noisy rooms.</span>
            <button
              onClick={(e) => {
                e.currentTarget.blur();
                setCaptureMode("push");
              }}
              className="rounded-lg border-2 border-vast bg-lavender px-3 py-1 font-bold text-vast"
            >
              Use push-to-talk
            </button>
            <button onClick={() => setNoisyRoom(false)} className="text-cream/70 underline underline-offset-4">
              Dismiss
            </button>
          </div>
        )}
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
              {micLive && turnStatus !== "speaking" && captureMode === "auto" && <MicMeter levelRef={micLevel} active={accepting} />}
            </div>
            {micLive && captureMode === "push" && (
              <button
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  pushStart();
                }}
                onPointerUp={() => void pushEnd()}
                onPointerCancel={() => void pushEnd()}
                onContextMenu={(e) => e.preventDefault()}
                disabled={turnStatus === "processing"}
                className={cn(
                  "flex select-none items-center gap-2 rounded-full border-2 border-vast px-6 py-3 font-bold text-vast transition-transform disabled:opacity-50",
                  holding ? "scale-105 bg-ember" : "bg-lavender",
                )}
                style={{ touchAction: "none" }}
                data-testid="push-to-talk"
              >
                <Mic size={18} /> {holding ? "Release to send" : "Hold to talk"}
              </button>
            )}
            {micLive && (
              <button
                onClick={(e) => {
                  e.currentTarget.blur();
                  setCaptureMode(captureMode === "auto" ? "push" : "auto");
                }}
                className="text-xs text-cream/60 underline underline-offset-4"
                data-testid="capture-mode"
              >
                {captureMode === "auto" ? "Noisy room? Use push-to-talk" : "Switch to hands-free"}
              </button>
            )}
            {typing && (
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
            <button onClick={() => setTextMode((v) => !v)} className={cn("icon-btn", typing && "bg-lavender")} aria-label="Type an answer" title="Type instead">
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
            {vad.errored && (
              <p className="mt-3 text-sm text-red-700">
                Voice detection couldn&apos;t load on this device. You can still type your answers.
                {debug && <span className="block font-mono text-xs">{String(vad.errored)}</span>}
              </p>
            )}
            <button onClick={() => begin(false)} className="mt-3 w-full text-sm font-semibold underline underline-offset-4" data-testid="start-text">
              Continue without a microphone
            </button>
            <label className="mt-4 flex items-center justify-center gap-2 text-xs text-vast/70">
              <input type="checkbox" checked={allowInterrupt} onChange={(e) => setAllowInterrupt(e.target.checked)} />
              Let me interrupt by speaking (turn off if you use speakers and get cut off)
            </label>
            <label className="mt-2 flex items-center justify-center gap-2 text-xs text-vast/70">
              <input type="checkbox" checked={captureMode === "push"} onChange={(e) => setCaptureMode(e.target.checked ? "push" : "auto")} data-testid="lobby-push-to-talk" />
              Noisy room or other voices nearby: use push-to-talk (hold Space while you answer)
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
