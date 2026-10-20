"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type MutableRefObject, type ReactNode } from "react";
import { Check, Code2, Hand, Headphones, Keyboard, Loader2, Mic, MicOff, Pause, RotateCcw, Send, Volume2 } from "lucide-react";
import { CanvasPanel } from "@/components/CanvasPanel";
import { InterviewerOrb, type OrbMode } from "@/components/InterviewerOrb";
import { TranscriptPane } from "@/components/TranscriptPane";
import { useIntegrity } from "@/hooks/useIntegrity";
import { useInterview } from "@/hooks/useInterview";
import { describeMicError, useVAD, type CaptureMode, type SpeechActivity } from "@/hooks/useVAD";
import { ClientApiError, endInterview, transcribeSpeculative, type SpeculativeTranscript } from "@/lib/api";
import { cn } from "@/lib/cn";
import { LIMITS } from "@/lib/protocol";
import { classifyEndpoint, type EndpointKind } from "@/lib/endpointing";
import { encodeWav } from "@/lib/wav";
import { EchoAwareBargeIn, outputLevelToRms } from "@/lib/barge-in";
import { MicCheck } from "@/components/MicCheck";

const SECTION_LABELS: Record<string, string> = {
  opening: "Introduction",
  background: "Your background",
  technical: "Technical",
  hands_on: "Hands-on",
  behavioral: "Behavioral",
  wrap_up: "Wrap-up",
  closing: "Closing",
};

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

