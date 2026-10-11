"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Printer, RotateCcw } from "lucide-react";
import { ClientApiError, getInterview, getReport } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { ReportView, SessionView } from "@/lib/protocol";

type ReadyReport = Extract<ReportView, { status: "ready" }>;

type PageState =
  | { kind: "loading"; slow: boolean }
  | { kind: "ready"; report: ReadyReport }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string; retryable: boolean };

const POLL_MS = 2_500;

function scoreTone(score: number) {
  if (score >= 75) return { label: "Strong", color: "text-forest", ring: "#034f46" };
  if (score >= 50) return { label: "Developing", color: "text-[#9a5b00]", ring: "#ffa946" };
  return { label: "Needs practice", color: "text-red-700", ring: "#b91c1c" };
}

function ScoreRing({ score }: { score: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const tone = scoreTone(score);
  return (
    <div className="relative h-40 w-40" role="img" aria-label={`Overall score ${score} out of 100`}>
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle cx="64" cy="64" r={radius} fill="none" stroke="#e4e4d0" strokeWidth="12" />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          stroke={tone.ring}
          strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - score / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif text-5xl leading-none">{score}</span>
        <span className="text-xs font-bold uppercase tracking-wider text-vast/60">of 100</span>
      </div>
    </div>
  );
}

/** Poll until the report is ready (or fails); resolves with the next page state. */
async function pollReport(sessionId: string, signal: AbortSignal, onSlow: () => void): Promise<PageState | null> {
  const startedAt = Date.now();
  let slowNotified = false;
  while (!signal.aborted) {
    try {
      const report = await getReport(sessionId, signal);
      if (report.status === "ready") return { kind: "ready", report };
      if (!slowNotified && Date.now() - startedAt > 20_000) {
        slowNotified = true;
        onSlow();
      }
    } catch (error) {
      if (signal.aborted) return null;
      const apiError = error instanceof ClientApiError ? error : null;
      if (apiError?.code === "not_enough_content") return { kind: "empty", message: apiError.message };
      return { kind: "error", message: apiError?.message ?? "Couldn't load the report.", retryable: apiError?.status !== 404 };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

export default function ReportPage() {
  const params = useParams<{ id: string }>();
  const sessionId = params.id;
  const [state, setState] = useState<PageState>({ kind: "loading", slow: false });
  const [session, setSession] = useState<SessionView | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    pollReport(sessionId, controller.signal, () => setState({ kind: "loading", slow: true })).then((next) => {
      if (next && !controller.signal.aborted) setState(next);
    });
    getInterview(sessionId, controller.signal).then(setSession, () => undefined);
    return () => controller.abort();
  }, [sessionId, reloadKey]);

  if (state.kind === "loading") {
    return (
      <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-cream p-6 text-center text-vast">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-vast/15 border-t-forest" aria-hidden />
        <h1 className="font-serif text-3xl">Generating your report…</h1>
        <p className="max-w-md text-vast/70">
          {state.slow
            ? "Still working — detailed evaluations can take up to a minute."
            : "We're reviewing every answer for evidence of each competency."}
        </p>
      </main>
    );
  }

  if (state.kind === "empty" || state.kind === "error") {
    return (
      <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-cream p-6 text-center text-vast">
        <h1 className="font-serif text-3xl">{state.kind === "empty" ? "No report yet" : "Report unavailable"}</h1>
        <p className="max-w-md text-vast/75">{state.message}</p>
        <div className="flex flex-wrap justify-center gap-3">
          {state.kind === "error" && state.retryable && (
            <button
              onClick={() => {
                setState({ kind: "loading", slow: false });
                setReloadKey((k) => k + 1);
              }}
              className="btn-primary"
            >
              <RotateCcw size={18} /> Try again
            </button>
          )}
          {state.kind === "empty" && session?.status === "active" && (
            <Link href={`/interview/${sessionId}`} className="btn-primary">Back to interview</Link>
          )}
          <Link href="/upload" className="btn-secondary">Start a new interview</Link>
        </div>
      </main>
    );
  }

  const { report } = state;
  const tone = scoreTone(report.score);

  return (
    <main className="min-h-[100dvh] bg-cream px-4 pb-16 pt-28 text-vast md:px-12 md:pt-32 print:pt-6">
      <div className="mx-auto max-w-5xl">
        {/* Summary */}
        <section className="card mb-8 flex flex-col items-center gap-8 p-6 md:flex-row md:p-10">
          <ScoreRing score={report.score} />
          <div className="flex-1 text-center md:text-left">
            <p className="mb-1 text-sm font-bold uppercase tracking-widest text-vast/60">
              {session ? `${session.candidate_name} · ${session.target_role}` : "Interview report"}
            </p>
            <h1 className="mb-3 font-serif text-4xl md:text-5xl">
              <span className={tone.color}>{tone.label}</span> performance
            </h1>
            {report.summary && <p className="text-lg leading-relaxed text-vast/85">{report.summary}</p>}
            <div className="mt-5 flex flex-wrap justify-center gap-3 md:justify-start print:hidden">
              <Link href="/upload" className="btn-primary">Practice again</Link>
              <button onClick={() => window.print()} className="btn-secondary">
                <Printer size={18} /> Save as PDF
              </button>
            </div>
          </div>
        </section>

        {/* Strengths & improvements */}
        <div className="mb-8 grid gap-6 md:grid-cols-2">
          <section className="rounded-[32px] border-2 border-vast bg-vast p-6 text-cream md:p-10">
            <h2 className="mb-6 flex items-center gap-3 font-serif text-3xl">
              <span className="h-4 w-4 rounded-full border-2 border-vast bg-green-400" /> Strengths
            </h2>
            <ul className="space-y-4">
              {report.strengths.length ? (
                report.strengths.map((item, i) => (
                  <li key={i} className="border-b-2 border-cream/15 pb-4 text-lg leading-relaxed last:border-0 last:pb-0">{item}</li>
                ))
              ) : (
                <li className="opacity-70">No specific strengths were identified in this session.</li>
              )}
            </ul>
          </section>
          <section className="card p-6 md:p-10">
            <h2 className="mb-6 flex items-center gap-3 font-serif text-3xl">
              <span className="h-4 w-4 rounded-full border-2 border-vast bg-ember" /> Areas to improve
            </h2>
            <ul className="space-y-4">
              {report.improvements.length ? (
                report.improvements.map((item, i) => (
                  <li key={i} className="border-b-2 border-vast/10 pb-4 text-lg leading-relaxed last:border-0 last:pb-0">{item}</li>
                ))
              ) : (
                <li className="opacity-70">Nothing major — keep practicing to stay sharp.</li>
              )}
            </ul>
          </section>
        </div>

        {/* Competency scorecard (1-5 rubric, each with a "why") */}
        {report.competency_scores.length > 0 && (
          <section className="card mb-8 p-6 md:p-10" data-testid="scorecard">
            <h2 className="mb-1 font-serif text-3xl">Scorecard</h2>
            <p className="mb-6 text-sm text-vast/60">1 = major gaps · 3 = meets the bar for your level · 5 = exceptional</p>
            <div className="grid gap-5 md:grid-cols-2">
              {report.competency_scores.map((competency) => (
                <article key={competency.name} className="rounded-2xl border-2 border-vast/15 p-5">
                  <div className="mb-2 flex items-baseline justify-between gap-4">
                    <h3 className="text-lg font-bold">{competency.name}</h3>
                    <span className="shrink-0 font-serif text-3xl leading-none">
                      {competency.score !== null ? competency.score.toFixed(1) : "–"}
                      <span className="font-sans text-sm text-vast/50"> / 5</span>
                    </span>
                  </div>
                  {competency.score !== null && (
                    <div className="mb-3 h-2.5 overflow-hidden rounded-full border-2 border-vast bg-stone">
                      <div className="h-full rounded-full bg-forest" style={{ width: `${(competency.score / 5) * 100}%` }} />
                    </div>
                  )}
                  {competency.rationale && (
                    <p className="mb-2 leading-relaxed">
                      <span className="font-semibold">Why: </span>
                      {competency.rationale}
                    </p>
                  )}
                  {competency.evidence.length > 0 && (
                    <ul className="space-y-1 border-l-4 border-lavender pl-3 text-sm italic text-vast/75">
                      {competency.evidence.slice(0, 3).map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  )}
                  {competency.confidence !== null && (
                    <p className="mt-2 text-xs text-vast/50">Confidence {Math.round(competency.confidence * 100)}%</p>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Hands-on exercise */}
        {report.hands_on && (
          <section className="card mb-8 p-6 md:p-10">
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 className="font-serif text-3xl">Hands-on exercise</h2>
              {report.hands_on.rating !== null && (
                <span className="font-serif text-3xl">
                  {report.hands_on.rating.toFixed(1)}
                  <span className="font-sans text-sm text-vast/50"> / 5</span>
                </span>
              )}
            </div>
            <p className="mb-4 text-lg leading-relaxed">{report.hands_on.summary}</p>
            <div className="grid gap-4 md:grid-cols-2">
              {report.hands_on.strengths.length > 0 && (
                <div>
                  <h3 className="mb-2 font-bold">What worked</h3>
                  <ul className="list-disc space-y-1 pl-5">{report.hands_on.strengths.map((item, i) => <li key={i}>{item}</li>)}</ul>
                </div>
              )}
              {report.hands_on.gaps.length > 0 && (
                <div>
                  <h3 className="mb-2 font-bold">Gaps</h3>
                  <ul className="list-disc space-y-1 pl-5">{report.hands_on.gaps.map((item, i) => <li key={i}>{item}</li>)}</ul>
                </div>
              )}
            </div>
            {session?.canvas.content && (
              <details className="mt-5">
                <summary className="cursor-pointer font-semibold">Your canvas work</summary>
                <pre className="mt-3 max-h-96 overflow-auto rounded-xl border-2 border-vast bg-white p-4 text-sm">{session.canvas.content}</pre>
              </details>
            )}
          </section>
        )}

        {/* Question by question */}
        {report.question_feedback.length > 0 && (
          <section className="card mb-8 p-6 md:p-10">
            <h2 className="mb-6 font-serif text-3xl">Question by question</h2>
            <ol className="space-y-4">
              {report.question_feedback.map((item, i) => (
                <li key={i} className="rounded-2xl border-2 border-vast/15 p-5">
                  <div className="mb-2 flex items-start justify-between gap-4">
                    <p className="font-bold">
                      {i + 1}. {item.question}
                    </p>
                    {item.rating !== null && (
                      <span className="shrink-0 rounded-full border-2 border-vast bg-lavender px-2.5 py-0.5 text-sm font-bold">{item.rating.toFixed(1)}</span>
                    )}
                  </div>
                  {item.answer_summary && <p className="mb-2 text-vast/70">You said: {item.answer_summary}</p>}
                  {item.feedback && <p className="mb-2 leading-relaxed">{item.feedback}</p>}
                  {item.tip && (
                    <p className="rounded-xl bg-forest/10 px-3 py-2 text-sm">
                      <span className="font-bold text-forest">Try next time: </span>
                      {item.tip}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Session signals */}
        {report.integrity.notes.length > 0 && (
          <section className="mb-8 rounded-[24px] border-2 border-dashed border-vast/30 p-6">
            <h2 className="mb-2 font-bold">Session signals</h2>
            <ul className="list-disc space-y-1 pl-5 text-vast/75">
              {report.integrity.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-vast/50">In a real interview, staying in the interview tab and typing your own work avoids integrity flags.</p>
          </section>
        )}

        {/* Transcript */}
        {session && session.transcript.length > 0 && (
          <section className="card p-6 md:p-10">
            <button
              onClick={() => setShowTranscript((v) => !v)}
              className="flex w-full items-center justify-between font-serif text-3xl print:hidden"
              aria-expanded={showTranscript}
            >
              Full transcript <span className="font-sans text-base font-semibold">{showTranscript ? "Hide" : "Show"}</span>
            </button>
            <div className={cn("mt-6 space-y-4", !showTranscript && "hidden print:block")}>
              {session.transcript.map((message, i) => (
                <div key={i}>
                  <p className="text-xs font-bold uppercase tracking-wider text-vast/50">
                    {message.role === "user" ? session.candidate_name : "Interviewer"}
                  </p>
                  <p className="leading-relaxed">{message.content}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <p className="mt-8 text-center text-sm text-vast/55">
          AI feedback can be incomplete or wrong. Treat it as a coaching signal and review the transcript.
        </p>
      </div>
    </main>
  );
}
