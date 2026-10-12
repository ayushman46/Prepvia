"use client";

import dynamic from "next/dynamic";
import { useState, type ClipboardEvent } from "react";
import { ChevronDown, ChevronUp, Check, Loader2 } from "lucide-react";
import type { CanvasState } from "@/hooks/useInterview";
import { cn } from "@/lib/cn";

const CodeEditor = dynamic(() => import("./CodeEditor"), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-vast/60">Loading editor…</div>,
});

export const CANVAS_LANGUAGE_LABELS: Record<string, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  java: "Java",
  go: "Go",
  cpp: "C++",
  sql: "SQL",
  text: "Plain text",
};

/** Large pastes are reported as an integrity signal (like Chakra's flags). */
const LARGE_PASTE_CHARS = 200;

export function CanvasPanel({
  canvas,
  onChange,
  onLargePaste,
  disabled,
  className,
}: {
  canvas: CanvasState;
  onChange: (content: string, language?: string) => void;
  onLargePaste?: (chars: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [showInstructions, setShowInstructions] = useState(true);
  if (!canvas.task) return null;

  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (text.length >= LARGE_PASTE_CHARS) onLargePaste?.(text.length);
  };

  return (
    <section
      className={cn("flex min-h-0 flex-col overflow-hidden rounded-[28px] border-2 border-vast bg-cream", className)}
      aria-label="Hands-on canvas"
    >
      <header className="flex items-center justify-between gap-3 border-b-2 border-vast px-5 py-3">
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-widest text-forest">Canvas</p>
          <h2 className="truncate font-serif text-xl">{canvas.task.title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Fixed width so the title doesn't shift while the label changes. */}
          <span className="flex items-center justify-end gap-1 text-xs text-vast/60 sm:w-44" aria-live="polite">
            {canvas.saving ? (
              <>
                <Loader2 size={12} className="animate-spin" /> Saving
              </>
            ) : canvas.unsaved ? (
              <span className="font-semibold text-red-700">Not saved yet · retrying</span>
            ) : (
              <>
                <Check size={12} /> Shared with interviewer
              </>
            )}
          </span>
          <label className="sr-only" htmlFor="canvas-language">
            Language
          </label>
          <select
            id="canvas-language"
            value={canvas.language}
            onChange={(e) => onChange(canvas.content, e.target.value)}
            className="rounded-lg border-2 border-vast bg-white px-2 py-1 text-sm"
            disabled={disabled}
          >
            {Object.entries(CANVAS_LANGUAGE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="border-b-2 border-vast/15 bg-white/60 px-5 py-3">
        <button
          onClick={() => setShowInstructions((v) => !v)}
          className="flex w-full items-center justify-between text-left text-sm font-bold"
          aria-expanded={showInstructions}
        >
          Problem {showInstructions ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showInstructions && (
          <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-vast/85">{canvas.task.instructions}</p>
        )}
      </div>

      <div className="min-h-[240px] flex-1 overflow-hidden" onPaste={onPaste}>
        <CodeEditor value={canvas.content} language={canvas.language} onChange={(value) => onChange(value)} readOnly={disabled} />
      </div>
      <p className="border-t-2 border-vast/15 px-5 py-2 text-xs text-vast/60">
        Think out loud as you work. The interviewer sees your canvas and may ask about your choices.
      </p>
    </section>
  );
}
