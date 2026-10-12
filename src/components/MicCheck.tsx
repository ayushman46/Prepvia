"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Check, Mic } from "lucide-react";
import { cn } from "@/lib/cn";

type Props = {
  /** The microphone is open (permission granted). */
  listening: boolean;
  /** Speech was heard since the check started. */
  heard: boolean;
  /** Live input level 0..1 (updated every audio frame). */
  levelRef: MutableRefObject<number>;
  deviceId: string;
  onSelectDevice: (id: string) => void;
  onCheck: () => void;
  checking: boolean;
  disabled?: boolean;
};

/** Lobby system check: open the microphone, show its level, pick the device, confirm speech is heard. */
export function MicCheck({ listening, heard, levelRef, deviceId, onSelectDevice, onCheck, checking, disabled }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const bar = useRef<HTMLSpanElement>(null);

  // Device labels are only available once permission is granted.
  useEffect(() => {
    if (!listening || !navigator.mediaDevices?.enumerateDevices) return;
    const load = () =>
      void navigator.mediaDevices
        .enumerateDevices()
        // "default"/"communications" are aliases of real devices, covered by "System default".
        .then((all) => setDevices(all.filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications")))
        .catch(() => undefined);
    load();
    navigator.mediaDevices.addEventListener?.("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", load);
  }, [listening]);

  useEffect(() => {
    if (!listening) return;
    let frame = 0;
    const tick = () => {
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, levelRef.current * 1.6)})`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [listening, levelRef]);

  if (!listening) {
    return (
      <button
        onClick={onCheck}
        disabled={disabled || checking}
        className="mb-4 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-vast bg-cream px-4 py-2.5 text-sm font-bold disabled:opacity-60"
        data-testid="mic-check"
      >
        <Mic size={16} /> {checking ? "Waiting for microphone permission…" : "Check my microphone"}
      </button>
    );
  }

  const named = devices.filter((device) => device.label);
  return (
    <div className="mb-4 rounded-2xl border-2 border-vast bg-white/60 p-3" data-testid="mic-check-panel">
      <div className="flex items-center gap-3">
        <Mic size={16} className="shrink-0" aria-hidden />
        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-vast/10" aria-hidden>
          <span ref={bar} className="block h-full w-full origin-left rounded-full bg-forest transition-transform duration-75" style={{ transform: "scaleX(0)" }} />
        </div>
        <span className={cn("flex shrink-0 items-center gap-1 text-xs font-bold", heard ? "text-forest" : "text-vast/70")} role="status" aria-live="polite" data-testid="mic-check-status">
          {heard ? (
            <>
              <Check size={14} /> We can hear you
            </>
          ) : (
            "Say a few words…"
          )}
        </span>
      </div>
      {named.length > 1 && (
        <label className="mt-2 flex items-center gap-2 text-xs text-vast/80">
          <span className="shrink-0">Microphone</span>
          <select
            value={named.some((device) => device.deviceId === deviceId) ? deviceId : ""}
            onChange={(event) => onSelectDevice(event.target.value)}
            className="min-w-0 flex-1 truncate rounded-lg border-2 border-vast bg-cream px-2 py-1"
            data-testid="mic-device"
          >
            <option value="">System default</option>
            {named.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
