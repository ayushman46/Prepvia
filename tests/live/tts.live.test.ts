import { afterAll, describe, expect, it } from "vitest";
import { closeTtsPool, prewarmTts, synthesizeSentence, ttsPoolSize } from "@/server/tts";

afterAll(() => closeTtsPool());

describe("edge tts (live network)", () => {
  it("synthesizes mp3 audio on a cold connection", async () => {
    closeTtsPool();
    const started = Date.now();
    const audio = await synthesizeSentence("Hello Jane, welcome to your practice interview.");
    console.log(`cold: bytes=${audio.length} ms=${Date.now() - started}`);
    expect(audio.length).toBeGreaterThan(5000);
    expect(audio[0]).toBe(0xff);
  });

  it("is much faster on a prewarmed connection and reuses sockets", async () => {
    closeTtsPool();
    prewarmTts(2);
    await new Promise((resolve) => setTimeout(resolve, 900)); // simulates STT + LLM time
    const timings: number[] = [];
    for (const text of ["Thanks for walking me through that.", "How did you test it?", "What would you change next time?"]) {
      const started = Date.now();
      const audio = await synthesizeSentence(text);
      timings.push(Date.now() - started);
      expect(audio.length).toBeGreaterThan(3000);
    }
    console.log(`warm timings ms=${timings.join(",")} pool=${ttsPoolSize()}`);
    expect(Math.max(...timings)).toBeLessThan(1500);
    expect(ttsPoolSize()).toBeLessThanOrEqual(4);
  });

  it("handles parallel synthesis across pooled sockets", async () => {
    const started = Date.now();
    const results = await Promise.all(
      ["One sentence here.", "Another sentence here.", "A third sentence here.", "And a fourth one."].map((t) => synthesizeSentence(t)),
    );
    console.log(`parallel x4 ms=${Date.now() - started} pool=${ttsPoolSize()}`);
    expect(results.every((r) => r.length > 3000)).toBe(true);
  });

  it("recovers when a pooled socket has been closed by the server", async () => {
    prewarmTts(2);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const { __dropPooledSocketsForTests } = await import("@/server/tts");
    expect(__dropPooledSocketsForTests()).toBeGreaterThan(0);
    const audio = await synthesizeSentence("Still works after a dropped socket.");
    expect(audio.length).toBeGreaterThan(3000);
  });
});
