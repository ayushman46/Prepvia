import "server-only";
import { randomBytes } from "node:crypto";
import { ObjectId, type Filter, type Document } from "mongodb";
import { config } from "./config";
import { getDb } from "./db";
import { ApiError } from "./http";
import { type InterviewPlan } from "./interview-plan";
import {
  defaultInterviewMemory,
  defaultInterviewState,
  memoryFromSession,
  type CanvasTask,
  type Competency,
  type InterviewMemory,
  type InterviewState,
  type QuestionUpdate,
  type TranscriptEntry,
} from "./interview-context";

export type SessionStatus = "active" | "completed";

export type IntegrityEvent = { type: string; at: Date; detail?: string };

export type CanvasState = {
  task?: CanvasTask | null;
  task_status?: "generating" | "ready" | "failed";
  task_claimed_at?: Date;
  /** Set once the interviewer has introduced the exercise. */
  introduced_at?: Date;
  content?: string;
  language?: string;
  updated_at?: Date;
};

export type SessionDoc = Partial<InterviewPlan> & {
  _id: string | ObjectId;
  candidate_name: string;
  target_role: string;
  resume_text: string;
  job_description: string;
  status: SessionStatus;
  interview_state: InterviewState;
  interview_memory: InterviewMemory;
  memory_rev?: number;
  turn_count?: number;
  turn_lock_until?: Date | null;
  turn_lock_id?: string | null;
  created_at: Date;
  updated_at?: Date;
  started_at?: Date;
  /** Aria closed the interview (it is completed once the candidate ends it or opens the report). */
  ended_at?: Date;
  completed_at?: Date;
  expires_at?: Date;
  canvas?: CanvasState;
  integrity_events?: IntegrityEvent[];
};

export type EvaluationDoc = {
  session_id: string;
  status?: "generating" | "ready";
  score?: number;
  strengths?: string[];
  improvements?: string[];
  competency_scores?: unknown[];
  evidence?: unknown[];
  summary?: string;
  started_at?: Date;
  created_at?: Date;
  expires_at?: Date;
};

const NEW_ID = /^[a-f0-9]{32}$/;
const LEGACY_ID = /^[a-f0-9]{24}$/;

export function isValidSessionId(id: string): boolean {
  return NEW_ID.test(id) || LEGACY_ID.test(id);
}

/**
 * New sessions use unguessable 128-bit ids (the URL acts as the access key).
 * Legacy sessions created by the Python backend use ObjectIds and still resolve.
 */
function sessionFilter(id: string): Filter<SessionDoc> {
  if (NEW_ID.test(id)) return { _id: id };
  if (LEGACY_ID.test(id)) return { _id: new ObjectId(id) };
  throw new ApiError(404, "session_not_found", "Interview not found.");
}

function expiry(): Date {
  return new Date(Date.now() + config.limits.sessionRetentionDays * 24 * 60 * 60 * 1000);
}

async function sessions() {
  return (await getDb()).collection<SessionDoc>("sessions");
}

async function transcripts() {
  return (await getDb()).collection<Document>("transcripts");
}

async function evaluations() {
  return (await getDb()).collection<EvaluationDoc>("evaluations");
}

export type CreateSessionInput = {
  name: string;
  role: string;
  resume_text: string;
  job_description: string;
  plan: InterviewPlan;
};

export async function createSession(input: CreateSessionInput): Promise<string> {
  const id = randomBytes(16).toString("hex");
  const now = new Date();
  await (await sessions()).insertOne({
    _id: id,
    candidate_name: input.name,
    target_role: input.role,
    resume_text: input.resume_text,
    job_description: input.job_description,
    ...input.plan,
    canvas: { content: "", language: "text" },
    integrity_events: [],
    status: "active",
    interview_state: defaultInterviewState(),
    interview_memory: defaultInterviewMemory(),
    memory_rev: 0,
    turn_count: 0,
    turn_lock_until: null,
    turn_lock_id: null,
    created_at: now,
    updated_at: now,
    expires_at: expiry(),
  });
  return id;
}

export async function getSession(id: string): Promise<SessionDoc | null> {
  if (!isValidSessionId(id)) return null;
  return (await sessions()).findOne(sessionFilter(id));
}

