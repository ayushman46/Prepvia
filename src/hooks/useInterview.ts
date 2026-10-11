"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { ClientApiError, getInterview, saveCanvas, sendEvents, streamTurn, type TurnPayload } from "@/lib/api";
import { SequencedAudioPlayer } from "@/lib/audio-player";
import type { CanvasTaskView, SessionView, TurnEvent, TurnMetrics } from "@/lib/protocol";

export type ChatMessage = { id: string; role: "user" | "ai"; content: string; pending?: boolean; interrupted?: boolean };

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

export type CanvasState = { task: CanvasTaskView | null; content: string; language: string; saving: boolean };

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
};

type Action =
  | { type: "loaded"; session: SessionView }
  | { type: "load_failed"; notFound: boolean; message: string }
  | { type: "processing"; value: boolean }
  | { type: "speaking"; value: boolean }
  | { type: "interrupted"; value: boolean }
  | { type: "add_message"; message: ChatMessage }
  | { type: "update_message"; id: string; content?: string; append?: string; pending?: boolean; interrupted?: boolean }
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
  | { type: "no_speech" };

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
        limitReached: action.session.turn_count >= action.session.max_turns,
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
    case "latency": {
      const others = state.latency.filter((r) => r.turn !== action.record.turn);
      return { ...state, latency: [...others, action.record].sort((a, b) => a.turn - b.turn) };
    }
  }
}

