/**
 * Pure helpers for computing the effective prompt of a node. Shared by
 *  - the client `computeEffectiveText` (used for live UI preview and when
 *    running a single text node)
 *  - the server executor (source of truth: always re-concatenates upstream
 *    text before handing the prompt to a provider).
 *
 * Keeping this logic in one place means a change in join semantics (e.g.
 * separator, trimming rules) ripples consistently to both sides.
 */

export function joinTextSegments(segments: Array<string | undefined | null>): string {
  return segments
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Extract upstream text from an `inputs` array (already-run parent outputs).
 * Prefers the parent's own `effectiveText` so a chain of text nodes folds
 * correctly: text1 → text2 → text3 → gen means gen only sees text3, but
 * text3.effectiveText already contains text1+text2+text3.
 */
export function extractUpstreamText<T extends { kind: string; effectiveText?: string; text?: string }>(
  inputs: Array<T | undefined | null>,
): string {
  const segments: string[] = [];
  for (const i of inputs) {
    if (!i || i.kind !== "content.text") continue;
    segments.push(i.effectiveText || i.text || "");
  }
  return joinTextSegments(segments);
}

/**
 * Build the final prompt for a generation node from its own prompt + upstream
 * text. Empty segments are dropped. The returned value should NEVER be stored
 * back on `nodeData.prompt` (that would double-concat on re-run).
 */
export function buildCombinedPrompt<T extends { kind: string; effectiveText?: string; text?: string }>(
  ownPrompt: string | undefined,
  inputs: Array<T | undefined | null>,
): string {
  const upstream = extractUpstreamText(inputs);
  return joinTextSegments([upstream, ownPrompt]);
}
