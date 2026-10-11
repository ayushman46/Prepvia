"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MicVAD, type RealTimeVADOptions } from "@ricky0123/vad-web";
import { rms, UtteranceTracker, type GateOptions } from "@/lib/utterance-tracker";
import { MAX_UTTERANCE_SECONDS } from "@/lib/wav";

const ASSET_PATH = process.env.NEXT_PUBLIC_VAD_ASSET_PATH || "/vad/";
const SAMPLE_RATE = 16_000;
/** Silence required before a turn ends. Exported so latency can be measured from the real end of speech. */
export const REDEMPTION_MS = 800;
const POSITIVE_THRESHOLD = 0.5;
const NEGATIVE_THRESHOLD = 0.35;
const PRE_SPEECH_PAD_MS = 300;
const MIN_SPEECH_MS = 250;
/** Silero v5 processes 512-sample frames at 16 kHz. */
const FRAME_MS = 32;
/** Start speculative STT after this much silence: late enough to skip most mid-sentence pauses (saving STT quota), early enough that the rest of the 800 ms window hides STT latency. */
export const SPECULATE_AFTER_MS = 350;
/**
 * Background-noise gate: an answer needs at least 256 ms of confident speech (with
 * 128 ms unbroken) that is 9 dB above the room's noise floor. Close-talk speech
 * clears this easily; clicks, coughs and distant voices don't.
 */
const GATE: GateOptions = { confidentThreshold: 0.8, minConfidentFrames: 8, minConfidentRun: 4, minSnrDb: 9, minSpeechRms: 0.006 };
const MAX_SPECULATIONS_PER_MINUTE = 8;
/** Push-to-talk keeps this much audio from just before the button was pressed, and after release. */
const HOLD_PREROLL_FRAMES = 10; // 320 ms
const HOLD_TAIL_FRAMES = 8; // 256 ms
/** A hold shorter than this (between press and release) is a tap, not an answer. */
const HOLD_MIN_FRAMES = 13; // ~0.4 s
/** Same cap as hands-free answers, so a long hold never exceeds the upload limit. */
const MAX_HOLD_SAMPLES = MAX_UTTERANCE_SECONDS * SAMPLE_RATE;
/** No frames for this long while listening means capture stalled. */
const STALL_MS = 2_500;
/** Exact digital silence for this long means a muted, dead or virtual input. */
const SILENT_FRAMES = 75; // 2.4 s

export type CaptureMode = "auto" | "push";
/** Something is wrong with the microphone signal while listening. */
export type CaptureIssue = "ended" | "muted" | "silent" | "stalled" | null;

export type VadCallbacks = {
  /**
   * A complete utterance; `endedAt` is performance.now() when the candidate actually
   * stopped talking. `speculationId` identifies a speculative transcript that covers
   * the whole utterance (see onSpeculate), or null.
   */
  onUtterance: (audio: Float32Array, endedAt: number, speculationId: number | null) => void;
  /** The candidate paused: transcribe this audio speculatively. */
  onSpeculate?: (audio: Float32Array, id: number) => void;
  /** A speculation will not be used (speech resumed, rejected, or capture paused): cancel it. */
  onCancelSpeculation?: (id: number) => void;
  /** Called for every ~32 ms audio frame with the speech probability, meter level (0-1) and raw RMS. */
  onFrame?: (speechProbability: number, level: number, rms: number, noiseFloor: number) => void;
  /** An utterance was ignored as background noise ("quiet": speech-like but too faint). */
  onRejected?: (reason: "short" | "quiet") => void;
  /** A real-sounding utterance ended while the candidate didn't have the floor. */
  onDropped?: () => void;
  /** A push-to-talk hold reached the maximum answer length. */
  onHoldLimit?: () => void;
};

type Hold = {
  frames: Float32Array[];
  samples: number;
  /** Frames captured between press and release (excludes pre-roll and tail). */
  heldFrames: number;
  /** Frames still to record after release, or null while held. */
  tail: number | null;
  resolve: ((audio: Float32Array | null) => void) | null;
  limitReported: boolean;
};

/** A microphone failure with a message telling the candidate what to do. */
export class MicError extends Error {
  constructor(
    public readonly kind: "denied" | "system_denied" | "not_found" | "busy" | "insecure" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "MicError";
  }
}

