export const GROK_BASE = "https://grok.com";
export const GROK_ASSETS_BASE = "https://assets.grok.com";

export const ENDPOINT_CREATE_POST = `${GROK_BASE}/rest/media/post/create`;
export const ENDPOINT_CONVO_NEW = `${GROK_BASE}/rest/app-chat/conversations/new`;
export const ENDPOINT_UPSCALE = `${GROK_BASE}/rest/media/video/upscale`;
export const ENDPOINT_UPLOAD_FILE = `${GROK_BASE}/rest/app-chat/upload-file`;

export const UPLOAD_FILE_SOURCE = "SELF_UPLOAD_FILE_SOURCE";

export interface GrokVideoConfig {
  aspectRatio: "9:16" | "16:9" | "1:1";
  videoLength: number; // seconds
  resolutionName: "480p" | "720p";
}

export const DEFAULT_VIDEO_CONFIG: GrokVideoConfig = {
  aspectRatio: "9:16",
  videoLength: 6,
  resolutionName: "480p",
};
