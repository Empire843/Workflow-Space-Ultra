import { describe, it, expect } from "vitest";

import { buildCombinedPrompt, extractUpstreamText, joinTextSegments } from "@/lib/prompt";

describe("joinTextSegments", () => {
  it("trims, drops empty, joins with newline", () => {
    expect(joinTextSegments(["  a  ", "", "b", null, undefined, "c"])).toBe("a\nb\nc");
  });
  it("returns empty for all-empty", () => {
    expect(joinTextSegments([null, "", "   "])).toBe("");
  });
});

describe("extractUpstreamText", () => {
  it("prefers effectiveText over text on text inputs", () => {
    expect(
      extractUpstreamText([
        { kind: "content.text", effectiveText: "chain", text: "raw" },
        { kind: "gen.image" },
        { kind: "content.text", text: "second" },
      ]),
    ).toBe("chain\nsecond");
  });
  it("ignores non-text inputs", () => {
    expect(extractUpstreamText([{ kind: "gen.image", imageUrl: "x" }])).toBe("");
  });
});

describe("buildCombinedPrompt", () => {
  it("joins upstream + own prompt", () => {
    expect(
      buildCombinedPrompt("own", [{ kind: "content.text", effectiveText: "chain" }]),
    ).toBe("chain\nown");
  });
  it("returns just own when no upstream text", () => {
    expect(buildCombinedPrompt("only mine", [])).toBe("only mine");
  });
  it("returns empty when no inputs and no own prompt", () => {
    expect(buildCombinedPrompt(undefined, [])).toBe("");
  });
});
