import "server-only";

/**
 * Centralised, typed access to environment configuration.
 * Values are read lazily so tests can override process.env per case.
 */

function str(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function int(name: string, fallback: number): number {
  const parsed = Number.parseInt(str(name), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function float(name: string, fallback: number): number {
  const parsed = Number.parseFloat(str(name));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = str(name).toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

export const config = {
  mongo: {
    get uri() {
      return str("MONGODB_URI");
    },
    get dbName() {
      return str("MONGODB_DB_NAME", "interviewai");
    },
  },

  nvidia: {
    get apiKey() {
      return str("NVIDIA_API_KEY");
    },
    get baseUrl() {
      return str("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1");
    },
    /** Benchmarked fastest and strongest for live turns (p50 ~250 ms TTFT with reasoning off). */
    get realtimeModel() {
      return str("NVIDIA_REALTIME_MODEL", "nvidia/nemotron-3-super-120b-a12b");
    },
    /** Different model = independent queue; used to hedge slow first tokens and for failover. */
    get realtimeBackupModel() {
      return str("NVIDIA_REALTIME_BACKUP_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b");
    },
    /** Reports and canvas exercises (once per interview): strongest model, reasoning on. */
    get analysisModel() {
      return str("NVIDIA_ANALYSIS_MODEL", "nvidia/nemotron-3-super-120b-a12b");
    },
    /**
     * Per-answer background notes. NVIDIA's free tier limits each model to ~40
     * requests/minute (measured), so these run on a different model than the
     * live interviewer, leaving its whole budget for real-time turns.
     */
    get notesModel() {
      return str("NVIDIA_NOTES_MODEL", "nvidia/nemotron-3.5-lightning-30b-a3b");
    },
    get realtimeThinking() {
      return bool("NVIDIA_REALTIME_THINKING", false);
    },
    get analysisThinking() {
      return bool("NVIDIA_ANALYSIS_THINKING", true);
    },
    get analysisReasoningBudget() {
      return int("NVIDIA_ANALYSIS_REASONING_BUDGET", 1024);
    },
  },

  groq: {
    get apiKey() {
      return str("GROQ_API_KEY");
    },
    get baseUrl() {
      return str("GROQ_BASE_URL", "https://api.groq.com/openai/v1");
    },
    get sttModel() {
      return str("GROQ_STT_MODEL", "whisper-large-v3-turbo");
    },
    /** Groq chat is only used as a fallback when NVIDIA fails or is not configured. */
    get llmFallback() {
      return bool("LLM_FALLBACK_GROQ", true);
    },
    get realtimeModel() {
      return str("GROQ_REALTIME_MODEL", "llama-3.3-70b-versatile");
    },
    get analysisModel() {
      return str("GROQ_ANALYSIS_MODEL", "llama-3.3-70b-versatile");
    },
  },

  llm: {
    get realtimeTimeoutMs() {
      return float("LLM_REALTIME_TIMEOUT", 15) * 1000;
    },
    /** A live provider that hasn't started streaming by now is abandoned (the turn moves on). */
    get realtimeFirstTokenTimeoutMs() {
      return float("LLM_REALTIME_FIRST_TOKEN_TIMEOUT", 6) * 1000;
    },
    /** Live turns whose providers all failed within this window get one more round. */
    get realtimeRetryWindowMs() {
      return float("LLM_REALTIME_RETRY_WINDOW", 8) * 1000;
    },
    get analysisTimeoutMs() {
      return float("LLM_ANALYSIS_TIMEOUT", 45) * 1000;
    },
    get realtimeTemperature() {
      return float("LLM_REALTIME_TEMPERATURE", 0.7);
    },
    get analysisTemperature() {
      return float("LLM_ANALYSIS_TEMPERATURE", 0.3);
    },
    get realtimeMaxTokens() {
      return int("LLM_REALTIME_MAX_TOKENS", 512);
    },
    get analysisMaxTokens() {
      return int("LLM_ANALYSIS_MAX_TOKENS", 2048);
    },
  },

  tts: {
    get voice() {
      return str("TTS_VOICE", "en-US-AriaNeural");
    },
    get rate() {
      return str("TTS_RATE", "+0%");
    },
    get timeoutMs() {
      return float("TTS_TIMEOUT", 12) * 1000;
    },
    get enabled() {
      return bool("TTS_ENABLED", true);
    },
  },

  analysis: {
    /**
     * Analyze every Nth answer in the background (1 = every answer, 0 = off).
     * The report always reads the full transcript; sampling preserves the shared
     * free-tier LLM budget (~40 requests/minute) for live turns.
     */
    get everyNAnswers() {
      return Math.max(0, int("ANALYSIS_EVERY_N_ANSWERS", 2));
    },
  },

  limits: {
    /** Max interview turns (candidate answers) per session. */
    get maxTurnsPerSession() {
      return int("MAX_TURNS_PER_SESSION", 40);
    },
    get sessionsPerIpPerHour() {
      return int("RATE_LIMIT_SESSIONS_PER_HOUR", 12);
    },
    get uploadsPerIpPerHour() {
      return int("RATE_LIMIT_UPLOADS_PER_HOUR", 20);
    },
    get turnsPerIpPerHour() {
      return int("RATE_LIMIT_TURNS_PER_HOUR", 240);
    },
    get transcriptionsPerIpPerHour() {
      return int("RATE_LIMIT_TRANSCRIPTIONS_PER_HOUR", 600);
    },
    get reportsPerIpPerHour() {
      return int("RATE_LIMIT_REPORTS_PER_HOUR", 30);
    },
    get sessionRetentionDays() {
      return int("SESSION_RETENTION_DAYS", 30);
    },
  },
};

export const testing = {
  /** Testing only: make interview time pass N times faster (e.g. 60 = one minute per second). */
  get clockSpeedup() {
    return Math.max(1, float("INTERVIEW_CLOCK_SPEEDUP", 1));
  },
};

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}
