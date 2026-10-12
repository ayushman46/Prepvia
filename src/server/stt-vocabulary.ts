import "server-only";
import { config } from "./config";
import { getSession, type SessionDoc } from "./sessions";
import { vocabularyPrompt } from "./stt";

/** Whisper prompts per session, so speculative transcription (no DB access on its path) usually has one ready. */
const prompts = new Map<string, { prompt: string; at: number }>();
const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 500;

/** The vocabulary prompt for a session document already in hand (and remember it). */
export function sessionPrompt(id: string, session: Pick<SessionDoc, "target_role" | "job_description" | "resume_text">): string | undefined {
  if (!config.groq.sttVocabularyPrompt) return undefined;
  const cached = prompts.get(id);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.prompt;
  const prompt = vocabularyPrompt(session);
  if (prompts.size >= MAX_ENTRIES) prompts.delete(prompts.keys().next().value as string);
  prompts.set(id, { prompt, at: Date.now() });
  return prompt;
}

/** The vocabulary prompt for a session id: from memory, or one database read. */
export async function promptForSession(id: string): Promise<string | undefined> {
  if (!config.groq.sttVocabularyPrompt) return undefined;
  const cached = prompts.get(id);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.prompt;
  const session = await getSession(id);
  return session ? sessionPrompt(id, session) : undefined;
}
