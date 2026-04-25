"use client";

import { Download, Film, Loader2, Mic, Package, Upload, Video, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import {
  DEFAULT_TTS_LANGUAGE,
  DEFAULT_TTS_VOICE,
  GEMINI_TTS_LANGUAGES,
  GEMINI_TTS_VOICES,
  type GeminiTtsVoice,
} from "@/lib/tts";
import { cn } from "@/lib/utils";

export interface AnalyzeVideoDialogProps {
  onClose: () => void;
  /** Called when analysis completes — passes pre-fill data to ScenesImportDialog. */
  onResult: (result: {
    imagePrompts: string;
    videoPrompts: string;
    aspectRatio: "16:9" | "9:16" | "1:1";
    sharedStyle?: string;
  }) => void;
}

// `preview` is the new post-analyze in-dialog state — entered only when the
// "Clone TTS script" toggle was on, so the user can generate + download audio
// before moving on to ScenesImportDialog. Without TTS we skip straight to
// `done` (which triggers `onResult` and closes) to preserve the original 1-step
// flow.
type Phase = "idle" | "uploading" | "analyzing" | "preview" | "error";

interface SceneResult {
  imagePrompt: string;
  videoPrompt: string;
  narration?: string;
}

interface AnalyzeApiResult {
  aspectRatio: "16:9" | "9:16" | "1:1";
  sharedStyle?: string;
  scenes: SceneResult[];
  detectedLanguage?: string;
}

interface TtsItem {
  index: number;
  audioDataUrl: string;
  mimeType: string;
  bytes: number;
}

export default function AnalyzeVideoDialog({ onClose, onResult }: AnalyzeVideoDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Clone-TTS toggle + voice/lang pickers — only consumed when the user flips
  // the checkbox on. Default voice/language come from `src/lib/tts.ts`, which
  // also drives the Settings dropdown so the two stay in sync by construction.
  const [cloneTts, setCloneTts] = useState(false);
  const [voice, setVoice] = useState<GeminiTtsVoice>(DEFAULT_TTS_VOICE);
  const [language, setLanguage] = useState<string>(DEFAULT_TTS_LANGUAGE);

  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeApiResult | null>(null);
  const [ttsItems, setTtsItems] = useState<TtsItem[] | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsPhase, setTtsPhase] = useState<"idle" | "generating" | "done">("idle");

  const handleFile = useCallback((f: File | null) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) {
      setError("Vui lòng chọn file video (mp4, webm, mov, avi, mkv).");
      return;
    }
    if (f.size > 200 * 1024 * 1024) {
      setError("File quá lớn (tối đa 200 MB).");
      return;
    }
    setFile(f);
    setYoutubeUrl(""); // Clear url when file is uploaded
    setError(null);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      handleFile(f ?? null);
    },
    [handleFile],
  );

  async function handleAnalyze() {
    if (!file && !youtubeUrl.trim()) return;
    setPhase("uploading");
    setError(null);
    setRawResponse(null);
    setAnalyzeResult(null);
    setTtsItems(null);
    setTtsError(null);
    setTtsPhase("idle");

    try {
      const formData = new FormData();
      if (file) {
        formData.append("video", file);
      } else {
        formData.append("youtubeUrl", youtubeUrl.trim());
      }
      if (cloneTts) formData.append("includeNarration", "true");

      setPhase("analyzing");

      const res = await fetch("/api/analyze-video", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        setPhase("error");
        setError(data.error || `Lỗi ${res.status}`);
        if (data.rawResponse) setRawResponse(data.rawResponse);
        return;
      }

      setAnalyzeResult(data as AnalyzeApiResult);

      // TTS OFF → keep original 1-step UX: push to ScenesImportDialog, close.
      if (!cloneTts) {
        proceedToScenes(data as AnalyzeApiResult);
        return;
      }

      // TTS ON → stay in dialog so user can preview narration + download audio.
      setPhase("preview");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function proceedToScenes(data: AnalyzeApiResult) {
    const imagePrompts = (data.scenes || [])
      .map((s) => s.imagePrompt)
      .join("\n");
    const videoPrompts = (data.scenes || [])
      .map((s) => s.videoPrompt)
      .join("\n");

    onResult({
      imagePrompts,
      videoPrompts,
      aspectRatio: data.aspectRatio || "16:9",
      sharedStyle: data.sharedStyle || undefined,
    });
  }

  async function handleGenerateTts() {
    if (!analyzeResult) return;
    setTtsPhase("generating");
    setTtsError(null);
    setTtsItems(null);

    try {
      const scenes = analyzeResult.scenes
        .map((s, i) => ({ index: i, narration: (s.narration || "").trim() }))
        .filter((s) => s.narration !== "");

      if (scenes.length === 0) {
        setTtsError(
          "Video không có giọng đọc nào để clone TTS (tất cả scene đều im lặng hoặc chỉ có nhạc nền).",
        );
        setTtsPhase("idle");
        return;
      }

      const res = await fetch("/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenes,
          voice,
          language,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setTtsError(err.error || `Lỗi ${res.status}`);
        setTtsPhase("idle");
        return;
      }

      const data = (await res.json()) as { items: TtsItem[] };
      setTtsItems(data.items);
      setTtsPhase("done");
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : String(err));
      setTtsPhase("idle");
    }
  }

  async function handleDownloadZip() {
    if (!analyzeResult) return;
    const scenes = analyzeResult.scenes
      .map((s, i) => ({ index: i, narration: (s.narration || "").trim() }))
      .filter((s) => s.narration !== "");
    if (scenes.length === 0) return;

    const res = await fetch("/api/tts/generate?format=zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenes, voice, language }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      setTtsError(err.error || `Lỗi ${res.status}`);
      return;
    }
    const blob = await res.blob();
    triggerBlobDownload(blob, "tts-scenes.zip");
  }

  const isProcessing = phase === "uploading" || phase === "analyzing";
  const inPreview = phase === "preview" && analyzeResult !== null;

  // Sum of scene narrations with content — drives "X scenes will be synthesised" counter.
  const narrationCount =
    analyzeResult?.scenes.filter((s) => (s.narration || "").trim() !== "").length ?? 0;
  const allSilent = analyzeResult !== null && narrationCount === 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !isProcessing) onClose();
      }}
    >
      <div
        className={cn(
          "w-[min(640px,94vw)] max-h-[92vh] flex flex-col",
          "rounded-xl border border-[color:var(--color-border)]",
          "bg-[color:var(--color-bg-elev-1)] shadow-2xl shadow-black/70",
        )}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 h-11 border-b border-[color:var(--color-border)]">
          <Film className="h-4 w-4 text-[color:var(--color-accent)]" />
          <div className="text-sm font-semibold text-[color:var(--color-fg)]">
            Clone video
          </div>
          <div className="ml-2 text-[11px] text-[color:var(--color-fg-dim)]">
            Upload video → AI phân tích → tạo workflow
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="ml-auto h-7 w-7 grid place-items-center rounded-md text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-elev-2)] hover:text-[color:var(--color-fg)] disabled:opacity-30"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 overflow-y-auto">
          {/* URL Input */}
          {!inPreview && (
            <div className="space-y-1">
              <input
                type="text"
                placeholder="Nhập link YouTube, TikTok, v.v..."
                value={youtubeUrl}
                onChange={(e) => {
                  setYoutubeUrl(e.target.value);
                  if (e.target.value) setFile(null); // Clear file when writing URL
                }}
                disabled={isProcessing}
                className="w-full px-3 py-2 rounded-lg bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-sm text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)] placeholder:text-[color:var(--color-fg-dim)]"
              />
            </div>
          )}

          {/* Separator */}
          {!inPreview && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-[color:var(--color-border)]" />
              <div className="text-[10px] uppercase font-semibold text-[color:var(--color-fg-muted)] tracking-wider">
                hoặc
              </div>
              <div className="flex-1 h-px bg-[color:var(--color-border)]" />
            </div>
          )}

          {/* Drop zone (hidden in preview to save vertical space) */}
          {!inPreview && (
            <div
              className={cn(
                "relative rounded-lg border-2 border-dashed p-8",
                "flex flex-col items-center justify-center gap-3 transition-colors cursor-pointer",
                dragOver
                  ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5"
                  : file
                    ? "border-green-500/40 bg-green-500/5"
                    : "border-[color:var(--color-border)] hover:border-[color:var(--color-fg-muted)]",
                isProcessing && "pointer-events-none opacity-60",
              )}
              onClick={() => !isProcessing && fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              {file ? (
                <>
                  <Video className="h-8 w-8 text-green-400" />
                  <div className="text-xs text-[color:var(--color-fg)]">
                    <span className="font-medium">{file.name}</span>
                    <span className="text-[color:var(--color-fg-dim)] ml-2">
                      ({(file.size / 1024 / 1024).toFixed(1)} MB)
                    </span>
                  </div>
                  <div className="text-[10px] text-[color:var(--color-fg-dim)]">
                    Click để đổi file
                  </div>
                </>
              ) : (
                <>
                  <Upload className="h-8 w-8 text-[color:var(--color-fg-muted)]" />
                  <div className="text-xs text-[color:var(--color-fg)]">
                    Kéo thả video vào đây hoặc{" "}
                    <span className="text-[color:var(--color-accent)] font-medium">
                      chọn file
                    </span>
                  </div>
                  <div className="text-[10px] text-[color:var(--color-fg-dim)]">
                    MP4, WebM, MOV, AVI · Tối đa 200 MB
                  </div>
                </>
              )}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
          />

          {/* TTS toggle + voice/language — shown in idle to let the user opt
              in BEFORE analysis starts (narration extraction is part of the
              same Gemini call as scene split). */}
          {!inPreview && (
            <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev-2)]/40">
              <label className="flex items-center gap-2 p-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={cloneTts}
                  onChange={(e) => setCloneTts(e.target.checked)}
                  disabled={isProcessing}
                  className="accent-[color:var(--color-accent)]"
                />
                <Mic className="h-4 w-4 text-[color:var(--color-accent)]" />
                <span className="text-xs font-medium text-[color:var(--color-fg)]">
                  Also clone TTS script
                </span>
                <span className="ml-auto text-[10px] text-[color:var(--color-fg-dim)]">
                  Gemini {voice} · {language === "auto" ? "auto" : language}
                </span>
              </label>
              {cloneTts && (
                <div className="px-3 pb-3 flex gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
                    Voice:
                    <select
                      value={voice}
                      onChange={(e) => setVoice(e.target.value as GeminiTtsVoice)}
                      disabled={isProcessing}
                      className="h-7 px-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs outline-none focus:border-[color:var(--color-accent)]"
                    >
                      {GEMINI_TTS_VOICES.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
                    Language:
                    <select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      disabled={isProcessing}
                      className="h-7 px-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs outline-none focus:border-[color:var(--color-accent)]"
                    >
                      {GEMINI_TTS_LANGUAGES.map((l) => (
                        <option key={l.value} value={l.value}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <div className="px-3 pb-3 text-[10px] text-[color:var(--color-fg-dim)] leading-relaxed">
                Khi bật, Gemini sẽ transcribe voice-over gốc theo từng scene, sau đó bạn
                có thể sinh TTS bằng giọng mới và download. Audio KHÔNG được ghép
                vào video — chỉ là file rời để bạn dùng lại.
              </div>
            </div>
          )}

          {/* Preview: per-scene narration + TTS controls. */}
          {inPreview && analyzeResult && (
            <PreviewSection
              result={analyzeResult}
              allSilent={allSilent}
              narrationCount={narrationCount}
              voice={voice}
              setVoice={setVoice}
              language={language}
              setLanguage={setLanguage}
              ttsItems={ttsItems}
              ttsPhase={ttsPhase}
              ttsError={ttsError}
              onGenerate={handleGenerateTts}
              onDownloadZip={handleDownloadZip}
            />
          )}

          {/* Progress */}
          {isProcessing && (
            <div className="flex items-center gap-2 text-xs text-[color:var(--color-fg)]">
              <Loader2 className="h-4 w-4 animate-spin text-[color:var(--color-accent)]" />
              {phase === "uploading" && (youtubeUrl ? "Đang tải video..." : "Đang upload video...")}
              {phase === "analyzing" && (
                cloneTts
                  ? "AI đang phân tích video + transcribe voice-over... (có thể mất 1-5 phút)"
                  : "AI đang phân tích video... (có thể mất 1-3 phút)"
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="text-xs text-red-400 p-3 rounded-md bg-red-500/10 border border-red-500/20">
              {error}
            </div>
          )}

          {/* Raw response fallback */}
          {rawResponse && (
            <details className="text-xs">
              <summary className="text-[color:var(--color-fg-dim)] cursor-pointer hover:text-[color:var(--color-fg)]">
                Xem raw AI response
              </summary>
              <pre className="mt-2 p-2 rounded bg-[color:var(--color-bg-elev-2)] text-[10px] max-h-40 overflow-auto whitespace-pre-wrap break-words">
                {rawResponse}
              </pre>
            </details>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[color:var(--color-border)] flex items-center gap-3">
          <div className="text-[10px] text-[color:var(--color-fg-dim)]">
            Powered by Gemini · Settings → Clone Video
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isProcessing}
              className="h-8 px-3 rounded-md text-xs text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-elev-2)] hover:text-[color:var(--color-fg)] disabled:opacity-30"
            >
              {inPreview ? "Cancel" : "Close"}
            </button>
            {inPreview ? (
              <button
                type="button"
                onClick={() => analyzeResult && proceedToScenes(analyzeResult)}
                className="h-8 px-4 rounded-md text-xs font-semibold bg-[color:var(--color-accent)] text-white hover:brightness-110"
              >
                Continue to scenes
              </button>
            ) : (
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={(!file && !youtubeUrl.trim()) || isProcessing}
                className={cn(
                  "h-8 px-4 rounded-md text-xs font-semibold transition flex items-center gap-1.5",
                  (file || youtubeUrl.trim()) && !isProcessing
                    ? "bg-[color:var(--color-accent)] text-white hover:brightness-110"
                    : "bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-dim)] cursor-not-allowed",
                )}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Đang phân tích…
                  </>
                ) : (
                  "Analyze"
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewSection({
  result,
  allSilent,
  narrationCount,
  voice,
  setVoice,
  language,
  setLanguage,
  ttsItems,
  ttsPhase,
  ttsError,
  onGenerate,
  onDownloadZip,
}: {
  result: AnalyzeApiResult;
  allSilent: boolean;
  narrationCount: number;
  voice: GeminiTtsVoice;
  setVoice: (v: GeminiTtsVoice) => void;
  language: string;
  setLanguage: (v: string) => void;
  ttsItems: TtsItem[] | null;
  ttsPhase: "idle" | "generating" | "done";
  ttsError: string | null;
  onGenerate: () => void;
  onDownloadZip: () => void;
}) {
  return (
    <div className="space-y-3">
      {/* Summary */}
      <div className="flex items-center gap-2 text-xs text-[color:var(--color-fg)]">
        <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20 text-[10px] font-semibold">
          {result.scenes.length} scenes
        </span>
        <span className="px-2 py-0.5 rounded-full bg-[color:var(--color-bg-elev-2)] text-[10px]">
          {result.aspectRatio}
        </span>
        {result.detectedLanguage && (
          <span className="px-2 py-0.5 rounded-full bg-[color:var(--color-bg-elev-2)] text-[10px]">
            Lang: {result.detectedLanguage}
          </span>
        )}
        <span className="ml-auto text-[10px] text-[color:var(--color-fg-dim)]">
          {narrationCount}/{result.scenes.length} scene có voice-over
        </span>
      </div>

      {/* Silent video banner */}
      {allSilent && (
        <div className="text-xs text-amber-400 p-3 rounded-md bg-amber-500/10 border border-amber-500/20">
          Video không có giọng đọc nào để clone TTS (tất cả scene đều im lặng hoặc chỉ có nhạc
          nền). Bạn vẫn có thể tiếp tục tạo scenes — chỉ không có audio để sinh.
        </div>
      )}

      {/* Voice/language picker + Generate button */}
      {!allSilent && (
        <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev-2)]/40 p-3 flex flex-wrap items-center gap-2">
          <Mic className="h-3.5 w-3.5 text-[color:var(--color-accent)]" />
          <label className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
            Voice:
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value as GeminiTtsVoice)}
              disabled={ttsPhase === "generating"}
              className="h-7 px-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs outline-none focus:border-[color:var(--color-accent)]"
            >
              {GEMINI_TTS_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
            Lang:
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={ttsPhase === "generating"}
              className="h-7 px-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs outline-none focus:border-[color:var(--color-accent)]"
            >
              {GEMINI_TTS_LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onGenerate}
              disabled={ttsPhase === "generating"}
              className={cn(
                "h-7 px-3 rounded-md text-xs font-semibold transition flex items-center gap-1.5",
                ttsPhase === "generating"
                  ? "bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-dim)] cursor-not-allowed"
                  : "bg-[color:var(--color-accent)] text-white hover:brightness-110",
              )}
            >
              {ttsPhase === "generating" ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Mic className="h-3.5 w-3.5" />
                  Generate TTS ({narrationCount})
                </>
              )}
            </button>
            {ttsItems && ttsItems.length > 0 && (
              <button
                type="button"
                onClick={onDownloadZip}
                className="h-7 px-3 rounded-md text-xs font-semibold bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-elev-2)]/70 border border-[color:var(--color-border)] flex items-center gap-1.5"
                title="Download .zip chứa mọi scene"
              >
                <Package className="h-3.5 w-3.5" />
                Zip
              </button>
            )}
          </div>
        </div>
      )}

      {ttsError && (
        <div className="text-xs text-red-400 p-3 rounded-md bg-red-500/10 border border-red-500/20">
          {ttsError}
        </div>
      )}

      {/* Scene list */}
      <div className="border border-[color:var(--color-border)] rounded-md divide-y divide-[color:var(--color-border)] max-h-[40vh] overflow-y-auto">
        {result.scenes.map((s, i) => {
          const narr = (s.narration || "").trim();
          const hasNarration = narr !== "";
          const audio = ttsItems?.find((t) => t.index === i);
          return (
            <div key={i} className="p-3 space-y-1.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-semibold text-[color:var(--color-fg)]">
                  Scene {i + 1}
                </span>
                {hasNarration ? (
                  <span className="text-[color:var(--color-fg-dim)]">
                    {narr.length} ký tự
                  </span>
                ) : (
                  <span className="text-[color:var(--color-fg-dim)] italic">
                    (im lặng)
                  </span>
                )}
                {audio && (
                  <a
                    href={audio.audioDataUrl}
                    download={`scene-${String(i + 1).padStart(2, "0")}.wav`}
                    className="ml-auto h-6 px-2 rounded text-[10px] font-semibold bg-[color:var(--color-bg-elev-2)] hover:bg-[color:var(--color-bg-elev-2)]/70 border border-[color:var(--color-border)] flex items-center gap-1"
                    title={`Download ${(audio.bytes / 1024).toFixed(0)} KB`}
                  >
                    <Download className="h-3 w-3" />
                    WAV
                  </a>
                )}
              </div>
              {hasNarration && (
                <div className="text-[11px] text-[color:var(--color-fg)] leading-relaxed">
                  {narr}
                </div>
              )}
              {audio && (
                <audio
                  src={audio.audioDataUrl}
                  controls
                  preload="none"
                  className="w-full h-8 mt-1"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so Safari/iOS have time to consume the link. The
  // timeout value is cargo-culted from the MDN example; a 0ms setTimeout
  // occasionally lost the download on older Safari.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
