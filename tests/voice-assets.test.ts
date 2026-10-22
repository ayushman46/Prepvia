import { describe, expect, it } from "vitest";
import { shouldPrefetchVoice } from "@/lib/voice-assets";

describe("shouldPrefetchVoice", () => {
  it("prefetches on normal and unknown connections", () => {
    expect(shouldPrefetchVoice(undefined)).toBe(true);
    expect(shouldPrefetchVoice({ effectiveType: "4g" })).toBe(true);
    expect(shouldPrefetchVoice({ effectiveType: "3g" })).toBe(true);
  });

  it("skips data-saver and 2G links", () => {
    expect(shouldPrefetchVoice({ saveData: true, effectiveType: "4g" })).toBe(false);
    expect(shouldPrefetchVoice({ effectiveType: "2g" })).toBe(false);
    expect(shouldPrefetchVoice({ effectiveType: "slow-2g" })).toBe(false);
  });
});
