/**
 * Barge-in detector: of the last `window` frames (~32 ms each), at least `frames`
 * must count as speech. A frame counts when Silero is confident (p >= confident),
 * or when it is moderately sure (p >= nearProbability) AND the mic frame is both
 * well above the room floor (>= minSnrDb) and clearly louder than the interviewer's
 * own playback (an echo estimate), so Aria's voice leaking past AEC cannot interrupt her.
 */
export interface BargeInOptions {
  window: number;
  frames: number;
  confident: number;
  nearProbability: number;
  minSnrDb: number;
  /** Mic RMS must exceed the playback RMS estimate by this many dB to count a near-voice frame. */
  minOverEchoDb: number;
}

export const BARGE_IN_DEFAULTS: BargeInOptions = {
  window: 10,
  frames: 7,
  confident: 0.7,
  nearProbability: 0.4,
  minSnrDb: 18,
  minOverEchoDb: 6,
};

export interface BargeInFrame {
  probability: number;
  rms: number;
  noiseFloor: number;
  /** RMS of the audio currently being played (0 when silent / unknown). */
  outputRms: number;
}

const db = (ratio: number) => 20 * Math.log10(ratio);
const EPS = 1e-6;

export function isBargeInFrame(f: BargeInFrame, o: BargeInOptions = BARGE_IN_DEFAULTS): boolean {
  if (!Number.isFinite(f.probability)) return false;
  if (f.probability >= o.confident) return true;
  if (f.probability < o.nearProbability) return false;
  if (!Number.isFinite(f.rms) || f.rms <= 0) return false;
  const floor = Math.max(Number.isFinite(f.noiseFloor) ? f.noiseFloor : 0, EPS);
  if (db(f.rms / floor) < o.minSnrDb) return false;
  const echo = Number.isFinite(f.outputRms) ? Math.max(f.outputRms, 0) : 0;
  if (echo > 0 && db(f.rms / echo) < o.minOverEchoDb) return false;
  return true;
}

/** Player levels are min(1, rms * 4); convert back to an RMS echo estimate. */
export const outputLevelToRms = (level: number) => (Number.isFinite(level) && level > 0 ? level / 4 : 0);

export class BargeInDetector {
  private recent: boolean[] = [];
  constructor(private readonly options: BargeInOptions = BARGE_IN_DEFAULTS) {}

  /** Feed one frame; returns true when the window fires (and resets). */
  push(frame: BargeInFrame): boolean {
    this.recent.push(isBargeInFrame(frame, this.options));
    if (this.recent.length > this.options.window) this.recent.shift();
    if (this.recent.filter(Boolean).length >= this.options.frames) {
      this.recent = [];
      return true;
    }
    return false;
  }

  reset(): void {
    this.recent = [];
  }

  get size(): number {
    return this.recent.length;
  }
}
