import { describe, expect, it } from "vitest";
import { classifyEndpoint } from "@/lib/endpointing";

describe("classifyEndpoint", () => {
  it.each([
    "Yes.",
    "No.",
    "Around two years.",
    "I think so.",
    "I chose Postgres because we needed transactions.",
    "That's how it was.",
    "I liked it, though.",
    "We used Kafka?",
    "Thanks!",
    "It was mostly me and her.",
  ])("treats a finished sentence as complete: %s", (text) => {
    expect(classifyEndpoint(text)).toBe("complete");
  });

  it.each([
    "We split the monolith into three services, and",
    "We split the monolith into three services, and.",
    "The first thing I would check is the",
    "I would use a queue because",
    "So,",
    "So.",
    "Um.",
    "Okay, so.",
    "Well...",
    "The main trade-off was…",
    "It depends on the read pattern, the write volume,",
    "I'd compare it with Redis or",
    "My answer is um",
  ])("treats an unfinished sentence as incomplete: %s", (text) => {
    expect(classifyEndpoint(text)).toBe("incomplete");
  });

  it.each(["Let me think.", "Hmm, let me think about that.", "Give me a second.", "One moment.", "Hold on.", "Just a sec..."])(
    "gives the candidate time when they ask for it: %s",
    (text) => {
      expect(classifyEndpoint(text)).toBe("thinking");
    },
  );

  it.each(["the first thing I would check is the database", "so I think the main issue was the connection pool size, honestly", "Yes"])(
    "is unsure when Whisper left the sentence unpunctuated: %s",
    (text) => {
      expect(classifyEndpoint(text)).toBe("uncertain");
    },
  );

  it("has nothing to decide from without words", () => {
    expect(classifyEndpoint("")).toBe("unknown");
    expect(classifyEndpoint(null)).toBe("unknown");
    expect(classifyEndpoint("...")).toBe("incomplete");
  });
});
