import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseAecPath,
  isChromiumBrowser,
  mungeOpusSdp,
  openAecLoopback,
  OPUS_MAX_AVERAGE_BITRATE,
} from "@/lib/aec-loopback";
import { SequencedAudioPlayer } from "@/lib/audio-player";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const EDGE_UA = `${CHROME_UA} Edg/126.0.0.0`;
const FIREFOX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IOS_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1";

describe("isChromiumBrowser", () => {
  it("detects Chrome and Edge from the user agent", () => {
    expect(isChromiumBrowser({ userAgent: CHROME_UA })).toBe(true);
    expect(isChromiumBrowser({ userAgent: EDGE_UA })).toBe(true);
  });

  it("rejects Firefox, desktop Safari and iOS browsers", () => {
    expect(isChromiumBrowser({ userAgent: FIREFOX_UA })).toBe(false);
    expect(isChromiumBrowser({ userAgent: SAFARI_UA })).toBe(false);
    expect(isChromiumBrowser({ userAgent: IOS_CHROME_UA })).toBe(false);
  });

  it("prefers userAgentData brands when the browser exposes them", () => {
    const brave = { brands: [{ brand: "Not;A=Brand" }, { brand: "Chromium" }, { brand: "Brave" }] };
    expect(isChromiumBrowser({ userAgent: SAFARI_UA, userAgentData: brave })).toBe(true);
    const notChromium = { brands: [{ brand: "Not;A=Brand" }] };
    expect(isChromiumBrowser({ userAgent: CHROME_UA, userAgentData: notChromium })).toBe(false);
  });

  it("is false for missing or empty navigators", () => {
    expect(isChromiumBrowser(undefined)).toBe(false);
    expect(isChromiumBrowser(null)).toBe(false);
    expect(isChromiumBrowser({})).toBe(false);
    expect(isChromiumBrowser({ userAgent: "" })).toBe(false);
  });
});

const OFFER_LINES = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9",
  "c=IN IP4 0.0.0.0",
  "a=mid:0",
  "a=sendrecv",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1;stereo=1",
  "a=rtpmap:63 red/48000/2",
  "a=rtpmap:9 G722/8000",
  "",
];
const OFFER = OFFER_LINES.join("\r\n");

describe("mungeOpusSdp", () => {
  it("sets Opus to mono with the target bitrate and keeps other fmtp params", () => {
    const out = mungeOpusSdp(OFFER).split("\r\n");
    expect(out).toContain(
      `a=fmtp:111 minptime=10;maxaveragebitrate=${OPUS_MAX_AVERAGE_BITRATE};stereo=0;sprop-stereo=0;useinbandfec=1`,
    );
    expect(out.filter((line) => line.startsWith("a=fmtp:111"))).toHaveLength(1);
    expect(OPUS_MAX_AVERAGE_BITRATE).toBe(96_000);
  });

  it("changes only the Opus fmtp line and keeps CRLF endings", () => {
    const out = mungeOpusSdp(OFFER);
    const before = OFFER.split("\r\n").filter((line) => !line.startsWith("a=fmtp:111"));
    const after = out.split("\r\n").filter((line) => !line.startsWith("a=fmtp:111"));
    expect(after).toEqual(before);
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out.replace(/\r\n/g, "")).not.toMatch(/\n/);
  });

  it("adds an fmtp line after the Opus rtpmap when the offer has none", () => {
    const lines = OFFER_LINES.filter((line) => !line.startsWith("a=fmtp:111"));
    const out = mungeOpusSdp(lines.join("\n")).split("\n");
    const rtpmapAt = out.indexOf("a=rtpmap:111 opus/48000/2");
    expect(out[rtpmapAt + 1]).toBe(
      `a=fmtp:111 maxaveragebitrate=${OPUS_MAX_AVERAGE_BITRATE};stereo=0;sprop-stereo=0;useinbandfec=1`,
    );
    expect(out.join("\n")).not.toContain("\r");
  });

  it("returns the SDP unchanged when there is no Opus payload", () => {
    const noOpus = "v=0\r\nm=audio 9 RTP/AVP 0 8\r\na=rtpmap:0 PCMU/8000\r\n";
    expect(mungeOpusSdp(noOpus)).toBe(noOpus);
  });

  it("is idempotent", () => {
    const once = mungeOpusSdp(OFFER);
    expect(mungeOpusSdp(once)).toBe(once);
  });
});

describe("chooseAecPath", () => {
  it("uses the loopback only on Chromium with a live, error-free track", () => {
    expect(chooseAecPath({ chromium: true, failed: false, trackLive: true })).toBe("loopback");
  });

  it("falls back to the direct route on every other outcome", () => {
    expect(chooseAecPath({ chromium: false, failed: false, trackLive: true })).toBe("direct");
    expect(chooseAecPath({ chromium: true, failed: true, trackLive: true })).toBe("direct");
    expect(chooseAecPath({ chromium: true, failed: false, trackLive: false })).toBe("direct");
  });
});

