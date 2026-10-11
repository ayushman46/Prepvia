/**
 * Injected into the page before any app code (Playwright addInitScript).
 *
 * - Replaces getUserMedia with a programmable microphone: tests call
 *   `window.__fakeMic.play(base64Wav)` to "speak" a recorded answer into the
 *   app's real VAD, exactly when they choose.
 * - Records every AudioBufferSourceNode.start() so tests can measure, from
 *   ground truth, when the interviewer's audio actually began playing.
 */
(() => {
  const mic = { ctx: null, dest: null, speaking: false };
  window.__fakeMic = mic;
  window.__audioStarts = [];

  window.__audioStops = [];
  const originalStop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function (...args) {
    window.__audioStops.push({ t: performance.now(), mic: this.context === mic.ctx });
    return originalStop.apply(this, args);
  };
  const originalStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    window.__audioStarts.push({ t: performance.now(), mic: this.context === mic.ctx, duration: this.buffer ? this.buffer.duration : 0 });
    return originalStart.apply(this, args);
  };

  const devices = navigator.mediaDevices;
  const originalGetUserMedia = devices.getUserMedia.bind(devices);
  devices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.audio) return originalGetUserMedia(constraints);
    if (!mic.ctx) mic.ctx = new AudioContext();
    if (mic.ctx.state === "suspended") await mic.ctx.resume();
    // A fresh destination per call: the VAD stops tracks when muted and asks again on unmute.
    mic.dest = mic.ctx.createMediaStreamDestination();
    return mic.dest.stream;
  };

  mic.play = async (base64) => {
    if (!mic.ctx || !mic.dest) throw new Error("Microphone not started");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const buffer = await mic.ctx.decodeAudioData(bytes.buffer);
    mic.speaking = true;
    mic.lastPlayStartedAt = performance.now();
    return new Promise((resolve) => {
      const source = mic.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(mic.dest);
      source.onended = () => {
        mic.speaking = false;
        resolve(performance.now());
      };
      originalStart.call(source, 0);
    });
  };
})();
