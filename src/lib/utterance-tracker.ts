/**
 * Speculative end-of-turn transcription.
 *
 * The VAD only declares the end of an utterance after REDEMPTION_MS of silence
 * (~800 ms). Waiting for that before starting speech-to-text puts STT on the
 * critical path. This tracker mirrors the VAD's frame-processor state machine
 * (same thresholds and frame counts) and, once the candidate has been silent for
 * `speculateAfterMs`, hands the audio captured so far to `onSpeculate`. If the
 * candidate stays silent until the VAD ends the utterance, that speculative
 * transcript is used and STT latency disappears inside the silence window; if
 * they resume talking, the speculation is invalidated.
 */

export type TrackerOptions = {
  frameMs: number;
  positiveThreshold: number;
  negativeThreshold: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  minSpeechMs: number;
  speculateAfterMs: number;
  onSpeculate: (audio: Float32Array, id: number) => void;
  /** Return false to skip speculation (e.g. while the interviewer is speaking). */
  shouldSpeculate?: () => boolean;
};

function concat(frames: Float32Array[]): Float32Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

export class UtteranceTracker {
  private frames: { frame: Float32Array; isSpeech: boolean }[] = [];
  private speaking = false;
  private speechFrames = 0;
  private redemption = 0;
  private speculatedThisPause = false;
  private speculationId: number | null = null;
  private speculationValid = false;
  private nextId = 0;
  private endedSpeculation: number | null = null;
  private readonly redemptionFrames: number;
  private readonly padFrames: number;
  private readonly minSpeechFrames: number;
  private readonly speculateFrames: number;

  constructor(private readonly options: TrackerOptions) {
    // Same rounding as @ricky0123/vad-web's calculateFrameParams.
    this.redemptionFrames = Math.floor(options.redemptionMs / options.frameMs);
    this.padFrames = Math.floor(options.preSpeechPadMs / options.frameMs);
    this.minSpeechFrames = Math.floor(options.minSpeechMs / options.frameMs);
    this.speculateFrames = Math.max(1, Math.ceil(options.speculateAfterMs / options.frameMs));
  }

  /** Feed every processed frame (16 kHz) with its speech probability. */
  frame(probability: number, frame: Float32Array): void {
    const isSpeech = probability >= this.options.positiveThreshold;
    this.frames.push({ frame, isSpeech });

    if (isSpeech) {
      this.speechFrames++;
      this.redemption = 0;
      if (this.speculatedThisPause) {
        // The candidate kept talking: the speculative transcript is incomplete.
        this.speculatedThisPause = false;
        this.speculationValid = false;
      }
    }
    if (isSpeech && !this.speaking) this.speaking = true;

    if (probability < this.options.negativeThreshold && this.speaking) {
      this.redemption++;
      if (this.redemption >= this.redemptionFrames) {
        // The VAD ends the utterance on this frame (speech end or misfire).
        const enough = this.frames.filter((f) => f.isSpeech).length >= this.minSpeechFrames;
        this.endedSpeculation = enough && this.speculationValid ? this.speculationId : null;
        this.reset();
        return;
      }
      if (this.redemption >= this.speculateFrames && !this.speculatedThisPause && this.speechFrames >= this.minSpeechFrames) {
        this.speculatedThisPause = true;
        if (this.options.shouldSpeculate?.() ?? true) {
          this.speculationId = ++this.nextId;
          this.speculationValid = true;
          this.options.onSpeculate(concat(this.frames.map((f) => f.frame)), this.speculationId);
        }
      }
    }

    if (!this.speaking) {
      while (this.frames.length > this.padFrames) this.frames.shift();
      this.speechFrames = 0;
    }
  }

  /**
   * Call from the VAD's onSpeechEnd: returns the id of a speculation that covers
   * the whole utterance (no speech after it), or null.
   */
  takeEndedSpeculation(): number | null {
    const id = this.endedSpeculation;
    this.endedSpeculation = null;
    return id;
  }

  private reset(): void {
    this.frames = [];
    this.speaking = false;
    this.speechFrames = 0;
    this.redemption = 0;
    this.speculatedThisPause = false;
    this.speculationValid = false;
    this.speculationId = null;
  }
}
