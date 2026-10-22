import { describe, expect, it } from "vitest";
import { EchoAwareBargeIn, GAIN_INITIAL, outputLevelToRms, type EchoFrame } from "@/lib/barge-in";

const FRAME_MS = 32;
const FLOOR = 0.0015;
/** Linear amplitude ratio for a dB difference. */
const db = (decibels: number) => 10 ** (decibels / 20);

const frame = (i: number, outputRms: number, micRms: number, probability = 0.95, noiseFloor = FLOOR): EchoFrame => ({
  t: i * FRAME_MS,
  probability,
  rms: micRms,
  noiseFloor,
  outputRms,
});

/** Aria speaking with a varying level. */
const playbackLevel = (i: number) => 0.1 + 0.08 * Math.sin(i / 3);

describe("outputLevelToRms", () => {
  it("inverts the player's min(1, rms * 4) level", () => {
    expect(outputLevelToRms(0.4)).toBeCloseTo(0.1);
    expect(outputLevelToRms(0)).toBe(0);
    expect(outputLevelToRms(NaN)).toBe(0);
  });
});

describe("EchoAwareBargeIn: echo", () => {
  it("never fires on Aria's own echo (mic = 0.3 x output, Silero 0.95) over 100 frames", () => {
    const d = new EchoAwareBargeIn();
    const fired = Array.from({ length: 100 }, (_, i) => {
      const out = playbackLevel(i);
      return d.push(frame(i, out, 0.3 * out));
    });
    expect(fired.some(Boolean)).toBe(false);
  });

  it("never fires on echo that lags the playback by two frames", () => {
    const d = new EchoAwareBargeIn();
    const outputs = Array.from({ length: 100 }, (_, i) => playbackLevel(i));
    const fired = outputs.map((out, i) => d.push(frame(i, out, i >= 2 ? 0.3 * outputs[i - 2] : 0)));
    expect(fired.some(Boolean)).toBe(false);
  });

  it("starts with the conservative gain before anything is learned", () => {
    expect(new EchoAwareBargeIn().echoGain).toBe(GAIN_INITIAL);
  });

  it("fires on a candidate 15 dB above the echo within 10 frames once the echo is learned", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 40; i++) d.push(frame(i, 0.1, 0.03));
    const candidate = 0.03 * db(15);
    const firedAt = Array.from({ length: 10 }, (_, k) => d.push(frame(40 + k, 0.1, candidate))).indexOf(true);
    expect(firedAt).toBeGreaterThanOrEqual(0);
    expect(firedAt).toBeLessThan(10);
  });

  it("does not fire on a candidate only 6 dB above the echo", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 40; i++) d.push(frame(i, 0.1, 0.03));
    const weak = 0.03 * db(6);
    expect(Array.from({ length: 30 }, (_, k) => d.push(frame(40 + k, 0.1, weak))).some(Boolean)).toBe(false);
  });

  it("does not fire on a candidate that is above the echo but not above the room floor", () => {
    const d = new EchoAwareBargeIn();
    const loudRoom = 0.05;
    for (let i = 0; i < 40; i++) d.push(frame(i, 0.1, 0.03, 0.95, loudRoom));
    // Above the predicted echo (0.03 x 3.98 = 0.12) but below the floor margin (0.05 x 7.94 = 0.40).
    const hum = 0.1;
    expect(Array.from({ length: 30 }, (_, k) => d.push(frame(40 + k, 0.1, hum, 0.95, loudRoom))).some(Boolean)).toBe(false);
  });

  it("needs the Silero probability to clear 0.5", () => {
    const d = new EchoAwareBargeIn();
    expect(Array.from({ length: 30 }, (_, i) => d.push(frame(i, 0, 0.3, 0.45))).some(Boolean)).toBe(false);
  });
});

