/**
 * Gemini Playwright provider — TRUE UI automation on gemini.google.com.
 *
 * Flow:
 *   1. Connect to the dedicated Chrome profile (where the user is already
 *      signed into Gemini Advanced).
 *   2. Open a fresh tab and navigate to gemini.google.com/app.
 *   3. Upload the video file via the hidden <input type="file">.
 *   4. Wait for Gemini to finish its upload-and-pre-process stage.
 *   5. Type the analyze prompt (asks for a JSON response) and submit.
 *   6. Wait for the response to finish streaming.
 *   7. Parse the response as the usual AnalyzeResult schema.
 *   8. Close the throwaway tab.
 *
 * No API key, no Bearer token — authentication is entirely cookie-based
 * inside the user's Chrome profile.  Each run costs 1 turn of Gemini
 * Advanced quota (same as if the user had done it manually).
 *
 * NB:  The user must have Gemini Advanced (or another plan that permits
 * file uploads); the free tier of gemini.google.com does not accept videos.
 */

import type { Page } from "playwright";

import type { AnalyzeVideoInput, AnalyzeResult } from "./types";
import { buildAnalyzePrompt } from "./prompt";
import { parseAnalyzeResponse, VideoAnalyzeParseError } from "./parseResponse";
import { getAiStudioCollector } from "@/server/tokens/aistudioTokenCollector";
import {
  openGeminiNewChat,
  sendPrompt,
  uploadVideo,
  waitForResponseText,
} from "./geminiUi";

/**
 * Overall deadline for a single analyze run.  Videos can take 1-3 min to
 * upload + process + analyze on Gemini Advanced, so we budget 6 min with
 * some headroom for slow networks.
 */
const ANALYZE_DEADLINE_MS = 6 * 60_000;

export async function analyzeWithGeminiPlaywright(
  input: AnalyzeVideoInput,
): Promise<AnalyzeResult> {
  const session = await getAiStudioCollector();
  const deadline = Date.now() + ANALYZE_DEADLINE_MS;

  let page: Page | null = null;
  try {
    page = await session.newPage();

    // 1. Open gemini.google.com/app on a fresh tab.
    await openGeminiNewChat(page, deadline);

    // 2. Upload the video and wait for Gemini to finish pre-processing.
    await uploadVideo(page, input.videoPath, deadline);

    // 3. Build the prompt (JSON mode + narration flag + scene count).
    const prompt = input.customPrompt || buildAnalyzePrompt({
      sceneCount: input.sceneCount,
      aspectHint: input.aspectHint,
      includeNarration: input.includeNarration,
    });

    // 4. Submit the prompt.
    await sendPrompt(page, prompt, deadline);

    // 5. Wait for the reply.
    const rawText = await waitForResponseText(page, deadline);

    // 6. Parse JSON.  If Gemini wrapped the JSON in prose we retry once
    //    with a stricter follow-up message (just like the API provider does).
    try {
      return parseAnalyzeResponse(rawText);
    } catch (e) {
      if (!(e instanceof VideoAnalyzeParseError)) throw e;

      // Follow-up: ask for JSON only.
      await sendPrompt(
        page,
        "Return ONLY the JSON object from your previous answer. " +
        "No markdown, no explanation, no extra text.",
        deadline,
      );
      const retryText = await waitForResponseText(page, deadline);
      return parseAnalyzeResponse(retryText);
    }
  } finally {
    // Close only the tab — leave the browser (and the user's session) alive
    // so the next analyze call can re-use the Chrome profile without logging
    // in again.
    try { await page?.close(); } catch { /* ignore */ }
  }
}
