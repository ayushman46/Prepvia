/**
 * Echo-cancellation loopback for Chromium.
 *
 * Chromium applies its acoustic echo canceller (AEC) to audio that flows through
 * WebRTC's audio pipeline, but not to Web Audio API output. Interviewer speech played
 * straight from an AudioContext therefore leaks into the candidate's microphone where the
 * canceller cannot see it, and the mic hears Aria as if she were the candidate.
 *
 * Workaround: send the Web Audio output into a local RTCPeerConnection pair (host
 * candidates only, no STUN or network), then play the receiving end through an
 * <audio> element. WebRTC renders that audio itself, so the canceller gets it as reference.
 *
 * Every failure path falls back to the direct Web Audio route, so playback is never silent.
 */

export type AecPath = "loopback" | "direct";

/** Budget for the local handshake plus the receiver track becoming live. */
export const LOOPBACK_READY_TIMEOUT_MS = 1500;
export const OPUS_MAX_AVERAGE_BITRATE = 96_000;

declare global {
  interface Window {
    /** Diagnostics: which output route the interviewer's voice is using. */
    __aecPath?: AecPath;
  }
}

export interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { brands?: ReadonlyArray<{ brand: string }> } | null;
}

const CHROMIUM_BRAND = /Chromium|Google Chrome|Microsoft Edge|Opera|Brave|Vivaldi|Samsung Internet/i;

/**
 * True for Chromium-based desktop and Android browsers (Chrome, Edge, Brave, Opera, Vivaldi).
 * Firefox, Safari and iOS browsers (WebKit shells, including Chrome on iOS) return false.
 */
export function isChromiumBrowser(nav: NavigatorLike | null | undefined): boolean {
  if (!nav) return false;
  const brands = nav.userAgentData?.brands;
  if (brands && brands.length > 0) return brands.some((entry) => CHROMIUM_BRAND.test(entry.brand));
  const ua = nav.userAgent ?? "";
  if (!ua) return false;
  if (/Firefox\/|FxiOS\//.test(ua)) return false;
  if (/iPhone|iPad|iPod/.test(ua)) return false;
  return /(Chrome|Chromium|Edg|OPR)\/\d/.test(ua);
}

const OPUS_RTPMAP = /^a=rtpmap:(\d+) opus\/48000\b/i;
const OPUS_FMTP_KEYS = ["maxaveragebitrate", "stereo", "sprop-stereo", "useinbandfec"];

/**
 * Rewrites the Opus fmtp line to mono with a fixed average bitrate, leaving the rest of the
 * SDP untouched. Adds the fmtp line when the offer has none. Returns the SDP unchanged when
 * it contains no Opus payload. Preserves CRLF or LF line endings.
 */
export function mungeOpusSdp(sdp: string, maxAverageBitrate: number = OPUS_MAX_AVERAGE_BITRATE): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  const rtpmapIndex = lines.findIndex((line) => OPUS_RTPMAP.test(line));
  if (rtpmapIndex < 0) return sdp;
  const payloadType = OPUS_RTPMAP.exec(lines[rtpmapIndex])?.[1];
  if (!payloadType) return sdp;

  const prefix = `a=fmtp:${payloadType} `;
  const wanted = [
    `maxaveragebitrate=${Math.round(maxAverageBitrate)}`,
    "stereo=0",
    "sprop-stereo=0",
    "useinbandfec=1",
  ];
  const fmtpIndex = lines.findIndex((line) => line.startsWith(prefix));
  if (fmtpIndex >= 0) {
    const kept = lines[fmtpIndex]
      .slice(prefix.length)
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && !OPUS_FMTP_KEYS.includes(part.split("=")[0].toLowerCase()));
    lines[fmtpIndex] = prefix + [...kept, ...wanted].join(";");
  } else {
    lines.splice(rtpmapIndex + 1, 0, prefix + wanted.join(";"));
  }
  return lines.join(eol);
}

/**
 * Which output route to use once the loopback attempt has finished. The loopback is used
 * only on Chromium, only if setup did not fail, and only if the receiver track is live.
 */