/** Explain a getUserMedia/VAD start failure in terms of what to do about it. */
export function describeMicError(error: unknown): MicError {
  if (error instanceof MicError) return error;
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    if (/system/i.test(message)) {
      return new MicError(
        "system_denied",
        "Your computer is blocking the microphone for this browser. Allow it in System Settings › Privacy & Security › Microphone, restart the browser, then try again.",
      );
    }
    return new MicError("denied", "Microphone permission was denied. Allow the microphone in your browser's site settings (the icon next to the address bar), then try again.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return new MicError("not_found", "No microphone was found. Connect one and try again, or continue by typing.");
  }
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") {
    return new MicError("busy", "Your microphone is busy or failed to start. Close other apps using it (Zoom, Teams, another tab), then try again.");
  }
  return new MicError("unknown", `Voice input couldn't start${name ? ` (${name})` : ""}. You can continue by typing.`);
}

const CONSTRAINTS: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true };

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/** Destroy a MicVAD whether or not it ever started (destroy() throws for never-started instances). */
async function safeDestroy(vad: MicVAD): Promise<void> {
  try {
    await vad.destroy();
  } catch {
    const internals = vad as unknown as {
      model?: { release?: () => Promise<void> };
      _stream?: MediaStream | null;
      _audioContext?: AudioContext | null;
      ownsAudioContext?: boolean;
    };
    internals._stream?.getTracks().forEach((track) => track.stop());
    if (internals.ownsAudioContext && internals._audioContext?.state !== "closed") await internals._audioContext?.close().catch(() => undefined);
    await internals.model?.release?.().catch(() => undefined);
  }
}

/**
 * Browser-side voice capture: Silero v5 voice activity detection (ONNX Runtime
 * WASM) plus a background-noise gate, or push-to-talk. Utterances are only
 * forwarded while `accepting` is true, so the interviewer's own voice (echo) is
 * never sent back as an answer.
 *
 * MicVAD is driven directly (not through vad-react) so that React StrictMode's
 * double mount, failed starts, and devices that change mid-interview are handled.
 */
