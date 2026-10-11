/**
 * Speculative end-of-turn transcription and a background-noise gate.
 *
 * The VAD only declares the end of an utterance after REDEMPTION_MS of silence
 * (~800 ms). Waiting for that before starting speech-to-text puts STT on the
 * critical path. This tracker mirrors the VAD's frame-processor state machine
 * (same thresholds and frame counts) and, once the candidate has been silent for
 * `speculateAfterMs`, hands the audio captured so far to `onSpeculate`. If the
 * candidate stays silent until the VAD ends the utterance, that speculative
 * transcript is used and STT latency disappears inside the silence window; if
 * they resume talking, the speculation is invalidated.
 *
 * With `gate` set, an utterance is only accepted when it contains enough
 * confident speech (including an unbroken run, so clicks and coughs fail) that
 * is clearly louder than the room's adaptive noise floor (so distant murmur
 * fails). Only accepted utterances are speculated on.
 */

export type GateOptions = {
  /** Speech probability that counts as confident speech. */
  confidentThreshold: number;
  /** Confident, loud frames required in the utterance. */
  minConfidentFrames: number;
  /** Of which at least this many consecutive. */
  minConfidentRun: number;
  /** How far above the noise floor a frame must be to count as loud. */
  minSnrDb: number;
  /** Absolute minimum RMS for a loud frame. */
  minSpeechRms: number;
};

export type TrackerOptions = {
  frameMs: number;
  positiveThreshold: number;
  negativeThreshold: number;
  redemptionMs: number;
  preSpeechPadMs: number;
  minSpeechMs: number;
  speculateAfterMs: number;
  onSpeculate: (audio: Float32Array, id: number) => void;
  /** A speculation was superseded (speech resumed, the utterance was rejected, or capture paused). */
  onCancelSpeculation?: (id: number) => void;
  /** Return false to skip speculation (e.g. while the interviewer is speaking). */
  shouldSpeculate?: () => boolean;
  /** Gate frames only count while this returns true (the candidate has the floor). */
  isAccepting?: () => boolean;
  gate?: GateOptions;
  /** Speculative transcriptions allowed per rolling minute. */
  maxSpeculationsPerMinute?: number;
};

export type UtteranceVerdict = {
  /** Passed the gate while the candidate had the floor. */
  accepted: boolean;
  /** Sounded like real close speech, whether or not the candidate had the floor. */
  heard: boolean;
  /** Why an utterance was rejected: too little confident speech ("short") or too faint ("quiet"). */
  reason: "ok" | "short" | "quiet";
  /** A speculation covering the whole utterance, or null. */
  speculationId: number | null;
  /** Samples in the utterance, to match it with the VAD's audio. */
  samples: number;
};

const FLOOR_MIN_DB = -60; // RMS 0.001
const FLOOR_MAX_DB = -26; // RMS 0.05
const FLOOR_INIT_DB = -40; // RMS 0.01

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

