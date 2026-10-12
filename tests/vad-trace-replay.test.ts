import { describe, expect, it } from "vitest";
import { UtteranceTracker, type UtteranceVerdict } from "../src/lib/utterance-tracker";
import trace from "./fixtures/vad-trace-user.json";

// Replays a real candidate's MacBook-mic trace (quiet room, Silero gave their speech
// mostly 0.35-0.8) through the tracker with the settings useVAD.ts ships. Frames are
// sampled snapshots, so each attempt's window is fed back-to-back at 32 ms per frame.
// Mirrors src/hooks/useVAD.ts (keep in sync).
const FRAME_MS = 32;
const SETTINGS = {
  frameMs: FRAME_MS,
  positiveThreshold: 0.4,
  negativeThreshold: 0.3,
  redemptionMs: 2_200, // END_OF_TURN_MS.incomplete (pending)
  fallbackRedemptionMs: 1_200, // END_OF_TURN_MS.unknown
  preSpeechPadMs: 300,
  minSpeechMs: 250,
  speculateAfterMs: 350,
  maxSpeculationsPerMinute: 8,
  gate: {
    confidentThreshold: 0.8,
    minConfidentFrames: 8,
    minConfidentRun: 4,
    minSnrDb: 9,
    minSpeechRms: 0.006,
    shortWord: { minRun: 5, minSnrDb: 18 },
    nearVoice: { minProbability: 0.4, minSnrDb: 18 },
  },
};

type Attempt = { atS: number; frames: [number, number, number][] };

function frameOf(level: number): Float32Array {
  return new Float32Array(512).fill(level);
}

function replay(attempt: Attempt, settings: typeof SETTINGS = SETTINGS): UtteranceVerdict[] {
  const verdicts: UtteranceVerdict[] = [];
  const tracker = new UtteranceTracker({ ...settings, onSpeculate: () => {} });
  const feed = (p: number, level: number) => {
    tracker.frame(p, frameOf(level), level);
    const ended = tracker.takeEnded();
    if (ended) verdicts.push(ended);
  };
  // Let the noise floor settle on the trace's quiet room (~0.0015 RMS).
  for (let i = 0; i < 100; i++) feed(0.01, 0.0015);
  for (const [, p, level] of attempt.frames) feed(p, level);
  for (let i = 0; i < 120; i++) feed(0.01, 0.0015);
  return verdicts;
}

const attempts = (trace as unknown as { attempts: Attempt[] }).attempts;

describe("real user trace replay (listen-2026-10-12T13-48-15)", () => {
  it("has the six real speech attempts", () => {
    expect(attempts.map((a) => a.atS)).toEqual([11, 17.5, 28, 37, 40.3, 62.9]);
  });

  for (const attempt of attempts) {
    it(`accepts the attempt at ${attempt.atS} s`, () => {
      const verdicts = replay(attempt);
      // One answer, not split into fragments by mid-sentence dips.
      expect(verdicts.filter((v) => v.accepted)).toHaveLength(1);
      expect(verdicts.some((v) => v.accepted), JSON.stringify(verdicts.map(({ accepted, reason, samples }) => ({ accepted, reason, samples })))).toBe(true);
    });
  }

  it("the pre-4d136aef settings lost some of these attempts (the test has teeth)", () => {
    const old = {
      ...SETTINGS,
      positiveThreshold: 0.5,
      negativeThreshold: 0.35,
      gate: { ...SETTINGS.gate, nearVoice: undefined },
    } as unknown as typeof SETTINGS;
    const lost = attempts.filter((a) => !replay(a, old).some((v) => v.accepted)).map((a) => a.atS);
    // Same three the live run lost (rejected "short" at 11 s; no utterance at 37 s and 40.3 s).
    expect(lost).toEqual([11, 37, 40.3]);
  });
});