export function chooseAecPath(state: { chromium: boolean; failed: boolean; trackLive: boolean }): AecPath {
  return state.chromium && !state.failed && state.trackLive ? "loopback" : "direct";
}

export interface AecLoopback {
  /** Connect the interviewer's output here instead of `context.destination`. */
  readonly sink: MediaStreamAudioDestinationNode;
  /** The receiving track, which the page plays through an <audio> element. */
  readonly track: MediaStreamTrack;
  /** Closes both peer connections and removes the audio element. Idempotent. */
  dispose(): void;
}

export interface AecLoopbackOptions {
  context: AudioContext;
  /** Handshake plus track-live budget. Defaults to LOOPBACK_READY_TIMEOUT_MS. */
  timeoutMs?: number;
  doc?: Document;
  createPeerConnection?: () => RTCPeerConnection;
  createStream?: (tracks: MediaStreamTrack[]) => MediaStream;
}

/**
 * Builds the loopback and starts playback of the receiver track. Rejects (after tearing
 * everything down) if negotiation, the track or playback fails within the budget.
 */
export async function openAecLoopback(options: AecLoopbackOptions): Promise<AecLoopback> {
  const { context, timeoutMs = LOOPBACK_READY_TIMEOUT_MS } = options;
  const doc = options.doc ?? globalThis.document;
  const makePc = options.createPeerConnection ?? (() => new RTCPeerConnection({ iceServers: [] }));
  const makeStream = options.createStream ?? ((tracks: MediaStreamTrack[]) => new MediaStream(tracks));

  let sender: RTCPeerConnection | null = null;
  let receiver: RTCPeerConnection | null = null;
  let audio: HTMLAudioElement | null = null;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      sender?.close();
    } catch {
      // already closed
    }
    try {
      receiver?.close();
    } catch {
      // already closed
    }
    if (audio) {
      try {
        audio.pause();
      } catch {
        // not playing
      }
      audio.srcObject = null;
      audio.remove();
    }
  };

  const sink = context.createMediaStreamDestination();
  try {
    sink.channelCount = 1; // mono keeps the Opus stream small
  } catch {
    // keep the default channel count
  }
  try {
    const [track] = sink.stream.getAudioTracks();
    if (!track) throw new Error("loopback: no audio track");
    const tx = makePc();
    const rx = makePc();
    sender = tx;
    receiver = rx;
    const remoteTrack = new Promise<MediaStreamTrack>((resolve) => {
      rx.ontrack = (event) => resolve(event.track);
    });
    const [, received] = await withTimeout(
      Promise.all([negotiate(tx, rx, track, sink.stream), remoteTrack]),
      timeoutMs,
      "loopback negotiation",
    );
    if (received.readyState !== "live") throw new Error("loopback: receiver track is not live");

    const element = doc.createElement("audio");
    audio = element;
    element.autoplay = true;
    element.setAttribute("playsinline", "");
    element.hidden = true;
    element.srcObject = makeStream([received]);
    doc.body.appendChild(element);
    await withTimeout(element.play(), timeoutMs, "loopback playback");
    if (disposed) throw new Error("loopback: disposed during setup");
    return { sink, track: received, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/** Offer/answer exchange between the two peers, with ICE fully gathered before each step. */
async function negotiate(
  tx: RTCPeerConnection,
  rx: RTCPeerConnection,
  track: MediaStreamTrack,
  stream: MediaStream,
): Promise<void> {
  tx.addTrack(track, stream);
  const offer = await tx.createOffer();
  await tx.setLocalDescription({ type: "offer", sdp: mungeOpusSdp(offer.sdp ?? "") });
  await waitForIceGathering(tx);
  await rx.setRemoteDescription({ type: "offer", sdp: tx.localDescription?.sdp ?? "" });
  const answer = await rx.createAnswer();
  await rx.setLocalDescription({ type: "answer", sdp: mungeOpusSdp(answer.sdp ?? "") });
  await waitForIceGathering(rx);
  await tx.setRemoteDescription({ type: "answer", sdp: rx.localDescription?.sdp ?? "" });
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState !== "complete") return;
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