const toDb = (value: number) => 20 * Math.log10(Math.max(value, 1e-5));

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
  private ended: UtteranceVerdict | null = null;
  // Gate state: frames counted while the candidate has the floor, and (heard*)
  // the same acoustic test regardless of the floor.
  private floorDb = FLOOR_INIT_DB;
  private confidentFrames = 0;
  private faintFrames = 0;
  private run = 0;
  private maxRun = 0;
  private heardFrames = 0;
  private heardRun = 0;
  private heardMaxRun = 0;
  private frameIndex = 0;
  private speculationFrames: number[] = [];
  private readonly redemptionFrames: number;
  private readonly padFrames: number;
  private readonly minSpeechFrames: number;
  private readonly speculateFrames: number;
  private readonly minuteFrames: number;

  constructor(private readonly options: TrackerOptions) {
    // Same rounding as @ricky0123/vad-web's calculateFrameParams.
    this.redemptionFrames = Math.floor(options.redemptionMs / options.frameMs);
    this.padFrames = Math.floor(options.preSpeechPadMs / options.frameMs);
    this.minSpeechFrames = Math.floor(options.minSpeechMs / options.frameMs);
    this.speculateFrames = Math.max(1, Math.ceil(options.speculateAfterMs / options.frameMs));
    this.minuteFrames = Math.round(60_000 / options.frameMs);
  }

  /** Current estimate of the room's background level (RMS). */
  get noiseFloorRms(): number {
    return 10 ** (this.floorDb / 20);
  }

  /** Feed every processed frame (16 kHz) with its speech probability; `level` is its RMS if already known. */
  frame(probability: number, frame: Float32Array, level = rms(frame)): void {
    this.frameIndex++;
    const isSpeech = probability >= this.options.positiveThreshold;
    this.frames.push({ frame, isSpeech });
    const db = toDb(level);
    if (probability < this.options.negativeThreshold) {
      // Follow quiet moments quickly and loud ones slowly, so the floor tracks the
      // room between words rather than transients.
      this.floorDb += (db - this.floorDb) * (db < this.floorDb ? 0.05 : 0.01);
      this.floorDb = Math.min(FLOOR_MAX_DB, Math.max(FLOOR_MIN_DB, this.floorDb));
    }

    if (isSpeech) {
      this.speechFrames++;
      this.redemption = 0;
      if (this.speculatedThisPause) {
        // The candidate kept talking: the speculative transcript is incomplete.
        this.speculatedThisPause = false;
        this.speculationValid = false;
        this.cancelSpeculation();
      }
    }
    if (isSpeech && !this.speaking) this.speaking = true;
    if (this.speaking) this.updateGate(probability, db);

    if (probability < this.options.negativeThreshold && this.speaking) {
      this.redemption++;
      if (this.redemption >= this.redemptionFrames) {
        // The VAD ends the utterance on this frame (speech end or misfire).
        const enough = this.frames.filter((f) => f.isSpeech).length >= this.minSpeechFrames;
        const accepted = this.passes();
        const speculationId = accepted && enough && this.speculationValid ? this.speculationId : null;
        if (this.speculationId !== null && this.speculationId !== speculationId) this.cancelSpeculation();
        this.ended = {
          accepted,
          heard: this.heard(),
          reason: accepted ? "ok" : this.faintFrames >= (this.options.gate?.minConfidentFrames ?? 0) ? "quiet" : "short",
          speculationId,
          samples: this.frames.reduce((n, f) => n + f.frame.length, 0),
        };
        this.speculationId = null; // handed over (or cancelled) above
        this.clearSegment();
        return;
      }
      if (
        this.redemption >= this.speculateFrames &&
        !this.speculatedThisPause &&
        this.speechFrames >= this.minSpeechFrames &&
        this.passes() &&
        this.withinBudget()
      ) {
        this.speculatedThisPause = true;
        if (this.options.shouldSpeculate?.() ?? true) {
          this.cancelSpeculation(); // an earlier, now incomplete speculation of this utterance
          this.speculationId = ++this.nextId;
          this.speculationValid = true;
          this.speculationFrames.push(this.frameIndex);
          this.options.onSpeculate(concat(this.frames.map((f) => f.frame)), this.speculationId);
        }
      }
    }

    if (!this.speaking) {
      while (this.frames.length > this.padFrames) this.frames.shift();
      this.speechFrames = 0;
    }
  }

  /** The verdict for the utterance the VAD just ended (call from onSpeechEnd), consumed once. */
  takeEnded(): UtteranceVerdict | null {
    const ended = this.ended;
    this.ended = null;
    return ended;
  }

  /** The id of a speculation covering the whole utterance that just ended, or null. */
  takeEndedSpeculation(): number | null {
    return this.takeEnded()?.speculationId ?? null;
  }

  /** Forget any utterance in progress (capture paused or restarted). */
  reset(): void {
    this.cancelSpeculation();
    this.clearSegment();
    this.ended = null;
  }

  /**
   * Cancel an outstanding speculation (and don't start another in this pause)
   * without touching segmentation, so the tracker stays in step with the VAD.
   */
  cancelPendingSpeculation(): void {
    this.speculatedThisPause = true;
    this.cancelSpeculation();
  }

  /**
   * The candidate took the floor mid-utterance (barge-in): count the speech already
   * heard in this utterance, which was spoken before the floor opened.
   */
  claimFloor(): void {
    if (!this.speaking) return;
    this.confidentFrames = Math.max(this.confidentFrames, this.heardFrames);
    this.maxRun = Math.max(this.maxRun, this.heardMaxRun);
    this.run = Math.max(this.run, this.heardRun);
  }

  private updateGate(probability: number, db: number): void {
    const gate = this.options.gate;
    if (!gate) return;
    const speech = probability >= gate.confidentThreshold;
    const loud = db >= Math.max(this.floorDb + gate.minSnrDb, toDb(gate.minSpeechRms));
    if (speech && loud) {
      this.heardFrames++;
      this.heardRun++;
      this.heardMaxRun = Math.max(this.heardMaxRun, this.heardRun);
    } else {
      this.heardRun = 0;
    }
    const confident = speech && (this.options.isAccepting?.() ?? true);
    if (confident && loud) {
      this.confidentFrames++;
      this.run++;
      this.maxRun = Math.max(this.maxRun, this.run);
    } else {
      if (confident) this.faintFrames++;
      this.run = 0;
    }
  }

  private passes(): boolean {
    const gate = this.options.gate;
    if (!gate) return true;
    return this.confidentFrames >= gate.minConfidentFrames && this.maxRun >= gate.minConfidentRun;
  }

  private heard(): boolean {
    const gate = this.options.gate;
    if (!gate) return true;
    return this.heardFrames >= gate.minConfidentFrames && this.heardMaxRun >= gate.minConfidentRun;
  }

  private withinBudget(): boolean {
    const max = this.options.maxSpeculationsPerMinute;
    if (!max) return true;
    this.speculationFrames = this.speculationFrames.filter((at) => this.frameIndex - at < this.minuteFrames);
    return this.speculationFrames.length < max;
  }

  private cancelSpeculation(): void {
    if (this.speculationId !== null) this.options.onCancelSpeculation?.(this.speculationId);
    this.speculationId = null;
    this.speculationValid = false;
  }

  private clearSegment(): void {
    this.frames = [];
    this.speaking = false;
    this.speechFrames = 0;
    this.redemption = 0;
    this.speculatedThisPause = false;
    this.speculationValid = false;
    this.confidentFrames = 0;
    this.faintFrames = 0;
    this.run = 0;
    this.maxRun = 0;
    this.heardFrames = 0;
    this.heardRun = 0;
    this.heardMaxRun = 0;
  }
}
