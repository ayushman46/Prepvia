/** Encode mono Float32 samples (-1..1) as a 16-bit PCM WAV blob. */
export function encodeWav(samples: Float32Array, sampleRate = 16_000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Max utterance length accepted by the server (~4 MB of 16 kHz PCM). */
export const MAX_UTTERANCE_SECONDS = 120;

/** Join WAVs made by `encodeWav` (same format) into one, with a short silence between them. */
export async function concatWav(blobs: Blob[], gapSeconds = 0.3, sampleRate = 16_000): Promise<Blob> {
  const parts = await Promise.all(blobs.map(async (blob) => new Int16Array((await blob.arrayBuffer()).slice(44))));
  const gap = Math.round(gapSeconds * sampleRate);
  const total = parts.reduce((n, part) => n + part.length, 0) + gap * Math.max(0, parts.length - 1);
  const samples = new Float32Array(total);
  let offset = 0;
  parts.forEach((part, i) => {
    if (i > 0) offset += gap;
    for (let j = 0; j < part.length; j++) samples[offset + j] = part[j] / 0x8000;
    offset += part.length;
  });
  return encodeWav(samples, sampleRate);
}