// Stubs for the browser objects openAecLoopback touches.

class FakeTrack {
  readyState: "live" | "ended" = "live";
}

type RemoteEvent = { track: FakeTrack };

class FakePc {
  static instances: FakePc[] = [];
  iceGatheringState: string = "complete";
  localDescription: { type?: string; sdp?: string } | null = null;
  remoteDescription: { type?: string; sdp?: string } | null = null;
  ontrack: ((event: RemoteEvent) => void) | null = null;
  connectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  closed = false;
  addedTracks: FakeTrack[] = [];

  constructor(private readonly silentReceiver: boolean) {
    FakePc.instances.push(this);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  addTrack(track: FakeTrack): void {
    this.addedTracks.push(track);
  }
  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: OFFER };
  }
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: "answer", sdp: OFFER.replace("a=sendrecv", "a=recvonly") };
  }
  async setLocalDescription(description: { type?: string; sdp?: string }): Promise<void> {
    this.localDescription = description;
  }
  async setRemoteDescription(description: { type?: string; sdp?: string }): Promise<void> {
    this.remoteDescription = description;
    if (description.type === "offer" && !this.silentReceiver) this.ontrack?.({ track: new FakeTrack() });
  }
  close(): void {
    this.closed = true;
  }
}

class FakeAudio {
  autoplay = false;
  hidden = false;
  srcObject: unknown = null;
  paused = false;
  removed = false;
  attributes: Record<string, string> = {};
  constructor(private readonly playMode: "ok" | "reject" | "hang") {}
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  play(): Promise<void> {
    if (this.playMode === "reject") return Promise.reject(new Error("NotAllowedError"));
    if (this.playMode === "hang") return new Promise(() => undefined);
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  remove(): void {
    this.removed = true;
  }
}

function makeEnv(options: { silentReceiver?: boolean; playMode?: "ok" | "reject" | "hang"; noDestination?: boolean } = {}) {
  const sinkTrack = new FakeTrack();
  const audio = new FakeAudio(options.playMode ?? "ok");
  const appended: unknown[] = [];
  const context = {
    createMediaStreamDestination() {
      if (options.noDestination) throw new Error("no destination");
      return {
        channelCount: 2,
        stream: { getAudioTracks: () => [sinkTrack] },
      };
    },
  };
  const doc = {
    createElement: () => audio,
    body: { appendChild: (node: unknown) => appended.push(node) },
  };
  return {
    sinkTrack,
    audio,
    appended,
    options: {
      context: context as unknown as AudioContext,
      doc: doc as unknown as Document,
      createPeerConnection: () => new FakePc(!!options.silentReceiver) as unknown as RTCPeerConnection,
      createStream: (tracks: MediaStreamTrack[]) => ({ tracks }) as unknown as MediaStream,
    },
  };
}

describe("openAecLoopback", () => {
  beforeEach(() => {
    FakePc.instances = [];
  });

  it("negotiates a mono, bitrate-capped loopback and plays the receiver track", async () => {
    const env = makeEnv();
    const handle = await openAecLoopback(env.options);
    const [sender, receiver] = FakePc.instances;

    expect(handle.track.readyState).toBe("live");
    expect(sender.addedTracks).toEqual([env.sinkTrack]);
    expect(receiver.remoteDescription?.sdp).toContain(`maxaveragebitrate=${OPUS_MAX_AVERAGE_BITRATE}`);
    expect(env.audio.autoplay).toBe(true);
    expect(env.audio.attributes.playsinline).toBe("");
    expect(env.appended).toEqual([env.audio]);
    expect((env.audio.srcObject as { tracks: unknown[] }).tracks).toEqual([handle.track]);

    handle.dispose();
    expect(sender.closed && receiver.closed).toBe(true);
    expect(env.audio.paused && env.audio.removed).toBe(true);
    expect(() => handle.dispose()).not.toThrow();
  });

  it("tears everything down and rejects when the receiver track never arrives in time", async () => {
    const env = makeEnv({ silentReceiver: true });
    await expect(openAecLoopback({ ...env.options, timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(FakePc.instances.every((pc) => pc.closed)).toBe(true);
    expect(env.audio.removed).toBe(false);
  });

  it("rejects and cleans up when playback is refused by autoplay policy", async () => {
    const env = makeEnv({ playMode: "reject" });
    await expect(openAecLoopback(env.options)).rejects.toThrow(/NotAllowedError/);
    expect(FakePc.instances.every((pc) => pc.closed)).toBe(true);
    expect(env.audio.removed).toBe(true);
  });

  it("rejects when playback never starts within the budget", async () => {
    const env = makeEnv({ playMode: "hang" });
    await expect(openAecLoopback({ ...env.options, timeoutMs: 20 })).rejects.toThrow(/playback timed out/);
    expect(FakePc.instances.every((pc) => pc.closed)).toBe(true);
  });

  it("reports a lost loopback once, and not for its own teardown", async () => {
    const env = makeEnv();
    let lost = 0;
    const handle = await openAecLoopback({ ...env.options, onLost: () => (lost += 1) });
    const [, receiver] = FakePc.instances as (FakePc & { connectionState?: string })[];

    receiver.connectionState = "failed";
    receiver.onconnectionstatechange?.();
    (handle.track as unknown as { onended: () => void }).onended();
    expect(lost).toBe(1);

    const quiet = await openAecLoopback({ ...env.options, onLost: () => (lost += 1) });
    quiet.dispose();
    expect(lost).toBe(1);
  });

  it("rejects without creating peers when the context has no stream destination", async () => {
    const env = makeEnv({ noDestination: true });
    await expect(openAecLoopback(env.options)).rejects.toThrow(/no destination/);
    expect(FakePc.instances).toHaveLength(0);
  });
});

class FakeAnalyser {
  fftSize = 0;
  smoothingTimeConstant = 0;
  outputs: unknown[] = [];
  connect(node: unknown): void {
    this.outputs.push(node);
  }
  disconnect(): void {
    this.outputs = [];
  }
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  state = "running";
  destination = { kind: "destination" };
  sink = { kind: "sink", channelCount: 2, stream: { getAudioTracks: () => [new FakeTrack()] } };
  analyser = new FakeAnalyser();
  constructor() {
    FakeAudioContext.last = this;
  }
  createAnalyser(): FakeAnalyser {
    return this.analyser;
  }
  createMediaStreamDestination(): unknown {
    return this.sink;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class StubPc extends FakePc {
  constructor() {
    super(false);
  }
}

describe("SequencedAudioPlayer output routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakePc.instances = [];
    FakeAudioContext.last = null;
  });

  function stubBrowser(userAgent: string, peerConnections: boolean) {
    const win: { AudioContext: typeof FakeAudioContext; __aecPath?: string } = { AudioContext: FakeAudioContext };
    const doc = { createElement: () => new FakeAudio("ok"), body: { appendChild: () => undefined } };
    vi.stubGlobal("window", win);
    vi.stubGlobal("navigator", { userAgent });
    vi.stubGlobal("document", doc);
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(public tracks: unknown[]) {}
      },
    );
    vi.stubGlobal("RTCPeerConnection", peerConnections ? StubPc : undefined);
    return win;
  }

  it("routes Chromium output through the loopback and reports it", async () => {
    const win = stubBrowser(CHROME_UA, true);
    const player = new SequencedAudioPlayer({ onSpeakingChange: () => undefined });
    await player.unlock();
    const context = FakeAudioContext.last as FakeAudioContext;

    expect(win.__aecPath).toBe("loopback");
    expect(context.analyser.outputs).toEqual([context.sink]);
    expect(FakePc.instances).toHaveLength(2);

    player.dispose();
    expect(FakePc.instances.every((pc) => pc.closed)).toBe(true);
    expect(win.__aecPath).toBeUndefined();
  });

  it("moves playback back to the direct route when the loopback drops mid-session", async () => {
    const win = stubBrowser(CHROME_UA, true);
    const player = new SequencedAudioPlayer({ onSpeakingChange: () => undefined });
    await player.unlock();
    const context = FakeAudioContext.last as FakeAudioContext;
    expect(win.__aecPath).toBe("loopback");

    const receiver = FakePc.instances[1] as FakePc & { connectionState?: string };
    receiver.connectionState = "failed";
    receiver.onconnectionstatechange?.();

    expect(win.__aecPath).toBe("direct");
    expect(context.analyser.outputs).toEqual([context.destination]);
    player.dispose();
  });

  it("falls back to the direct route when the loopback cannot be built", async () => {
    const win = stubBrowser(CHROME_UA, false);
    const player = new SequencedAudioPlayer({ onSpeakingChange: () => undefined });
    await player.unlock();
    const context = FakeAudioContext.last as FakeAudioContext;

    expect(win.__aecPath).toBe("direct");
    expect(context.analyser.outputs).toEqual([context.destination]);
    player.dispose();
  });

  it("keeps the direct route on non-Chromium browsers without touching WebRTC", async () => {
    const win = stubBrowser(SAFARI_UA, true);
    const player = new SequencedAudioPlayer({ onSpeakingChange: () => undefined });
    await player.unlock();
    const context = FakeAudioContext.last as FakeAudioContext;

    expect(win.__aecPath).toBe("direct");
    expect(context.analyser.outputs).toEqual([context.destination]);
    expect(FakePc.instances).toHaveLength(0);
    player.dispose();
  });
});
