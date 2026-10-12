import { describe, expect, it, vi } from "vitest";
import { UtteranceTracker } from "@/lib/utterance-tracker";
// vad-web's own frame processor (the state machine MicVAD runs), to prove the
// tracker stays in step with it when the end-of-turn silence changes.
import { FrameProcessor } from "@ricky0123/vad-web/dist/frame-processor.js";

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

describe("UtteranceTracker noise gate", () => {
  const GATE = { confidentThreshold: 0.8, minConfidentFrames: 8, minConfidentRun: 4, minSnrDb: 9, minSpeechRms: 0.006 };
  /** Feed `count` frames with speech probability `p` at loudness `level` (RMS). */
  const feedAt = (tracker: UtteranceTracker, p: number, level: number, count: number) => {
    for (let i = 0; i < count; i++) tracker.frame(p, frame(level));
  };

  it("rejects speech-like sound that is barely above the room noise (distant voices)", () => {
    const { tracker, onSpeculate } = makeTracker({ gate: GATE, speculateAfterMs: 350 });
    feedAt(tracker, 0.05, 0.01, 60); // room at RMS 0.01
    feedAt(tracker, 0.9, 0.02, 20); // "speech" only +6 dB above it
    feedAt(tracker, 0.05, 0.01, 25);
    expect(onSpeculate).not.toHaveBeenCalled();
    expect(tracker.takeEnded()).toMatchObject({ accepted: false, reason: "quiet", speculationId: null });
  });

  it("accepts close speech well above the room noise, and speculates on it", () => {
    const { tracker, onSpeculate } = makeTracker({ gate: GATE, speculateAfterMs: 350 });
    feedAt(tracker, 0.05, 0.01, 60);
    feedAt(tracker, 0.9, 0.08, 20); // +18 dB
    feedAt(tracker, 0.05, 0.01, 25);
    expect(onSpeculate).toHaveBeenCalledTimes(1);
    const verdict = tracker.takeEnded();
    expect(verdict).toMatchObject({ accepted: true, reason: "ok", speculationId: onSpeculate.mock.calls[0][1] });
    expect(verdict?.samples).toBe((9 + 20 + 25) * 512);
  });

  it("rejects scattered spikes (clicks, coughs) that never form a run of confident speech", () => {
    const { tracker, onSpeculate } = makeTracker({ gate: GATE, speculateAfterMs: 350 });
    feedAt(tracker, 0.05, 0.003, 30);
    for (let i = 0; i < 12; i++) {
      feedAt(tracker, 0.95, 0.1, 1);
      feedAt(tracker, 0.4, 0.004, 2);
    }
    feedAt(tracker, 0.05, 0.003, 25);
    expect(onSpeculate).not.toHaveBeenCalled();
    expect(tracker.takeEnded()).toMatchObject({ accepted: false, reason: "short" });
  });

  it("raises the noise floor slowly in a loud room and lowers it quickly when it quietens", () => {
    const { tracker } = makeTracker({ gate: GATE });
    feedAt(tracker, 0.1, 0.04, 20);
    expect(tracker.noiseFloorRms).toBeLessThan(0.015); // a burst of noise barely moves it
    feedAt(tracker, 0.1, 0.04, 180);
    expect(tracker.noiseFloorRms).toBeGreaterThan(0.03);
    expect(tracker.noiseFloorRms).toBeLessThanOrEqual(0.045);
    feedAt(tracker, 0.9, 0.06, 20); // not clearly above the loud room
    feedAt(tracker, 0.1, 0.04, 25);
    expect(tracker.takeEnded()?.accepted).toBe(false);
    feedAt(tracker, 0.1, 0.003, 40);
    expect(tracker.noiseFloorRms).toBeLessThan(0.006);
    feedAt(tracker, 0.9, 0.03, 20);
    feedAt(tracker, 0.1, 0.003, 25);
    expect(tracker.takeEnded()?.accepted).toBe(true);
  });

  it("only counts speech while the candidate has the floor", () => {
    let accepting = false;
    const { tracker } = makeTracker({ gate: GATE, isAccepting: () => accepting });
    feedAt(tracker, 0.05, 0.003, 30);
    feedAt(tracker, 0.95, 0.08, 30); // e.g. echo of the interviewer, before the floor opens
    accepting = true;
    feedAt(tracker, 0.05, 0.003, 25);
    expect(tracker.takeEnded()?.accepted).toBe(false);
    feedAt(tracker, 0.95, 0.08, 30); // the candidate talks after the floor opened
    feedAt(tracker, 0.05, 0.003, 25);
    expect(tracker.takeEnded()?.accepted).toBe(true);
  });

  it("cancels superseded speculations and caps how many it starts per minute", () => {
    const onCancelSpeculation = vi.fn();
    const { tracker, onSpeculate } = makeTracker({ gate: GATE, speculateAfterMs: 350, onCancelSpeculation, maxSpeculationsPerMinute: 2 });
    feedAt(tracker, 0.05, 0.003, 30);
    feedAt(tracker, 0.95, 0.08, 20);
    feedAt(tracker, 0.05, 0.003, 12); // speculation #1
    feedAt(tracker, 0.95, 0.08, 10); // resumed: #1 cancelled
    expect(onCancelSpeculation).toHaveBeenCalledWith(onSpeculate.mock.calls[0][1]);
    feedAt(tracker, 0.05, 0.003, 25); // speculation #2, then the end
    feedAt(tracker, 0.95, 0.08, 20);
    expect(tracker.takeEnded()).toMatchObject({ accepted: true, speculationId: onSpeculate.mock.calls[1][1] }); // #2 handed over
    feedAt(tracker, 0.95, 0.08, 20);
    feedAt(tracker, 0.05, 0.003, 25); // budget used up: no third speculation
    expect(onSpeculate).toHaveBeenCalledTimes(2);
    expect(onCancelSpeculation).toHaveBeenCalledTimes(1);
    expect(tracker.takeEnded()).toMatchObject({ accepted: true, speculationId: null });
    feedAt(tracker, 0.05, 0.003, 1875); // a minute later the budget is available again
    feedAt(tracker, 0.95, 0.08, 20);
    feedAt(tracker, 0.05, 0.003, 25);
    expect(onSpeculate).toHaveBeenCalledTimes(3);
  });

  it("reports speech heard while the candidate didn't have the floor (so it can be flagged, not answered)", () => {
    const { tracker } = makeTracker({ gate: GATE, isAccepting: () => false });
    feedAt(tracker, 0.05, 0.003, 30);
    feedAt(tracker, 0.95, 0.08, 30);
    feedAt(tracker, 0.05, 0.003, 25);
    expect(tracker.takeEnded()).toMatchObject({ accepted: false, heard: true });
    feedAt(tracker, 0.95, 0.008, 30); // faint: neither accepted nor heard
    feedAt(tracker, 0.05, 0.003, 25);
    expect(tracker.takeEnded()).toMatchObject({ accepted: false, heard: false });
  });

  it("credits speech spoken just before a barge-in handed over the floor", () => {
    let accepting = false;
    const { tracker } = makeTracker({ gate: GATE, isAccepting: () => accepting });
    feedAt(tracker, 0.05, 0.003, 30);
    feedAt(tracker, 0.95, 0.08, 9); // "Sorry—" over the interviewer: barge-in fires
    tracker.claimFloor();
    accepting = true;
    feedAt(tracker, 0.05, 0.003, 25); // the candidate stops right away
    expect(tracker.takeEnded()?.accepted).toBe(true);
  });

  it("cancelling a speculation keeps segmentation in step with the VAD", () => {
    const onCancelSpeculation = vi.fn();
    const { tracker, onSpeculate } = makeTracker({ gate: GATE, speculateAfterMs: 350, onCancelSpeculation });
    feedAt(tracker, 0.95, 0.08, 20);
    feedAt(tracker, 0.05, 0.003, 12); // speculation #1
    tracker.cancelPendingSpeculation(); // e.g. push-to-talk pressed
    expect(onCancelSpeculation).toHaveBeenCalledWith(onSpeculate.mock.calls[0][1]);
    feedAt(tracker, 0.05, 0.003, 13); // the VAD still ends the utterance on schedule
    expect(tracker.takeEnded()).toMatchObject({ accepted: true, speculationId: null, samples: (20 + 25) * 512 });
  });

  it("reset() abandons the utterance in progress and its speculation", () => {
    const onCancelSpeculation = vi.fn();
    const { tracker, onSpeculate } = makeTracker({ gate: GATE, speculateAfterMs: 350, onCancelSpeculation });
    feedAt(tracker, 0.95, 0.08, 20);
    feedAt(tracker, 0.05, 0.003, 12);
    tracker.reset();
    expect(onCancelSpeculation).toHaveBeenCalledWith(onSpeculate.mock.calls[0][1]);
    feedAt(tracker, 0.05, 0.003, 30);
    expect(tracker.takeEnded()).toBeNull();
  });
});

