import { describe, expect, it, vi } from "vitest";
import { UtteranceTracker } from "@/lib/utterance-tracker";

const FRAME_MS = 32;
const frame = (value: number) => new Float32Array(512).fill(value);

function makeTracker(overrides: Partial<ConstructorParameters<typeof UtteranceTracker>[0]> = {}) {
  const onSpeculate = vi.fn();
  const tracker = new UtteranceTracker({
    frameMs: FRAME_MS,
    positiveThreshold: 0.5,
    negativeThreshold: 0.35,
    redemptionMs: 800,
    preSpeechPadMs: 300,
    minSpeechMs: 250,
    speculateAfterMs: 250,
    onSpeculate,
    ...overrides,
  });
  return { tracker, onSpeculate };
}

/** Feed `count` frames of speech (p=0.9) or silence (p=0.05). */
function feed(tracker: UtteranceTracker, kind: "speech" | "silence", count: number, value = 0.1) {
  for (let i = 0; i < count; i++) tracker.frame(kind === "speech" ? 0.9 : 0.05, frame(value));
}

describe("UtteranceTracker", () => {
  it("speculates after the configured silence and reports it when the utterance ends", () => {
    const { tracker, onSpeculate } = makeTracker();
    feed(tracker, "silence", 15); // more than the 9-frame pre-speech pad
    feed(tracker, "speech", 40); // ~1.3 s of speech
    feed(tracker, "silence", 8); // 256 ms -> speculation fires
    expect(onSpeculate).toHaveBeenCalledTimes(1);
    const [audio, id] = onSpeculate.mock.calls[0];
    // Includes the pre-speech pad (9 frames) plus speech and silence so far.
    expect(audio.length).toBe((9 + 40 + 8) * 512);
    feed(tracker, "silence", 17); // reaches 25 frames (800 ms) -> utterance ends
    expect(tracker.takeEndedSpeculation()).toBe(id);
    expect(tracker.takeEndedSpeculation()).toBeNull(); // consumed once
  });

  it("invalidates the speculation if the candidate resumes talking", () => {
    const { tracker, onSpeculate } = makeTracker();
    feed(tracker, "speech", 30);
    feed(tracker, "silence", 10); // speculation #1
    feed(tracker, "speech", 20); // resumed: #1 invalid
    feed(tracker, "silence", 25); // speculation #2 then end
    expect(onSpeculate).toHaveBeenCalledTimes(2);
    expect(tracker.takeEndedSpeculation()).toBe(onSpeculate.mock.calls[1][1]);
  });

  it("does not report a speculation when the pause ends before speculating", () => {
    const { tracker, onSpeculate } = makeTracker({ speculateAfterMs: 2_000 });
    feed(tracker, "speech", 30);
    feed(tracker, "silence", 25);
    expect(onSpeculate).not.toHaveBeenCalled();
    expect(tracker.takeEndedSpeculation()).toBeNull();
  });

  it("never speculates on misfires (too little speech)", () => {
    const { tracker, onSpeculate } = makeTracker();
    feed(tracker, "speech", 3); // < minSpeech (7 frames)
    feed(tracker, "silence", 25);
    expect(onSpeculate).not.toHaveBeenCalled();
    expect(tracker.takeEndedSpeculation()).toBeNull();
  });

  it("respects shouldSpeculate (e.g. while the interviewer is talking)", () => {
    let allowed = false;
    const { tracker, onSpeculate } = makeTracker({ shouldSpeculate: () => allowed });
    feed(tracker, "speech", 20);
    feed(tracker, "silence", 25);
    expect(onSpeculate).not.toHaveBeenCalled();
    expect(tracker.takeEndedSpeculation()).toBeNull();
    allowed = true;
    feed(tracker, "speech", 20);
    feed(tracker, "silence", 25);
    expect(onSpeculate).toHaveBeenCalledTimes(1);
  });

  it("treats in-between probabilities like the VAD (neither speech nor silence)", () => {
    const { tracker, onSpeculate } = makeTracker();
    feed(tracker, "speech", 20);
    for (let i = 0; i < 30; i++) tracker.frame(0.42, frame(0.1)); // between thresholds: no redemption progress
    expect(onSpeculate).not.toHaveBeenCalled();
    feed(tracker, "silence", 25);
    expect(tracker.takeEndedSpeculation()).not.toBeNull();
  });
});
