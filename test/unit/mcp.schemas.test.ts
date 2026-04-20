import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  ImageInputShape,
  JobIdShape,
  OpenLoginShape,
  VideoI2VShape,
  VideoStartEndShape,
  VideoT2VShape,
  WorkflowIdShape,
} from "@/server/mcp/schemas";

const ImageInput = z.object(ImageInputShape);
const VideoT2V = z.object(VideoT2VShape);
const VideoI2V = z.object(VideoI2VShape);
const VideoStartEnd = z.object(VideoStartEndShape);
const JobId = z.object(JobIdShape);
const OpenLogin = z.object(OpenLoginShape);
const WorkflowId = z.object(WorkflowIdShape);

describe("mcp tool input schemas", () => {
  it("ImageInput: accepts minimal body", () => {
    const r = ImageInput.safeParse({ prompt: "hello" });
    expect(r.success).toBe(true);
  });

  it("ImageInput: rejects empty prompt", () => {
    const r = ImageInput.safeParse({ prompt: "" });
    expect(r.success).toBe(false);
  });

  it("ImageInput: rejects outputCount > 8", () => {
    const r = ImageInput.safeParse({ prompt: "x", outputCount: 99 });
    expect(r.success).toBe(false);
  });

  it("ImageInput: accepts reference urls array", () => {
    const r = ImageInput.safeParse({
      prompt: "x",
      referenceImageUrls: ["https://example.com/a.png", "data:image/png;base64,AAA"],
    });
    expect(r.success).toBe(true);
  });

  it("VideoT2V: provider is required", () => {
    const r = VideoT2V.safeParse({ prompt: "x" });
    expect(r.success).toBe(false);
  });

  it("VideoT2V: rejects invalid provider", () => {
    const r = VideoT2V.safeParse({ prompt: "x", provider: "bogus" });
    expect(r.success).toBe(false);
  });

  it("VideoT2V: rejects videoLength out of range", () => {
    const r = VideoT2V.safeParse({ prompt: "x", provider: "grok", videoLength: 30 });
    expect(r.success).toBe(false);
  });

  it("VideoI2V: startImageUrl required", () => {
    const r = VideoI2V.safeParse({ prompt: "x", provider: "veo" });
    expect(r.success).toBe(false);
  });

  it("VideoStartEnd: both frames required", () => {
    const onlyStart = VideoStartEnd.safeParse({
      prompt: "x",
      startImageUrl: "https://a/1.png",
    });
    expect(onlyStart.success).toBe(false);
    const full = VideoStartEnd.safeParse({
      prompt: "x",
      startImageUrl: "https://a/1.png",
      endImageUrl: "https://a/2.png",
    });
    expect(full.success).toBe(true);
  });

  it("JobId: rejects empty string", () => {
    expect(JobId.safeParse({ jobId: "" }).success).toBe(false);
    expect(JobId.safeParse({ jobId: "job_abc" }).success).toBe(true);
  });

  it("OpenLogin: only veo/grok allowed", () => {
    expect(OpenLogin.safeParse({ target: "veo" }).success).toBe(true);
    expect(OpenLogin.safeParse({ target: "veo", profileName: "foo" }).success).toBe(true);
    expect(OpenLogin.safeParse({ target: "other" }).success).toBe(false);
  });

  it("WorkflowId: required, non-empty", () => {
    expect(WorkflowId.safeParse({}).success).toBe(false);
    expect(WorkflowId.safeParse({ workflowId: "wf_abc" }).success).toBe(true);
  });
});
