"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  ClientApiError,
  getInterview,
  saveCanvas,
  sendEvents,
  SPECULATION_DEADLINE_MS,
  streamTurn,
  withDeadline,
  type SpeculativeTranscript,
  type TurnPayload,
} from "@/lib/api";
import { concatWav } from "@/lib/wav";
import { SequencedAudioPlayer } from "@/lib/audio-player";
import type { CanvasTaskView, SessionView, TurnEvent, TurnMetrics } from "@/lib/protocol";

export type ChatMessage = {
  id: string;
  role: "user" | "ai";
  content: string;
  pending?: boolean;
  interrupted?: boolean;
  /** Interviewer sentences that were cut off by an interruption and never spoken. */
  unspoken?: string;
};

/**
 * - `processing`: answer sent; waiting for transcription / interviewer text.
 * - `speaking`: interviewer audio is playing.
 * - `ready`: the candidate's turn.
 */
export type TurnStatus = "ready" | "processing" | "speaking";

export type InterviewError = { message: string; retryable: boolean; retryContinues: boolean };

/** Per-turn latency record, also exposed on `window.__interviewMetrics` for automated tests. */
export type TurnLatency = {
  turn: number;
  input: "audio" | "text" | "continue";
  server?: TurnMetrics;
  /** Candidate stopped speaking (VAD) or submitted text -> first interviewer audio audible. */
  response_latency_ms?: number;
  request_to_first_sentence_ms?: number;
  request_to_first_audio_event_ms?: number;
  /** STT ran during the end-of-turn pause (speculative transcript was used). */
  speculative_stt?: boolean;
  interrupted?: boolean;
};

export type CanvasState = {
  task: CanvasTaskView | null;
  content: string;
  language: string;
  saving: boolean;
  /** The last save failed; it is retried automatically. */
  unsaved?: boolean;
};

type State = {
  loadState: "loading" | "loaded" | "not_found" | "error";
  loadError: string | null;
  session: SessionView | null;
  messages: ChatMessage[];
  processing: boolean;
  speaking: boolean;
  /** The candidate barged in; the floor is theirs even if the old turn is still finishing. */
  interrupted: boolean;
  error: InterviewError | null;
  notice: string | null;
  limitReached: boolean;
  questionNumber: number;
  section: string | null;
  caption: string;
  started: boolean;
  startedAt: number | null;
  canvas: CanvasState;
  latency: TurnLatency[];
  /** Speech-to-text can't work on this server (e.g. invalid key): answers must be typed. */
  voiceUnavailable: boolean;
  /** Spoken "answers" that turned out to contain no speech (background noise). */
  noSpeechCount: number;
  /** Aria's reply is held back because the candidate kept talking after their answer was sent. */
  candidateHold: boolean;
};

type Action =
  | { type: "loaded"; session: SessionView }
  | { type: "load_failed"; notFound: boolean; message: string }
  | { type: "processing"; value: boolean }
  | { type: "speaking"; value: boolean }
  | { type: "interrupted"; value: boolean }
  | { type: "add_message"; message: ChatMessage }
  | { type: "update_message"; id: string; content?: string; append?: string; appendUnspoken?: string; pending?: boolean; interrupted?: boolean }
  | { type: "remove_message"; id: string }
  | { type: "error"; error: InterviewError | null }
  | { type: "notice"; notice: string | null }
  | { type: "limit_reached" }
  | { type: "question_number"; value: number }
  | { type: "section"; value: string }
  | { type: "caption"; value: string }
  | { type: "started"; at: number }
  | { type: "canvas"; patch: Partial<CanvasState> }
  | { type: "latency"; record: TurnLatency }
  | { type: "voice_unavailable" }
  | { type: "no_speech" }
  | { type: "candidate_hold"; value: boolean };

const initialState: State = {
  loadState: "loading",
  loadError: null,
  session: null,
  messages: [],
  processing: false,
  speaking: false,
  interrupted: false,
  error: null,
  notice: null,
  limitReached: false,
  questionNumber: 0,
  section: null,
  caption: "",
  started: false,
  startedAt: null,
  canvas: { task: null, content: "", language: "text", saving: false },
  latency: [],
  voiceUnavailable: false,
  noSpeechCount: 0,
  candidateHold: false,
};

