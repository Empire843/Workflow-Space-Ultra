/**
 * DOM selectors for AI Studio and ChatGPT automation.
 *
 * Separated into its own module so selectors can be updated independently
 * when the target sites change their DOM structure — without touching
 * the provider logic.
 *
 * Phase 2 — selectors will be filled in during Playwright provider implementation.
 */

// ── AI Studio (aistudio.google.com) ──────────────────────────────

export const AISTUDIO = {
  /** File upload input in the chat interface. */
  fileInput: 'input[type="file"]',
  /** The main prompt textarea / contenteditable. */
  promptInput: '[aria-label="Type something"]',
  /** Send / submit button. */
  sendButton: 'button[aria-label="Run"]',
  /** The model response container — wait for this to have text. */
  responseContainer: '.response-container',
  /** Selector for the "new chat" button to start fresh. */
  newChatButton: 'button[aria-label="New chat"]',
} as const;

// ── ChatGPT (chatgpt.com) ────────────────────────────────────────

export const CHATGPT = {
  /** File upload input (hidden, triggered by attachment button). */
  fileInput: 'input[type="file"][data-testid]',
  /** The main prompt textarea. */
  promptInput: '#prompt-textarea',
  /** Send button. */
  sendButton: '[data-testid="send-button"]',
  /** The assistant message container. */
  responseContainer: '[data-message-author-role="assistant"]',
  /** "Stop generating" button — indicates response is still streaming. */
  stopButton: 'button[aria-label="Stop generating"]',
} as const;