describe("UtteranceTracker adaptive end of turn", () => {
  const options = { redemptionMs: 2_200, fallbackRedemptionMs: 1_200, speculateAfterMs: 350 };

  it("waits the pending silence until the pause's transcript decides, then ends a finished answer at 800 ms", () => {
    const onRedemptionChange = vi.fn();
    const { tracker, onSpeculate } = makeTracker({ ...options, onRedemptionChange });
    feed(tracker, "speech", 30);
    feed(tracker, "silence", 11); // speculation at 352 ms
    expect(onSpeculate).toHaveBeenCalledTimes(1);
    feed(tracker, "silence", 20); // 992 ms: past 800 but the transcript isn't in yet
    expect(tracker.takeEnded()).toBeNull();
    expect(tracker.endpoint(onSpeculate.mock.calls[0][1], 800)).toBe(true);
    expect(onRedemptionChange).toHaveBeenLastCalledWith(800);
    feed(tracker, "silence", 1); // already past 800 ms: ends on the next frame
    expect(tracker.takeEnded()).toMatchObject({ speculationId: onSpeculate.mock.calls[0][1], silenceMs: 32 * 32 });
    feed(tracker, "silence", 1);
    expect(onRedemptionChange).toHaveBeenLastCalledWith(2_200); // the next utterance starts from the pending value
  });

  it("keeps listening through a thinking pause after an unfinished sentence, as one utterance", () => {
    const { tracker, onSpeculate } = makeTracker(options);
    feed(tracker, "speech", 40);
    feed(tracker, "silence", 11);
    tracker.endpoint(onSpeculate.mock.calls[0][1], 2_200); // "…and"
    feed(tracker, "silence", 50); // 1.95 s of thinking
    expect(tracker.takeEnded()).toBeNull();
    feed(tracker, "speech", 40); // the candidate continues
    feed(tracker, "silence", 11);
    tracker.endpoint(onSpeculate.mock.calls[1][1], 800);
    feed(tracker, "silence", 14);
    expect(tracker.takeEnded()).toMatchObject({ speculationId: onSpeculate.mock.calls[1][1], samples: (40 + 61 + 40 + 25) * 512 });
  });

  it("ignores a decision for a stale speculation (the candidate already resumed)", () => {
    const { tracker, onSpeculate } = makeTracker(options);
    feed(tracker, "speech", 30);
    feed(tracker, "silence", 11);
    feed(tracker, "speech", 10); // resumed before the transcript came back
    expect(tracker.endpoint(onSpeculate.mock.calls[0][1], 800)).toBe(false);
    feed(tracker, "silence", 30);
    expect(tracker.takeEnded()).toBeNull(); // still waiting for this pause's own decision
  });

  it("falls back to a fixed silence when a pause gets no speculation", () => {
    const { tracker, onSpeculate } = makeTracker({ ...options, shouldSpeculate: () => false });
    feed(tracker, "speech", 30);
    feed(tracker, "silence", 36); // 1,152 ms
    expect(tracker.takeEnded()).toBeNull();
    feed(tracker, "silence", 1); // 37 frames = floor(1,200 / 32), the VAD's own rounding
    expect(tracker.takeEnded()).toMatchObject({ silenceMs: 37 * 32 });
    expect(onSpeculate).not.toHaveBeenCalled();
  });

  it("stays frame-for-frame in step with vad-web's FrameProcessor while the silence changes", async () => {
    let seed = 42;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    let probability = 0.05;
    const vadOptions = { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, redemptionMs: 2_200, preSpeechPadMs: 300, minSpeechMs: 250, submitUserSpeechOnPause: false };
    const vad = new FrameProcessor(async () => ({ isSpeech: probability, notSpeech: 1 - probability }), () => undefined, vadOptions, FRAME_MS);
    vad.resume();
    const speculations: number[] = [];
    const tracker = new UtteranceTracker({
      frameMs: FRAME_MS,
      positiveThreshold: 0.5,
      negativeThreshold: 0.35,
      redemptionMs: 2_200,
      fallbackRedemptionMs: 1_200,
      preSpeechPadMs: 300,
      minSpeechMs: 250,
      speculateAfterMs: 350,
      maxSpeculationsPerMinute: 6,
      onSpeculate: (_audio, id) => speculations.push(id),
      onRedemptionChange: (ms) => vad.setOptions({ redemptionMs: ms }),
    });
    let ends = 0;
    for (let i = 0; i < 20_000; i++) {
      // Bursts of speech, pauses of every length, in-between probabilities.
      if (random() < 0.04) probability = [0.95, 0.9, 0.6, 0.45, 0.2, 0.05, 0.02][Math.floor(random() * 7)];
      // Speculative transcripts come back at random moments with random verdicts.
      if (speculations.length && random() < 0.08) tracker.endpoint(speculations[speculations.length - 1], [800, 1_200, 2_200, 5_000][Math.floor(random() * 4)]);
      let vadEnded: number | null = null;
      await vad.process(new Float32Array(512).fill(0.05), (event: { msg: string; probs?: { isSpeech: number }; frame?: Float32Array; audio?: Float32Array }) => {
        if (event.msg === "FRAME_PROCESSED") tracker.frame(event.probs!.isSpeech, event.frame!);
        if (event.msg === "SPEECH_END") vadEnded = event.audio!.length;
        if (event.msg === "VAD_MISFIRE") vadEnded = -1;
      });
      const verdict = tracker.takeEnded();
      expect(verdict !== null, `frame ${i}: VAD ended ${vadEnded !== null}, tracker ended ${verdict !== null}`).toBe(vadEnded !== null);
      if (verdict && vadEnded !== -1) expect(verdict.samples).toBe(vadEnded);
      if (verdict) ends++;
    }
    expect(ends).toBeGreaterThan(50);
  });
});

