"use client";

import { useEffect, useRef } from "react";
import { useMicVAD } from "@ricky0123/vad-react";
import { UtteranceTracker } from "@/lib/utterance-tracker";
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

export type VadCallbacks = {
  /**
   * A complete utterance; `endedAt` is performance.now() when the candidate actually
   * stopped talking. `speculationId` identifies a speculative transcript that covers
   * the whole utterance (see onSpeculate), or null.
   */
  onUtterance: (audio: Float32Array, endedAt: number, speculationId: number | null) => void;
  /** The candidate paused: transcribe this audio speculatively. */
  onSpeculate?: (audio: Float32Array, id: number) => void;
  /** Called for every ~32 ms audio frame with the speech probability and RMS level. */
  onFrame?: (speechProbability: number, level: number) => void;
};

function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/**
 * Browser-side voice activity detection (Silero v5 via ONNX Runtime WASM).
 * Utterances are only forwarded while `accepting` is true, so the interviewer's
 * own voice (echo) is never sent back as an answer.
 */
export function useVAD(callbacks: VadCallbacks, accepting: boolean) {
  const callbacksRef = useRef(callbacks);
  const acceptingRef = useRef(accepting);
  const trackerRef = useRef<UtteranceTracker | null>(null);

  useEffect(() => {
    trackerRef.current = new UtteranceTracker({
      frameMs: FRAME_MS,
      positiveThreshold: POSITIVE_THRESHOLD,
      negativeThreshold: NEGATIVE_THRESHOLD,
      redemptionMs: REDEMPTION_MS,
      preSpeechPadMs: PRE_SPEECH_PAD_MS,
      minSpeechMs: MIN_SPEECH_MS,
      speculateAfterMs: SPECULATE_AFTER_MS,
      shouldSpeculate: () => acceptingRef.current && !!callbacksRef.current.onSpeculate,
      onSpeculate: (audio, id) => callbacksRef.current.onSpeculate?.(audio, id),
    });
  }, []);

  useEffect(() => {
    callbacksRef.current = callbacks;
    acceptingRef.current = accepting;
  }, [callbacks, accepting]);

  return useMicVAD({
    startOnLoad: false,
    model: "v5",
    baseAssetPath: ASSET_PATH,
    onnxWASMBasePath: ASSET_PATH,
    // ~0.8 s of silence ends a turn: responsive, but natural pauses mid-answer
    // (which rarely exceed this) don't cut the candidate off.
    positiveSpeechThreshold: POSITIVE_THRESHOLD,
    negativeSpeechThreshold: NEGATIVE_THRESHOLD,
    redemptionMs: REDEMPTION_MS,
    preSpeechPadMs: PRE_SPEECH_PAD_MS,
    minSpeechMs: MIN_SPEECH_MS,
    submitUserSpeechOnPause: false,
    ortConfig(ort) {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = ASSET_PATH;
    },
    onFrameProcessed: (probabilities, frame) => {
      trackerRef.current?.frame(probabilities.isSpeech, new Float32Array(frame));
      callbacksRef.current.onFrame?.(probabilities.isSpeech, Math.min(1, rms(frame) * 6));
    },
    onSpeechEnd: (audio) => {
      // The VAD fires after REDEMPTION_MS of silence; the candidate stopped talking then.
      const endedAt = performance.now() - REDEMPTION_MS;
      const speculationId = trackerRef.current?.takeEndedSpeculation() ?? null;
      if (!acceptingRef.current) return;
      const maxSamples = MAX_UTTERANCE_SECONDS * SAMPLE_RATE;
      const clipped = audio.length > maxSamples;
      callbacksRef.current.onUtterance(clipped ? audio.slice(0, maxSamples) : audio, endedAt, clipped ? null : speculationId);
    },
  });
}