export async function requireSession(id: string): Promise<SessionDoc> {
  const session = await getSession(id);
  if (!session) throw new ApiError(404, "session_not_found", "Interview not found. It may have expired.");
  return session;
}

/** An interviewer reply the candidate interrupted, as they actually heard it. */
export function heardContent(heard: string): string {
  const said = heard.trim();
  return said ? `${said} [interrupted by the candidate; the rest was never spoken]` : "[interrupted by the candidate before anything was spoken]";
}

/**
 * The conversation in order. Interrupted interviewer replies read as heard (for the
 * interviewer, the analysis and the report) unless `asSaved` asks for the full text.
 */
export async function getTranscripts(id: string, { asSaved = false } = {}): Promise<TranscriptEntry[]> {
  const docs = await (await transcripts())
    .find({ session_id: id }, { projection: { role: 1, content: 1, heard: 1 } })
    .sort({ timestamp: 1, _id: 1 })
    .limit(1000)
    .toArray();
  return docs.map((doc) => ({
    role: doc.role === "user" ? "user" : "ai",
    content: !asSaved && doc.role === "ai" && typeof doc.heard === "string" ? heardContent(doc.heard) : String(doc.content ?? ""),
  }));
}

/** Record what the candidate heard of the latest interviewer reply before interrupting it. */
export async function markLastReplyHeard(id: string, heard: string): Promise<void> {
  const collection = await transcripts();
  const last = await collection.find({ session_id: id }).sort({ timestamp: -1, _id: -1 }).limit(1).next();
  if (last?.role !== "ai") return;
  await collection.updateOne({ _id: last._id }, { $set: { heard: heard.slice(0, 4_000) } });
}

/**
 * The candidate continued their latest answer before hearing the reply to it: append
 * `extra` to that answer and delete the replies to it (never heard). Returns the
 * merged answer, or null if there is no answer to continue.
 */
export async function amendLastAnswer(id: string, extra: string, maxChars: number): Promise<string | null> {
  const collection = await transcripts();
  const answer = await collection.find({ session_id: id, role: "user" }).sort({ timestamp: -1, _id: -1 }).limit(1).next();
  if (!answer) return null;
  const merged = `${String(answer.content ?? "").trim()} ${extra.trim()}`.trim().slice(0, maxChars);
  await Promise.all([
    collection.updateOne({ _id: answer._id }, { $set: { content: merged } }),
    collection.deleteMany({
      session_id: id,
      role: "ai",
      $or: [{ timestamp: { $gt: answer.timestamp } }, { timestamp: answer.timestamp, _id: { $gt: answer._id } }],
    }),
  ]);
  return merged;
}

export async function appendTranscript(id: string, role: "user" | "ai", content: string): Promise<void> {
  await (await transcripts()).insertOne({
    session_id: id,
    role,
    content,
    timestamp: new Date(),
    expires_at: expiry(),
  });
}

/**
 * Serialize turns per session across serverless instances with a lease stored
 * on the session document. The lease expires on its own if an instance dies.
 * Returns the (active) session in the same round trip, or why it failed.
 */
export async function acquireTurnLock(
  id: string,
  leaseMs = 90_000,
): Promise<{ lockId: string; session: SessionDoc } | { error: "not_found" | "completed" | "busy" }> {
  const lockId = randomBytes(8).toString("hex");
  const now = new Date();
  const collection = await sessions();
  const session = await collection.findOneAndUpdate(
    {
      ...sessionFilter(id),
      status: { $ne: "completed" },
      $or: [{ turn_lock_until: null }, { turn_lock_until: { $exists: false } }, { turn_lock_until: { $lt: now } }],
    },
    { $set: { turn_lock_until: new Date(now.getTime() + leaseMs), turn_lock_id: lockId } },
    { returnDocument: "after" },
  );
  if (session) return { lockId, session };
  const existing = await collection.findOne(sessionFilter(id), { projection: { status: 1 } });
  if (!existing) return { error: "not_found" };
  return { error: existing.status === "completed" ? "completed" : "busy" };
}

export async function releaseTurnLock(id: string, lockId: string): Promise<void> {
  await finishTurn(id, lockId, {});
}

