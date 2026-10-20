/**
 * Echo-aware barge-in: decides when the candidate is talking over Aria.
 *
 * Chromium does not echo-cancel audio played through the Web Audio API, so Aria's own
 * voice reaches the mic and Silero scores it as speech. A probability threshold alone
 * therefore cuts her off mid-sentence. This model predicts the echo level from what
 * Aria is playing and only counts a frame when the mic is clearly above that prediction.
 *
 * Pure logic: the caller supplies timestamps, VAD probability, mic RMS, the room floor
 * and the playback RMS. Frames arrive about every 32 ms.
 */

/** Frames of the sliding window that must count before barge-in fires. */
export const BARGE_IN_WINDOW = 10;
export const BARGE_IN_FRAMES = 7;
/** Silero probability a frame needs to count at all (echo scores ~0.95, so this is not the gate). */
export const BARGE_IN_MIN_PROBABILITY = 0.5;
/** Mic must be this far above the predicted echo (dB). */
export const ECHO_MARGIN_DB = 12;
/** Mic must be this far above the room noise floor (dB). */
export const SNR_MARGIN_DB = 18;
/** Recent playback frames whose maximum is the echo reference (about 12 x 32 ms). */
export const ECHO_HISTORY_FRAMES = 12;
/** Echo keeps arriving after playback stops (room reverb and buffering), so playback counts as active this long. */
export const ECHO_TAIL_MS = 400;
/** Gain samples kept for the percentile estimate. */
export const GAIN_SAMPLES = 150;
/** Robust high percentile of the gain samples. */
export const GAIN_PERCENTILE = 0.8;
/** Starting echo gain: conservative, so an unlearned echo never looks like a candidate. */
export const GAIN_INITIAL = 0.5;
/** Estimate floor (keeps a quiet room from driving the gain to zero). */
export const GAIN_MIN = 0.05;
/** Estimate ceiling and per-sample clamp. */
export const GAIN_MAX = 4;
/** Samples needed before the gain estimate replaces the initial value. */
const GAIN_MIN_SAMPLES = 5;
/** After this many samples, a sample more than ECHO_MARGIN_DB above the estimate is candidate speech, not echo. */
const GAIN_WARMUP = 20;
/** Playback RMS below this is silence. */
export const OUTPUT_FLOOR = 0.004;

export interface EchoFrame {
  /** Monotonic timestamp in ms (performance.now()). */
  t: number;
  /** Silero speech probability for the frame. */
  probability: number;
  /** Mic RMS of the frame. */
  rms: number;
  /** Room noise floor RMS. */
  noiseFloor: number;
  /** RMS of Aria's current playback (0 when silent). */
  outputRms: number;
}

const EPS = 1e-6;
const fromDb = (decibels: number) => 10 ** (decibels / 20);
const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/** Player levels are min(1, rms * 4); convert back to an RMS echo estimate. */
export const outputLevelToRms = (level: number) => (Number.isFinite(level) && level > 0 ? level / 4 : 0);

/** Value at the given percentile (nearest rank) of a non-empty list. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export class EchoAwareBargeIn {
  /** Output RMS of the last ECHO_HISTORY_FRAMES frames. */
  private outputs: number[] = [];
  /** Echo-gain samples: mic RMS divided by the echo reference, on playback frames. */
  private samples: number[] = [];
  private gain = GAIN_INITIAL;
  /** Most recent frame with audible playback, and the level it had. */
  private lastAudibleAt = -Infinity;
  private lastAudibleRms = 0;
  /** Sliding window of frames that counted as candidate speech. */
  private window: boolean[] = [];

  /** Current echo gain (mic RMS per unit of playback RMS). */
  get echoGain(): number {
    return this.gain;
  }

  /** Frames in the sliding window (for tests and debugging). */
  get windowSize(): number {
    return this.window.length;
  }

  /** Whether playback is still active at `t` (audible now, or within the echo tail). */
  isPlaying(t: number): boolean {
    return t - this.lastAudibleAt <= ECHO_TAIL_MS;
  }

  /** Echo reference: the loudest recent playback, held through the echo tail. */
  echoReference(t: number): number {
    const recentMax = this.outputs.reduce((max, value) => Math.max(max, value), 0);
    return this.isPlaying(t) ? Math.max(recentMax, this.lastAudibleRms) : 0;
  }

  /** Predicted echo RMS at the mic for the current playback. */
  predictedEcho(t: number): number {
    return this.gain * this.echoReference(t);
  }

  /** Update the echo model (history, tail, gain) without counting the frame. */
  observe(frame: EchoFrame): void {
    const output = Math.max(finiteOr(frame.outputRms, 0), 0);
    this.outputs.push(output);
    if (this.outputs.length > ECHO_HISTORY_FRAMES) this.outputs.shift();
    if (output > OUTPUT_FLOOR) {
      this.lastAudibleAt = frame.t;
      this.lastAudibleRms = output;
      this.learn(frame);
    }
  }

  /**
   * Feed one frame. `armed` is true only while Aria is the interviewer speaking (barge-in
   * allowed); otherwise the frame still updates the echo model but the window is cleared.
   * Returns true when the window fires (and clears itself).
   */
  push(frame: EchoFrame, armed = true): boolean {
    this.observe(frame);
    if (!armed) {
      this.window = [];
      return false;
    }
    this.window.push(this.counts(frame));
    if (this.window.length > BARGE_IN_WINDOW) this.window.shift();
    if (this.window.filter(Boolean).length >= BARGE_IN_FRAMES) {
      this.window = [];
      return true;
    }
    return false;
  }

  /** Whether one frame is candidate speech rather than Aria's echo. */
  counts(frame: EchoFrame): boolean {
    if (!Number.isFinite(frame.probability) || frame.probability < BARGE_IN_MIN_PROBABILITY) return false;
    if (!Number.isFinite(frame.rms) || frame.rms <= 0) return false;
    const floor = Math.max(finiteOr(frame.noiseFloor, 0), EPS);
    if (frame.rms < floor * fromDb(SNR_MARGIN_DB)) return false;
    const echo = this.predictedEcho(frame.t);
    if (frame.rms < echo * fromDb(ECHO_MARGIN_DB)) return false;
    return true;
  }

  /** Forget the window only (keeps the learned echo model). */
  resetWindow(): void {
    this.window = [];
  }

  /** New interview: forget everything, including the learned gain. */
  reset(): void {
    this.outputs = [];
    this.samples = [];
    this.gain = GAIN_INITIAL;
    this.lastAudibleAt = -Infinity;
    this.lastAudibleRms = 0;
    this.window = [];
  }

  /** Learn the echo gain from a playback frame. Candidate speech is skipped once the estimate has warmed up. */
  private learn(frame: EchoFrame): void {
    const reference = this.echoReference(frame.t);
    const rms = finiteOr(frame.rms, 0);
    if (reference <= 0 || rms <= 0) return;
    const sample = Math.min(GAIN_MAX, rms / reference);
    if (this.samples.length >= GAIN_WARMUP && sample > this.gain * fromDb(ECHO_MARGIN_DB)) return;
    this.samples.push(sample);
    if (this.samples.length > GAIN_SAMPLES) this.samples.shift();
    if (this.samples.length >= GAIN_MIN_SAMPLES) {
      this.gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, percentile(this.samples, GAIN_PERCENTILE)));
    }
  }
}
