import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the heavy deps BEFORE importing batcher so the singleton picks up our stubs.
vi.mock("@/server/tokens/veoTokenCollector", () => {
  return {
    getVeoCollector: vi.fn(async () => ({
      collectAuth: vi.fn(async () => ({
        accessToken: "AT",
        sessionId: "sess",
        projectId: "proj",
        cookie: "c=1",
      })),
      getFreshRecaptchaToken: vi.fn(async () => "RT"),
      invalidateAuth: vi.fn(),
    })),
  };
});

const postMock = vi.fn();
vi.mock("@/server/providers/veo/http", () => ({
  postJsonWithToken: (...args: unknown[]) => postMock(...args),
}));

import { resetCreateImageBatcherForTests, getCreateImageBatcher } from "@/server/providers/veo/batcher";

function mockOkBody(nImages: number): string {
  // Shape mirrors what parseGeneratedImages traverses: any object with
  // `downloadUrl` + `mediaId` is picked up in document order.
  return JSON.stringify({
    imagePanels: Array.from({ length: nImages }, (_, i) => ({
      generatedImages: [
        { mediaId: `img-${i}`, downloadUrl: `https://cdn/img-${i}.png`, mimeType: "image/png" },
      ],
    })),
  });
}

const baseOpts = {
  prompt: "hello",
  modelLabel: "Nano Banana 2",
  aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
  outputCount: 1,
};

describe("CreateImageBatcher", () => {
  beforeEach(() => {
    resetCreateImageBatcherForTests();
    postMock.mockReset();
    process.env.VEO_IMAGE_BATCH_MAX = "4";
    process.env.VEO_IMAGE_BATCH_WINDOW_MS = "50";
  });

  afterEach(() => {
    delete process.env.VEO_IMAGE_BATCH_MAX;
    delete process.env.VEO_IMAGE_BATCH_WINDOW_MS;
  });

  it("merges 3 submits within the window into a single HTTP call", async () => {
    postMock.mockResolvedValueOnce({ ok: true, status: 200, body: mockOkBody(3), headers: {}, url: "x" });

    const batcher = getCreateImageBatcher();
    const p1 = batcher.submit({ ...baseOpts, prompt: "a" });
    const p2 = batcher.submit({ ...baseOpts, prompt: "b" });
    const p3 = batcher.submit({ ...baseOpts, prompt: "c" });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(postMock).toHaveBeenCalledTimes(1);
    const payload = postMock.mock.calls[0][1] as { requests: unknown[] };
    expect(payload.requests).toHaveLength(3);
    expect(r1.raw).toHaveLength(1);
    expect(r2.raw).toHaveLength(1);
    expect(r3.raw).toHaveLength(1);
    expect(r1.raw[0].mediaId).toBe("img-0");
    expect(r2.raw[0].mediaId).toBe("img-1");
    expect(r3.raw[0].mediaId).toBe("img-2");
  });

  it("flushes immediately when max batch size is reached", async () => {
    process.env.VEO_IMAGE_BATCH_MAX = "2";
    process.env.VEO_IMAGE_BATCH_WINDOW_MS = "10000";
    resetCreateImageBatcherForTests();

    postMock.mockResolvedValueOnce({ ok: true, status: 200, body: mockOkBody(2), headers: {}, url: "x" });

    const batcher = getCreateImageBatcher();
    const started = Date.now();
    const [r1, r2] = await Promise.all([
      batcher.submit({ ...baseOpts, prompt: "a" }),
      batcher.submit({ ...baseOpts, prompt: "b" }),
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(r1.raw[0].mediaId).toBe("img-0");
    expect(r2.raw[0].mediaId).toBe("img-1");
  });

  it("groups by modelLabel — different models go in separate API calls", async () => {
    postMock
      .mockResolvedValueOnce({ ok: true, status: 200, body: mockOkBody(2), headers: {}, url: "x" })
      .mockResolvedValueOnce({ ok: true, status: 200, body: mockOkBody(1), headers: {}, url: "x" });

    const batcher = getCreateImageBatcher();
    const a = batcher.submit({ ...baseOpts, prompt: "a", modelLabel: "Nano Banana 2" });
    const b = batcher.submit({ ...baseOpts, prompt: "b", modelLabel: "Nano Banana 2" });
    const c = batcher.submit({ ...baseOpts, prompt: "c", modelLabel: "Imagen 4" });
    await Promise.all([a, b, c]);

    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to individual calls when the batched response is mis-shaped", async () => {
    // First call = the batched attempt → returns fewer images than expected.
    postMock
      .mockResolvedValueOnce({ ok: true, status: 200, body: mockOkBody(1), headers: {}, url: "x" })
      // Fallback individual calls — 2 of them, both succeed.
      .mockResolvedValueOnce({ ok: true, status: 200, body: mockOkBody(1), headers: {}, url: "x" })
      .mockResolvedValueOnce({ ok: true, status: 200, body: mockOkBody(1), headers: {}, url: "x" });

    const batcher = getCreateImageBatcher();
    const [r1, r2] = await Promise.all([
      batcher.submit({ ...baseOpts, prompt: "a" }),
      batcher.submit({ ...baseOpts, prompt: "b" }),
    ]);

    expect(postMock).toHaveBeenCalledTimes(3);
    expect(r1.raw).toHaveLength(1);
    expect(r2.raw).toHaveLength(1);
  });

  it("propagates HTTP error through fallback", async () => {
    postMock.mockResolvedValue({ ok: false, status: 500, body: "oops", headers: {}, url: "x" });

    const batcher = getCreateImageBatcher();
    await expect(
      Promise.all([
        batcher.submit({ ...baseOpts, prompt: "a" }),
        batcher.submit({ ...baseOpts, prompt: "b" }),
      ])
    ).rejects.toThrow(/500|oops/);
  });

  it("respects per-request outputCount in demux", async () => {
    // caller 1 wants 2 images, caller 2 wants 1 → 3 slots total.
    postMock.mockResolvedValueOnce({ ok: true, status: 200, body: mockOkBody(3), headers: {}, url: "x" });

    const batcher = getCreateImageBatcher();
    const [r1, r2] = await Promise.all([
      batcher.submit({ ...baseOpts, prompt: "a", outputCount: 2 }),
      batcher.submit({ ...baseOpts, prompt: "b", outputCount: 1 }),
    ]);

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(r1.raw).toHaveLength(2);
    expect(r2.raw).toHaveLength(1);
    expect(r1.raw.map((i) => i.mediaId)).toEqual(["img-0", "img-1"]);
    expect(r2.raw[0].mediaId).toBe("img-2");
  });
});
