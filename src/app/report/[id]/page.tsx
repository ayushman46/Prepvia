"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { ClientApiError, getInterview, getReport } from "@/lib/api";
import type { SessionView } from "@/lib/protocol";
import { restartReport } from "@/components/report/report-api";
import { transientRetryDelay } from "@/components/report/report-format";
import { ReportScorecard, type ReadyReport } from "@/components/report/ReportScorecard";
import { GeneratingScreen, MessageScreen } from "@/components/report/ReportStatus";

type PageState =
  | { kind: "loading"; elapsedMs: number; retrying: boolean }
  | { kind: "ready"; report: ReadyReport }
  | { kind: "empty" }
  | { kind: "error"; title: string; message: string; retryable: boolean };

const POLL_MS = 2_000;
/** Safety net: the server gives up long before this (two attempts of at most 100 s each). */
const GIVE_UP_MS = 5 * 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

function errorState(error: ClientApiError | null): PageState {
  if (error?.code === "session_not_found") {
    return { kind: "error", title: "We couldn't find this interview", message: error.message, retryable: false };
  }
  if (error?.code === "report_failed") {
    return {
      kind: "error",
      title: "Your report needs another try",
      message: "Our AI reviewer couldn't finish the report after a few attempts. Your answers are safely saved, so try again in a moment.",
      retryable: true,
    };
  }
  return { kind: "error", title: "We couldn't load your report", message: error?.message ?? "Something went wrong loading the report. Your answers are saved, so please try again.", retryable: true };
}

/** Poll until the report is ready, or a final error; transient failures are retried with backoff. */
async function pollReport(
  sessionId: string,
  signal: AbortSignal,
  onProgress: (progress: { elapsedMs: number; retrying: boolean }) => void,
): Promise<PageState | null> {
  const startedAt = Date.now();
  let failures = 0;
  while (!signal.aborted) {
    let waitMs = POLL_MS;
    try {
      const report = await getReport(sessionId, signal);
      if (report.status === "ready") return { kind: "ready", report };
      failures = 0;
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > GIVE_UP_MS) {
        return {
          kind: "error",
          title: "Your report is taking longer than usual",
          message: "It isn't ready yet, but your answers are saved. Try again now, or come back to this page in a few minutes.",
          retryable: true,
        };
      }
      onProgress({ elapsedMs: Math.max(report.elapsed_ms ?? 0, elapsedMs), retrying: !!report.retrying });
    } catch (error) {
      if (signal.aborted) return null;
      const apiError = error instanceof ClientApiError ? error : null;
      if (apiError?.code === "not_enough_content") return { kind: "empty" };
      const delay = transientRetryDelay(apiError, failures);
      if (delay === null) return errorState(apiError);
      failures += 1;
      waitMs = delay;
      onProgress({ elapsedMs: Date.now() - startedAt, retrying: true });
    }
    await sleep(waitMs, signal);
  }
  return null;
}

export default function ReportPage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const [state, setState] = useState<PageState>({ kind: "loading", elapsedMs: 0, retrying: false });
  const [session, setSession] = useState<SessionView | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const forceRestart = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const force = forceRestart.current;
    forceRestart.current = false;
    (async () => {
      if (force) {
        try {
          await restartReport(sessionId);
        } catch (error) {
          if (controller.signal.aborted) return;
          const apiError = error instanceof ClientApiError ? error : null;
          if (apiError?.code === "not_enough_content") return setState({ kind: "empty" });
          // Transient problems are handled by polling below; anything else is shown now.
          if (transientRetryDelay(apiError, 0) === null) return setState(errorState(apiError));
        }
      }
      const next = await pollReport(sessionId, controller.signal, (progress) => {
        if (!controller.signal.aborted) setState({ kind: "loading", ...progress });
      });
      if (next && !controller.signal.aborted) setState(next);
    })();
    getInterview(sessionId, controller.signal).then(setSession, () => undefined);
    return () => controller.abort();
  }, [sessionId, reloadKey]);

  const tryAgain = () => {
    forceRestart.current = true;
    setState({ kind: "loading", elapsedMs: 0, retrying: false });
    setReloadKey((k) => k + 1);
  };

  if (state.kind === "loading") return <GeneratingScreen elapsedMs={state.elapsedMs} retrying={state.retrying} />;

  if (state.kind === "empty") {
    // An active interview can still be answered; an ended one never will be.
    return session?.status === "active" ? (
      <MessageScreen title="Nothing to score yet" message="Your scorecard is built from your answers. Head back, answer at least one question, then end the interview to see your feedback.">
        <Link href={`/interview/${sessionId}`} className="btn-primary">
          Back to interview
        </Link>
        <Link href="/upload" className="btn-secondary">
          Start a new interview
        </Link>
      </MessageScreen>
    ) : (
      <MessageScreen
        title="This interview has no answers to review"
        message="It ended before any answers were recorded, so there's nothing to score. Start a fresh interview and answer even one question to get evidence-backed feedback."
      >
        <Link href="/upload" className="btn-primary">
          Start a new interview
        </Link>
        <Link href="/" className="btn-secondary">
          Back to home
        </Link>
      </MessageScreen>
    );
  }

  if (state.kind === "error") {
    return (
      <MessageScreen title={state.title} message={state.message} alert>
        {state.retryable && (
          <button type="button" onClick={tryAgain} className="btn-primary">
            <RotateCcw size={18} aria-hidden /> Try again
          </button>
        )}
        <Link href="/upload" className="btn-secondary">
          Start a new interview
        </Link>
      </MessageScreen>
    );
  }

  return <ReportScorecard report={state.report} session={session} />;
}
