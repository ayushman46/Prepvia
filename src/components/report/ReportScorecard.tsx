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

function CiteChip({ n }: { n: number }) {
  const { count, jump } = useContext(CiteContext);
  const className =
    "ml-1 inline-block rounded-md border border-vast/25 px-1.5 align-[0.1em] text-xs font-bold not-italic leading-5 text-vast/80 no-underline print:border-0 print:px-0.5";
  if (n > count) return <span className={className}>#{n}</span>;
  return (
    <a
      href={`#t-${n}`}
      onClick={(event) => {
        event.preventDefault();
        jump(n);
      }}
      className={cn(className, "hover:bg-lavender")}
      aria-label={`Transcript entry ${n}`}
    >
      #{n}
    </a>
  );
}

/** Plain text with `code` spans set in monospace. */
function InlineCode({ text }: { text: string }) {
  // split() with a capture group puts the code spans at odd indices.
  return (
    <>
      {text.split(/`([^`\n]+)`/g).map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-stone/70 px-1 font-mono text-[0.9em] not-italic">
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
function CitedText({ text }: { text: string }) {
  return (
    <>
      {splitCitations(text).map((part, i) =>
        "text" in part ? (
          <InlineCode key={i} text={part.text} />
        ) : (
          <span key={i} className="whitespace-nowrap">
            {part.turns.map((n) => (
              <CiteChip key={n} n={n} />
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
    <div className="relative h-36 w-36 shrink-0 md:h-40 md:w-40 print:h-28 print:w-28" role="img" aria-label={`Overall score ${score} out of 100`}>
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
        <span className="font-serif text-5xl leading-none print:text-4xl">{score}</span>
        <span className="text-xs font-bold uppercase tracking-wider text-vast/70">of 100</span>
      </div>
    </div>
  );
}

function ScoreBar({ score, className }: { score: number | null; className?: string }) {
  return (
    <div className={cn("relative h-2.5 overflow-hidden rounded-full border-2 border-vast bg-stone", className)} aria-hidden>
      {score !== null && <div className={cn("h-full rounded-full", rubricBar(score))} style={{ width: `${(score / 5) * 100}%` }} />}
      {/* "Meets the bar" (3 / 5) reference tick. */}
      <span className="absolute inset-y-0 left-[60%] w-px bg-vast/40" />
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
    <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm text-vast/70 md:justify-start" aria-label="Interview details">
      {items.map((item) => (
        <li key={item.label} className="inline-flex min-w-0 max-w-full items-center gap-1.5">
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
          <h1 className="mb-4 font-serif text-4xl md:text-5xl print:text-4xl">
            Overall: <span className={tone.text}>{tone.label}</span>
          </h1>
          <MetaRow report={report} session={session} />
          {report.summary ? (
            <p className="mt-5 break-words text-lg leading-relaxed text-vast/85">
              <CitedText text={report.summary} />
            </p>
          ) : (
            <p className="mt-5 text-vast/75">We couldn't write an overall summary for this one, but the scores and feedback below still apply.</p>
          )}
          {meta?.limited_evidence && (
            <p className="mt-5 flex items-start gap-3 rounded-2xl border-2 border-ember bg-ember/15 p-4 text-left text-sm leading-relaxed">
              <TriangleAlert size={18} className="mt-0.5 shrink-0 text-[#9a5b00]" aria-hidden />
              <span>
                <span className="font-bold">Limited evidence. </span>
                This report is based on {meta.substantive_answers} substantive answer{meta.substantive_answers === 1 ? "" : "s"}, so scores
                are provisional and capped. Answer a few more questions next time for a fuller, more reliable read.
              </span>
            </p>
          )}
          <div className="mt-6 flex flex-wrap justify-center gap-3 md:justify-start print:hidden">
            <Link href="/upload" className="btn-primary">
              Practice another round
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
    <div className="mb-8 grid gap-6 md:grid-cols-2 print:grid-cols-2 print:gap-4">
      <section className="card min-w-0 p-6 md:p-10" aria-labelledby="strengths-heading">
        <h2 id="strengths-heading" className="mb-6 flex items-center gap-3 font-serif text-2xl">
          <span className="h-4 w-4 rounded-full border-2 border-vast bg-green-400" aria-hidden /> Strengths
        </h2>
        <ul className="space-y-4">
          {report.strengths.length ? (
            report.strengths.map((item, i) => (
              <li key={i} className="break-words border-b-2 border-vast/10 pb-4 text-lg leading-relaxed last:border-0 last:pb-0">
                <CitedText text={item} />
              </li>
            ))
          ) : (
            <li className="text-vast/75">No standout strengths were flagged this time. Longer, more detailed answers give the reviewer more to recognize.</li>
          )}
        </ul>
      </section>
      <section className="card min-w-0 p-6 md:p-10" aria-labelledby="improvements-heading">
        <h2 id="improvements-heading" className="mb-6 flex items-center gap-3 font-serif text-2xl">
          <span className="h-4 w-4 rounded-full border-2 border-vast bg-ember" aria-hidden /> What to work on next
        </h2>
        <ul className="space-y-4">
          {report.improvements.length ? (
            report.improvements.map((item, i) => (
              <li key={i} className="break-words border-b-2 border-vast/10 pb-4 text-lg leading-relaxed last:border-0 last:pb-0">
                <CitedText text={item} />
              </li>
            ))
          ) : (
            <li className="text-vast/75">No specific improvements were flagged this time. Keep practicing to stay sharp.</li>
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
      <p className="mb-4 text-sm text-vast/75">
        <span className="font-semibold text-vast">{rubricLabel(competency.score)}</span>
        {confidence && (
          <>
            {" · "}
            {confidence}
          </>
        )}
      </p>
      {competency.rationale ? (
        <p className="mb-3 break-words leading-relaxed">
          <span className="font-semibold">Why: </span>
          <CitedText text={competency.rationale} />
        </p>
      ) : (
        <p className="mb-3 text-sm text-vast/75">The reviewer didn't explain this score.</p>
      )}
      {competency.evidence.length > 0 && (
        <div className="mb-3">
          <h4 className="mb-1 text-xs font-bold uppercase tracking-wider text-vast/70">Evidence</h4>
          <ul className="space-y-1 border-l-[3px] border-forest/60 pl-3 text-[15px] italic text-vast">
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
          <SignalList title="What stood out" items={competency.positive_signals} positive />
          <SignalList title="What held it back" items={competency.negative_signals} positive={false} />
        </div>
      )}
    </article>
  );
}

/** One overview line: name, bar and "3.9 / 5 · Strong". The fixed score column keeps every bar the same length. */
function OverviewRow({ href, name, score, className }: { href: string; name: string; score: number | null; className?: string }) {
  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_10.5rem]",
        className,
      )}
    >
      <a href={href} className="min-w-0 break-words font-semibold hover:underline">
        {name}
      </a>
      <ScoreBar score={score} className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto" />
      <span className="whitespace-nowrap text-right">
        <OutOfFive score={score} />
        <span className="ml-1 text-sm text-vast/70">· {rubricLabel(score)}</span>
      </span>
    </li>
  );
}

function Scorecard({ competencies, handsOn }: { competencies: CompetencyScore[]; handsOn: ReadyReport["hands_on"] }) {
  return (
    <section className="card mb-8 p-6 md:p-10" aria-labelledby="scorecard-heading" data-testid="scorecard">
      <SectionHeading id="scorecard-heading" note="1 = major gaps · 3 = meets the bar for your level · 5 = exceptional. Every score cites your own words.">
        Scorecard
      </SectionHeading>
      {competencies.length === 0 ? (
        <p className="text-vast/75">There wasn't enough in this interview to score any competency. A few fuller answers next time will fill this in.</p>
      ) : (
        <>
          <ul className="mb-8 space-y-3 break-inside-avoid" aria-label="Competency overview">
            {competencies.map((c, i) => (
              <OverviewRow key={`${c.name}-${i}`} href={`#competency-${i + 1}`} name={c.name} score={c.score} />
            ))}
            {handsOn && (
              <OverviewRow href="#hands-on-heading" name="Hands-on exercise" score={handsOn.rating} className="border-t-2 border-vast/10 pt-3" />
            )}
          </ul>
          <div className="grid gap-5 lg:grid-cols-2 print:grid-cols-2">
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
  // Never label the untouched starter code as the candidate's work.
  const work = report.meta?.hands_on_work_submitted !== false && session?.canvas.content?.trim() ? session.canvas.content : "";
  return (
    <section className="card mb-8 p-6 md:p-10" aria-labelledby="hands-on-heading">
      <div className="mb-4 flex items-baseline justify-between gap-4 break-after-avoid">
        <div className="min-w-0">
          <h2 id="hands-on-heading" className="scroll-mt-28 font-serif text-3xl">
            Hands-on exercise
          </h2>
          {task?.title && <p className="mt-1 break-words text-sm text-vast/75">Exercise: {task.title}</p>}
        </div>
        <div className="shrink-0 text-right">
          <OutOfFive score={handsOn.rating} large />
          <p className="text-sm font-semibold">{rubricLabel(handsOn.rating)}</p>
        </div>
      </div>
      {report.meta?.hands_on_work_submitted === false && (
        <p className="mb-4 flex items-start gap-3 rounded-2xl border-2 border-ember bg-ember/15 p-4 text-sm">
          <TriangleAlert size={18} className="mt-0.5 shrink-0 text-[#9a5b00]" aria-hidden />
          <span>No canvas work was submitted (the editor still held only the starter code), so this rating reflects your spoken reasoning alone.</span>
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
            <p className="text-sm text-vast/75">Nothing specific was called out.</p>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-2 font-bold">What to tighten</h3>
          {handsOn.gaps.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {handsOn.gaps.map((item, i) => (
                <li key={i} className="break-words">
                  <CitedText text={item} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-vast/75">No specific gaps were called out.</p>
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
      <div className="mb-3 flex flex-col items-start gap-2 sm:flex-row sm:justify-between sm:gap-4">
        <h3 className="min-w-0 break-words font-bold">
          <span className="mr-1 text-vast/70">Q{index + 1}.</span>
          <CitedText text={item.question} />
          {item.question_turn !== null && <CiteChip n={item.question_turn} />}
        </h3>
        {item.rating !== null && (
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-vast/20 bg-white px-2.5 py-0.5 text-sm font-bold">
            <span className={cn("h-2 w-2 rounded-full", rubricBar(item.rating))} aria-hidden />
            <span>
              <span className="sr-only">Rated </span>
              {item.rating.toFixed(1)}
              <span className="font-normal"> / 5</span>
              <span className="font-normal text-vast/70"> · {rubricLabel(item.rating)}</span>
            </span>
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
      <SectionHeading id="questions-heading" note="Every answer is rated on the same 1–5 rubric. Summaries are paraphrased; the transcript below has your exact words.">
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
  if (notes.length === 0) {
    return (
      <p className="mb-8 flex items-center justify-center gap-2 text-sm text-vast/70">
        <ShieldCheck size={16} aria-hidden /> Clean session: no integrity concerns were recorded.
      </p>
    );
  }
  return (
    <section className="card mb-8 break-inside-avoid p-6 md:p-10" aria-labelledby="integrity-heading">
      <SectionHeading id="integrity-heading">Session integrity</SectionHeading>
      <ul className="list-disc space-y-1 pl-5 text-vast/80">
        {notes.map((note, i) => (
          <li key={i} className="break-words">
            <CitedText text={note} />
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-vast/70">In a real interview, staying in the interview tab and writing your own work keeps your session free of flags.</p>
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
          <StrengthsAndImprovements report={report} />
          <Scorecard competencies={report.competency_scores} handsOn={report.hands_on} />
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
