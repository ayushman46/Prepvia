"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import { cn } from "@/lib/cn";

export type OrbMode = "idle" | "waiting" | "speaking" | "listening" | "thinking";

/**
 * Animated interviewer presence. Reads live audio levels every frame
 * (interviewer output via `getOutputLevel`, candidate mic via `micLevelRef`)
 * and writes CSS variables directly, so it never re-renders React at 60 fps.
 */
export function InterviewerOrb({
  mode,
  getOutputLevel,
  micLevelRef,
  className,
}: {
  mode: OrbMode;
  getOutputLevel: () => number;
  micLevelRef: MutableRefObject<number>;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    let frame = 0;
    let smoothed = 0;
    const tick = () => {
      const current = modeRef.current;
      const target = current === "speaking" ? getOutputLevel() : current === "listening" ? micLevelRef.current : 0;
      smoothed += (target - smoothed) * 0.35;
      ref.current?.style.setProperty("--level", smoothed.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getOutputLevel, micLevelRef]);

  return (
    <div
      ref={ref}
      className={cn(
        "orb relative flex aspect-square items-center justify-center",
        // "waiting" breathes like idle but dimmed, so the orb visibly hands the floor to the candidate.
        mode === "waiting" ? "orb-idle orb-waiting [&_.orb-core]:brightness-[.85] [&_.orb-core]:saturate-[.45] [&_.orb-halo]:opacity-0" : `orb-${mode}`,
        className,
      )}
      role="img"
      aria-label={
        mode === "speaking"
          ? "Interviewer speaking"
          : mode === "listening"
            ? "Listening to you"
            : mode === "thinking"
              ? "Interviewer thinking"
              : mode === "waiting"
                ? "Interviewer waiting for your answer"
                : "Interviewer"
      }
    >
      <div className="orb-halo absolute inset-0 rounded-full" />
      <div className="orb-ring absolute inset-[8%] rounded-full" />
      <div className="orb-core relative h-[62%] w-[62%] rounded-full border-2 border-vast" />
    </div>
  );
}
