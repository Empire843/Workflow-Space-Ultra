/**
 * Unit tests for the Gemini TTS → WAV adapter.
 *
 * We only test the pure parts here:
 *   - `pcmToWav` — pure function, no network, no filesystem
 *   - WAV header fields match the RIFF spec
 *   - Round-trip via `wavToPcm` recovers the original payload byte-for-byte
 *
 * The network path (actual Gemini call) is covered by integration tests that
 * run against a live key and are not part of this CI-friendly suite.
 */

import { describe, expect, it } from "vitest";

import {
  GEMINI_TTS_PCM_FORMAT,
  pcmToWav,
  wavToPcm,
} from "@/server/providers/tts/pcmToWav";

// Build a tiny PCM buffer — 200 samples of a 1 kHz sine wave at 24 kHz/16-bit
// mono. That's small enough to diff byte-by-byte in test output if something
// goes wrong, but non-trivial enough to catch endian/offset bugs.
function makeTestPcm(samples: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * i * 1000) / 24000) * 32767);
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

describe("pcmToWav", () => {
  it("prefixes a 44-byte canonical WAV header", () => {
    const pcm = makeTestPcm(200);
    const wav = pcmToWav(pcm);
    expect(wav.length).toBe(44 + pcm.length);
  });

  it("header carries RIFF/WAVE ASCII markers", () => {
    const pcm = makeTestPcm(100);
    const wav = pcmToWav(pcm);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
  });

  it("encodes format chunk for 24 kHz / 16-bit / mono PCM", () => {
    const wav = pcmToWav(makeTestPcm(50));
    expect(wav.readUInt16LE(20)).toBe(1);           // AudioFormat = PCM
    expect(wav.readUInt16LE(22)).toBe(1);           // channels
    expect(wav.readUInt32LE(24)).toBe(24000);       // sampleRate
    expect(wav.readUInt16LE(34)).toBe(16);          // bitsPerSample
    expect(wav.readUInt32LE(28)).toBe(24000 * 2);   // byteRate = sr * channels * bytes/sample
    expect(wav.readUInt16LE(32)).toBe(2);           // blockAlign
  });

  it("chunk-size fields cover header remainder and data length", () => {
    const pcm = makeTestPcm(123);
    const wav = pcmToWav(pcm);
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF chunk size
    expect(wav.readUInt32LE(40)).toBe(pcm.length);     // data chunk size
  });

  it("round-trips bytes through wavToPcm", () => {
    const pcm = makeTestPcm(512);
    const wav = pcmToWav(pcm);
    const back = wavToPcm(wav);
    expect(back.length).toBe(pcm.length);
    expect(back.equals(pcm)).toBe(true);
  });

  it("accepts override format without changing payload bytes", () => {
    const pcm = makeTestPcm(64);
    const wav = pcmToWav(pcm, {
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 16,
    });
    expect(wav.readUInt32LE(24)).toBe(48000);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(28)).toBe(48000 * 2 * 2);
    expect(wav.readUInt16LE(32)).toBe(4); // channels * bytes/sample
    // Payload still intact at offset 44.
    expect(wav.subarray(44).equals(pcm)).toBe(true);
  });

  it("wavToPcm throws on non-RIFF data", () => {
    const garbage = Buffer.alloc(44, 0);
    expect(() => wavToPcm(garbage)).toThrow(/Not a RIFF/);
  });

  it("wavToPcm throws on truncated buffer", () => {
    expect(() => wavToPcm(Buffer.alloc(10))).toThrow(/too short/i);
  });

  it("exposes the canonical Gemini TTS format constants", () => {
    expect(GEMINI_TTS_PCM_FORMAT.sampleRate).toBe(24000);
    expect(GEMINI_TTS_PCM_FORMAT.channels).toBe(1);
    expect(GEMINI_TTS_PCM_FORMAT.bitsPerSample).toBe(16);
  });
});
