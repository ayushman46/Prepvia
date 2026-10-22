"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { beaconEvents, sendEvents, type SessionEvent } from "@/lib/api";

/**
 * Records session integrity signals while the interview is live: leaving the
 * tab, long window blurs, and large pastes. Signals are batched to the server
 * and summarized (neutrally) in the report, similar to Chakra's flags.
 */
export function useIntegrity(sessionId: string, active: boolean) {
  const queue = useRef<SessionEvent[]>([]);
  const hiddenAt = useRef<number | null>(null);
  const blurAt = useRef<number | null>(null);
  const [tabSwitches, setTabSwitches] = useState(0);

  const flush = useCallback(() => {
    const events = queue.current.splice(0);
    if (events.length) void sendEvents(sessionId, events).catch(() => queue.current.unshift(...events));
  }, [sessionId]);

  const record = useCallback((type: string, detail?: string) => {
    queue.current.push({ type, detail });
  }, []);

  useEffect(() => {
    if (!active) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        // The page may never become visible again (closed tab): send now.
        beaconEvents(sessionId, queue.current.splice(0));
      } else if (hiddenAt.current) {
        const seconds = Math.round((Date.now() - hiddenAt.current) / 1000);
        hiddenAt.current = null;
        if (seconds >= 1) {
          record("tab_hidden", `${seconds}s`);
          setTabSwitches((count) => count + 1);
          flush();
        }
      }
    };
    const onBlur = () => {
      blurAt.current = Date.now();
    };
    const onFocus = () => {
      if (blurAt.current && document.visibilityState === "visible") {
        const seconds = Math.round((Date.now() - blurAt.current) / 1000);
        if (seconds >= 5) record("window_blur", `${seconds}s`);
      }
      blurAt.current = null;
    };
    const onPageHide = () => beaconEvents(sessionId, queue.current.splice(0));
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
    const timer = setInterval(flush, 5_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(timer);
      // The interview ended while the candidate was on another tab: record the
      // time away so far, since the "visible" event will no longer be handled.
      if (hiddenAt.current) {
        const seconds = Math.round((Date.now() - hiddenAt.current) / 1000);
        hiddenAt.current = null;
        if (seconds >= 1) record("tab_hidden", `${seconds}s`);
      }
      flush();
    };
  }, [active, flush, record, sessionId]);

  const reportLargePaste = useCallback(
    (chars: number) => {
      record("large_paste", `${chars} chars`);
      flush();
    },
    [flush, record],
  );

  return { tabSwitches, reportLargePaste };
}
