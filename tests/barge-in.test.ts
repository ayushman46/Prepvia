import { describe, expect, it } from "vitest";
import { BargeInDetector, isBargeInFrame, outputLevelToRms } from "@/lib/barge-in";

const quiet = { noiseFloor: 0.0015, outputRms: 0 };

describe("isBargeInFrame", () => {
  it("counts confident frames regardless of level", () => {
    expect(isBargeInFrame({ probability: 0.75, rms: 0.001, ...quiet })).toBe(true);
  });
  it("counts moderate frames that are loud over the floor and over the echo", () => {
    expect(isBargeInFrame({ probability: 0.5, rms: 0.15, noiseFloor: 0.0015, outputRms: 0.03 })).toBe(true);
  });
  it("rejects moderate frames close to the room floor", () => {
    expect(isBargeInFrame({ probability: 0.5, rms: 0.01, noiseFloor: 0.0015, outputRms: 0 })).toBe(false);
  });
  it("rejects moderate frames no louder than Aria's own playback (echo)", () => {
    expect(isBargeInFrame({ probability: 0.6, rms: 0.05, noiseFloor: 0.0015, outputRms: 0.05 })).toBe(false);
  });
  it("rejects low-probability frames even when loud", () => {
    expect(isBargeInFrame({ probability: 0.2, rms: 0.4, ...quiet })).toBe(false);
  });
  it("is safe with NaN / zero inputs", () => {
    expect(isBargeInFrame({ probability: NaN, rms: 0.4, ...quiet })).toBe(false);
    expect(isBargeInFrame({ probability: 0.5, rms: 0, ...quiet })).toBe(false);
  });
});

describe("BargeInDetector", () => {
  it("fires on 7 of 10 moderate-but-loud frames and resets", () => {
    const d = new BargeInDetector();
    const voice = { probability: 0.55, rms: 0.2, noiseFloor: 0.0015, outputRms: 0.02 };
    const dip = { probability: 0.1, rms: 0.02, noiseFloor: 0.0015, outputRms: 0.02 };
    const seq = [voice, voice, dip, voice, voice, dip, voice, voice, voice];
    const fired = seq.map((f) => d.push(f));
    expect(fired.at(-1)).toBe(true);
    expect(fired.slice(0, -1).some(Boolean)).toBe(false);
    expect(d.size).toBe(0);
  });
  it("does not fire on echo of Aria's voice at moderate probability", () => {
    const d = new BargeInDetector();
    const echo = { probability: 0.6, rms: 0.04, noiseFloor: 0.0015, outputRms: outputLevelToRms(0.3) };
    expect(Array.from({ length: 30 }, () => d.push(echo)).some(Boolean)).toBe(false);
  });
});