describe("EchoAwareBargeIn: gain learning", () => {
  it("converges to the true echo gain", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 40; i++) d.observe(frame(i, 0.1, 0.03));
    expect(d.echoGain).toBeCloseTo(0.3, 2);
  });

  it("learns a louder echo instead of staying stuck at the initial gain", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 60; i++) d.observe(frame(i, 0.1, 0.08));
    expect(d.echoGain).toBeCloseTo(0.8, 2);
  });

  it("does not learn from candidate speech while Aria plays", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 60; i++) d.observe(frame(i, 0.1, 0.03));
    const before = d.echoGain;
    for (let i = 60; i < 100; i++) d.observe(frame(i, 0.1, 0.03 * db(15)));
    expect(d.echoGain).toBeCloseTo(before, 6);
  });

  it("does not learn the echo from a candidate who talks over Aria from the start of her reply", () => {
    const d = new EchoAwareBargeIn();
    // The candidate talks 20 dB louder than Aria's echo at the mic: far above the estimate.
    for (let i = 0; i < 30; i++) d.observe(frame(i, 0.1, 0.1 * db(20), 0.9));
    expect(d.echoGain).toBe(GAIN_INITIAL);
  });

  it("still learns a louder echo that persists, even when it is far above the start estimate", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 80; i++) d.observe(frame(i, 0.1, 0.1 * 3, 0.95));
    expect(d.echoGain).toBeCloseTo(3, 1);
  });

  it("then still barges in on that candidate: 15 dB above a learned echo fires", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 60; i++) d.observe(frame(i, 0.1, 0.03));
    let fired = false;
    for (let i = 60; i < 80 && !fired; i++) fired = d.push(frame(i, 0.1, 0.03 * db(15), 0.9));
    expect(fired).toBe(true);
  });

  it("does not learn from silence", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 40; i++) d.observe(frame(i, 0, 0.2));
    expect(d.echoGain).toBe(GAIN_INITIAL);
  });

  it("never drops below the floor in a very quiet echo", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 60; i++) d.observe(frame(i, 0.1, 0.0));
    expect(d.echoGain).toBeGreaterThanOrEqual(0.05);
  });
});

describe("EchoAwareBargeIn: echo tail", () => {
  it("keeps predicting echo for about 400 ms after playback stops, then stops", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 40; i++) d.observe(frame(i, 0.1, 0.03));
    const lastAudible = 39 * FRAME_MS;
    for (let i = 40; i < 60; i++) d.observe(frame(i, 0, 0));
    expect(d.predictedEcho(lastAudible + 200)).toBeGreaterThan(0);
    expect(d.predictedEcho(lastAudible + 450)).toBe(0);
  });

  it("does not fire on the echo tail after playback stops", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 40; i++) d.push(frame(i, 0.1, 0.03));
    // Decaying echo for about 400 ms after the last audible frame (12 frames).
    const tail = Array.from({ length: 12 }, (_, k) => d.push(frame(40 + k, 0, 0.03 * (1 - k / 12))));
    expect(tail.some(Boolean)).toBe(false);
  });

  it("fires on a candidate once the tail has passed", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 40; i++) d.push(frame(i, 0.1, 0.03));
    for (let i = 40; i < 60; i++) d.observe(frame(i, 0, 0));
    const later = Array.from({ length: 10 }, (_, k) => d.push(frame(60 + k, 0, 0.1)));
    expect(later.indexOf(true)).toBeGreaterThanOrEqual(0);
  });
});

describe("EchoAwareBargeIn: window", () => {
  const yes = frame(0, 0, 0.1);
  const no = frame(0, 0, 0.1, 0.1);

  it("fires on 7 of 10 counting frames, and only then", () => {
    const d = new EchoAwareBargeIn();
    const pattern = [yes, yes, no, yes, yes, no, yes, yes, no, yes];
    const fired = pattern.map((f, i) => d.push({ ...f, t: i * FRAME_MS }));
    expect(fired.slice(0, 9).some(Boolean)).toBe(false);
    expect(fired[9]).toBe(true);
  });

  it("does not fire on 6 of 10 counting frames", () => {
    const d = new EchoAwareBargeIn();
    const pattern = [yes, yes, no, yes, yes, no, yes, yes, no, no];
    expect(pattern.map((f, i) => d.push({ ...f, t: i * FRAME_MS })).some(Boolean)).toBe(false);
  });

  it("clears the window when not armed (Aria is not speaking)", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 6; i++) d.push({ ...yes, t: i * FRAME_MS });
    expect(d.push({ ...yes, t: 6 * FRAME_MS }, false)).toBe(false);
    expect(d.windowSize).toBe(0);
    const again = Array.from({ length: 6 }, (_, i) => d.push({ ...yes, t: (7 + i) * FRAME_MS }));
    expect(again.some(Boolean)).toBe(false);
  });

  it("still learns the echo model while not armed", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 40; i++) d.push(frame(i, 0.1, 0.03), false);
    expect(d.echoGain).toBeCloseTo(0.3, 2);
  });
});

describe("EchoAwareBargeIn: safety and reset", () => {
  it("is safe with NaN and zero inputs", () => {
    const d = new EchoAwareBargeIn();
    expect(d.counts(frame(0, 0, 0.4, NaN))).toBe(false);
    expect(d.counts(frame(0, 0, 0))).toBe(false);
    expect(d.push(frame(0, NaN, 0.4))).toBe(false);
    expect(d.echoGain).toBe(GAIN_INITIAL);
  });

  it("reset() forgets the learned gain for a new interview", () => {
    const d = new EchoAwareBargeIn();
    for (let i = 0; i < 40; i++) d.observe(frame(i, 0.1, 0.03));
    expect(d.echoGain).toBeCloseTo(0.3, 2);
    d.reset();
    expect(d.echoGain).toBe(GAIN_INITIAL);
  });
});
