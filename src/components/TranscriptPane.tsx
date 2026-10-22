"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/hooks/useInterview";
import { cn } from "@/lib/cn";

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="Working">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-2 w-2 animate-bounce rounded-full bg-current opacity-60"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

export function TranscriptPane({
  messages,
  candidateName,
  compact = false,
}: {
  messages: ChatMessage[];
  candidateName?: string;
  /** The pane is narrow (the canvas is open beside it): keep bubbles at their phone size. */
  compact?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Follow new messages only while the candidate is reading the latest ones (not scrolled up). */
  const followRef = useRef(true);
  /** True while the pane scrolls itself, so those scroll events never stop following. */
  const autoScrollRef = useRef(false);
  const lastTopRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) scrollToEnd(el, true, autoScrollRef, lastTopRef);
  }, [messages]);

  // The pane narrows when the canvas opens (or the answer box appears, or the window
  // resizes) and the text reflows: stay pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) scrollToEnd(el, false, autoScrollRef, lastTopRef);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={scrollRef}
      className="mx-auto w-full max-w-3xl flex-1 space-y-5 overflow-y-auto px-1 py-4 [mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%-16px),transparent)] md:px-4"
      role="log"
      aria-live="polite"
      aria-label="Interview transcript"
      onScroll={(event) => {
        if (autoScrollRef.current) return;
        const el = event.currentTarget;
        // Only the candidate scrolling up stops following; getting back to the bottom resumes it.
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        if (nearBottom) followRef.current = true;
        else if (el.scrollTop < lastTopRef.current) followRef.current = false;
        lastTopRef.current = el.scrollTop;
      }}
    >
      {messages.length === 0 && (
        <p className="pt-6 text-center text-cream/60">Aria will greet you once you start.</p>
      )}
      {messages.map((message) => (
        <div key={message.id} className={cn("flex w-full flex-col", message.role === "user" ? "items-end" : "items-start")}>
          <span className="mb-1 px-2 text-xs font-bold uppercase tracking-wider text-cream/50">
            {message.role === "user" ? candidateName || "You" : "Aria"}
          </span>
          <div
            data-testid={message.role === "user" ? "msg-user" : "msg-ai"}
            data-interrupted={message.interrupted ? "true" : undefined}
            data-pending={message.pending ? "true" : undefined}
            className={cn(
              "max-w-[88%] rounded-[24px] border-2 border-vast px-5 py-3 text-base leading-relaxed",
              !compact && "md:max-w-[80%] md:text-lg",
              message.role === "user" ? "rounded-br-md bg-lavender text-vast" : "rounded-bl-md bg-cream text-vast",
            )}
          >
            {message.pending && !message.content ? <TypingDots /> : message.content}
            {message.pending && message.content && message.role === "user" && (
              <span className="ml-2 align-middle">
                <TypingDots />
              </span>
            )}
            {message.unspoken && (
              <span className="text-vast/45 italic" title="Not spoken: you interrupted Aria">
                {message.content ? " " : ""}
                {message.unspoken}
              </span>
            )}
            {message.interrupted && <span className="ml-2 text-xs font-semibold uppercase tracking-wider text-vast/45">interrupted</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Scroll to the latest message, flagging the scroll as programmatic until it settles. */
function scrollToEnd(
  el: HTMLDivElement,
  smooth: boolean,
  autoScrollRef: { current: boolean },
  lastTopRef: { current: number },
) {
  autoScrollRef.current = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    el.removeEventListener("scrollend", clear);
    autoScrollRef.current = false;
    lastTopRef.current = el.scrollTop;
  };
  if (smooth) {
    el.addEventListener("scrollend", clear, { once: true });
    timer = setTimeout(clear, 600);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  } else {
    el.scrollTop = el.scrollHeight;
    // The scroll event of an instant jump is dispatched on the next frame.
    timer = setTimeout(clear, 50);
  }
}
