/**
 * Unit tests for video analyzer parseResponse module.
 * Tests JSON extraction from various AI response formats and zod validation.
 */

import { describe, it, expect } from "vitest";
import { parseAnalyzeResponse, VideoAnalyzeParseError } from "@/server/providers/videoAnalyzer/parseResponse";

const VALID_RESULT = {
  aspectRatio: "16:9" as const,
  scenes: [
    { imagePrompt: "A woman walking on a beach at sunset", videoPrompt: "Camera slowly pans left" },
    { imagePrompt: "Close-up of waves crashing on rocks", videoPrompt: "Zoom in with slight shake" },
  ],
};

describe("parseAnalyzeResponse", () => {
  it("parses raw JSON", () => {
    const raw = JSON.stringify(VALID_RESULT);
    const result = parseAnalyzeResponse(raw);
    expect(result.aspectRatio).toBe("16:9");
    expect(result.scenes).toHaveLength(2);
    expect(result.scenes[0].imagePrompt).toBe("A woman walking on a beach at sunset");
    expect(result.rawResponse).toBe(raw);
  });

  it("parses code-fenced JSON (```json)", () => {
    const raw = "Here is the analysis:\n\n```json\n" + JSON.stringify(VALID_RESULT) + "\n```\n\nHope this helps!";
    const result = parseAnalyzeResponse(raw);
    expect(result.scenes).toHaveLength(2);
  });

  it("parses code-fenced JSON without language tag", () => {
    const raw = "```\n" + JSON.stringify(VALID_RESULT) + "\n```";
    const result = parseAnalyzeResponse(raw);
    expect(result.scenes).toHaveLength(2);
  });

  it("parses JSON embedded in prose", () => {
    const raw =
      "I found 2 scenes in the video. " +
      JSON.stringify(VALID_RESULT) +
      " Let me know if you need anything else.";
    const result = parseAnalyzeResponse(raw);
    expect(result.scenes).toHaveLength(2);
  });

  it("throws VideoAnalyzeParseError for no JSON", () => {
    expect(() => parseAnalyzeResponse("No JSON here, just text about the video.")).toThrow(
      VideoAnalyzeParseError,
    );
  });

  it("throws VideoAnalyzeParseError for invalid JSON syntax", () => {
    expect(() => parseAnalyzeResponse('{"aspectRatio": "16:9", "scenes": [broken')).toThrow(
      VideoAnalyzeParseError,
    );
  });

  it("throws VideoAnalyzeParseError for missing required fields", () => {
    const incomplete = JSON.stringify({ aspectRatio: "16:9" });
    expect(() => parseAnalyzeResponse(incomplete)).toThrow(VideoAnalyzeParseError);
  });

  it("throws VideoAnalyzeParseError for invalid aspectRatio", () => {
    const bad = JSON.stringify({
      aspectRatio: "4:3",
      scenes: [{ imagePrompt: "test", videoPrompt: "test" }],
    });
    expect(() => parseAnalyzeResponse(bad)).toThrow(VideoAnalyzeParseError);
  });

  it("throws VideoAnalyzeParseError for empty scenes array", () => {
    const empty = JSON.stringify({ aspectRatio: "16:9", scenes: [] });
    expect(() => parseAnalyzeResponse(empty)).toThrow(VideoAnalyzeParseError);
  });

  it("throws VideoAnalyzeParseError for scenes with empty prompts", () => {
    const bad = JSON.stringify({
      aspectRatio: "16:9",
      scenes: [{ imagePrompt: "", videoPrompt: "test" }],
    });
    expect(() => parseAnalyzeResponse(bad)).toThrow(VideoAnalyzeParseError);
  });

  it("preserves rawResponse on successful parse", () => {
    const raw = JSON.stringify(VALID_RESULT);
    const result = parseAnalyzeResponse(raw);
    expect(result.rawResponse).toBe(raw);
  });

  it("handles 9:16 aspect ratio", () => {
    const data = { ...VALID_RESULT, aspectRatio: "9:16" };
    const result = parseAnalyzeResponse(JSON.stringify(data));
    expect(result.aspectRatio).toBe("9:16");
  });

  it("handles 1:1 aspect ratio", () => {
    const data = { ...VALID_RESULT, aspectRatio: "1:1" };
    const result = parseAnalyzeResponse(JSON.stringify(data));
    expect(result.aspectRatio).toBe("1:1");
  });

  // Narration / detectedLanguage fields — populated when
  // `AnalyzeVideoInput.includeNarration` was passed into the request. The
  // schema treats them as optional so older responses (no narration ask) keep
  // parsing cleanly.
  it("parses narration + detectedLanguage when present", () => {
    const data = {
      aspectRatio: "16:9" as const,
      detectedLanguage: "vi-vn",
      scenes: [
        {
          imagePrompt: "A quiet beach",
          videoPrompt: "Slow pan left",
          narration: "Hôm nay biển rất đẹp.",
        },
        {
          imagePrompt: "Sunset over rocks",
          videoPrompt: "Zoom in",
          narration: "",
        },
      ],
    };
    const result = parseAnalyzeResponse(JSON.stringify(data));
    expect(result.detectedLanguage).toBe("vi-vn");
    expect(result.scenes[0].narration).toBe("Hôm nay biển rất đẹp.");
    expect(result.scenes[1].narration).toBe("");
  });

  it("accepts response without narration (backwards compat)", () => {
    const raw = JSON.stringify(VALID_RESULT);
    const result = parseAnalyzeResponse(raw);
    // Optional fields should be absent, not undefined-but-present in a
    // strict sense — just verify they don't break validation.
    expect(result.scenes[0].narration).toBeUndefined();
    expect(result.detectedLanguage).toBeUndefined();
  });

  it("accepts empty detectedLanguage (silent video case)", () => {
    const data = {
      aspectRatio: "9:16" as const,
      detectedLanguage: "",
      scenes: [
        {
          imagePrompt: "Ambient shot",
          videoPrompt: "Static",
          narration: "",
        },
      ],
    };
    const result = parseAnalyzeResponse(JSON.stringify(data));
    expect(result.detectedLanguage).toBe("");
    expect(result.scenes[0].narration).toBe("");
  });
});