let idCounter = 0;
const nextId = () => `m${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "loaded":
      return {
        ...state,
        loadState: "loaded",
        session: action.session,
        questionNumber: action.session.question_number,
        limitReached: action.session.turn_count >= action.session.max_turns || !!action.session.ended,
        error: null,
        startedAt: action.session.started_at ? Date.parse(action.session.started_at) : null,
        messages: action.session.transcript.map((m) => ({ id: nextId(), role: m.role, content: m.content })),
        canvas: {
          task: action.session.canvas.task,
          content: action.session.canvas.content || action.session.canvas.task?.starter_code || "",
          language: action.session.canvas.language || "text",
          saving: false,
        },
      };
    case "load_failed":
      return { ...state, loadState: action.notFound ? "not_found" : "error", loadError: action.message };
    case "processing":
      return { ...state, processing: action.value };
    case "speaking":
      return { ...state, speaking: action.value, caption: action.value ? state.caption : "" };
    case "interrupted":
      return { ...state, interrupted: action.value };
    case "add_message":
      return { ...state, messages: [...state.messages, action.message] };
    case "update_message":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id
            ? {
                ...m,
                content: action.content ?? (action.append ? (m.content ? `${m.content} ${action.append}` : action.append) : m.content),
                unspoken: action.appendUnspoken ? (m.unspoken ? `${m.unspoken} ${action.appendUnspoken}` : action.appendUnspoken) : m.unspoken,
                pending: action.pending ?? m.pending,
                interrupted: action.interrupted ?? m.interrupted,
              }
            : m,
        ),
      };
    case "remove_message":
      return { ...state, messages: state.messages.filter((m) => m.id !== action.id) };
    case "error":
      return { ...state, error: action.error };
    case "notice":
      return { ...state, notice: action.notice };
    case "limit_reached":
      return { ...state, limitReached: true };
    case "question_number":
      return { ...state, questionNumber: action.value };
    case "section":
      return { ...state, section: action.value };
    case "caption":
      return { ...state, caption: action.value };
    case "started":
      return { ...state, started: true, startedAt: state.startedAt ?? action.at };
    case "canvas":
      return { ...state, canvas: { ...state.canvas, ...action.patch } };
    case "voice_unavailable":
      return { ...state, voiceUnavailable: true };
    case "no_speech":
      return { ...state, noSpeechCount: state.noSpeechCount + 1 };
    case "candidate_hold":
      return { ...state, candidateHold: action.value };
    case "latency": {
      const others = state.latency.filter((r) => r.turn !== action.record.turn);
      return { ...state, latency: [...others, action.record].sort((a, b) => a.turn - b.turn) };
    }
  }
}

type AiTurn = { messageId: string; texts: Map<number, string>; revealed: Set<number>; interrupted?: boolean };

/** The latest candidate answer and whether Aria's reply to it has been heard yet. */
type AnswerTurn = {
  turn: number;
  aiStarted: boolean;
  audible: boolean;
  /** performance.now() when the reply started playing. */
  audibleAt?: number;
  /** The candidate cut the reply off right after it started: they were still answering. */
  falseStart?: boolean;
  superseded: boolean;
};

/** Interrupting Aria this soon after her reply starts means the candidate hadn't finished. */
const FALSE_START_MS = 1_500;
/** A sound that hasn't turned into close speech by then doesn't hold Aria's reply. */
const ONSET_HOLD_MS = 400;

type QueuedTurn = { payload: TurnPayload; options: { inputAt?: number }; extraAudio: Blob[] };

/** Failures worth one automatic resend of the same answer (nothing was saved yet). */
const TRANSIENT_CODES = new Set(["network_error", "timeout", "stt_busy", "stt_failed", "turn_in_progress", "rate_limited", "http_error"]);
const isTransient = (failure: { code: string; status?: number }) => TRANSIENT_CODES.has(failure.code) || failure.status === 429 || (failure.status ?? 0) >= 502;

export function useInterview(sessionId: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const playerRef = useRef<SequencedAudioPlayer | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiTurnRef = useRef<AiTurn | null>(null);
  const latencyRef = useRef(new Map<number, TurnLatency & { t0: number; inputAt: number; playerTurn?: number }>());
  const turnCounter = useRef(0);
  const prefetchRef = useRef<"idle" | "running" | "done" | "failed">("idle");
  const releasedAtRef = useRef<number | null>(null);
  const canvasRef = useRef({ content: "", language: "text", dirty: false, timer: null as ReturnType<typeof setTimeout> | null });
  const pendingTurnRef = useRef<QueuedTurn | null>(null);
  const answerTurnRef = useRef<AnswerTurn | null>(null);
  const candidateHoldRef = useRef(false);
  const onsetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** An answer whose turn failed before the server saved it: Retry sends it again. */
  const failedPayloadRef = useRef<{ payload: TurnPayload; options: { inputAt?: number } } | null>(null);
  /** What the candidate heard of an interrupted reply, sent with their next turn. */
  const heardRef = useRef<string | undefined>(undefined);
  const sendTurnRef = useRef<((payload: TurnPayload, options?: { inputAt?: number }, attempt?: number) => Promise<boolean>) | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const publishLatency = useCallback((turn: number) => {
    const record = latencyRef.current.get(turn);
    if (!record) return;
    const publicRecord: TurnLatency = {
      turn: record.turn,
      input: record.input,
      server: record.server,
      response_latency_ms: record.response_latency_ms,
      request_to_first_sentence_ms: record.request_to_first_sentence_ms,
      request_to_first_audio_event_ms: record.request_to_first_audio_event_ms,
      speculative_stt: record.speculative_stt,
      interrupted: record.interrupted,
    };
    dispatch({ type: "latency", record: publicRecord });
    if (typeof window !== "undefined") {
      const w = window as unknown as { __interviewMetrics?: TurnLatency[] };
      w.__interviewMetrics = [...(w.__interviewMetrics ?? []).filter((r) => r.turn !== turn), publicRecord];
    }
  }, []);

  // Reveal a sentence in the transcript and live caption when it starts playing.
  const revealSentence = useCallback((seq: number, text: string) => {
    const turn = aiTurnRef.current;
    if (!turn || turn.revealed.has(seq)) return;
    turn.revealed.add(seq);
    dispatch({ type: "update_message", id: turn.messageId, append: text, pending: false });
    dispatch({ type: "caption", value: text });
  }, []);

  /**
   * Show any sentences that were never played: as said (playback impossible), or as
   * unspoken text after an interruption, so the transcript never claims Aria said them.
   */
  const revealRemaining = useCallback((interrupted: boolean) => {
    const turn = aiTurnRef.current;
    if (!turn) return;
    const rest = [...turn.texts.entries()].filter(([seq]) => !turn.revealed.has(seq)).sort((a, b) => a[0] - b[0]);
    for (const [seq, text] of rest) {
      turn.revealed.add(seq);
      dispatch(
        interrupted
          ? { type: "update_message", id: turn.messageId, appendUnspoken: text, pending: false }
          : { type: "update_message", id: turn.messageId, append: text, pending: false },
      );
    }
    // Cut off mid-sentence counts too, even when every sentence had started playing.
    if (interrupted) dispatch({ type: "update_message", id: turn.messageId, interrupted: true, pending: false });
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const session = await getInterview(sessionId, signal);
        canvasRef.current.content = session.canvas.content || session.canvas.task?.starter_code || "";
        canvasRef.current.language = session.canvas.language || "text";
        dispatch({ type: "loaded", session });
      } catch (error) {
        const apiError = error instanceof ClientApiError ? error : null;
        if (apiError?.code === "aborted") return;
        dispatch({
          type: "load_failed",
          notFound: apiError?.status === 404,
          message: apiError?.message ?? "Couldn't load this interview.",
        });
      }
    },
    [sessionId],
  );

  useEffect(() => {
    const controller = new AbortController();
    const latency = latencyRef.current;
    const player = new SequencedAudioPlayer({
      onSpeakingChange: (speaking) => dispatch({ type: "speaking", value: speaking }),
      onSentenceStart: (seq, text) => revealSentence(seq, text),
      onTurnAudioStart: (playerTurn, at) => {
        const answer = answerTurnRef.current;
        if (answer && latency.get(answer.turn)?.playerTurn === playerTurn) {
          answer.audible = true;
          answer.audibleAt = at;
        }
        for (const [turn, record] of latency) {
          if (record.playerTurn !== playerTurn || record.response_latency_ms !== undefined) continue;
          // A prefetched opening starts when the candidate presses Start.
          const from = Math.max(record.inputAt, releasedAtRef.current ?? 0);
          record.response_latency_ms = Math.round(at - from);
          publishLatency(turn);
        }
      },
    });
    playerRef.current = player;
    void load(controller.signal);
    const canvas = canvasRef.current;
    return () => {
      controller.abort();
      abortRef.current?.abort();
      player.dispose();
      if (playerRef.current === player) playerRef.current = null;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (canvas.timer) clearTimeout(canvas.timer);
    };
  }, [load, revealSentence, publishLatency]);

  const flashNotice = useCallback((notice: string) => {
    dispatch({ type: "notice", notice });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => dispatch({ type: "notice", notice: null }), 4_000);
  }, []);

  // ------------------------------------------------------------- canvas

  const flushCanvas = useCallback(async () => {
    const canvas = canvasRef.current;
    if (canvas.timer) clearTimeout(canvas.timer);
    canvas.timer = null;
    if (!canvas.dirty) return;
    canvas.dirty = false;
    dispatch({ type: "canvas", patch: { saving: true } });
    try {
      await saveCanvas(sessionId, canvas.content, canvas.language);
      dispatch({ type: "canvas", patch: { saving: false, unsaved: false } });
    } catch {
      // Keep the work and try again shortly (the label says it isn't shared yet).
      canvas.dirty = true;
      dispatch({ type: "canvas", patch: { saving: false, unsaved: true } });
      canvas.timer ??= setTimeout(() => void flushCanvasRef.current(), 3_000);
    }
  }, [sessionId]);
  const flushCanvasRef = useRef(flushCanvas);
  useEffect(() => {
    flushCanvasRef.current = flushCanvas;
  }, [flushCanvas]);

  const updateCanvas = useCallback(
    (content: string, language?: string) => {
      const canvas = canvasRef.current;
      canvas.content = content;
      if (language) canvas.language = language;
      canvas.dirty = true;
      dispatch({ type: "canvas", patch: { content, ...(language ? { language } : {}) } });
      if (canvas.timer) clearTimeout(canvas.timer);
      canvas.timer = setTimeout(() => void flushCanvas(), 1_000);
    },
    [flushCanvas],
  );

  // ------------------------------------------------------------- turns

  /** Send the queued answer (merging any audio queued after it) once the current turn is done. */
  const flushQueue = useCallback(() => {
    const queued = pendingTurnRef.current;
    pendingTurnRef.current = null;
    if (!queued) return;
    setTimeout(async () => {
      let payload = queued.payload;
      if (queued.extraAudio.length && "audio" in payload) {
        payload = { audio: await concatWav([payload.audio, ...queued.extraAudio]), amend: payload.amend };
      }
      void sendTurnRef.current?.(payload, queued.options);
    }, 0);
  }, []);

  /** Queue an answer behind the turn in flight; audio queued together is sent as one answer. */
  const queueTurn = useCallback((payload: TurnPayload, options: { inputAt?: number }) => {
    if ("continue" in payload) return;
    const queued = pendingTurnRef.current;
    if (queued && "audio" in queued.payload && "audio" in payload) {
      queued.extraAudio.push(payload.audio);
      return;
    }
    pendingTurnRef.current = { payload, options, extraAudio: [] };
  }, []);

  const sendTurn = useCallback(
    async (payload: TurnPayload, options: { inputAt?: number } = {}, attempt = 0): Promise<boolean> => {
      if ("audio" in payload && stateRef.current.voiceUnavailable) {
        if (!busyRef.current) dispatch({ type: "processing", value: false });
        return false;
      }
      if (busyRef.current) {
        // A turn is still finishing (e.g. the candidate barged in while the reply
        // was streaming): queue this answer and send it as soon as the lock frees.
        queueTurn(payload, options);
        return false;
      }
      busyRef.current = true;
      if (!("continue" in payload) && heardRef.current !== undefined && payload.heard === undefined) {
        payload = { ...payload, heard: heardRef.current };
      }
      const turn = ++turnCounter.current;
      const input: TurnLatency["input"] = "audio" in payload ? "audio" : "text" in payload ? "text" : "continue";
      // This becomes the answer a continuation would amend (restored if it never reaches the server).
      const previousAnswer = answerTurnRef.current;
      const answerTurn: AnswerTurn | null = input !== "continue" ? { turn, aiStarted: false, audible: false, superseded: false } : null;
      if (answerTurn) answerTurnRef.current = answerTurn;
      const superseded = () => !!answerTurn?.superseded;
      if ("audio" in payload && payload.transcript) {
        // Hold the floor while the speculative transcript settles (it usually already
        // has, during the end-of-turn pause). Empty means Whisper heard no speech:
        // don't start a turn (no bubble, no second transcription of the same noise).
        dispatch({ type: "processing", value: true });
        const speculative = await withDeadline(payload.transcript, SPECULATION_DEADLINE_MS);
        if (speculative && (speculative.echo || !speculative.text.trim())) {
          dispatch({ type: "processing", value: false });
          busyRef.current = false;
          if (answerTurnRef.current === answerTurn) answerTurnRef.current = previousAnswer;
          dispatch({ type: "no_speech" });
          if (!speculative.echo) flashNotice("Sorry, I didn't catch that. Could you say it again?");
          flushQueue();
          return true;
        }
      }
      dispatch({ type: "interrupted", value: false });
      const inputAt = options.inputAt ?? performance.now();
      dispatch({ type: "error", error: null });
      dispatch({ type: "processing", value: true });

      const player = playerRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      const record: TurnLatency & { t0: number; inputAt: number; playerTurn?: number } = { turn, input, t0: performance.now(), inputAt };
      latencyRef.current.set(turn, record);

      // Optimistic placeholder so the candidate sees their answer was received. A
      // continuation updates the answer it continues instead of adding a bubble.
      let userMessageId: string | null = null;
      let amended: { id: string; content: string } | null = null;
      if (payload.amend) {
        const last = [...stateRef.current.messages].reverse().find((m) => m.role === "user");
        if (last) {
          amended = { id: last.id, content: last.content };
          userMessageId = last.id;
          dispatch({ type: "update_message", id: last.id, pending: true });
        }
      }
      if (!amended && "audio" in payload) {
        userMessageId = nextId();
        dispatch({ type: "add_message", message: { id: userMessageId, role: "user", content: "", pending: true } });
      } else if (!amended && "text" in payload) {
        userMessageId = nextId();
        dispatch({ type: "add_message", message: { id: userMessageId, role: "user", content: payload.text, pending: true } });
      }

      let lastSeq = 0;
      let finished = false;
      let userConfirmed = false;
      let aiMessageId: string | null = null;
      let failed = false;
      let failure: { code: string; message: string; retryable: boolean; status?: number; retryAfterMs?: number } | null = null;

      const onEvent = (event: TurnEvent) => {
        switch (event.type) {
          case "user_transcript":
            userConfirmed = true;
            heardRef.current = undefined; // delivered with this turn
            failedPayloadRef.current = null;
            if (userMessageId) dispatch({ type: "update_message", id: userMessageId, content: event.content, pending: false });
            break;
          case "no_speech":
            if (amended) dispatch({ type: "update_message", id: amended.id, content: amended.content, pending: false });
            else if (userMessageId) dispatch({ type: "remove_message", id: userMessageId });
            userMessageId = null;
            dispatch({ type: "no_speech" });
            flashNotice("Sorry, I didn't catch that. Could you say it again?");
            break;
          case "ai_start": {
            record.playerTurn = player?.startTurn();
            if (answerTurn) answerTurn.aiStarted = true;
            if (superseded()) {
              player?.interrupt(); // the candidate is still answering: this reply is never played
              break;
            }
            aiMessageId = nextId();
            aiTurnRef.current = { messageId: aiMessageId, texts: new Map(), revealed: new Set() };
            dispatch({ type: "add_message", message: { id: aiMessageId, role: "ai", content: "", pending: true } });
            break;
          }
          case "ai_sentence":
            if (superseded()) break;
            lastSeq = event.seq;
            record.request_to_first_sentence_ms ??= Math.round(performance.now() - record.t0);
            aiTurnRef.current?.texts.set(event.seq, event.content);
            if (aiTurnRef.current?.interrupted) {
              // Interrupted turn: keep the transcript complete (it matches what the server saved).
              aiTurnRef.current.revealed.add(event.seq);
              dispatch({ type: "update_message", id: aiTurnRef.current.messageId, appendUnspoken: event.content, pending: false });
            } else {
              player?.addSentence(event.seq, event.content);
            }
            break;
          case "audio":
            if (superseded()) break;
            record.request_to_first_audio_event_ms ??= Math.round(performance.now() - record.t0);
            player?.addAudio(event.seq, event.data);
            break;
          case "audio_error":
            if (!superseded()) player?.markAudioFailed(event.seq);
            break;
          case "canvas_task":
            dispatch({ type: "canvas", patch: { task: event.task, language: event.task.language } });
            if (!canvasRef.current.content.trim()) {
              canvasRef.current.content = event.task.starter_code;
              canvasRef.current.language = event.task.language;
              dispatch({ type: "canvas", patch: { content: event.task.starter_code } });
            }
            break;
          case "ai_done":
            finished = true;
            if (superseded()) break;
            player?.finishTurn(lastSeq);
            dispatch({ type: "question_number", value: event.question_number });
            break;
          case "metrics":
            record.server = event.metrics;
            if (event.metrics.section) dispatch({ type: "section", value: event.metrics.section });
            break;
          case "error":
            failed = true;
            if (event.code === "stt_unavailable") dispatch({ type: "voice_unavailable" });
            failure = { code: event.code, message: event.message, retryable: event.retryable };
            break;
          case "done":
            if (event.limit_reached && !superseded()) dispatch({ type: "limit_reached" });
            break;
        }
      };

      try {
        await flushCanvas(); // the interviewer should see the latest canvas work
        if ("audio" in payload && payload.transcript) {
          record.speculative_stt = !!(await withDeadline(payload.transcript, SPECULATION_DEADLINE_MS))?.text;
        }
        await streamTurn(sessionId, payload, onEvent, controller.signal);
      } catch (error) {
        failed = true;
        const apiError = error instanceof ClientApiError ? error : new ClientApiError(0, "unknown", "Something went wrong.");
        if (apiError.code !== "aborted") {
          if (apiError.code === "turn_limit" || apiError.code === "interview_completed") dispatch({ type: "limit_reached" });
          failure = {
            code: apiError.code,
            message: apiError.message,
            retryable: !["turn_limit", "interview_completed", "session_not_found"].includes(apiError.code),
            status: apiError.status,
            retryAfterMs: apiError.retryAfterMs,
          };
        }
      } finally {
        const unsaved = !userConfirmed && !("continue" in payload);
        if (unsaved && answerTurnRef.current === answerTurn) answerTurnRef.current = previousAnswer;
        if (userMessageId && !userConfirmed) {
          if (amended) dispatch({ type: "update_message", id: amended.id, content: amended.content, pending: false });
          else dispatch({ type: "remove_message", id: userMessageId });
        }
        if (aiMessageId && lastSeq === 0) dispatch({ type: "remove_message", id: aiMessageId });
        if (!finished && lastSeq > 0 && !superseded()) player?.finishTurn(lastSeq);
        busyRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
        publishLatency(turn);
        const resend = failure && unsaved && failure.code !== "stt_unavailable" && failure.retryable !== false;
        if (failure && resend && attempt === 0 && isTransient(failure) && (failure.retryAfterMs ?? 0) <= 8_000) {
          // Transient failure before the answer was saved: send the same answer again
          // once, without making the candidate repeat it.
          const wait = Math.max(failure.code === "turn_in_progress" ? 800 : 400, failure.retryAfterMs ?? 0);
          setTimeout(() => void sendTurnRef.current?.(payload, options, attempt + 1), wait);
        } else {
          // A queued answer goes out next: stay "thinking" instead of flashing "your turn".
          if (!pendingTurnRef.current) dispatch({ type: "processing", value: false });
          if (failure && failure.code !== "aborted") {
            if (resend)
              failedPayloadRef.current = {
                payload: "audio" in payload ? { audio: payload.audio, amend: payload.amend, heard: payload.heard } : payload,
                options,
              };
            dispatch({
              type: "error",
              error: {
                message: resend ? `${failure.message} Your answer was kept — press Retry to send it again.` : failure.message,
                retryable: resend ? true : failure.code.startsWith("stt_") ? false : failure.retryable,
                // LLM failures happen after the answer is saved, so retrying continues the turn.
                retryContinues: userConfirmed || ("continue" in payload && failure.code !== "stt_unavailable"),
              },
            });
          }
          flushQueue();
        }
      }
      return !failed;
    },
    [sessionId, flashNotice, flushCanvas, publishLatency, flushQueue, queueTurn],
  );

  useEffect(() => {
    sendTurnRef.current = sendTurn;
  }, [sendTurn]);

  // Prefetch the interviewer's opening while the candidate is still in the
  // lobby, so it starts playing the instant they press Start.
  useEffect(() => {
    const session = state.session;
    if (!session || session.status !== "active" || prefetchRef.current !== "idle") return;
    const last = session.transcript[session.transcript.length - 1];
    if (last && last.role === "ai") {
      prefetchRef.current = "done";
      return;
    }
    prefetchRef.current = "running";
    playerRef.current?.hold();
    void sendTurn({ continue: true }).then((ok) => {
      prefetchRef.current = ok ? "done" : "failed";
    });
  }, [state.session, sendTurn]);

  /** Called from the Start button (a user gesture): unlock audio and go live. */
  const begin = useCallback(async () => {
    const player = playerRef.current;
    await player?.unlock();
    releasedAtRef.current = performance.now();
    player?.release();
    dispatch({ type: "started", at: Date.now() });
    void sendEvents(sessionId, [{ type: "started" }]).catch(() => undefined);
    if (prefetchRef.current === "failed") void sendTurn({ continue: true });
  }, [sessionId, sendTurn]);

  /** Barge-in: the candidate started talking over the interviewer. */
  const interrupt = useCallback(() => {
    const player = playerRef.current;
    if (!player || !stateRef.current.speaking) return false;
    player.interrupt();
    const ai = aiTurnRef.current;
    if (ai) {
      // Tell the server what was actually heard, so the conversation and the report
      // don't treat the unspoken rest of the reply as asked.
      heardRef.current = [...ai.texts.entries()]
        .filter(([seq]) => ai.revealed.has(seq))
        .sort((a, b) => a[0] - b[0])
        .map(([, text]) => text)
        .join(" ");
    }
    revealRemaining(true);
    if (aiTurnRef.current) aiTurnRef.current.interrupted = true;
    const answer = answerTurnRef.current;
    if (answer?.audibleAt !== undefined && performance.now() - answer.audibleAt < FALSE_START_MS) answer.falseStart = true;
    dispatch({ type: "speaking", value: false });
    dispatch({ type: "interrupted", value: true });
    for (const record of latencyRef.current.values()) {
      if (record.playerTurn !== undefined && !record.interrupted && record.turn === turnCounter.current) {
        record.interrupted = true;
        publishLatency(record.turn);
      }
    }
    return true;
  }, [revealRemaining, publishLatency]);

  /**
   * The candidate is talking while their last answer is being answered: don't let Aria
   * start speaking over them. A sound only delays her briefly until it turns out to be
   * speech; then the reply waits until they stop. If what they said continues their
   * answer, `amend` replaces the held reply.
   */
  const holdForCandidate = useCallback((activity: "onset" | "speech" | "ended") => {
    const player = playerRef.current;
    if (!player || !stateRef.current.started) return;
    const release = () => {
      if (!candidateHoldRef.current) return;
      candidateHoldRef.current = false;
      if (onsetTimerRef.current) clearTimeout(onsetTimerRef.current);
      onsetTimerRef.current = null;
      player.release();
      dispatch({ type: "candidate_hold", value: false });
    };
    if (activity === "ended") {
      // A continuation that just ended is handed to `amend` in this same task: release after it.
      if (candidateHoldRef.current) setTimeout(release, 0);
      return;
    }
    const answer = answerTurnRef.current;
    if (!answer || answer.audible || answer.superseded || stateRef.current.limitReached) return;
    if (!busyRef.current && !answer.aiStarted) return; // nothing in flight to hold
    if (!candidateHoldRef.current) {
      candidateHoldRef.current = true;
      player.hold();
    }
    if (activity === "onset") {
      if (onsetTimerRef.current) clearTimeout(onsetTimerRef.current);
      onsetTimerRef.current = setTimeout(() => {
        onsetTimerRef.current = null;
        if (!stateRef.current.candidateHold) release(); // never became speech: let Aria talk
      }, ONSET_HOLD_MS);
    } else {
      if (onsetTimerRef.current) clearTimeout(onsetTimerRef.current);
      onsetTimerRef.current = null;
      dispatch({ type: "candidate_hold", value: true });
    }
  }, []);

  /**
   * The candidate kept talking after their answer was sent, before Aria's reply was
   * heard (or right after it started, a false start): add what they said to that
   * answer, and drop the reply (it answered only part of it; the server deletes it and
   * answers the whole answer instead). Returns false when it's a new answer instead.
   */
  const amend = useCallback(
    (audio: Blob, endedAt: number, transcript?: Promise<SpeculativeTranscript | null>): boolean => {
      const answer = answerTurnRef.current;
      if (!answer || (answer.audible && !answer.falseStart) || stateRef.current.limitReached || !stateRef.current.started) return false;
      if (!answer.superseded) {
        answer.superseded = true;
        playerRef.current?.interrupt();
        const ai = aiTurnRef.current;
        if (ai && answer.aiStarted) {
          dispatch({ type: "remove_message", id: ai.messageId });
          aiTurnRef.current = null;
        }
        heardRef.current = undefined; // that reply is withdrawn, not interrupted
        dispatch({ type: "interrupted", value: false });
      }
      if (candidateHoldRef.current) {
        candidateHoldRef.current = false;
        playerRef.current?.release();
        dispatch({ type: "candidate_hold", value: false });
      }
      void sendTurn({ audio, transcript, amend: true }, { inputAt: endedAt });
      return true;
    },
    [sendTurn],
  );

  /** Retry after an error: resend the kept answer, or continue the turn whose answer was saved. */
  const retry = useCallback(() => {
    const failedPayload = failedPayloadRef.current;
    const error = stateRef.current.error;
    dispatch({ type: "error", error: null });
    if (error?.retryContinues) return void sendTurn({ continue: true });
    if (failedPayload) {
      failedPayloadRef.current = null;
      return void sendTurn(failedPayload.payload, failedPayload.options);
    }
    void load();
  }, [sendTurn, load]);

  /** Wait until no answer is being sent or queued (e.g. before ending the interview). */
  const settle = useCallback(async (timeoutMs = 20_000) => {
    const deadline = performance.now() + timeoutMs;
    while ((busyRef.current || pendingTurnRef.current) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, []);

  const stopAudio = useCallback(() => {
    playerRef.current?.stop();
    revealRemaining(false);
  }, [revealRemaining]);

  const getOutputLevel = useCallback(() => playerRef.current?.getLevel() ?? 0, []);

  // After a barge-in the floor belongs to the candidate, even while the old turn finishes.
  // Audible speech wins over "processing": the reply often starts playing while the
  // server is still generating and synthesizing later sentences.
  const turnStatus: TurnStatus = state.interrupted ? "ready" : state.speaking ? "speaking" : state.processing ? "processing" : "ready";

  const markVoiceUnavailable = useCallback(() => dispatch({ type: "voice_unavailable" }), []);

  return {
    ...state,
    turnStatus,
    sendTurn,
    flashNotice,
    markVoiceUnavailable,
    begin,
    interrupt,
    holdForCandidate,
    amend,
    retry,
    settle,
    stopAudio,
    updateCanvas,
    flushCanvas,
    getOutputLevel,
    reload: () => load(),
  };
}