/** Touch-first device: copy talks about tapping and holding the button, not Space. */
const subscribeCoarse = (onChange: () => void) => {
  const query = window.matchMedia("(pointer: coarse)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const useCoarsePointer = () =>
  useSyncExternalStore(
    subscribeCoarse,
    () => window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );

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
  /** Echo model and barge-in window for this interview (remounts with the page). */
  const bargeIn = useRef(new EchoAwareBargeIn());
  /** Speculative transcripts started during the candidate's pauses, by tracker id. */
  const speculations = useRef(new Map<number, { promise: Promise<SpeculativeTranscript | null>; controller: AbortController }>());
  /** After a 429 from /transcribe, skip speculation until then (performance.now()). */
  const speculationBlockedUntil = useRef(0);
  const flashNotice = interview.flashNotice;
  const claimFloorRef = useRef<() => void>(() => undefined);
  const endpointRef = useRef<(id: number, kind: EndpointKind) => void>(() => undefined);
  const pushEndRef = useRef<() => Promise<void>>(async () => undefined);
  const markVoiceUnavailable = interview.markVoiceUnavailable;

  const integrity = useIntegrity(sessionId, started && !limitReached && !ending);
  const coarse = useCoarsePointer();
  const answerRef = useRef<HTMLTextAreaElement>(null);

  // End-interview confirmation: Escape or a click outside closes it.
  const endWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!confirmEnd || ending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmEnd(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!endWrapRef.current?.contains(event.target as Node)) setConfirmEnd(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [confirmEnd, ending]);

  const candidateHold = interview.candidateHold;
  // While Aria's reply is held for a candidate who kept talking, their speech is a continuation (see onDropped).
  const accepting = started && turnStatus === "ready" && !muted && !limitReached && !ending && !voiceUnavailable && !candidateHold;

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
  const noisyDismissedAt = useRef(-Infinity);
  const noteNoise = () => {
    const now = performance.now();
    noiseEvents.current = [...noiseEvents.current.filter((t) => now - t < 60_000), now];
    // Once dismissed, the hint stays away for a few minutes.
    if (noiseEvents.current.length >= NOISY_ROOM_EVENTS && now - noisyDismissedAt.current > 5 * 60_000) setNoisyRoom(true);
  };
  /** Attempts to answer that never reached Aria (misfires on audible sound, gate rejections). */
  const lostAttempts = useRef<number[]>([]);
  /** performance.now() of the last frame clearly above the room's noise floor. */
  const lastLoudAt = useRef(-Infinity);
  const noteLostAttempt = () => {
    const now = performance.now();
    lostAttempts.current = [...lostAttempts.current.filter((t) => now - t < 30_000), now];
    const lost = lostAttempts.current.length;
    if (lost >= 3 && now - noisyDismissedAt.current > 5 * 60_000) {
      setNoisyRoom(true);
    } else if (lost >= 2) {
      hint("unclear", "I can hear sound but not clear speech — try speaking a little closer, or hold Space / the button to talk.", 30_000);
    }
  };
  const dismissNoisy = () => {
    noisyDismissedAt.current = performance.now();
    noiseEvents.current = [];
    lostAttempts.current = [];
    setNoisyRoom(false);
  };

  /** ?debug=1: every voice decision, readable from the console as window.__vadEvents (diagnostics). */
  const logVad = (event: string, detail: Record<string, unknown> = {}) => {
    if (!debug) return;
    const w = window as unknown as { __vadEvents?: Record<string, unknown>[] };
    (w.__vadEvents ??= []).push({ t: Math.round(performance.now()), event, ...detail });
    if (w.__vadEvents.length > 500) w.__vadEvents.splice(0, 100);
  };

  const vadCallbacks = useMemo(
    () => ({
      onSpeculate: (audio: Float32Array, id: number) => {
        logVad("speculate", { id, seconds: +(audio.length / 16_000).toFixed(1) });
        if (performance.now() < speculationBlockedUntil.current) return endpointRef.current(id, "unknown");
        const controller = new AbortController();
        const promise = transcribeSpeculative(sessionId, encodeWav(audio), controller.signal).catch((error: unknown) => {
          if (error instanceof ClientApiError) {
            if (error.status === 429) speculationBlockedUntil.current = performance.now() + (error.retryAfterMs ?? 5_000);
            if (error.code === "stt_unavailable") markVoiceUnavailable();
          }
          return null; // the turn falls back to uploading the audio
        });
        speculations.current.set(id, { promise, controller });
        // Decide from what was said so far whether the candidate has finished (nothing
        // heard: end now; "…and" / "let me think": give them time to continue).
        void promise.then((result) => {
          const kind = !result ? "unknown" : result.echo || !result.text.trim() ? "complete" : classifyEndpoint(result.text);
          logVad("endpoint", { id, kind, text: result?.text ?? null });
          endpointRef.current(id, kind);
        });
      },
      onCancelSpeculation: (id: number) => {
        speculations.current.get(id)?.controller.abort();
        speculations.current.delete(id);
      },
      onUtterance: (audio: Float32Array, endedAt: number, speculationId: number | null) => {
        const transcript = speculationId !== null ? speculations.current.get(speculationId)?.promise : undefined;
        for (const [id, speculation] of speculations.current) if (id !== speculationId) speculation.controller.abort();
        speculations.current.clear();
        lostAttempts.current = []; // they got through: start counting afresh
        const wav = encodeWav(audio);
        logVad("utterance", { seconds: +(audio.length / 16_000).toFixed(1), speculationId, turnStatus });
        // Cut Aria off just as she started replying? Then the candidate was still answering.
        if (interview.amend(wav, endedAt, transcript)) return;
        void sendTurn({ audio: wav, transcript }, { inputAt: endedAt });
      },
      onRejected: (reason: "short" | "quiet") => {
        logVad("rejected", { reason, started });
        if (!started) return; // the lobby microphone check
        noteNoise();
        noteLostAttempt();
        if (reason === "quiet") hint("faint", "I can only just hear you — try moving a little closer to the mic.", 20_000);
      },
      onMisfire: () => {
        const loud = performance.now() - lastLoudAt.current < 1_500;
        logVad("misfire", { loud, turnStatus });
        // Only a sound the meter showed counts: a click or a cough shouldn't nag.
        if (!started || !loud) return;
        noteLostAttempt();
      },
      onHoldLimit: () => {
        hint("hold-limit", "Answers are limited to 2 minutes, so I've sent what you said so far.", 10_000);
        void pushEndRef.current();
      },
      onDropped: (audio: Float32Array, endedAt: number) => {
        logVad("dropped", { seconds: +(audio.length / 16_000).toFixed(1), turnStatus, started, candidateHold: interview.candidateHold, muted, limitReached });
        if (!started) return; // the lobby microphone check
        // The candidate kept talking after their answer was sent: before Aria's reply is
        // heard, it's part of the same answer.
        if (captureMode === "auto" && interview.amend(encodeWav(audio), endedAt)) return;
        if (turnStatus !== "processing") return; // while Aria speaks, talking over her is barge-in's job
        noteNoise();
        hint("busy", "Aria is still thinking — say that again once she's replied.", 10_000);
      },
      onSpeechActivity: (activity: SpeechActivity) => {
        logVad("activity", { activity, turnStatus });
        if (captureMode === "auto") interview.holdForCandidate(activity);
      },
      onFrame: (probability: number, level: number, rms: number, noiseFloor: number) => {
        micLevel.current = level;
        // ~18 dB over the room floor: the meter visibly moved for this.
        if (rms > Math.max(0.02, noiseFloor * 8)) lastLoudAt.current = performance.now();
        if (debug) {
          const w = window as unknown as { __vadProbs?: { t: number; p: number; rms: number; floor: number }[] };
          (w.__vadProbs ??= []).push({ t: performance.now(), p: probability, rms, floor: noiseFloor });
          if (w.__vadProbs.length > 3_000) w.__vadProbs.splice(0, 1_000);
        }
        // Barge-in: sustained candidate speech while the interviewer is talking (hands-free mode
        // only, and never during her goodbye: "thank you" must not cut the closing short). Echo-aware:
        // Aria's own voice reaches the mic, so a frame must clearly exceed her predicted echo.
        // Every frame feeds the echo model, so it is learned even while she is not speaking.
        const armed = allowInterrupt && captureMode === "auto" && turnStatus === "speaking" && !limitReached;
        const outputRms = outputLevelToRms(interview.getOutputLevel());
        if (bargeIn.current.push({ t: performance.now(), probability, rms, noiseFloor, outputRms }, armed)) {
          if (interview.interrupt()) claimFloorRef.current();
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hint/noteNoise only touch refs and stable setters
    [sendTurn, allowInterrupt, captureMode, turnStatus, limitReached, started, interview, sessionId, debug, flashNotice, markVoiceUnavailable],
  );
  const vad = useVAD(vadCallbacks, accepting, captureMode);
  useEffect(() => {
    claimFloorRef.current = vad.claimFloor;
    endpointRef.current = vad.endpoint;
  }, [vad.claimFloor, vad.endpoint]);
  const micAvailable = !micError && !vad.errored;
  const micLive = vad.listening && !muted && micAvailable && !voiceUnavailable;

  // Find out before the first answer whether speech recognition works on this server.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal, cache: "no-store" })
      .then((response) => response.json() as Promise<{ checks?: { stt?: string } }>)
      .then((health) => {
        if (["not_configured", "invalid_key", "model_unavailable"].includes(health.checks?.stt ?? "")) markVoiceUnavailable();
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [markVoiceUnavailable]);

  // Speech-to-text can't work on this server: stop listening (typing is shown instead).
  // Once Aria has said goodbye the microphone is released too.
  const interviewOver = limitReached && turnStatus !== "speaking";
  useEffect(() => {
    if (voiceUnavailable || interviewOver) void vad.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- vad.pause is stable
  }, [voiceUnavailable, interviewOver]);
  const typing = textMode || voiceUnavailable;

  // Empty transcripts count as background noise too.
  const noSpeechCount = interview.noSpeechCount;
  useEffect(() => {
    if (noSpeechCount > 0) noteNoise();
  }, [noSpeechCount]);

  // The first time the candidate leaves the tab, say (once) that it's noted.
  const tabSwitches = integrity.tabSwitches;
  useEffect(() => {
    if (tabSwitches === 1 && !limitReached) flashNotice("Leaving the interview tab is noted in your report.");
  }, [tabSwitches, limitReached, flashNotice]);

  // Clock
  useEffect(() => {
    if (!started) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [started]);

  // Time is up and the candidate is quiet: let Aria close the interview rather than wait forever.
  const closingRequested = useRef(false);
  const startedAt = interview.startedAt;
  useEffect(() => {
    if (!started || limitReached || ending || closingRequested.current || !session || !startedAt) return;
    const overtime = (now - startedAt) / 1000 - session.duration_minutes * 60;
    if (overtime < 5 || turnStatus !== "ready" || vad.userSpeaking || candidateHold) return;
    closingRequested.current = true;
    void sendTurn({ continue: true });
  }, [now, started, limitReached, ending, session, startedAt, turnStatus, vad.userSpeaking, candidateHold, sendTurn]);

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
    // In push mode Space still activates a control focused from the keyboard (accessibility),
    // but not one that merely kept focus after a mouse click, and never the talk button.
    const control = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      return (
        !!target?.closest("button, a, [role='button'], input, select") && target.matches(":focus-visible") && !target.closest("[data-testid='push-to-talk']")
      );
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

  // Show the canvas tab on mobile once an exercise arrives and Aria has finished
  // introducing it, never mid-sentence (derived state).
  const hasCanvas = !!canvas.task;
  const [hadCanvas, setHadCanvas] = useState(hasCanvas);
  const [canvasSwitchPending, setCanvasSwitchPending] = useState(false);
  if (hasCanvas !== hadCanvas) {
    setHadCanvas(hasCanvas);
    if (hasCanvas) setCanvasSwitchPending(true);
  }
  if (canvasSwitchPending && turnStatus !== "speaking" && turnStatus !== "processing") {
    setCanvasSwitchPending(false);
    setMobileTab("canvas");
  }

  // Lobby system check: open the microphone early and confirm speech is heard.
  const [micChecking, setMicChecking] = useState(false);
  const [micHeard, setMicHeard] = useState(false);
  if (!started && vad.userSpeaking && !micHeard) setMicHeard(true);
  const checkMic = async () => {
    setMicChecking(true);
    try {
      await vad.start();
      setMicError(null);
    } catch (error) {
      setMicError(describeMicError(error).message);
    } finally {
      setMicChecking(false);
    }
  };

  const begin = async (withMic: boolean) => {
    if (withMic && vad.listening) {
      // Already open from the microphone check.
    } else if (withMic && !vad.errored) {
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
    if (answerRef.current) answerRef.current.style.height = "";
    void sendTurn({ text });
  };

  const retry = interview.retry;

  const finish = async () => {
    setEnding(true);
    interview.stopAudio();
    // Keep an answer the candidate was still giving, and let answers in flight reach the
    // server before the interview closes, so the report includes them.
    await vad.pause({ submit: true }).catch(() => undefined);
    await pushEndRef.current().catch(() => undefined);
    await interview.settle(15_000);
    await interview.flushCanvas().catch(() => undefined);
    try {
      await endInterview(sessionId);
    } catch {
      // The report endpoint also marks the session completed; navigate regardless.
    }
    router.push(`/report/${sessionId}`);
  };

  const getOutputLevel = interview.getOutputLevel;

  // ------------------------------------------------------------------ states

  if (interview.loadState === "loading") return <FullScreenMessage title="Setting up your interview room…" />;
  if (interview.loadState === "not_found") {
    return (
      <FullScreenMessage title="Interview not found" body="This link is broken or the interview has expired. Start a fresh one in under a minute.">
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
      <FullScreenMessage
        title="This interview has ended"
        body={session.transcript.some((m) => m.role === "user") ? "Your scorecard is ready, with evidence from your own answers." : "No answers were recorded, so there’s nothing to score yet."}
      >
        {session.transcript.some((m) => m.role === "user") ? (
          <Link href={`/report/${sessionId}`} className="btn-primary">View report</Link>
        ) : (
          <Link href="/upload" className="btn-primary">Start a new interview</Link>
        )}
      </FullScreenMessage>
    );
  }

  const hasAnswers = messages.some((m) => m.role === "user" && m.content);
  const resuming = session.transcript.length > 1;
  // Never more than the interview length (the clock may have ticked before startedAt was set).
  const remaining = interview.startedAt
    ? Math.min(session.duration_minutes * 60, session.duration_minutes * 60 - (now - interview.startedAt) / 1000)
    : session.duration_minutes * 60;
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
          : turnStatus === "ready" && !limitReached && !ending
            ? "waiting"
            : "idle";

  const statusLabel = !started
    ? "Waiting to start"
    : ending
      ? "Saving your answers…"
      : candidateHold
        ? "Listening…"
        : turnStatus === "processing"
          ? "Thinking…"
          : turnStatus === "speaking"
            ? coarse && micLive && (captureMode === "push" || allowInterrupt)
              ? "Aria is speaking · tap Interrupt"
              : captureMode === "push" && micLive
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
                    : coarse
                      ? "Your turn · hold the button to answer"
                      : "Your turn · hold Space or the button to answer"
                  : userSpeaking
                    ? "Listening…"
                    : textMode
                      ? "Your turn · speak naturally or type"
                      : "Your turn · speak naturally";

  /** Whose move it is, shown by the status pill's colour and icon (not only its text). */
  const statusTone: "aria" | "you" | "busy" | "done" | "off" = !started
    ? "done"
    : ending
      ? "busy"
      : candidateHold
        ? "you"
        : turnStatus === "processing"
          ? "busy"
          : turnStatus === "speaking"
            ? "aria"
            : limitReached
              ? "done"
              : !micLive && !typing
                ? "off"
                : "you";
  const StatusIcon = { aria: Volume2, you: micLive ? Mic : Keyboard, busy: Loader2, done: Check, off: MicOff }[statusTone];

  const captureIssueText: Record<string, string> = {
    ended: "Your microphone stopped. It may have been unplugged or disconnected.",
    muted: "Your microphone is muted by the system or another app.",
    silent: "No sound from your microphone. Check it isn't muted or set to the wrong input.",
    stalled: "The microphone paused for a moment.",
  };

  const stage = (
    <section
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border-2 border-vast bg-vast p-4 text-cream",
        // Beside the canvas: the same radius and a compact header, so the transcript keeps the room.
        hasCanvas ? "md:rounded-[28px] md:p-4" : "md:rounded-[40px] md:p-6",
      )}
    >
      {/* Compact on phones (orb pinned left, beside the status) so the transcript keeps most of the screen. */}
      <div className={cn("flex items-center justify-start gap-3 pb-2 md:justify-center", !hasCanvas && "md:flex-col md:gap-2")}>
        <InterviewerOrb mode={orbMode} getOutputLevel={getOutputLevel} micLevelRef={micLevel} className={cn("w-14 shrink-0", !hasCanvas && "md:w-32")} />
        <div className={cn("flex min-w-0 flex-1 flex-col items-start gap-1 md:flex-none", !hasCanvas && "md:items-center md:gap-2")}>
          <p className="font-serif text-lg leading-none">Aria</p>
          <p
            className={cn(
              "flex max-w-full items-center gap-1.5 rounded-full border-2 px-3 py-1 text-sm font-bold transition-colors",
              !hasCanvas && "md:text-center",
              {
                aria: "border-vast bg-cream text-vast",
                you: "border-vast bg-lavender text-vast",
                busy: "border-cream/30 bg-transparent text-cream/80",
                done: "border-cream/30 bg-transparent text-cream/80",
                off: "border-ember bg-transparent text-ember",
              }[statusTone],
            )}
            aria-live="polite"
            data-testid="status"
          >
            <StatusIcon size={15} className={cn("shrink-0", statusTone === "busy" && "animate-spin")} aria-hidden />
            <span className="truncate">{statusLabel}</span>
          </p>
        </div>
      </div>

      <div className="relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden">
        <TranscriptPane messages={messages} candidateName={session.candidate_name} compact={hasCanvas} />
      </div>

      <footer className="z-10 flex flex-col items-center gap-2 pt-2">
        {/* One message at a time, most important first, so banners never pile up and push the transcript around. */}
        {error ? (
          <div role="alert" className="flex w-full max-w-2xl items-center justify-between gap-3 rounded-2xl border-2 border-vast bg-ember px-4 py-3 text-vast">
            <span className="font-medium">{error.message}</span>
            {error.retryable && (
              <button onClick={retry} className="flex shrink-0 items-center gap-1 rounded-lg border-2 border-vast bg-cream px-3 py-1 font-bold">
                <RotateCcw size={16} /> Retry
              </button>
            )}
          </div>
        ) : started && !limitReached && micLive && vad.captureIssue ? (
          <div role="alert" className="flex w-full max-w-2xl items-center justify-between gap-3 rounded-2xl border-2 border-vast bg-ember px-4 py-2 text-sm text-vast">
            <span className="font-medium">{captureIssueText[vad.captureIssue]}</span>
            <button
              onClick={() => void (vad.captureIssue === "ended" ? enableMic() : vad.restart())}
              className="flex shrink-0 items-center gap-1 rounded-lg border-2 border-vast bg-cream px-3 py-1 font-bold"
            >
              <RotateCcw size={14} /> Restart microphone
            </button>
          </div>
        ) : micError && started ? (
          <div className="flex max-w-2xl flex-col items-center gap-1 text-center text-sm text-ember" data-testid="mic-error">
            <p>{micError}</p>
            {!voiceUnavailable && (
              <button onClick={() => void enableMic()} className="font-bold underline underline-offset-4">
                Try the microphone again
              </button>
            )}
          </div>
        ) : started && !limitReached && voiceUnavailable ? (
          <p role="alert" className="max-w-2xl text-center text-sm font-medium text-ember" data-testid="voice-unavailable">
            Voice answers aren&apos;t available right now: speech recognition isn&apos;t working on this server. Please type your answers.
          </p>
        ) : started && !limitReached && noisyRoom && captureMode === "auto" && micLive ? (
          <div className="flex w-full max-w-2xl flex-wrap items-center justify-center gap-2 rounded-2xl border-2 border-lavender px-4 py-2 text-sm" data-testid="noisy-hint">
            <span>It&apos;s noisy where you are. Push-to-talk will keep stray sounds out of your answers.</span>
            <button
              onClick={(e) => {
                e.currentTarget.blur();
                setCaptureMode("push");
              }}
              className="rounded-lg border-2 border-vast bg-lavender px-3 py-1 font-bold text-vast"
            >
              Use push-to-talk
            </button>
            <button onClick={dismissNoisy} className="text-cream/70 underline underline-offset-4">
              Dismiss
            </button>
          </div>
        ) : null}
        {/* Short-lived notices float above the controls instead of resizing the layout. */}
        <div className="pointer-events-none relative h-0 w-full" aria-live="polite">
          {notice && (
            <p className="absolute bottom-1 left-1/2 w-max max-w-[90%] -translate-x-1/2 rounded-full bg-vast/90 px-4 py-1.5 text-center text-sm font-medium text-lavender shadow-lg" data-testid="notice">
              {notice}
            </p>
          )}
        </div>

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
              {micLive && !typing && turnStatus !== "speaking" && captureMode === "auto" && <MicMeter levelRef={micLevel} active={accepting} />}
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
            {micLive && (turnStatus === "ready" || captureMode === "push") && (
              <button
                onClick={(e) => {
                  e.currentTarget.blur();
                  setCaptureMode(captureMode === "auto" ? "push" : "auto");
                }}
                className={cn("text-xs text-cream/60 underline underline-offset-4", typing && "hidden sm:inline")}
                data-testid="capture-mode"
              >
                {captureMode === "auto" ? "Noisy room? Use push-to-talk" : "Switch to hands-free"}
              </button>
            )}
            {typing && (
              <form onSubmit={submitText} className="flex w-full max-w-2xl gap-2">
                <label htmlFor="answer" className="sr-only">Type your answer</label>
                <textarea
                  ref={answerRef}
                  id="answer"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    // Grow with the answer where field-sizing isn't supported.
                    const t = e.currentTarget;
                    t.style.height = "auto";
                    t.style.height = `${t.scrollHeight}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) submitText(e);
                  }}
                  onPaste={(e) => {
                    const length = e.clipboardData.getData("text").length;
                    if (length >= 200) integrity.reportLargePaste(length);
                  }}
                  maxLength={LIMITS.answerChars}
                  rows={2}
                  placeholder={turnStatus === "processing" ? "Aria is thinking it over…" : "Type your answer and press Enter…"}
                  className="max-h-40 min-h-[3.25rem] flex-1 resize-none overflow-y-auto rounded-2xl border-2 border-vast bg-cream px-4 py-3 text-vast outline-none [field-sizing:content] focus:bg-white"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || turnStatus === "processing"}
                  className="h-[3.25rem] self-end rounded-2xl border-2 border-vast bg-lavender px-4 text-vast transition-transform hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0"
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
      <header className="flex flex-nowrap items-center justify-between gap-2 rounded-[22px] border-2 border-vast bg-cream px-3 py-2 sm:px-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-serif text-xl md:text-2xl">{session.target_role}</h1>
          <p className="truncate text-xs text-vast/60 sm:hidden">
            {sectionLabel} · Q{Math.max(questionNumber, 1)}
          </p>
          <p className="hidden truncate text-xs text-vast/60 sm:block">
            {session.interview_type[0].toUpperCase() + session.interview_type.slice(1)} interview · {session.level} level · Question {Math.max(questionNumber, 1)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
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
          {started && micAvailable && !limitReached && (
            <button
              onClick={toggleMute}
              className={cn("icon-btn", muted && "bg-ember hover:bg-ember")}
              aria-pressed={muted}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          )}
          {started && !limitReached && (
            <button
              onClick={() => setTextMode((v) => !v)}
              className={cn("icon-btn", typing && "bg-lavender hover:bg-lavender")}
              aria-pressed={typing}
              aria-label="Type an answer"
              title={typing ? "Back to voice" : "Type instead"}
            >
              <Keyboard size={18} />
            </button>
          )}
          {!limitReached && (
            <div ref={endWrapRef} className="relative">
              <button
                onClick={() => setConfirmEnd((v) => !v)}
                className="rounded-xl border-2 border-vast bg-vast px-3 py-2 text-sm font-bold text-cream"
                aria-label="End interview"
                aria-haspopup="dialog"
                aria-expanded={confirmEnd}
              >
                <span className="sm:hidden">End</span>
                <span className="hidden sm:inline">End interview</span>
              </button>
              {confirmEnd && (
                <div
                  role="alertdialog"
                  aria-labelledby="end-title"
                  aria-describedby="end-body"
                  className="fixed inset-x-4 bottom-4 z-30 rounded-[32px] border-2 border-vast bg-cream p-5 text-vast shadow-xl md:absolute md:inset-x-auto md:bottom-auto md:right-0 md:top-full md:mt-2 md:w-[22rem]"
                >
                  <h2 id="end-title" className="font-serif text-xl">End the interview?</h2>
                  <p id="end-body" className="mt-1 text-sm text-vast/75">
                    {hasAnswers
                      ? `${remaining >= 1 ? `You still have ${formatClock(Math.round(remaining))} left. ` : ""}Aria will wrap up and build your scorecard from your answers${hasCanvas ? " and canvas" : ""}. You can't resume afterwards.`
                      : "You haven't answered anything yet, so there won't be a scorecard."}
                  </p>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      onClick={() => setConfirmEnd(false)}
                      disabled={ending}
                      autoFocus
                      className="rounded-xl border-2 border-vast bg-cream px-3 py-2 text-sm font-bold disabled:opacity-50"
                    >
                      Keep interviewing
                    </button>
                    <button onClick={finish} disabled={ending} className="rounded-xl border-2 border-vast bg-ember px-3 py-2 text-sm font-bold">
                      {ending ? "Saving…" : hasAnswers ? "End & get report" : "End anyway"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Mobile tab switcher when a canvas is open; on the canvas tab the status stays visible. */}
      {hasCanvas && (
        <div className="flex flex-col gap-1 md:hidden">
          <div className="flex gap-2">
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
          {mobileTab === "canvas" && started && (
            <div className="flex items-center justify-between gap-2 rounded-xl border-2 border-vast bg-vast px-3 py-1.5 text-sm text-cream">
              <span className="truncate font-bold">{statusLabel}</span>
              {turnStatus === "speaking" ? (
                <button onClick={() => interview.interrupt()} className="shrink-0 rounded-full border-2 border-vast bg-cream px-3 py-0.5 text-xs font-bold text-vast">
                  Interrupt
                </button>
              ) : (
                <button onClick={() => setMobileTab("interview")} className="shrink-0 text-xs underline underline-offset-4">
                  Transcript
                </button>
              )}
            </div>
          )}
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
        <div className="fixed inset-0 z-20 overflow-y-auto bg-vast/70 p-4 backdrop-blur-sm">
          <div className="flex min-h-full items-center justify-center">
            <div className="w-full max-w-md rounded-[32px] border-2 border-vast bg-cream p-6 text-vast sm:p-8">
              {!resuming && <p className="mb-1 text-xs font-bold uppercase tracking-widest text-forest">Step 3 of 3 · Mic check</p>}
              <h2 className="mb-2 font-serif text-2xl sm:text-3xl">{resuming ? "Welcome back" : `Ready, ${session.candidate_name.split(" ")[0]}?`}</h2>
              <p className="mb-5 text-vast/75">
                {resuming
                  ? "Pick up mid-conversation. Aria remembers everything you’ve said so far."
                  : `A ${session.duration_minutes}-minute ${session.interview_type} interview for ${session.target_role}. Aria opens; answer out loud, just like the real thing.`}
              </p>
              <ul className="mb-5 space-y-2 text-sm">
                <li className="flex items-start gap-2.5">
                  <Headphones size={16} className="mt-0.5 shrink-0 text-forest" aria-hidden />
                  <span>Headphones keep Aria from hearing herself (no echo).</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Pause size={16} className="mt-0.5 shrink-0 text-forest" aria-hidden />
                  <span>Think out loud. A pause to collect yourself won&apos;t cut you off.</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Hand size={16} className="mt-0.5 shrink-0 text-forest" aria-hidden />
                  <span>{coarse ? "Talk over Aria (or tap Interrupt) to stop her." : "Talk over Aria (or press Space) to interrupt."}</span>
                </li>
                {session.canvas_enabled && (
                  <li className="flex items-start gap-2.5">
                    <Code2 size={16} className="mt-0.5 shrink-0 text-forest" aria-hidden />
                    <span>Later, a canvas opens for a hands-on exercise.</span>
                  </li>
                )}
              </ul>
              {voiceUnavailable ? (
                <p className="mb-4 rounded-2xl border-2 border-vast bg-ember/30 px-3 py-2 text-sm" data-testid="voice-unavailable-lobby">
                  Voice answers aren&apos;t available on this server right now, so you&apos;ll type your answers.
                </p>
              ) : (
                !vad.errored && (
                  <MicCheck
                    listening={vad.listening}
                    heard={micHeard}
                    levelRef={micLevel}
                    deviceId={vad.deviceId}
                    onSelectDevice={vad.selectDevice}
                    onCheck={() => void checkMic()}
                    checking={micChecking}
                    disabled={vad.loading}
                  />
                )
              )}
              {!started && micError && <p className="mb-3 text-sm text-red-700" data-testid="lobby-mic-error">{micError}</p>}
              <fieldset className="mb-4 space-y-2 rounded-2xl border-2 border-vast/15 p-3">
                <legend className="px-1 text-xs font-bold uppercase tracking-wider text-vast/60">Audio settings</legend>
                <label className="flex items-start gap-2 text-sm text-vast/80">
                  <input
                    type="checkbox"
                    checked={allowInterrupt}
                    onChange={(e) => setAllowInterrupt(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-forest"
                  />
                  <span>
                    Interrupt Aria by speaking
                    <span className="block text-xs text-vast/60">Turn off if you’re on speakers and Aria keeps cutting you off</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm text-vast/80">
                  <input
                    type="checkbox"
                    checked={captureMode === "push"}
                    onChange={(e) => setCaptureMode(e.target.checked ? "push" : "auto")}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-forest"
                    data-testid="lobby-push-to-talk"
                  />
                  <span>
                    Push-to-talk
                    <span className="block text-xs text-vast/60">
                      {coarse ? "For noisy rooms: hold the button while you answer" : "For noisy rooms: hold Space or the button while you answer"}
                    </span>
                  </span>
                </label>
              </fieldset>
              <button onClick={() => begin(true)} disabled={vad.loading && !vad.errored} className="btn-primary w-full disabled:opacity-60" data-testid="start">
                {vad.loading && !vad.errored ? "Warming up the microphone…" : resuming ? "Resume interview" : "Start interview"}
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
            </div>
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
    <div className={cn("flex h-8 items-center gap-1.5 rounded-full border-2 border-vast bg-cream px-3", !active && "opacity-50")} aria-label="Microphone level">
      <Mic size={14} className="text-vast" aria-hidden />
      <span className="text-xs font-bold text-vast">Mic on</span>
      <div className="flex h-4 items-end gap-0.5" aria-hidden>
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
    <Suspense fallback={<FullScreenMessage title="Setting up your interview room…" />}>
      <InterviewRoom />
    </Suspense>
  );
}
