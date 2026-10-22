"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

const BARS = [
  { duration: 1.1, delay: 0 },
  { duration: 1.4, delay: 0.1 },
  { duration: 1.2, delay: 0.2 },
  { duration: 1.6, delay: 0.3 },
  { duration: 1.3, delay: 0.4 },
];

export function WaveformIndicator({ isActive, colorClass = "bg-forest" }: { isActive: boolean; colorClass?: string }) {
  return (
    <div className="flex h-10 w-fit items-center justify-center gap-1.5 rounded-full border-2 border-vast bg-cream px-5" aria-hidden>
      {BARS.map((bar, i) => (
        <motion.div
          key={i}
          className={cn("w-1.5 rounded-full", colorClass)}
          initial={{ height: 4 }}
          animate={{ height: isActive ? [4, 18, 6, 22, 8, 4] : 4 }}
          transition={{ repeat: isActive ? Infinity : 0, duration: bar.duration, delay: bar.delay, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}
