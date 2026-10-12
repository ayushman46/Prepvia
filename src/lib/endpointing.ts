/**
 * Semantic end-of-turn detection: decide from the speculative transcript of a
 * pause whether the candidate has finished, so a thinking pause ("…and", "um",
 * "let me think") doesn't end their answer, while finished answers still get a
 * fast reply.
 */

/**
 * complete: a finished sentence. uncertain: no closing punctuation (Whisper usually
 * leaves it off when the voice didn't fall at the end). incomplete: a sentence that
 * is clearly still going. thinking: the candidate asked for time. unknown: no words.
 */
export type EndpointKind = "complete" | "uncertain" | "incomplete" | "thinking" | "unknown";

// Words that (almost) never end a finished English sentence. Deliberately absent:
// "so" ("I think so."), "like", "then", "too", "though", "her", "is/was" ("that's how it was.").
const CONTINUATION_WORDS = new Set(
  "and but or nor because cause the a an to of with from into onto my our your their if whether than versus um umm uh uhh er erm hmm".split(" "),
);

// A whole utterance that only stalls for time.
const STALLING = /^(?:so|well|okay so|ok so|right so|yeah so|um+|uh+|hmm+|er+m?|basically|actually|i mean|you know)$/;

// The candidate asked for time: wait much longer before taking the turn.
const THINKING =
  /\b(?:let me (?:think|see|recall|remember)(?: (?:about|of|on|for|through) (?:it|that|this|a (?:second|sec|moment|bit)|the question))?|give me (?:a|one) (?:second|sec|moment|minute)|one (?:second|sec|moment)|just a (?:second|sec|moment)|hold on|i need (?:a|to) (?:moment|second|think)|thinking about (?:it|that|this))\b[^a-z]*$/;

/** Classify a (speculative) transcript of everything the candidate said before the pause. */
export function classifyEndpoint(transcript: string | null | undefined): EndpointKind {
  const text = (transcript ?? "").trim();
  if (!text) return "unknown";
  const lower = text.toLowerCase();
  if (THINKING.test(lower)) return "thinking";
  // Trailing comma, colon, dash or ellipsis: the sentence is still going.
  if (/(?:[,;:\-–—]|\.\.\.|…)\s*$/.test(text)) return "incomplete";
  const words = lower.match(/[a-z']+/g) ?? [];
  if (words.length === 0) return "unknown";
  if (STALLING.test(words.join(" "))) return "incomplete";
  if (CONTINUATION_WORDS.has(words[words.length - 1])) return "incomplete";
  if (!/[.?!]["')\]]*$/.test(text)) return "uncertain";
  return "complete";
}
