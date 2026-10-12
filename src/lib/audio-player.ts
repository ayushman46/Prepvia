/**
 * Plays an interviewer turn sentence-by-sentence in strict `seq` order, even
 * though server-side TTS for later sentences may finish first.
 *
 * - Audio is decoded with the Web Audio API (gapless and low-latency) and routed
 *   through an analyser so the UI can visualise the interviewer's voice.
 * - If server TTS failed for a sentence, the browser's speech synthesis speaks it
 *   instead, so the candidate never misses a question.
 * - Playback can be held (e.g. while the opening is prefetched in the lobby) and
 *   interrupted (barge-in), which returns the sentences that were never spoken.
 * - `unlock()` must be called from a user gesture to satisfy autoplay policies.
 */

type Item = { text?: string; audio?: ArrayBuffer | null };

export type PlayerCallbacks = {
  onSpeakingChange: (speaking: boolean) => void;
  /** A sentence started playing (drives synchronized captions). */
  onSentenceStart?: (seq: number, text: string) => void;
  /** The first sentence of a turn started playing (for latency measurement). */
  onTurnAudioStart?: (turn: number, at: number) => void;
};

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class SequencedAudioPlayer {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuffer: Uint8Array<ArrayBuffer> | null = null;
  private items = new Map<number, Item>();
  private nextSeq = 1;
  private totalSentences: number | null = null;
  private playing = false;
  private held = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private generation = 0;
  private speaking = false;
  private browserSpeaking = false;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private turn = 0;
  private turnAudioStarted = false;
  /** After an interruption, ignore late audio for that turn until the next one starts. */
  private discarding = false;

  constructor(private readonly callbacks: PlayerCallbacks) {}

  /** Create/resume the AudioContext. Call inside a click/tap handler. */
  async unlock(): Promise<void> {
    if (typeof window === "undefined") return;
    if (!this.context) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new Ctx({ latencyHint: "interactive" });
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyser.connect(this.context.destination);
      this.levelBuffer = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    }
    if (this.context.state === "suspended") await this.context.resume().catch(() => undefined);
    // Prime speech synthesis on iOS/Safari, which also requires a gesture.
    if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
  }

  get unlocked(): boolean {
    return !!this.context && this.context.state === "running";
  }

  /** Hold playback (audio keeps buffering) until `release()`. */
  hold(): void {
    this.held = true;
  }

  release(): void {
    this.held = false;
    void this.pump();
  }

  /** Current output level 0..1 (RMS), for visualisation. */
  getLevel(): number {
    if (this.browserSpeaking) return 0.35 + 0.15 * Math.sin(performance.now() / 120);
    if (!this.analyser || !this.levelBuffer || !this.playing) return 0;
    this.analyser.getByteTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const value of this.levelBuffer) {
      const v = (value - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.levelBuffer.length) * 4);
  }

  /** Begin a new interviewer turn, discarding anything left from the last one. */
  startTurn(): number {
    this.stopPlayback();
    this.generation += 1;
    this.items.clear();
    this.nextSeq = 1;
    this.totalSentences = null;
    this.turn += 1;
    this.turnAudioStarted = false;
    this.discarding = false;
    return this.turn;
  }

  addSentence(seq: number, text: string): void {
    if (this.discarding) return;
    const item = this.items.get(seq) ?? {};
    item.text = text;
    this.items.set(seq, item);
    this.armStallTimer();
  }

  addAudio(seq: number, base64: string): void {
    if (this.discarding) return;
    const item = this.items.get(seq) ?? {};
    item.audio = base64ToArrayBuffer(base64);
    this.items.set(seq, item);
    void this.pump();
  }

  /** Server TTS failed for this sentence: fall back to browser speech. */
  markAudioFailed(seq: number): void {
    if (this.discarding) return;
    const item = this.items.get(seq) ?? {};
    item.audio = null;
    this.items.set(seq, item);
    void this.pump();
  }

  /** All sentences for this turn have been announced. */
  finishTurn(totalSentences: number): void {
    if (this.discarding) return;
    this.totalSentences = totalSentences;
    void this.pump();
  }

  /**
   * Barge-in: stop speaking immediately and drop the rest of this turn.
   * Returns the sentences that were never (fully) spoken, in order.
   */
  interrupt(): { seq: number; text: string }[] {
    const pending: { seq: number; text: string }[] = [];
    for (const [seq, item] of this.items) if (item.text) pending.push({ seq, text: item.text });
    pending.sort((a, b) => a.seq - b.seq);
    this.stopPlayback();
    this.generation += 1;
    this.items.clear();
    this.totalSentences = 0;
    this.discarding = true;
    return pending;
  }

  /** Immediately stop playback (e.g. leaving the room). */
  stop(): void {
    this.stopPlayback();
    this.generation += 1;
  }

  dispose(): void {
    this.stop();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.analyser = null;
  }

  private stopPlayback(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    try {
      this.currentSource?.stop();
    } catch {
      // already stopped
    }
    this.currentSource = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    this.browserSpeaking = false;
    this.playing = false;
    this.setSpeaking(false);
  }

  private setSpeaking(value: boolean): void {
    if (this.speaking !== value) {
      this.speaking = value;
      this.callbacks.onSpeakingChange(value);
    }
  }

  /**
   * Safety net: if audio for the next sentence never arrives (e.g. a dropped
   * connection), speak its text with browser TTS rather than stalling forever.
   */
  private armStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    const generation = this.generation;
    this.stallTimer = setTimeout(() => {
      if (generation !== this.generation || this.playing || this.held) return;
      const item = this.items.get(this.nextSeq);
      if (item?.text && item.audio === undefined) this.markAudioFailed(this.nextSeq);
    }, 12_000);
  }

  private async pump(): Promise<void> {
    if (this.playing || this.held) return;
    const item = this.items.get(this.nextSeq);
    if (!item || item.audio === undefined) {
      if (this.totalSentences !== null && this.nextSeq > this.totalSentences) this.setSpeaking(false);
      return;
    }

    const generation = this.generation;
    const seq = this.nextSeq;
    this.playing = true;
    this.setSpeaking(true);
    this.items.delete(seq);

    const onStart = () => {
      if (generation !== this.generation) return;
      if (!this.turnAudioStarted) {
        this.turnAudioStarted = true;
        this.callbacks.onTurnAudioStart?.(this.turn, performance.now());
      }
      if (item.text) this.callbacks.onSentenceStart?.(seq, item.text);
    };

    try {
      if (item.audio) await this.playBuffer(item.audio, onStart);
      else if (item.text) await this.speakWithBrowser(item.text, onStart);
      else onStart();
    } catch (error) {
      console.warn("Audio playback failed; continuing", error);
      if (generation === this.generation && item.text && item.audio) {
        await this.speakWithBrowser(item.text, onStart).catch(() => undefined);
      }
    }

    if (generation !== this.generation) return; // stopped, interrupted, or a new turn began
    this.playing = false;
    this.nextSeq += 1;
    this.armStallTimer();
    void this.pump();
  }

  private async playBuffer(data: ArrayBuffer, onStart: () => void): Promise<void> {
    if (!this.context) await this.unlock();
    const context = this.context as AudioContext;
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    const buffer = await context.decodeAudioData(data.slice(0));
    await new Promise<void>((resolve) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser ?? context.destination);
      source.onended = () => resolve();
      this.currentSource = source;
      source.start(0);
      onStart();
    });
    this.currentSource = null;
  }

  private speakWithBrowser(text: string, onStart: () => void): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        onStart();
        return resolve();
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 1.02;
      const preferred = window.speechSynthesis
        .getVoices()
        .find((voice) => voice.lang.startsWith("en") && /natural|neural|google|samantha|aria/i.test(voice.name));
      if (preferred) utterance.voice = preferred;
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        this.browserSpeaking = true;
        onStart();
      };
      utterance.onstart = start;
      // Some browsers never fire onstart/onend; cap by an estimate of speaking time.
      const fallback = setTimeout(() => done(), Math.max(3_000, text.length * 90));
      const done = () => {
        clearTimeout(fallback);
        start();
        this.browserSpeaking = false;
        resolve();
      };
      utterance.onend = utterance.onerror = done;
      window.speechSynthesis.speak(utterance);
      setTimeout(start, 400); // reveal the caption even if onstart is late
    });
  }
}
