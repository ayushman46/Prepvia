import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { estimatedProgress, GENERATION_STEPS, generationDetail, generationStep } from "./report-format";

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-cream px-4 pb-12 pt-28 text-vast">
      <div className="card w-full max-w-lg p-6 text-center md:p-10">{children}</div>
    </main>
  );
}

/** Shown while the report is written: a status line announced to screen readers, and three steps. */
export function GeneratingScreen({ elapsedMs, retrying }: { elapsedMs: number; retrying: boolean }) {
  const step = generationStep(elapsedMs);
  return (
    <Screen>
      <h1 className="font-serif text-3xl md:text-4xl">Writing your scorecard</h1>
      <div role="status" aria-live="polite" aria-atomic="true">
        <p className="mt-3 text-vast/75">{generationDetail(elapsedMs, retrying)}</p>
      </div>
      <ol className="mx-auto mt-8 max-w-xs space-y-3 text-left" aria-label="Progress">
        {GENERATION_STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-3" aria-current={i === step ? "step" : undefined}>
            <span
              className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2",
                i < step ? "border-forest bg-forest text-cream" : i === step ? "border-forest" : "border-vast/30",
              )}
              aria-hidden
            >
              {i < step ? <Check size={14} strokeWidth={3} /> : i === step ? <span className="h-2 w-2 rounded-full bg-forest" /> : null}
            </span>
            <span className={cn(i > step ? "text-vast/70" : "font-semibold")}>
              {label.replace("…", "")}
              <span className="sr-only">{i < step ? " (done)" : i === step ? " (in progress)" : ""}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-8 h-2 overflow-hidden rounded-full bg-stone" aria-hidden>
        <div className="h-full rounded-full bg-forest transition-[width] duration-1000" style={{ width: `${Math.max(6, estimatedProgress(elapsedMs))}%` }} />
      </div>
    </Screen>
  );
}

/** A full-page explanation with ways forward (no report, an error, or nothing to score). */
export function MessageScreen({
  title,
  message,
  alert = false,
  children,
}: {
  title: string;
  message: string;
  /** Announce the message immediately (errors). */
  alert?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Screen>
      <h1 className="font-serif text-3xl md:text-4xl">{title}</h1>
      <p className="mx-auto mt-3 max-w-md text-vast/80" role={alert ? "alert" : undefined}>
        {message}
      </p>
      {children && <div className="mt-6 flex flex-wrap justify-center gap-3">{children}</div>}
    </Screen>
  );
}