/** Per-turn session changes, applied together when the turn's lease is released. */
export type TurnSessionUpdate = {
  incrementTurn?: boolean;
  question?: QuestionUpdate | null;
  startedAt?: Date;
  canvasIntroduced?: boolean;
  /** Aria closed the interview: reopening the link shows the report button, not a live room. */
  ended?: boolean;
  /** Replace the asked-questions list (before `question` adds its entry), e.g. after an unheard reply was withdrawn. */
  questionsAsked?: InterviewState["questions_asked"];
};

/**
 * Release the turn lease and persist every per-turn session change in ONE
 * write. The free Atlas tier allows ~100 operations/second, so collapsing the
 * turn counter, question bookkeeping, clock start and canvas flag into the
 * release raises how many concurrent interviews one free cluster can serve.
 */
export async function finishTurn(id: string, lockId: string, update: TurnSessionUpdate): Promise<void> {
  const $set: Record<string, unknown> = { turn_lock_until: null, turn_lock_id: null, updated_at: new Date() };
  const doc: Record<string, unknown> = { $set };
  if (update.question) {
    Object.assign($set, {
      "interview_state.question_number": update.question.question_number,
      "interview_state.phase": update.question.phase,
      "interview_state.current_difficulty": update.question.current_difficulty,
      "interview_state.current_topic": update.question.current_topic,
      "interview_state.topics_covered": update.question.topics_covered,
    });
    if (update.questionsAsked) $set["interview_state.questions_asked"] = [...update.questionsAsked, update.question.question_entry].slice(-24);
    else doc.$push = { "interview_state.questions_asked": { $each: [update.question.question_entry], $slice: -24 } };
  } else if (update.questionsAsked) {
    $set["interview_state.questions_asked"] = update.questionsAsked;
  }
  if (update.incrementTurn) doc.$inc = { turn_count: 1 };
  if (update.startedAt) $set.started_at = update.startedAt;
  if (update.canvasIntroduced) $set["canvas.introduced_at"] = new Date();
  if (update.ended) $set.ended_at = new Date();
  await (await sessions()).updateOne({ ...sessionFilter(id), turn_lock_id: lockId }, doc);
}

/**
 * Merge background answer analysis with optimistic concurrency so overlapping
 * analyses never silently overwrite each other's evidence.
 */
export async function updateAnalysis(
  id: string,
  merge: (competencies: Competency[], memory: InterviewMemory) => { competencies: Competency[]; memory: InterviewMemory },
  attempts = 4,
): Promise<boolean> {
  const collection = await sessions();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const session = await collection.findOne(sessionFilter(id), {
      projection: { interview_state: 1, interview_memory: 1, memory_rev: 1 },
    });
    if (!session) return false;
    const rev = session.memory_rev ?? 0;
    const current = Array.isArray(session.interview_state?.competencies_assessed)
      ? session.interview_state.competencies_assessed
      : [];
    const next = merge(current, memoryFromSession(session));
    const result = await collection.updateOne(
      { ...sessionFilter(id), $or: rev === 0 ? [{ memory_rev: 0 }, { memory_rev: { $exists: false } }] : [{ memory_rev: rev }] },
      {
        $set: {
          "interview_state.competencies_assessed": next.competencies,
          interview_memory: next.memory,
          memory_rev: rev + 1,
          updated_at: new Date(),
        },
      },
    );
    if (result.modifiedCount === 1) return true;
  }
  return false;
}

/** Record when the interviewer first spoke; the interview clock starts here. */
export async function markStarted(id: string, at = new Date()): Promise<void> {
  await (await sessions()).updateOne({ ...sessionFilter(id), started_at: { $exists: false } }, { $set: { started_at: at } });
}

export async function updateCanvasContent(id: string, content: string, language: string): Promise<boolean> {
  const result = await (await sessions()).updateOne(
    { ...sessionFilter(id), status: { $ne: "completed" } },
    { $set: { "canvas.content": content, "canvas.language": language, "canvas.updated_at": new Date() } },
  );
  return result.matchedCount === 1;
}