type AiTurn = { messageId: string; texts: Map<number, string>; revealed: Set<number>; interrupted?: boolean };

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
  const pendingTurnRef = useRef<{ payload: TurnPayload; options: { inputAt?: number } } | null>(null);
  const sendTurnRef = useRef<((payload: TurnPayload, options?: { inputAt?: number }) => Promise<boolean>) | null>(null);
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

  /** Show any sentences that were never played (interrupted or playback impossible). */
  const revealRemaining = useCallback((interrupted: boolean) => {
    const turn = aiTurnRef.current;
    if (!turn) return;
    const rest = [...turn.texts.entries()].filter(([seq]) => !turn.revealed.has(seq)).sort((a, b) => a[0] - b[0]);
    for (const [seq, text] of rest) {
      turn.revealed.add(seq);
      dispatch({ type: "update_message", id: turn.messageId, append: text, pending: false });
    }
    // Cut off mid-sentence counts too, even when every sentence had started playing.
    if (interrupted) dispatch({ type: "update_message", id: turn.messageId, interrupted: true });
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
    } catch {
      canvas.dirty = true; // retry on the next flush
    } finally {
      dispatch({ type: "canvas", patch: { saving: false } });
    }
  }, [sessionId]);

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

  const sendTurn = useCallback(
    async (payload: TurnPayload, options: { inputAt?: number } = {}): Promise<boolean> => {
      if ("audio" in payload && stateRef.current.voiceUnavailable) return false;
      if (busyRef.current) {
        // A turn is still finishing (e.g. the candidate barged in while the reply
        // was streaming): queue this answer and send it as soon as the lock frees.
        if (!("continue" in payload)) pendingTurnRef.current = { payload, options };
        return false;
      }
      busyRef.current = true;
      if ("audio" in payload && payload.transcript) {
        // Hold the floor while the speculative transcript settles (it usually already
        // has, during the end-of-turn pause). Empty means Whisper heard no speech:
        // don't start a turn (no bubble, no second transcription of the same noise).
        dispatch({ type: "processing", value: true });
        const speculative = await payload.transcript.catch(() => null);
        if (speculative && (speculative.echo || !speculative.text.trim())) {
          dispatch({ type: "processing", value: false });
          busyRef.current = false;
          dispatch({ type: "no_speech" });
          const seconds = (payload.audio.size - 44) / 32_000;
          if (seconds >= 2 && !speculative.echo) flashNotice("Didn't catch that. Please try again.");
          const queued = pendingTurnRef.current;
          pendingTurnRef.current = null;
          if (queued) setTimeout(() => void sendTurnRef.current?.(queued.payload, queued.options), 0);
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
      const turn = ++turnCounter.current;
      const input: TurnLatency["input"] = "audio" in payload ? "audio" : "text" in payload ? "text" : "continue";
      const record: TurnLatency & { t0: number; inputAt: number; playerTurn?: number } = { turn, input, t0: performance.now(), inputAt };
      latencyRef.current.set(turn, record);

      // Optimistic placeholder so the candidate sees their answer was received.
      let userMessageId: string | null = null;
      if ("audio" in payload) {
        userMessageId = nextId();
        dispatch({ type: "add_message", message: { id: userMessageId, role: "user", content: "", pending: true } });
      } else if ("text" in payload) {
        userMessageId = nextId();
        dispatch({ type: "add_message", message: { id: userMessageId, role: "user", content: payload.text } });
      }

      let lastSeq = 0;
      let finished = false;
      let userConfirmed = "text" in payload;
      let aiMessageId: string | null = null;
      let failed = false;

      const onEvent = (event: TurnEvent) => {
        switch (event.type) {
          case "user_transcript":
            userConfirmed = true;
            if (userMessageId) dispatch({ type: "update_message", id: userMessageId, content: event.content, pending: false });
            break;
          case "no_speech":
            if (userMessageId) dispatch({ type: "remove_message", id: userMessageId });
            userMessageId = null;
            dispatch({ type: "no_speech" });
            flashNotice("Didn't catch that. Please try again.");
            break;
          case "ai_start": {
            record.playerTurn = player?.startTurn();
            aiMessageId = nextId();
            aiTurnRef.current = { messageId: aiMessageId, texts: new Map(), revealed: new Set() };
            dispatch({ type: "add_message", message: { id: aiMessageId, role: "ai", content: "", pending: true } });
            break;
          }
          case "ai_sentence":
            lastSeq = event.seq;
            record.request_to_first_sentence_ms ??= Math.round(performance.now() - record.t0);
            aiTurnRef.current?.texts.set(event.seq, event.content);
            if (aiTurnRef.current?.interrupted) {
              // Interrupted turn: keep the transcript complete (it matches what the server saved).
              aiTurnRef.current.revealed.add(event.seq);
              dispatch({ type: "update_message", id: aiTurnRef.current.messageId, append: event.content, pending: false });
            } else {
              player?.addSentence(event.seq, event.content);
            }
            break;
          case "audio":
            record.request_to_first_audio_event_ms ??= Math.round(performance.now() - record.t0);
            player?.addAudio(event.seq, event.data);
            break;
          case "audio_error":
            player?.markAudioFailed(event.seq);
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
            dispatch({
              type: "error",
              error: {
                message: event.message,
                // Speech-to-text errors mean "say it again": nothing was saved, so a
                // Retry button would have nothing to resend.
                retryable: event.code.startsWith("stt_") ? false : event.retryable,
                // LLM failures happen after the answer is saved, so retrying continues the turn.
                retryContinues: !event.code.startsWith("stt_"),
              },
            });
            break;
          case "done":
            if (event.limit_reached) dispatch({ type: "limit_reached" });
            break;
        }
      };

      try {
        await flushCanvas(); // the interviewer should see the latest canvas work
        if ("audio" in payload && payload.transcript) {
          record.speculative_stt = !!(await payload.transcript.catch(() => null))?.text;
        }
        await streamTurn(sessionId, payload, onEvent, controller.signal);
      } catch (error) {
        failed = true;
        const apiError = error instanceof ClientApiError ? error : new ClientApiError(0, "unknown", "Something went wrong.");
        if (apiError.code !== "aborted" && apiError.code !== "turn_in_progress") {
          if (apiError.code === "turn_limit" || apiError.code === "interview_completed") dispatch({ type: "limit_reached" });
          dispatch({
            type: "error",
            error: {
              message: apiError.message,
              retryable: !["turn_limit", "interview_completed", "session_not_found"].includes(apiError.code),
              retryContinues: userConfirmed,
            },
          });
        }
      } finally {
        if (userMessageId && !userConfirmed) dispatch({ type: "remove_message", id: userMessageId });
        if (aiMessageId && lastSeq === 0) dispatch({ type: "remove_message", id: aiMessageId });
        if (!finished && lastSeq > 0) player?.finishTurn(lastSeq);
        dispatch({ type: "processing", value: false });
        busyRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
        publishLatency(turn);
        const queued = pendingTurnRef.current;
        pendingTurnRef.current = null;
        if (queued) setTimeout(() => void sendTurnRef.current?.(queued.payload, queued.options), 0);
      }
      return !failed;
    },
    [sessionId, flashNotice, flushCanvas, publishLatency],
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
    revealRemaining(true);
    if (aiTurnRef.current) aiTurnRef.current.interrupted = true;
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
    stopAudio,
    updateCanvas,
    flushCanvas,
    getOutputLevel,
    reload: () => load(),
  };
}