export function useVAD(callbacks: VadCallbacks, accepting: boolean, mode: CaptureMode = "auto") {
  const callbacksRef = useRef(callbacks);
  const acceptingRef = useRef(accepting);
  const modeRef = useRef(mode);
  const vadRef = useRef<MicVAD | null>(null);
  const brokenRef = useRef(false);
  const disposedRef = useRef(false);
  /** start/pause/restart run one at a time: MicVAD is not safe to drive concurrently. */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const restartPendingRef = useRef<Promise<void> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const listeningRef = useRef(false);
  const lastFrameAtRef = useRef(0);
  const silentFramesRef = useRef(0);
  const prerollRef = useRef<Float32Array[]>([]);
  const holdRef = useRef<Hold | null>(null);
  const speakingRef = useRef(false);
  const restartRef = useRef<() => Promise<void>>(async () => undefined);
  /** A barge-in handed the floor over; re-credit the utterance once `accepting` catches up. */
  const claimRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState<string | false>(false);
  const [listening, setListening] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [captureIssue, setCaptureIssue] = useState<CaptureIssue>(null);

  useEffect(() => {
    callbacksRef.current = callbacks;
    acceptingRef.current = accepting;
    modeRef.current = mode;
    if (accepting && claimRef.current) {
      claimRef.current = false;
      trackerRef.current?.claimFloor();
    }
  }, [callbacks, accepting, mode]);

  // One tracker for the hook's lifetime (its callbacks read the latest props through
  // refs). Created after mount: frames only flow once the candidate presses Start.
  const trackerRef = useRef<UtteranceTracker | null>(null);
  useEffect(() => {
    trackerRef.current ??= new UtteranceTracker({
      frameMs: FRAME_MS,
      positiveThreshold: POSITIVE_THRESHOLD,
      negativeThreshold: NEGATIVE_THRESHOLD,
      redemptionMs: REDEMPTION_MS,
      preSpeechPadMs: PRE_SPEECH_PAD_MS,
      minSpeechMs: MIN_SPEECH_MS,
      speculateAfterMs: SPECULATE_AFTER_MS,
      gate: GATE,
      maxSpeculationsPerMinute: MAX_SPECULATIONS_PER_MINUTE,
      isAccepting: () => acceptingRef.current,
      shouldSpeculate: () => acceptingRef.current && modeRef.current === "auto" && !!callbacksRef.current.onSpeculate,
      onSpeculate: (audio, id) => callbacksRef.current.onSpeculate?.(audio, id),
      onCancelSpeculation: (id) => callbacksRef.current.onCancelSpeculation?.(id),
    });
  }, []);

  /** Serialize an operation on the MicVAD after any operation already in flight. */
  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(operation, operation);
    queueRef.current = run.catch(() => undefined);
    return run;
  }, []);

  const finishHold = useCallback((hold: Hold) => {
    if (holdRef.current === hold) holdRef.current = null;
    hold.resolve?.(hold.heldFrames >= HOLD_MIN_FRAMES ? concat(hold.frames) : null);
    hold.resolve = null;
  }, []);

  const handleFrame = useCallback(
    (probability: number, raw: Float32Array) => {
      const frame = new Float32Array(raw);
      const level = rms(frame);
      lastFrameAtRef.current = performance.now();
      silentFramesRef.current = level < 1e-6 ? silentFramesRef.current + 1 : 0;
      if (silentFramesRef.current === SILENT_FRAMES) setCaptureIssue((issue) => issue ?? "silent");
      else if (silentFramesRef.current === 0) setCaptureIssue((issue) => (issue === "silent" || issue === "stalled" ? null : issue));

      prerollRef.current.push(frame);
      if (prerollRef.current.length > HOLD_PREROLL_FRAMES) prerollRef.current.shift();
      const hold = holdRef.current;
      if (hold) {
        if (hold.samples < MAX_HOLD_SAMPLES) {
          hold.frames.push(frame);
          hold.samples += frame.length;
          if (hold.tail === null) hold.heldFrames++;
        }
        if (hold.tail === null && hold.samples >= MAX_HOLD_SAMPLES && !hold.limitReported) {
          hold.limitReported = true;
          callbacksRef.current.onHoldLimit?.();
        }
        if (hold.tail !== null && --hold.tail <= 0) finishHold(hold);
      }

      const tracker = trackerRef.current;
      if (!tracker) return;
      tracker.frame(probability, frame, level);
      const speaking = probability > 0.6;
      if (speaking !== speakingRef.current) {
        speakingRef.current = speaking;
        setUserSpeaking(speaking);
      }
      callbacksRef.current.onFrame?.(probability, Math.min(1, level * 6), level, tracker.noiseFloorRms);
    },
    [finishHold],
  );

  const handleSpeechEnd = useCallback((audio: Float32Array) => {
    // The VAD fires after REDEMPTION_MS of silence; the candidate stopped talking then.
    const endedAt = performance.now() - REDEMPTION_MS;
    const verdict = trackerRef.current?.takeEnded() ?? null;
    claimRef.current = false;
    const discard = () => {
      if (verdict?.speculationId != null) callbacksRef.current.onCancelSpeculation?.(verdict.speculationId);
    };
    if (modeRef.current === "push") return discard(); // push-to-talk: the button decides
    // The tracker mirrors the VAD frame for frame; if they ever disagree, fail open.
    const matched = verdict !== null && verdict.samples === audio.length;
    if (!acceptingRef.current) {
      discard();
      // Real-sounding speech while Aria was thinking: tell the candidate it wasn't heard.
      if (!matched || verdict.heard) callbacksRef.current.onDropped?.();
      return;
    }
    if (matched && !verdict.accepted) {
      discard();
      callbacksRef.current.onRejected?.(verdict.reason === "ok" ? "short" : verdict.reason);
      return;
    }
    const maxSamples = MAX_UTTERANCE_SECONDS * SAMPLE_RATE;
    const clipped = audio.length > maxSamples;
    const speculationId = matched && !clipped ? verdict.speculationId : null;
    if (speculationId === null) discard();
    callbacksRef.current.onUtterance(clipped ? audio.slice(0, maxSamples) : audio, endedAt, speculationId);
  }, []);

  const acquireStream = useCallback(async (): Promise<MediaStream> => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS });
    // Never leave an earlier capture running (e.g. overlapping restarts).
    const previous = streamRef.current;
    if (previous && previous !== stream) previous.getTracks().forEach((track) => track.stop());
    streamRef.current = stream;
    const track = stream.getAudioTracks()[0];
    if (track) {
      // "ended" fires when the device disappears or permission is revoked (not on our own stop()).
      track.addEventListener("ended", () => {
        if (streamRef.current === stream) void restartRef.current();
      });
      track.addEventListener("mute", () => streamRef.current === stream && setCaptureIssue("muted"));
      track.addEventListener("unmute", () => streamRef.current === stream && setCaptureIssue(null));
    }
    return stream;
  }, []);

  const releaseStream = useCallback(async (stream: MediaStream) => {
    stream.getTracks().forEach((track) => track.stop());
    if (streamRef.current === stream) streamRef.current = null;
  }, []);

  const create = useCallback(
    () =>
      MicVAD.new({
        model: "v5",
        baseAssetPath: ASSET_PATH,
        onnxWASMBasePath: ASSET_PATH,
        startOnLoad: false,
        // ~0.8 s of silence ends a turn: responsive, but natural pauses mid-answer
        // (which rarely exceed this) don't cut the candidate off.
        positiveSpeechThreshold: POSITIVE_THRESHOLD,
        negativeSpeechThreshold: NEGATIVE_THRESHOLD,
        redemptionMs: REDEMPTION_MS,
        preSpeechPadMs: PRE_SPEECH_PAD_MS,
        minSpeechMs: MIN_SPEECH_MS,
        submitUserSpeechOnPause: false,
        getStream: acquireStream,
        resumeStream: acquireStream,
        pauseStream: releaseStream,
        ortConfig(ort) {
          ort.env.logLevel = "error";
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.wasmPaths = ASSET_PATH;
        },
        onFrameProcessed: (probabilities, frame) => handleFrame(probabilities.isSpeech, frame),
        onSpeechEnd: handleSpeechEnd,
      } satisfies Partial<RealTimeVADOptions>),
    [acquireStream, releaseStream, handleFrame, handleSpeechEnd],
  );

  // Load the model once. Under React StrictMode the effect runs twice; the first
  // instance is destroyed safely instead of poisoning the shared state.
  useEffect(() => {
    disposedRef.current = false;
    let disposed = false;
    let instance: MicVAD | null = null;
    create().then(
      (vad) => {
        if (disposed) {
          void safeDestroy(vad);
          return;
        }
        instance = vad;
        vadRef.current = vad;
        setErrored(false);
        setLoading(false);
      },
      (error: unknown) => {
        if (disposed) return;
        console.error("[voice] voice detection failed to load", error);
        setErrored(error instanceof Error ? error.message : String(error));
        setLoading(false);
      },
    );
    return () => {
      disposed = true;
      disposedRef.current = true;
      listeningRef.current = false;
      // Destroy whatever is current (start() may have replaced the loaded instance).
      const current = vadRef.current;
      vadRef.current = null;
      if (current) void safeDestroy(current);
      if (instance && instance !== current) void safeDestroy(instance);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [create]);

  const start = useCallback(
    () =>
      enqueue(async () => {
        if (typeof window !== "undefined" && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
          throw new MicError("insecure", "Voice input needs a secure (https://) connection. Open the https:// address, or continue by typing.");
        }
        let vad = vadRef.current;
        if (!vad) throw new MicError("unknown", "Voice detection is still loading. Please try again in a moment.");
        if (vad.listening && !brokenRef.current) return;
        if (brokenRef.current) {
          // A MicVAD whose start failed stays errored: replace it.
          void safeDestroy(vad);
          vad = await create();
          if (disposedRef.current) {
            void safeDestroy(vad);
            return;
          }
          vadRef.current = vad;
          brokenRef.current = false;
        }
        const streamBefore = streamRef.current;
        try {
          await vad.start();
          if (vad.errored) throw new Error(vad.errored);
        } catch (error) {
          brokenRef.current = true;
          const acquired = streamRef.current !== null && streamRef.current !== streamBefore;
          streamRef.current?.getTracks().forEach((track) => track.stop());
          // getUserMedia worked, so the failure is the browser's audio stack, not permission.
          if (acquired) {
            console.error("[voice] audio setup failed after the microphone opened", error);
            throw new MicError("unknown", "Voice input couldn't start in this browser. Try reloading, another browser, or continue by typing.");
          }
          throw describeMicError(error);
        }
        if (disposedRef.current) return;
        trackerRef.current?.reset();
        lastFrameAtRef.current = performance.now();
        silentFramesRef.current = 0;
        listeningRef.current = true;
        setListening(true);
        setCaptureIssue(null);
      }),
    [create, enqueue],
  );

  const pause = useCallback(
    () =>
      enqueue(async () => {
        listeningRef.current = false;
        setListening(false);
        trackerRef.current?.reset();
        const hold = holdRef.current;
        if (hold) {
          holdRef.current = null;
          hold.resolve?.(null);
        }
        await vadRef.current?.pause().catch(() => undefined);
      }),
    [enqueue],
  );

  /** Re-open the microphone (new default device, revoked or dead track). Coalesces overlapping calls. */
  const restart = useCallback((): Promise<void> => {
    if (restartPendingRef.current) return restartPendingRef.current;
    const run = enqueue(async () => {
      if (!listeningRef.current || !vadRef.current) return;
      try {
        await vadRef.current.pause().catch(() => undefined);
        trackerRef.current?.reset();
        if (!listeningRef.current) return; // paused (muted, finished) meanwhile
        await vadRef.current.start();
        if (!listeningRef.current) await vadRef.current.pause().catch(() => undefined);
        lastFrameAtRef.current = performance.now();
        silentFramesRef.current = 0;
        speakingRef.current = false;
        setUserSpeaking(false);
        setCaptureIssue(null);
      } catch (error) {
        console.error("[voice] microphone restart failed", error);
        brokenRef.current = true;
        setCaptureIssue("ended");
      }
    }).finally(() => {
      restartPendingRef.current = null;
    });
    restartPendingRef.current = run;
    return run;
  }, [enqueue]);
  useEffect(() => {
    restartRef.current = restart;
  }, [restart]);

  // Devices plugged in or removed mid-interview (headsets, AirPods): follow them.
  useEffect(() => {
    if (!listening || typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const track = streamRef.current?.getAudioTracks()[0];
        if (!track) return; // a restart is already re-acquiring the microphone
        if (track.readyState === "ended") return void restartRef.current();
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        const inputs = devices.filter((d) => d.kind === "audioinput");
        const settings = track.getSettings();
        const gone = settings.deviceId !== undefined && settings.deviceId !== "default" && !inputs.some((d) => d.deviceId === settings.deviceId);
        const defaultMoved = settings.deviceId === "default" && inputs.some((d) => d.deviceId === "default" && d.groupId !== settings.groupId);
        if (gone || defaultMoved) void restartRef.current();
      }, 600);
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => {
      if (timer) clearTimeout(timer);
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
    };
  }, [listening]);

  // Watchdog: frames stop arriving if the audio context is suspended or capture dies.
  useEffect(() => {
    if (!listening) return;
    const resume = () => {
      const context = (vadRef.current as unknown as { _audioContext?: AudioContext | null } | null)?._audioContext;
      if (context && context.state !== "running" && context.state !== "closed") void context.resume().catch(() => undefined);
    };
    const timer = setInterval(() => {
      if (!listeningRef.current || performance.now() - lastFrameAtRef.current < STALL_MS) return;
      resume();
      setCaptureIssue((issue) => issue ?? "stalled");
    }, 1_000);
    const onVisible = () => document.visibilityState === "visible" && resume();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [listening]);

  /**
   * Push-to-talk: start recording (including ~320 ms from just before the press).
   * Returns false if capture isn't running. A press during the previous hold's
   * tail finishes that hold immediately and starts a new one.
   */
  const beginHold = useCallback((): boolean => {
    if (!listeningRef.current) return false;
    const previous = holdRef.current;
    if (previous) {
      if (previous.tail === null) return true; // already holding
      finishHold(previous);
    }
    trackerRef.current?.cancelPendingSpeculation();
    holdRef.current = { frames: [...prerollRef.current], samples: 0, heldFrames: 0, tail: null, resolve: null, limitReported: false };
    holdRef.current.samples = holdRef.current.frames.reduce((n, f) => n + f.length, 0);
    return true;
  }, [finishHold]);

  /** Push-to-talk: stop recording after a short tail; resolves with the audio (null if too short). */
  const endHold = useCallback((): Promise<Float32Array | null> => {
    const hold = holdRef.current;
    if (!hold || hold.tail !== null) return Promise.resolve(null);
    return new Promise((resolve) => {
      hold.resolve = resolve;
      hold.tail = HOLD_TAIL_FRAMES;
      // If frames stop (capture paused), don't wait forever.
      setTimeout(() => {
        if (hold.resolve) finishHold(hold);
      }, HOLD_TAIL_FRAMES * FRAME_MS + 400);
    });
  }, [finishHold]);

  /** Barge-in: the candidate took the floor mid-utterance; count what they already said. */
  const claimFloor = useCallback(() => {
    claimRef.current = true;
    trackerRef.current?.claimFloor();
  }, []);

  return { loading, errored, listening, userSpeaking, captureIssue, start, pause, restart, beginHold, endHold, claimFloor };
}
