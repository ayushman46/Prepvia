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
  /**
   * A single crisp word ("No.") passes with a shorter unbroken run of confident
   * speech when it is clearly close to the microphone: this far above the floor.
   */
  shortWord?: { minRun: number; minSnrDb: number };
  /**
   * Some voices (and some microphones' processing) only get moderate speech
   * probabilities from Silero. Sound this far above the room that is still at least
   * this speech-like counts as confident: a loud, close voice is the candidate.
   */
  nearVoice?: {
    minProbability: number;
    minSnrDb: number;
    /**
     * Guard: loud, near-voice utterances must also contain this many loud frames
     * that are at least `strongProbability` speech (defaults 3 at 0.6), so a
     * sustained loud sound Silero is unsure about (fan gust, chair scrape) fails.
     */
    minStrongFrames?: number;
    strongProbability?: number;
  };
};

export type TrackerOptions = {
  frameMs: number;
  positiveThreshold: number;
  negativeThreshold: number;
  /** Silence that ends an utterance until `endpoint()` decides otherwise for the current pause. */
  redemptionMs: number;
  /** Silence that ends an utterance when a pause gets no speculation (nothing to decide from). */
  fallbackRedemptionMs?: number;
  /**
   * The tracker changed the end-of-utterance silence. Apply the same value to the
   * VAD before its next frame so the two stay in step (vad-web's setOptions).
   */
  onRedemptionChange?: (ms: number) => void;
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
  /** Trailing silence that ended the utterance (the candidate stopped talking this long ago). */
  silenceMs: number;
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
  /** Loud frames that are clearly speech-like (nearVoice guard), with and without the floor. */
  private strongFrames = 0;
  private heardStrongFrames = 0;
  private heardRun = 0;
  private heardMaxRun = 0;
  /** Loudest confident frame relative to the noise floor (dB), with and without the floor. */
  private peakSnrDb = -Infinity;
  private heardPeakSnrDb = -Infinity;
  private frameIndex = 0;
  private speculationFrames: number[] = [];
  private redemptionFrames: number;
  private redemptionMs: number;
  private pendingRedemptionMs: number | null = null;
  private inFrame = false;
  private readonly padFrames: number;
  private readonly minSpeechFrames: number;
  private readonly speculateFrames: number;
  private readonly minuteFrames: number;

  constructor(private readonly options: TrackerOptions) {
    // Same rounding as @ricky0123/vad-web's calculateFrameParams.
    this.redemptionMs = options.redemptionMs;
    this.redemptionFrames = Math.floor(options.redemptionMs / options.frameMs);
    this.padFrames = Math.floor(options.preSpeechPadMs / options.frameMs);
    this.minSpeechFrames = Math.floor(options.minSpeechMs / options.frameMs);
    this.speculateFrames = Math.max(1, Math.ceil(options.speculateAfterMs / options.frameMs));
    this.minuteFrames = Math.round(60_000 / options.frameMs);
  }

  /** Silence that currently ends an utterance. */
  get currentRedemptionMs(): number {
    return this.redemptionMs;
  }

  /** An utterance is in progress (the VAD heard speech-like sound and hasn't ended it). */
  get inUtterance(): boolean {
    return this.speaking;
  }

  /** The current utterance already sounds like real close speech (it would be "heard"). */
  get hearing(): boolean {
    return this.speaking && this.heard();
  }

  /** Current estimate of the room's background level (RMS). */
  get noiseFloorRms(): number {
    return 10 ** (this.floorDb / 20);
  }

  /** Feed every processed frame (16 kHz) with its speech probability; `level` is its RMS if already known. */
  frame(probability: number, frame: Float32Array, level = rms(frame)): void {
    // The VAD checks this frame against its own redemption after we return, so a
    // change decided while processing a frame takes effect (for both) on the next one.
    if (this.pendingRedemptionMs !== null) {
      const ms = this.pendingRedemptionMs;
      this.pendingRedemptionMs = null;
      this.applyRedemption(ms);
    }
    this.inFrame = true;
    try {
      this.step(probability, frame, level);
    } finally {
      this.inFrame = false;
    }
  }

  private step(probability: number, frame: Float32Array, level: number): void {
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
        // The candidate kept talking: the speculative transcript is incomplete, and
        // the next pause gets its own end-of-turn decision.
        this.speculatedThisPause = false;
        this.speculationValid = false;
        this.cancelSpeculation();
        this.setRedemption(this.options.redemptionMs);
      }
    }
    if (isSpeech && !this.speaking) this.speaking = true;
    if (this.speaking) this.updateGate(probability, db);
    if (!isSpeech && this.speculationValid && probability >= this.options.negativeThreshold && this.isLoud(db)) {
      // Soft words after the speculation point (between the two thresholds) don't
      // reset the pause, but the speculative transcript would miss them: transcribe
      // the whole utterance instead, and end the pause on the fixed fallback.
      this.speculationValid = false;
      this.cancelSpeculation();
      this.setRedemption(this.options.fallbackRedemptionMs ?? this.options.redemptionMs);
    }

    if (probability < this.options.negativeThreshold && this.speaking) {
      this.redemption++;
      if (this.redemption >= this.redemptionFrames) {
        // The VAD ends the utterance on this frame (speech end or misfire).
        this.ended = this.finishSegment();
        return;
      }
      if (this.redemption >= this.speculateFrames && !this.speculatedThisPause) {
        // One decision per pause: transcribe what was said so far (endpoint() then
        // decides how long to wait), or fall back to a fixed silence.
        this.speculatedThisPause = true;
        if (this.speechFrames >= this.minSpeechFrames && this.passes() && this.withinBudget() && (this.options.shouldSpeculate?.() ?? true)) {
          this.cancelSpeculation(); // an earlier, now incomplete speculation of this utterance
          this.speculationId = ++this.nextId;
          this.speculationValid = true;
          this.speculationFrames.push(this.frameIndex);
          this.options.onSpeculate(concat(this.frames.map((f) => f.frame)), this.speculationId);
        } else {
          this.setRedemption(this.options.fallbackRedemptionMs ?? this.options.redemptionMs);
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

  /**
   * End the utterance in progress now, as the VAD does when it pauses with its audio
   * submitted (e.g. the candidate ended the interview mid-sentence). Null if none.
   */
  endNow(): UtteranceVerdict | null {
    return this.speaking ? this.finishSegment() : null;
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
    this.setRedemption(this.options.redemptionMs, true);
  }

  /**
   * Cancel an outstanding speculation (and don't start another in this pause)
   * without touching segmentation, so the tracker stays in step with the VAD.
   */
  cancelPendingSpeculation(): void {
    this.speculatedThisPause = true;
    this.cancelSpeculation();
    if (this.speaking) this.setRedemption(this.options.fallbackRedemptionMs ?? this.options.redemptionMs);
  }

  /**
   * The transcript of speculation `id` is in: end the current pause after `silenceMs`
   * of silence in total (immediately if that much has already passed). Ignored when
   * the speculation is stale (the candidate resumed talking or the utterance ended).
   */
  endpoint(id: number, silenceMs: number): boolean {
    if (!this.speaking || id !== this.speculationId || !this.speculationValid) return false;
    this.setRedemption(silenceMs);
    return true;
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
    this.peakSnrDb = Math.max(this.peakSnrDb, this.heardPeakSnrDb);
    this.strongFrames = Math.max(this.strongFrames, this.heardStrongFrames);
  }

  private finishSegment(): UtteranceVerdict {
    const enough = this.frames.filter((f) => f.isSpeech).length >= this.minSpeechFrames;
    const accepted = this.passes();
    const speculationId = accepted && enough && this.speculationValid ? this.speculationId : null;
    if (this.speculationId !== null && this.speculationId !== speculationId) this.cancelSpeculation();
    const verdict: UtteranceVerdict = {
      accepted,
      heard: this.heard(),
      reason: accepted ? "ok" : this.faintFrames >= (this.options.gate?.minConfidentFrames ?? 0) ? "quiet" : "short",
      speculationId,
      samples: this.frames.reduce((n, f) => n + f.frame.length, 0),
      silenceMs: this.redemption * this.options.frameMs,
    };
    this.speculationId = null; // handed over (or cancelled) above
    this.clearSegment();
    this.setRedemption(this.options.redemptionMs);
    return verdict;
  }

  private isLoud(db: number): boolean {
    const gate = this.options.gate;
    return !gate || db >= Math.max(this.floorDb + gate.minSnrDb, toDb(gate.minSpeechRms));
  }

  private updateGate(probability: number, db: number): void {
    const gate = this.options.gate;
    if (!gate) return;
    const snr = db - this.floorDb;
    const near = !!gate.nearVoice && probability >= gate.nearVoice.minProbability && snr >= gate.nearVoice.minSnrDb;
    const speech = probability >= gate.confidentThreshold || near;
    const loud = this.isLoud(db);
    const strong = probability >= (gate.nearVoice?.strongProbability ?? 0.6);
    if (speech && loud) {
      this.heardFrames++;
      if (strong) this.heardStrongFrames++;
      this.heardRun++;
      this.heardMaxRun = Math.max(this.heardMaxRun, this.heardRun);
      this.heardPeakSnrDb = Math.max(this.heardPeakSnrDb, snr);
    } else {
      this.heardRun = 0;
    }
    const confident = speech && (this.options.isAccepting?.() ?? true);
    if (confident && loud) {
      this.confidentFrames++;
      if (strong) this.strongFrames++;
      this.run++;
      this.maxRun = Math.max(this.maxRun, this.run);
      this.peakSnrDb = Math.max(this.peakSnrDb, snr);
    } else {
      if (confident) this.faintFrames++;
      this.run = 0;
    }
  }

  /** Enough confident speech, or one crisp close word. */
  private gatePasses(frames: number, maxRun: number, peakSnrDb: number, strongFrames: number): boolean {
    const gate = this.options.gate;
    if (!gate) return true;
    if (gate.nearVoice && strongFrames < (gate.nearVoice.minStrongFrames ?? 3)) return false;
    if (frames >= gate.minConfidentFrames && maxRun >= gate.minConfidentRun) return true;
    return !!gate.shortWord && maxRun >= gate.shortWord.minRun && peakSnrDb >= gate.shortWord.minSnrDb;
  }

  private passes(): boolean {
    return this.gatePasses(this.confidentFrames, this.maxRun, this.peakSnrDb, this.strongFrames);
  }

  private heard(): boolean {
    return this.gatePasses(this.heardFrames, this.heardMaxRun, this.heardPeakSnrDb, this.heardStrongFrames);
  }

  private withinBudget(): boolean {
    const max = this.options.maxSpeculationsPerMinute;
    if (!max) return true;
    this.speculationFrames = this.speculationFrames.filter((at) => this.frameIndex - at < this.minuteFrames);
    return this.speculationFrames.length < max;
  }

  private setRedemption(ms: number, force = false): void {
    if (this.inFrame) {
      this.pendingRedemptionMs = ms;
      return;
    }
    this.pendingRedemptionMs = null;
    this.applyRedemption(ms, force);
  }

  private applyRedemption(ms: number, force = false): void {
    if (ms === this.redemptionMs && !force) return;
    this.redemptionMs = ms;
    this.redemptionFrames = Math.floor(ms / this.options.frameMs);
    this.options.onRedemptionChange?.(ms);
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
    this.strongFrames = 0;
    this.heardStrongFrames = 0;
    this.heardRun = 0;
    this.heardMaxRun = 0;
    this.peakSnrDb = -Infinity;
    this.heardPeakSnrDb = -Infinity;
  }
}
