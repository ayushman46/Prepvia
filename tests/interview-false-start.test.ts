import { describe, expect, it } from "vitest";
import { FALSE_START_MS, canAmendLastAnswer, isFalseStart } from "@/hooks/useInterview";

const voiceAt = (elapsed: number, extra: Partial<Parameters<typeof isFalseStart>[0]> = {}) =>
  isFalseStart({ source: "voice", audibleAt: 10_000, now: 10_000 + elapsed, amended: false, ...extra });

describe("isFalseStart", () => {
  it("is 1.5 s, down from 2 s", () => {
    expect(FALSE_START_MS).toBe(1_500);
    expect(voiceAt(FALSE_START_MS - 1)).toBe(true);
    expect(voiceAt(FALSE_START_MS)).toBe(false);
  });

  it("counts a voice interruption shortly after the reply became audible", () => {
    expect(voiceAt(400)).toBe(true);
  });

  it("never counts a manual interruption (Space, Interrupt button, push-to-talk, typed answer)", () => {
    expect(isFalseStart({ source: "manual", audibleAt: 10_000, now: 10_400, amended: false })).toBe(false);
  });

  it("never counts an answer that was itself sent as an amendment", () => {
    expect(voiceAt(400, { amended: true })).toBe(false);
  });

  it("needs the reply to have been heard", () => {
    expect(isFalseStart({ source: "voice", audibleAt: undefined, now: 10_400, amended: false })).toBe(false);
  });

  it("ignores a backwards clock and NaN", () => {
    expect(voiceAt(-100)).toBe(false);
    expect(voiceAt(Number.NaN)).toBe(false);
  });
});

const ready = { hasAnswer: true, started: true, limitReached: false, audible: false, falseStart: false, playingAudibly: false };

describe("canAmendLastAnswer", () => {
  it("amends an answer whose reply has not been heard yet", () => {
    expect(canAmendLastAnswer(ready)).toBe(true);
  });

  it("amends after a false start (the reply was cut off and is no longer playing)", () => {
    expect(canAmendLastAnswer({ ...ready, audible: true, falseStart: true })).toBe(true);
  });

  it("refuses once the reply was heard and was not cut off: a new answer instead", () => {
    expect(canAmendLastAnswer({ ...ready, audible: true })).toBe(false);
  });

  it("never amends while Aria is audibly speaking, even if the answer was marked a false start", () => {
    expect(canAmendLastAnswer({ ...ready, audible: true, falseStart: true, playingAudibly: true })).toBe(false);
  });

  it("never amends while a reply is audibly playing, even before this answer's reply is heard", () => {
    expect(canAmendLastAnswer({ ...ready, playingAudibly: true })).toBe(false);
  });

  it("refuses with no answer, before the interview started, or at the turn limit", () => {
    expect(canAmendLastAnswer({ ...ready, hasAnswer: false })).toBe(false);
    expect(canAmendLastAnswer({ ...ready, started: false })).toBe(false);
    expect(canAmendLastAnswer({ ...ready, limitReached: true })).toBe(false);
  });
});

describe("false-start chain", () => {
  it("stops after one amendment: an amended answer is never false-started again", () => {
    // Answer 1 is heard; the candidate's voice (or Aria's echo) cuts her off 400 ms in.
    let answer = { amended: false, audible: true, falseStart: false, audibleAt: 10_000 };
    const cutOffAt = (now: number) => {
      if (isFalseStart({ source: "voice", audibleAt: answer.audibleAt, now, amended: answer.amended })) answer.falseStart = true;
    };
    cutOffAt(10_400);
    expect(canAmendLastAnswer({ ...ready, audible: answer.audible, falseStart: answer.falseStart })).toBe(true);

    // The utterance amends it: a new answer, sent as an amendment, whose reply is heard.
    answer = { amended: true, audible: true, falseStart: false, audibleAt: 20_000 };
    // Her echo cuts that reply off 400 ms in: this must not count as a false start.
    cutOffAt(20_400);
    expect(answer.falseStart).toBe(false);
    // So the next utterance is a new answer, not another amendment.
    expect(canAmendLastAnswer({ ...ready, audible: answer.audible, falseStart: answer.falseStart })).toBe(false);
  });
});
