"use client";

import { AlertTriangle, ChevronRight, ListPlus, Paperclip, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { GenMode } from "@/lib/nodes";
import { cn } from "@/lib/utils";
import { useWorkflowStore } from "@/state/workflowStore";

export interface ScenesImportDialogProps {
  /** React Flow world coordinates — anchor for the top-left of the spawned batch (or Frame). */
  flowX: number;
  flowY: number;
  onClose: () => void;
  /** Pre-fill from Clone Video analysis result. */
  initialState?: {
    imagePrompts: string;
    videoPrompts: string;
    aspectRatio: "16:9" | "9:16" | "1:1";
  };
}

type ImageGenModeOpt = "t2i.veo";
type VideoGenModeOpt = "t2v.veo" | "t2v.grok";
type AspectRatio = "16:9" | "9:16" | "1:1";

// Cố tình chỉ expose 3 ratio mà backend thật sự support (xem
// executor.ts và VEO constants: LANDSCAPE / PORTRAIT / SQUARE).
// Bất cứ ratio nào khác (2:3, 3:2, 4:5, …) sẽ bị silently coerce về
// LANDSCAPE, nên không đưa vào dropdown để tránh lập lờ kết quả.
const ASPECT_OPTIONS: AspectRatio[] = ["16:9", "9:16", "1:1"];

/** Split a pasted block into per-line prompts. Only trims whitespace at the
 *  very start/end of the block so internal blank lines are preserved as empty
 *  prompts (keeps scene indexes aligned). Individual lines are trimmed. */
function splitPrompts(raw: string): string[] {
  const block = raw.replace(/^[\s\r\n]+|[\s\r\n]+$/g, "");
  if (!block) return [];
  return block.split(/\r?\n/).map((l) => l.trim());
}

/** Read a File as a `data:<mime>;base64,<payload>` URL. Used for reference
 *  images so the store can keep them inline (no remote upload round-trip
 *  before the user even runs the frame). */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** Upper bound per reference image. Above this we warn — large refs slow
 *  down both the page save (IndexedDB) and the upload leg of the first run.
 *  VEO's upload endpoint itself comfortably accepts ≥10 MB, but there's no
 *  reason to pay that cost for a character sheet that will re-resize anyway. */
const MAX_REF_BYTES = 6 * 1024 * 1024;
const MAX_REF_COUNT = 3;

type RefImage = { dataUrl: string; mime: string; name: string; bytes: number };

export default function ScenesImportDialog({ flowX, flowY, onClose, initialState }: ScenesImportDialogProps) {
  const importScenes = useWorkflowStore((s) => s.importScenes);

  const [imageText, setImageText] = useState(initialState?.imagePrompts ?? "");
  const [videoText, setVideoText] = useState(initialState?.videoPrompts ?? "");
  const [imageGenMode, setImageGenMode] = useState<ImageGenModeOpt>("t2i.veo");
  const [videoGenMode, setVideoGenMode] = useState<VideoGenModeOpt>("t2v.veo");
  const [groupInFrame, setGroupInFrame] = useState(true);
  /**
   * One-prompt-video mode: nhập 1 prompt video duy nhất, áp dụng cho tất cả
   * scene. Scene count lúc này = số dòng image prompt. Cover trường hợp phổ
   * biến: user chỉ muốn mô tả motion chung ("camera slowly dollies in,
   * cinematic 24fps") mà không cần viết lại cho từng scene.
   */
  const [oneVideoPrompt, setOneVideoPrompt] = useState(false);
  // Applied uniformly to every gen.image AND gen.video node created in
  // this batch. User can still override per-node later via the inspector.
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(initialState?.aspectRatio ?? "16:9");

  // Consistency tools (Shared style text + reference images). Collapsed by
  // default: unfamiliar users shouldn't be forced to deal with it, but the
  // section is one click away so returning users find it fast.
  const [consistencyOpen, setConsistencyOpen] = useState(false);
  const [stylePrefix, setStylePrefix] = useState("");
  const [refImages, setRefImages] = useState<RefImage[]>([]);
  const [refError, setRefError] = useState<string | null>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);

  const imageFirstTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    imageFirstTextareaRef.current?.focus();
  }, []);

  const imagePrompts = useMemo(() => splitPrompts(imageText), [imageText]);
  // In one-prompt-video mode the whole textarea is a single prompt — we don't
  // split by line. The replicated array (one per scene) is computed below
  // once `n` is known.
  const videoLinePrompts = useMemo(() => splitPrompts(videoText), [videoText]);
  const videoSingleText = videoText.trim();

  const imgCount = imagePrompts.length;
  const vidCount = oneVideoPrompt
    ? videoSingleText
      ? 1
      : 0
    : videoLinePrompts.length;
  // Mismatch only matters in per-line mode; single mode maps 1 prompt → N.
  const mismatch = oneVideoPrompt ? false : imgCount !== vidCount;
  const empty = imgCount === 0 && vidCount === 0;
  const n = oneVideoPrompt
    ? videoSingleText
      ? imgCount
      : 0
    : Math.min(imgCount, videoLinePrompts.length);
  const canConfirm = !empty && !mismatch && n > 0;
  const tooMany = n > 50;

  // Final video prompts passed to the store: replicate the single prompt N
  // times in one-prompt mode, otherwise use the per-line array as-is.
  const effectiveVideoPrompts = useMemo(
    () =>
      oneVideoPrompt
        ? Array.from({ length: n }, () => videoSingleText)
        : videoLinePrompts,
    [oneVideoPrompt, n, videoSingleText, videoLinePrompts],
  );

  async function handlePickRefFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setRefError(null);
    const available = Math.max(0, MAX_REF_COUNT - refImages.length);
    if (available === 0) {
      setRefError(`Tối đa ${MAX_REF_COUNT} ảnh reference.`);
      return;
    }
    const files = Array.from(fileList).slice(0, available);
    const next: RefImage[] = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) {
        setRefError(`Bỏ qua "${f.name}" — không phải ảnh.`);
        continue;
      }
      if (f.size > MAX_REF_BYTES) {
        setRefError(
          `"${f.name}" quá lớn (${(f.size / 1024 / 1024).toFixed(1)} MB > ${MAX_REF_BYTES / 1024 / 1024} MB).`,
        );
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(f);
        next.push({ dataUrl, mime: f.type, name: f.name, bytes: f.size });
      } catch {
        setRefError(`Không đọc được "${f.name}".`);
      }
    }
    if (next.length) setRefImages((prev) => [...prev, ...next]);
    // Clear file input so the same file can be re-picked after a remove.
    if (refFileInputRef.current) refFileInputRef.current.value = "";
  }

  function removeRef(idx: number) {
    setRefImages((prev) => prev.filter((_, i) => i !== idx));
  }

  const nonVeoImageModel = imageGenMode !== "t2i.veo"; // future-proof
  const refHint = refImages.length > 0
    ? "Sẽ được gắn làm reference cho MỌI node Image. Chỉ Nano Banana 2 / pro dùng; Imagen 4 sẽ bỏ qua."
    : "Upload 1–3 ảnh character / style / setting. Mỗi gen.image sẽ nhận tất cả ảnh này làm reference.";

  function handleConfirm() {
    if (!canConfirm) return;
    importScenes({
      imagePrompts,
      videoPrompts: effectiveVideoPrompts,
      imageGenMode: imageGenMode as GenMode,
      videoGenMode: videoGenMode as GenMode,
      aspectRatio,
      anchor: { x: flowX, y: flowY },
      groupInFrame,
      stylePrefix: stylePrefix.trim() || undefined,
      referenceImages: refImages.length
        ? refImages.map((r) => ({ dataUrl: r.dataUrl, mime: r.mime, name: r.name }))
        : undefined,
    });
    onClose();
  }

  // Esc closes; Ctrl/Cmd+Enter confirms.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (canConfirm) handleConfirm();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canConfirm,
    imagePrompts,
    effectiveVideoPrompts,
    imageGenMode,
    videoGenMode,
    groupInFrame,
    stylePrefix,
    refImages,
    oneVideoPrompt,
    aspectRatio,
  ]);

  // VEO video endpoint only knows LANDSCAPE / PORTRAIT — "1:1" is silently
  // coerced to 16:9 by executor.ts. Warn so user isn't surprised when the
  // video comes back landscape even though they picked 1:1. Grok supports
  // 1:1 natively, so no warning when video provider = Grok.
  const veoSquareFallback = aspectRatio === "1:1" && videoGenMode === "t2v.veo";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Close on backdrop click but not when clicking inside the panel.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "w-[min(1100px,96vw)] max-h-[92vh] flex flex-col",
          "rounded-xl border border-[color:var(--color-border)]",
          "bg-[color:var(--color-bg-elev-1)] shadow-2xl shadow-black/70",
        )}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="flex items-center gap-2 px-4 h-11 border-b border-[color:var(--color-border)]">
          <ListPlus className="h-4 w-4 text-[color:var(--color-accent)]" />
          <div className="text-sm font-semibold text-[color:var(--color-fg)]">
            Import scenes from prompts
          </div>
          <div className="ml-2 text-[11px] text-[color:var(--color-fg-dim)]">
            {oneVideoPrompt
              ? "Image: 1 dòng = 1 scene · Video: 1 prompt chung"
              : "Mỗi dòng = 1 scene · Số dòng 2 ô phải bằng nhau"}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto h-7 w-7 grid place-items-center rounded-md text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-elev-2)] hover:text-[color:var(--color-fg)]"
            title="Close (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 p-4 grid grid-cols-2 gap-4">
          <PromptColumn
            label="Image prompts"
            hint="Prompt tạo ảnh (1 dòng / scene)"
            value={imageText}
            onChange={setImageText}
            count={imgCount}
            countMismatch={mismatch}
            textareaRef={imageFirstTextareaRef}
          />
          <PromptColumn
            label={oneVideoPrompt ? "Video prompt (1 chung)" : "Video prompts"}
            hint={
              oneVideoPrompt
                ? `Áp dụng cho cả ${Math.max(imgCount, 1)} scene`
                : "Prompt chuyển động video (1 dòng / scene)"
            }
            value={videoText}
            onChange={setVideoText}
            count={vidCount}
            countLabel={oneVideoPrompt ? (videoSingleText ? "✓" : "—") : undefined}
            countMismatch={mismatch}
            placeholderOverride={
              oneVideoPrompt
                ? "VD: Camera slowly dollies in, subtle breathing motion, cinematic 24 fps."
                : undefined
            }
          />
        </div>

        {/* Consistency tools — shared style text + reference images.
             Cả hai đi vào header row của Frame và được fan-out tới mọi scene
             (xem workflowStore.importScenes), nên chỉnh 1 chỗ sẽ đồng bộ
             character / bối cảnh / phong cách cho tất cả scene. */}
        <div className="border-t border-[color:var(--color-border)]">
          <button
            type="button"
            onClick={() => setConsistencyOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-4 h-9 text-xs text-[color:var(--color-fg)] hover:bg-[color:var(--color-bg-elev-2)] transition-colors"
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                consistencyOpen && "rotate-90",
              )}
            />
            <Sparkles className="h-3.5 w-3.5 text-[color:var(--color-accent)]" />
            <span className="font-semibold">Style & References</span>
            <span className="text-[color:var(--color-fg-dim)]">
              Đồng bộ character / bối cảnh / phong cách cho mọi scene
            </span>
            <div className="ml-auto flex items-center gap-2 text-[10px] text-[color:var(--color-fg-dim)]">
              {stylePrefix.trim() && (
                <span className="px-1.5 py-0.5 rounded bg-[color:var(--color-bg-elev-2)]">
                  +style
                </span>
              )}
              {refImages.length > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-[color:var(--color-bg-elev-2)]">
                  {refImages.length} ref
                </span>
              )}
            </div>
          </button>

          {consistencyOpen && (
            <div className="px-4 pb-3 grid grid-cols-[1fr_320px] gap-4">
              <div className="flex flex-col min-h-0">
                <div className="flex items-baseline gap-2 mb-1.5">
                  <div className="text-xs font-semibold text-[color:var(--color-fg)]">
                    Shared style / character sheet
                  </div>
                  <div className="text-[10px] text-[color:var(--color-fg-dim)]">
                    Tự động prepend vào prompt của mọi scene (cả image và video)
                  </div>
                </div>
                <textarea
                  value={stylePrefix}
                  onChange={(e) => setStylePrefix(e.target.value)}
                  spellCheck={false}
                  placeholder={`VD: An orange tabby cat named Miu, white chest, green collar. Pixar 3D style, warm key-light, cozy indoor scene, cinematic.`}
                  className={cn(
                    "h-[110px] resize-none",
                    "rounded-md border p-3 text-xs leading-relaxed font-mono",
                    "bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg)]",
                    "placeholder:text-[color:var(--color-fg-dim)]",
                    "outline-none focus:border-[color:var(--color-accent)]",
                    "border-[color:var(--color-border)]",
                  )}
                />
              </div>

              <div className="flex flex-col min-h-0">
                <div className="flex items-baseline gap-2 mb-1.5">
                  <div className="text-xs font-semibold text-[color:var(--color-fg)]">
                    Reference images
                  </div>
                  <div className="text-[10px] text-[color:var(--color-fg-dim)]">
                    {refImages.length}/{MAX_REF_COUNT}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                  {refImages.map((r, i) => (
                    <div
                      key={`${r.name}-${i}`}
                      className="relative group h-16 w-16 rounded-md overflow-hidden border border-[color:var(--color-border)]"
                      title={`${r.name} · ${(r.bytes / 1024).toFixed(0)} KB`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={r.dataUrl}
                        alt={r.name}
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeRef(i)}
                        className="absolute top-0.5 right-0.5 h-4 w-4 grid place-items-center rounded bg-black/70 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Remove"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                  {refImages.length < MAX_REF_COUNT && (
                    <button
                      type="button"
                      onClick={() => refFileInputRef.current?.click()}
                      className={cn(
                        "h-16 w-16 rounded-md grid place-items-center text-[color:var(--color-fg-muted)]",
                        "border-2 border-dashed border-[color:var(--color-border)]",
                        "hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-accent)] transition-colors",
                      )}
                      title="Add reference image"
                    >
                      <Paperclip className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <input
                  ref={refFileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void handlePickRefFiles(e.target.files);
                  }}
                />
                <div className="text-[10px] text-[color:var(--color-fg-dim)] leading-relaxed">
                  {refHint}
                </div>
                {refError && (
                  <div className="mt-1 text-[10px] text-red-400">{refError}</div>
                )}
                {nonVeoImageModel && refImages.length > 0 && (
                  <div className="mt-1 text-[10px] text-amber-400">
                    Image provider hiện không hỗ trợ reference — ảnh sẽ bị bỏ qua.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[color:var(--color-border)] flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-[color:var(--color-fg)]">
            <span className="text-[color:var(--color-fg-muted)]">Image:</span>
            <select
              value={imageGenMode}
              onChange={(e) => setImageGenMode(e.target.value as ImageGenModeOpt)}
              className="h-7 px-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs outline-none focus:border-[color:var(--color-accent)]"
            >
              <option value="t2i.veo">VEO · Text → Image</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-[color:var(--color-fg)]">
            <span className="text-[color:var(--color-fg-muted)]">Video:</span>
            <select
              value={videoGenMode}
              onChange={(e) => setVideoGenMode(e.target.value as VideoGenModeOpt)}
              className="h-7 px-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs outline-none focus:border-[color:var(--color-accent)]"
            >
              <option value="t2v.veo">VEO · Text/Image → Video</option>
              <option value="t2v.grok">Grok · Text/Image → Video</option>
            </select>
          </label>

          <label
            className="flex items-center gap-1.5 text-xs text-[color:var(--color-fg)]"
            title="Tỉ lệ khung hình áp dụng cho cả gen.image và gen.video trong batch"
          >
            <span className="text-[color:var(--color-fg-muted)]">Aspect:</span>
            <select
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
              className="h-7 px-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs outline-none focus:border-[color:var(--color-accent)]"
            >
              {ASPECT_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-[color:var(--color-fg)] select-none cursor-pointer">
            <input
              type="checkbox"
              checked={groupInFrame}
              onChange={(e) => setGroupInFrame(e.target.checked)}
              className="accent-[color:var(--color-accent)]"
            />
            Wrap trong 1 Frame
          </label>

          <label
            className="flex items-center gap-1.5 text-xs text-[color:var(--color-fg)] select-none cursor-pointer"
            title="Dùng chung 1 prompt video cho tất cả scene thay vì 1 prompt / scene"
          >
            <input
              type="checkbox"
              checked={oneVideoPrompt}
              onChange={(e) => setOneVideoPrompt(e.target.checked)}
              className="accent-[color:var(--color-accent)]"
            />
            One prompt video
          </label>

          {mismatch && !empty && (
            <div className="flex items-center gap-1.5 text-[11px] text-red-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              Số dòng không khớp: {imgCount} vs {vidCount}
            </div>
          )}
          {tooMany && canConfirm && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />
              Sắp tạo {n * 4} node — chắc chứ?
            </div>
          )}
          {veoSquareFallback && (
            <div
              className="flex items-center gap-1.5 text-[11px] text-amber-400"
              title="Đổi Video sang Grok nếu muốn video 1:1 thật sự."
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              VEO video không hỗ trợ 1:1 — sẽ fallback 16:9. Dùng Grok cho video vuông.
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-[10px] text-[color:var(--color-fg-dim)] hidden sm:inline">
              Ctrl/Cmd+Enter · Esc
            </span>
            <button
              type="button"
              onClick={onClose}
              className="h-8 px-3 rounded-md text-xs text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-elev-2)] hover:text-[color:var(--color-fg)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className={cn(
                "h-8 px-3 rounded-md text-xs font-semibold transition",
                canConfirm
                  ? "bg-[color:var(--color-accent)] text-white hover:brightness-110"
                  : "bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-dim)] cursor-not-allowed",
              )}
            >
              {canConfirm ? `Create ${n} scene${n > 1 ? "s" : ""}` : "Create scenes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PromptColumn({
  label,
  hint,
  value,
  onChange,
  count,
  countMismatch,
  textareaRef,
  countLabel,
  placeholderOverride,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  count: number;
  countMismatch: boolean;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Override the default "{count} dòng" counter — e.g. a check mark in
   *  single-prompt mode where line count is meaningless. */
  countLabel?: string;
  placeholderOverride?: string;
}) {
  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-baseline gap-2 mb-1.5">
        <div className="text-xs font-semibold text-[color:var(--color-fg)]">{label}</div>
        <div
          className={cn(
            "text-[11px] tabular-nums",
            countMismatch ? "text-red-400" : "text-[color:var(--color-fg-dim)]",
          )}
        >
          {countLabel ?? `${count} dòng`}
        </div>
        <div className="ml-auto text-[10px] text-[color:var(--color-fg-dim)] truncate">{hint}</div>
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder={
          placeholderOverride ??
          `Scene 1 prompt…\nScene 2 prompt…\nScene 3 prompt…`
        }
        className={cn(
          "flex-1 min-h-[320px] resize-none",
          "rounded-md border p-3 text-xs leading-relaxed font-mono",
          "bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg)]",
          "placeholder:text-[color:var(--color-fg-dim)]",
          "outline-none focus:border-[color:var(--color-accent)]",
          countMismatch
            ? "border-red-500/50"
            : "border-[color:var(--color-border)]",
        )}
      />
    </div>
  );
}
