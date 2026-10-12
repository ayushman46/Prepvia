"use client";

import Link from "next/link";
import { createContext, Fragment, useCallback, useContext, useEffect, useState } from "react";
import {
  Briefcase,
  CalendarDays,
  Clock,
  Gauge,
  ListChecks,
  Minus,
  MessageSquareText,
  Plus,
  Printer,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { CompetencyScore, QuestionFeedback, ReportView, SessionView } from "@/lib/protocol";
import {
  confidenceLabel,
  formatDate,
  formatMinutes,
  interviewTypeLabel,
  levelLabel,
  rubricBar,
  rubricLabel,
  scoreTone,
  splitCitations,
} from "./report-format";

export type ReadyReport = Extract<ReportView, { status: "ready" }>;

/** Jump from a [#n] citation to transcript entry n (when the transcript is loaded). */
const CiteContext = createContext<{ count: number; jump: (n: number) => void }>({ count: 0, jump: () => undefined });

function CiteChip({ n, dark }: { n: number; dark?: boolean }) {
  const { count, jump } = useContext(CiteContext);
  const className = cn(
    "ml-1 inline-block rounded-md border px-1.5 align-[0.1em] text-xs font-bold leading-5 no-underline print:border-0 print:px-0.5",
    dark ? "border-cream/40 text-cream" : "border-vast/25 text-vast/80",
  );
  if (n > count) return <span className={className}>#{n}</span>;
  return (
    <a
      href={`#t-${n}`}
      onClick={(event) => {
        event.preventDefault();
        jump(n);
      }}
      className={cn(className, dark ? "hover:bg-cream/15" : "hover:bg-lavender")}
      aria-label={`Transcript entry ${n}`}
    >
      #{n}
    </a>
  );
}

/** Plain text with `code` spans set in monospace. */
function InlineCode({ text, dark }: { text: string; dark?: boolean }) {
  // split() with a capture group puts the code spans at odd indices.
  return (
    <>
      {text.split(/`([^`\n]+)`/g).map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className={cn("rounded px-1 font-mono text-[0.9em]", dark ? "bg-cream/15" : "bg-stone/70")}>
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** Report text with its [#n] citations rendered as links into the transcript. */
function CitedText({ text, dark }: { text: string; dark?: boolean }) {
  return (
    <>
      {splitCitations(text).map((part, i) =>
        "text" in part ? (
          <InlineCode key={i} text={part.text} dark={dark} />
        ) : (
          <span key={i} className="whitespace-nowrap">
            {part.turns.map((n) => (
              <CiteChip key={n} n={n} dark={dark} />
            ))}
          </span>
        ),
      )}
    </>
  );
}

function ScoreRing({ score }: { score: number }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const tone = scoreTone(score);
  return (
    <div className="relative h-36 w-36 shrink-0 md:h-40 md:w-40" role="img" aria-label={`Overall score ${score} out of 100`}>
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90" aria-hidden>
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
          strokeDashoffset={circumference * (1 - Math.max(0, Math.min(100, score)) / 100)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
        <span className="font-serif text-5xl leading-none">{score}</span>
        <span className="text-xs font-bold uppercase tracking-wider text-vast/70">of 100</span>
      </div>
    </div>
  );
}

function ScoreBar({ score, className }: { score: number | null; className?: string }) {
  return (
    <div className={cn("h-2.5 overflow-hidden rounded-full border-2 border-vast bg-stone", className)} aria-hidden>
      {score !== null && <div className={cn("h-full rounded-full", rubricBar(score))} style={{ width: `${(score / 5) * 100}%` }} />}
    </div>
  );
}

function OutOfFive({ score, large }: { score: number | null; large?: boolean }) {
  return (
    <span className="shrink-0 whitespace-nowrap">
      <span className={cn("tabular-nums", large ? "font-serif text-3xl leading-none" : "font-bold")}>{score !== null ? score.toFixed(1) : "–"}</span>
      <span className="font-sans text-sm text-vast/70"> / 5</span>
    </span>
  );
}

function SectionHeading({ id, children, note }: { id: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="mb-6 break-after-avoid">
      <h2 id={id} className="font-serif text-3xl">
        {children}
      </h2>
      {note && <p className="mt-1 text-sm text-vast/70">{note}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ header

function MetaRow({ report, session }: { report: ReadyReport; session: SessionView | null }) {
  const meta = report.meta;
  const answers = meta?.answered_questions ?? session?.transcript.filter((m) => m.role === "user").length;
  const duration = formatMinutes(meta?.duration_minutes) ?? (session ? `${session.duration_minutes} min planned` : null);
  const type = meta?.interview_type ?? session?.interview_type;
  const level = meta?.level ?? session?.level;
  const items: { icon: React.ReactNode; label: string; text: string }[] = [];
  if (session?.target_role) items.push({ icon: <Briefcase size={15} />, label: "Role", text: session.target_role });
  if (level) items.push({ icon: <Gauge size={15} />, label: "Level", text: levelLabel(level) });
  if (type) items.push({ icon: <MessageSquareText size={15} />, label: "Interview type", text: interviewTypeLabel(type) });
  const date = formatDate(session?.started_at ?? session?.created_at);
  if (date) items.push({ icon: <CalendarDays size={15} />, label: "Date", text: date });
  if (duration) items.push({ icon: <Clock size={15} />, label: "Duration", text: duration });
  if (answers !== undefined) items.push({ icon: <ListChecks size={15} />, label: "Answers", text: `${answers} answer${answers === 1 ? "" : "s"}` });
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap justify-center gap-2 md:justify-start" aria-label="Interview details">
      {items.map((item) => (
        <li key={item.label} className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border-2 border-vast/15 px-3 py-1 text-sm font-medium">
          <span className="shrink-0 text-vast/70" aria-hidden>
            {item.icon}
          </span>
          <span className="sr-only">{item.label}: </span>
          <span className="min-w-0 break-words">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Header({ report, session }: { report: ReadyReport; session: SessionView | null }) {
  const tone = scoreTone(report.score);
  const meta = report.meta;
  return (
    <header className="card mb-8 p-6 md:p-10">
      <div className="flex flex-col items-center gap-8 md:flex-row md:items-start">
        <ScoreRing score={report.score} />
        <div className="min-w-0 flex-1 text-center md:text-left">
          <p className="mb-1 break-words text-sm font-bold uppercase tracking-widest text-vast/70">
            {session?.candidate_name ? `${session.candidate_name} · Interview scorecard` : "Interview scorecard"}
          </p>
          <h1 className="mb-4 font-serif text-4xl md:text-5xl">
            <span className={tone.text}>{tone.label}</span> performance
          </h1>
          <MetaRow report={report} session={session} />
          {report.summary ? (
            <p className="mt-5 break-words text-lg leading-relaxed text-vast/85">
              <CitedText text={report.summary} />
            </p>
          ) : (
            <p className="mt-5 text-vast/75">No overall summary was produced for this interview.</p>
          )}
          {meta?.limited_evidence && (
            <p className="mt-5 flex items-start gap-3 rounded-2xl border-2 border-ember bg-ember/15 p-4 text-left text-sm leading-relaxed">
              <TriangleAlert size={18} className="mt-0.5 shrink-0 text-[#9a5b00]" aria-hidden />
              <span>
                <span className="font-bold">Limited evidence. </span>
                This report is based on {meta.substantive_answers} substantive answer{meta.substantive_answers === 1 ? "" : "s"}, so scores
                are provisional and capped. A longer interview gives a more reliable read.
              </span>
            </p>
          )}
          <div className="mt-6 flex flex-wrap justify-center gap-3 md:justify-start print:hidden">
            <Link href="/upload" className="btn-primary">
              Practice again
            </Link>
            <button type="button" onClick={() => window.print()} className="btn-secondary">
              <Printer size={18} aria-hidden /> Save as PDF
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

// ------------------------------------------------------------- sections

function StrengthsAndImprovements({ report }: { report: ReadyReport }) {
  return (
    <div className="mb-8 grid gap-6 md:grid-cols-2">
      <section className="min-w-0 rounded-[32px] border-2 border-vast bg-vast p-6 text-cream md:p-10" aria-labelledby="strengths-heading">
        <h2 id="strengths-heading" className="mb-6 flex items-center gap-3 font-serif text-3xl">
          <span className="h-4 w-4 rounded-full border-2 border-vast bg-green-400" aria-hidden /> Strengths
        </h2>
        <ul className="space-y-4">
          {report.strengths.length ? (
            report.strengths.map((item, i) => (
              <li key={i} className="break-words border-b-2 border-cream/15 pb-4 text-lg leading-relaxed last:border-0 last:pb-0">
                <CitedText text={item} dark />
              </li>
            ))
          ) : (
            <li className="text-cream/80">No specific strengths were identified in this session.</li>
          )}
        </ul>
      </section>
      <section className="card min-w-0 p-6 md:p-10" aria-labelledby="improvements-heading">
        <h2 id="improvements-heading" className="mb-6 flex items-center gap-3 font-serif text-3xl">
          <span className="h-4 w-4 rounded-full border-2 border-vast bg-ember" aria-hidden /> Areas to improve
        </h2>
        <ul className="space-y-4">
          {report.improvements.length ? (
            report.improvements.map((item, i) => (
              <li key={i} className="break-words border-b-2 border-vast/10 pb-4 text-lg leading-relaxed last:border-0 last:pb-0">
                <CitedText text={item} />
              </li>
            ))
          ) : (
            <li className="text-vast/75">No specific improvements were identified in this session.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

function SignalList({ title, items, positive }: { title: string; items: string[]; positive: boolean }) {
  if (items.length === 0) return null;
  const Icon = positive ? Plus : Minus;
  return (
    <div className="min-w-0">
      <h4 className="mb-1 text-xs font-bold uppercase tracking-wider text-vast/70">{title}</h4>
      <ul className="space-y-1 text-sm">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2 break-words">
            <Icon size={14} className={cn("mt-1 shrink-0", positive ? "text-forest" : "text-red-700")} aria-hidden />
            <span className="min-w-0">
              <CitedText text={item} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CompetencyCard({ competency, index }: { competency: CompetencyScore; index: number }) {
  const confidence = confidenceLabel(competency.confidence);
  return (
    <article id={`competency-${index + 1}`} className="min-w-0 scroll-mt-28 break-inside-avoid rounded-2xl border-2 border-vast/15 p-5">
      <div className="mb-1 flex items-baseline justify-between gap-4">
        <h3 className="min-w-0 break-words text-lg font-bold">{competency.name}</h3>
        <OutOfFive score={competency.score} large />
      </div>
      <p className="mb-3 text-sm text-vast/75">
        <span className="font-semibold text-vast">{rubricLabel(competency.score)}</span>
        {confidence && (
          <>
            {" · "}
            {confidence}
            {competency.confidence !== null && ` (${Math.round(competency.confidence * 100)}%)`}
          </>
        )}
      </p>
      <ScoreBar score={competency.score} className="mb-4" />
      {competency.rationale ? (
        <p className="mb-3 break-words leading-relaxed">
          <span className="font-semibold">Why: </span>
          <CitedText text={competency.rationale} />
        </p>
      ) : (
        <p className="mb-3 text-sm text-vast/75">No rationale was given for this score.</p>
      )}
      {competency.evidence.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1 text-xs font-bold uppercase tracking-wider text-vast/70">Evidence</h4>
          <ul className="space-y-1 border-l-4 border-lavender pl-3 text-sm text-vast/85">
            {competency.evidence.map((item, i) => (
              <li key={i} className="break-words">
                <CitedText text={item} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {(competency.positive_signals.length > 0 || competency.negative_signals.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <SignalList title="Positive signals" items={competency.positive_signals} positive />
          <SignalList title="Concerns" items={competency.negative_signals} positive={false} />
        </div>
      )}
    </article>
  );
}

function Scorecard({ competencies }: { competencies: CompetencyScore[] }) {
  return (
    <section className="card mb-8 p-6 md:p-10" aria-labelledby="scorecard-heading" data-testid="scorecard">
      <SectionHeading id="scorecard-heading" note="1 = major gaps · 3 = meets the bar for your level · 5 = exceptional">
        Scorecard
      </SectionHeading>
      {competencies.length === 0 ? (
        <p className="text-vast/75">No competencies could be scored from this interview.</p>
      ) : (
        <>
          <ul className="mb-8 space-y-3 break-inside-avoid" aria-label="Competency overview">
            {competencies.map((c, i) => (
              <li
                key={`${c.name}-${i}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]"
              >
                <a href={`#competency-${i + 1}`} className="min-w-0 break-words font-semibold hover:underline">
                  {c.name}
                </a>
                <ScoreBar score={c.score} className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto" />
                <span className="text-right">
                  <OutOfFive score={c.score} />
                  <span className="sr-only">, {rubricLabel(c.score)}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="grid gap-5 lg:grid-cols-2">
            {competencies.map((c, i) => (
              <CompetencyCard key={`${c.name}-${i}`} competency={c} index={i} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function HandsOn({ report, session }: { report: ReadyReport; session: SessionView | null }) {
  const [showWork, setShowWork] = useState(false);
  const handsOn = report.hands_on;
  if (!handsOn) return null;
  const task = session?.canvas.task;
  const work = session?.canvas.content?.trim() ? session.canvas.content : "";
  return (
    <section className="card mb-8 p-6 md:p-10" aria-labelledby="hands-on-heading">
      <div className="mb-4 flex items-baseline justify-between gap-4 break-after-avoid">
        <div className="min-w-0">
          <h2 id="hands-on-heading" className="font-serif text-3xl">
            Hands-on exercise
          </h2>
          {task?.title && <p className="mt-1 break-words text-sm text-vast/75">Exercise: {task.title}</p>}
        </div>
        <OutOfFive score={handsOn.rating} large />
      </div>
      {report.meta?.hands_on_work_submitted === false && (
        <p className="mb-4 flex items-start gap-3 rounded-2xl border-2 border-ember bg-ember/15 p-4 text-sm">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-[#9a5b00]" aria-hidden />
          <span>No canvas work was submitted: the editor still held only the starter code, so the rating reflects your reasoning alone.</span>
        </p>
      )}
      <p className="mb-5 break-words text-lg leading-relaxed">
        <CitedText text={handsOn.summary} />
      </p>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 font-bold">What worked</h3>
          {handsOn.strengths.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {handsOn.strengths.map((item, i) => (
                <li key={i} className="break-words">
                  <CitedText text={item} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-vast/75">Nothing specific was noted.</p>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 font-bold">Gaps</h3>
          {handsOn.gaps.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {handsOn.gaps.map((item, i) => (
                <li key={i} className="break-words">
                  <CitedText text={item} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-vast/75">No specific gaps were listed.</p>
          )}
        </div>
      </div>
      {work && (
        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-bold">Your canvas work</h3>
            <button
              type="button"
              onClick={() => setShowWork((v) => !v)}
              aria-expanded={showWork}
              aria-controls="canvas-work"
              className="rounded-xl border-2 border-vast px-4 py-1.5 text-sm font-bold hover:bg-lavender print:hidden"
            >
              {showWork ? "Hide" : "Show"}
            </button>
          </div>
          <pre
            id="canvas-work"
            className={cn(
              "mt-3 max-h-96 overflow-auto rounded-xl border-2 border-vast bg-white p-4 text-sm",
              "print:max-h-none print:overflow-visible print:whitespace-pre-wrap print:break-words",
              !showWork && "hidden print:block",
            )}
          >
            {work}
          </pre>
        </div>
      )}
    </section>
  );
}

function QuestionCard({ item, index }: { item: QuestionFeedback; index: number }) {
  return (
    <li className="min-w-0 break-inside-avoid rounded-2xl border-2 border-vast/15 p-5">
      <div className="mb-3 flex items-start justify-between gap-4">
        <h3 className="min-w-0 break-words font-bold">
          <span className="mr-1 text-vast/70">Q{index + 1}.</span>
          <CitedText text={item.question} />
          {item.question_turn !== null && <CiteChip n={item.question_turn} />}
        </h3>
        {item.rating !== null && (
          <span className="shrink-0 whitespace-nowrap rounded-full border-2 border-vast bg-lavender px-2.5 py-0.5 text-sm font-bold">
            <span className="sr-only">Rated </span>
            {item.rating.toFixed(1)}
            <span className="font-normal"> / 5</span>
          </span>
        )}
      </div>
      {item.answer_summary && (
        <p className="mb-3 break-words text-vast/80">
          <span className="font-semibold text-vast">Summary of your answer: </span>
          <CitedText text={item.answer_summary} />
          {item.answer_turns.map((n) => (
            <CiteChip key={n} n={n} />
          ))}
        </p>
      )}
      {item.technical_issues.length > 0 && (
        <div className="mb-3 rounded-xl border-2 border-red-700/25 bg-red-50 px-3 py-2 text-sm">
          <h4 className="mb-1 font-bold text-red-800">Technical issues</h4>
          <ul className="list-disc space-y-1 pl-5">
            {item.technical_issues.map((issue, i) => (
              <li key={i} className="break-words">
                <CitedText text={issue} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.feedback && (
        <p className="mb-3 break-words leading-relaxed">
          <CitedText text={item.feedback} />
        </p>
      )}
      {item.tip && (
        <p className="break-words rounded-xl bg-forest/10 px-3 py-2 text-sm">
          <span className="font-bold text-forest">Try next time: </span>
          <CitedText text={item.tip} />
        </p>
      )}
    </li>
  );
}

function Questions({ items }: { items: QuestionFeedback[] }) {
  if (items.length === 0) return null;
  return (
    <section className="card mb-8 p-6 md:p-10" aria-labelledby="questions-heading">
      <SectionHeading id="questions-heading" note="Each answer is rated on the same 1-5 rubric. Summaries are paraphrases; the transcript has your exact words.">
        Question by question
      </SectionHeading>
      <ol className="space-y-4">
        {items.map((item, i) => (
          <QuestionCard key={i} item={item} index={i} />
        ))}
      </ol>
    </section>
  );
}

function Integrity({ report }: { report: ReadyReport }) {
  const notes = report.integrity.notes;
  return (
    <section className="mb-8 break-inside-avoid rounded-[24px] border-2 border-dashed border-vast/30 p-6" aria-labelledby="integrity-heading">
      <h2 id="integrity-heading" className="mb-2 flex items-center gap-2 text-lg font-bold">
        <ShieldCheck size={18} aria-hidden /> Session integrity
      </h2>
      {notes.length ? (
        <ul className="list-disc space-y-1 pl-5 text-vast/80">
          {notes.map((note, i) => (
            <li key={i} className="break-words">
              <CitedText text={note} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-vast/80">No integrity concerns were recorded in this session.</p>
      )}
      <p className="mt-2 text-sm text-vast/70">In a real interview, staying in the interview tab and typing your own work avoids integrity flags.</p>
    </section>
  );
}

function Transcript({
  session,
  open,
  onToggle,
  highlight,
}: {
  session: SessionView;
  open: boolean;
  onToggle: () => void;
  highlight: number | null;
}) {
  return (
    <section className="card p-6 md:p-10" aria-labelledby="transcript-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 break-after-avoid">
        <h2 id="transcript-heading" className="font-serif text-3xl">
          Full transcript
        </h2>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="transcript-body"
          className="rounded-xl border-2 border-vast px-4 py-1.5 text-sm font-bold hover:bg-lavender print:hidden"
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>
      <ol id="transcript-body" className={cn("mt-6 space-y-2", !open && "hidden print:block")}>
        {session.transcript.map((message, i) => (
          <li
            key={i}
            id={`t-${i + 1}`}
            tabIndex={-1}
            className={cn(
              "scroll-mt-28 break-inside-avoid rounded-xl px-3 py-2 outline-none transition-colors",
              highlight === i + 1 && "bg-lavender/60",
            )}
          >
            <p className="text-xs font-bold uppercase tracking-wider text-vast/70">
              #{i + 1} · {message.role === "user" ? session.candidate_name || "You" : "Interviewer"}
            </p>
            <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The ready report: a Chakra-style scorecard with evidence linked to the transcript. */
export function ReportScorecard({ report, session }: { report: ReadyReport; session: SessionView | null }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [jumpTo, setJumpTo] = useState<{ n: number; seq: number } | null>(null);
  const jump = useCallback((n: number) => {
    setShowTranscript(true);
    setJumpTo((previous) => ({ n, seq: (previous?.seq ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (!jumpTo) return;
    const entry = document.getElementById(`t-${jumpTo.n}`);
    entry?.scrollIntoView({ behavior: "smooth", block: "center" });
    entry?.focus({ preventScroll: true });
  }, [jumpTo]);

  return (
    <CiteContext.Provider value={{ count: session?.transcript.length ?? 0, jump }}>
      <main className="min-h-[100dvh] bg-cream px-4 pb-16 pt-28 text-vast md:px-12 md:pt-32 print:bg-white print:px-0 print:pb-0 print:pt-0">
        <div className="mx-auto max-w-5xl">
          <Header report={report} session={session} />
          <Scorecard competencies={report.competency_scores} />
          <StrengthsAndImprovements report={report} />
          <HandsOn report={report} session={session} />
          <Questions items={report.question_feedback} />
          <Integrity report={report} />
          {session && session.transcript.length > 0 && (
            <Transcript
              session={session}
              open={showTranscript}
              onToggle={() => setShowTranscript((v) => !v)}
              highlight={jumpTo?.n ?? null}
            />
          )}
          <p className="mt-8 text-center text-sm text-vast/70">
            AI feedback can be incomplete or wrong. Treat it as a coaching signal and check it against the transcript.
          </p>
        </div>
      </main>
    </CiteContext.Provider>
  );
}