/** Claim the right to generate the canvas task (once per session, with stale takeover). */
export async function claimCanvasTask(id: string, staleAfterMs = 60_000): Promise<boolean> {
  const now = new Date();
  const result = await (await sessions()).updateOne(
    {
      ...sessionFilter(id),
      $or: [
        { "canvas.task_status": { $exists: false } },
        { "canvas.task_status": "failed" },
        { "canvas.task_status": "generating", "canvas.task_claimed_at": { $lt: new Date(now.getTime() - staleAfterMs) } },
      ],
    },
    { $set: { "canvas.task_status": "generating", "canvas.task_claimed_at": now } },
  );
  return result.modifiedCount === 1;
}

export async function saveCanvasTask(id: string, task: CanvasTask | null): Promise<void> {
  const update: Record<string, unknown> = task
    ? { "canvas.task": task, "canvas.task_status": "ready", "canvas.language": task.language, "canvas.content": task.starter_code }
    : { "canvas.task_status": "failed" };
  // Never overwrite work the candidate already started.
  const filter = task ? { ...sessionFilter(id), $or: [{ "canvas.content": "" }, { "canvas.content": { $exists: false } }] } : sessionFilter(id);
  const result = await (await sessions()).updateOne(filter, { $set: update });
  if (task && result.matchedCount === 0) {
    await (await sessions()).updateOne(sessionFilter(id), { $set: { "canvas.task": task, "canvas.task_status": "ready" } });
  }
}

const ALLOWED_INTEGRITY_EVENTS = new Set(["tab_hidden", "window_blur", "large_paste", "fullscreen_exit", "copy"]);

export async function appendIntegrityEvents(id: string, events: { type: string; detail?: string }[]): Promise<void> {
  const clean = events
    .filter((event) => ALLOWED_INTEGRITY_EVENTS.has(event.type))
    .slice(0, 50)
    .map((event) => ({ type: event.type, at: new Date(), detail: event.detail ? String(event.detail).slice(0, 200) : undefined }));
  if (clean.length === 0) return;
  await (await sessions()).updateOne(
    { ...sessionFilter(id), status: { $ne: "completed" } },
    { $push: { integrity_events: { $each: clean, $slice: -200 } } },
  );
}

export async function markCompleted(id: string): Promise<void> {
  await (await sessions()).updateOne(
    { ...sessionFilter(id), status: { $ne: "completed" } },
    { $set: { status: "completed", completed_at: new Date(), updated_at: new Date() } },
  );
}

// ---------------------------------------------------------------- evaluations

export function isReadyEvaluation(doc: EvaluationDoc | null): boolean {
  // Legacy evaluations (Python backend) have no status but do have a score.
  return !!doc && doc.status !== "generating" && typeof doc.score === "number";
}

export async function getEvaluation(id: string): Promise<EvaluationDoc | null> {
  return (await evaluations()).findOne({ session_id: id });
}

/**
 * Claim the right to generate a report. Returns true when this caller should
 * generate it; false when another request is already generating (or done).
 */
export async function claimEvaluation(id: string, staleAfterMs = 150_000): Promise<boolean> {
  const collection = await evaluations();
  const now = new Date();
  try {
    const before = await collection.findOneAndUpdate(
      { session_id: id },
      { $setOnInsert: { session_id: id, status: "generating", started_at: now, expires_at: expiry() } },
      { upsert: true, returnDocument: "before" },
    );
    if (!before) return true;
  } catch (error) {
    // Duplicate key from a concurrent upsert: someone else owns the claim.
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
  // Take over a claim abandoned by a crashed or timed-out invocation.
  const takeover = await collection.updateOne(
    { session_id: id, status: "generating", started_at: { $lt: new Date(now.getTime() - staleAfterMs) } },
    { $set: { started_at: now } },
  );
  return takeover.modifiedCount === 1;
}

export async function saveEvaluation(id: string, data: Omit<EvaluationDoc, "session_id">): Promise<void> {
  await (await evaluations()).updateOne(
    { session_id: id },
    { $set: { ...data, status: "ready", created_at: new Date(), expires_at: expiry() }, $unset: { started_at: "" } },
    { upsert: true },
  );
}

export async function releaseEvaluationClaim(id: string): Promise<void> {
  await (await evaluations()).deleteOne({ session_id: id, status: "generating" });
}
