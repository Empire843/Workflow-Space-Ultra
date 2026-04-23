/**
 * PCM → WAV wrapper.
 *
 * Gemini's TTS endpoint returns raw linear PCM (signed 16-bit little-endian,
 * mono, 24 kHz) in the `inlineData.data` field. Browsers can't play raw PCM,
 * so we prepend a 44-byte RIFF/WAVE header. No resampling, no re-encoding —
 * this is purely a container wrap, which keeps the operation O(1) on header
 * size plus a single Buffer concat for the payload.
 *
 * Layout reference: http://soundfile.sapp.org/doc/WaveFormat/
 */

export interface PcmFormat {
  /** Samples per second. Gemini TTS is fixed at 24000. */
  sampleRate: number;
  /** 1 = mono, 2 = stereo. Gemini TTS is fixed at 1. */
  channels: number;
  /** Bits per sample. Gemini TTS is fixed at 16. */
  bitsPerSample: number;
}

export const GEMINI_TTS_PCM_FORMAT: PcmFormat = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
};

export function pcmToWav(pcm: Buffer, fmt: PcmFormat = GEMINI_TTS_PCM_FORMAT): Buffer {
  const { sampleRate, channels, bitsPerSample } = fmt;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  // 44-byte canonical PCM WAV header — RIFF(12) + fmt (24) + data(8).
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4); // chunk size = header remainder + data
  header.write("WAVE", 8, "ascii");

  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);            // Subchunk1Size for PCM
  header.writeUInt16LE(1, 20);             // AudioFormat = 1 (PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm], header.length + dataSize);
}

/**
 * Inverse helper: pull out the PCM payload from a WAV we wrote above. Only
 * used by unit tests — real consumers play the WAV directly. Assumes the
 * canonical 44-byte header; good enough for round-trip verification.
 */
export function wavToPcm(wav: Buffer): Buffer {
  if (wav.length < 44) throw new Error("WAV buffer too short (< 44 bytes)");
  const riff = wav.toString("ascii", 0, 4);
  const wave = wav.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error(`Not a RIFF/WAVE buffer (got ${riff}/${wave})`);
  }
  return wav.subarray(44);
}
