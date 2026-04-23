"use client";

import { ExternalLink, KeyRound, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { GEMINI_TTS_LANGUAGES, GEMINI_TTS_VOICES } from "@/lib/tts";
import { cn } from "@/lib/utils";
import OAuthClientsSection from "./OAuthClientsSection";

type TestState = "idle" | "loading" | "ok" | "error";

interface AppSettings {
  accountType: "NORMAL" | "PRO" | "ULTRA";
  veoProjectId: string;
  veoSessionId: string;
  createImageModel: string;
  seedMode: "Random" | "Fixed";
  seedValue: number;
  veoConcurrency: number;
  grokConcurrency: number;
  /** Absolute path. Empty = dùng fallback browser download của OS. */
  exportDir: string;
  // Clone Video
  geminiApiKey: string;
  videoAnalyzerProvider: "gemini-api" | "gemini-playwright" | "chatgpt-playwright";
  geminiModel: "gemini-2.5-flash" | "gemini-2.5-pro";
  // Clone TTS (voice-over sub-feature of Clone Video)
  geminiTtsModel:
    | "gemini-3.1-flash-tts-preview"
    | "gemini-2.5-flash-preview-tts"
    | "gemini-2.5-pro-preview-tts";
  geminiTtsVoice: string;
  geminiTtsLanguage: string;
}

export default function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [veoTest, setVeoTest] = useState<{ state: TestState; msg?: string }>({ state: "idle" });
  const [grokTest, setGrokTest] = useState<{ state: TestState; msg?: string }>({ state: "idle" });
  const [veoOpen, setVeoOpen] = useState<{ state: TestState; msg?: string }>({ state: "idle" });
  const [grokOpen, setGrokOpen] = useState<{ state: TestState; msg?: string }>({ state: "idle" });
  const [aistudioOpen, setAistudioOpen] = useState<{ state: TestState; msg?: string }>({ state: "idle" });

  useEffect(() => {
    if (!open) return;
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: { settings: AppSettings }) => setSettings(d.settings))
      .catch(() => setSettings(null));
  }, [open]);

  if (!open) return null;

  const save = async () => {
    if (!settings) return;
    await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    onOpenChange(false);
  };

  const testVeo = async () => {
    setVeoTest({ state: "loading" });
    try {
      const res = await fetch("/api/test/veo", { method: "POST" });
      const data = (await res.json()) as { ok: boolean; message?: string };
      setVeoTest({ state: data.ok ? "ok" : "error", msg: data.message });
    } catch (e) {
      setVeoTest({ state: "error", msg: String(e) });
    }
  };

  const testGrok = async () => {
    setGrokTest({ state: "loading" });
    try {
      const res = await fetch("/api/test/grok", { method: "POST" });
      const data = (await res.json()) as { ok: boolean; message?: string };
      setGrokTest({ state: data.ok ? "ok" : "error", msg: data.message });
    } catch (e) {
      setGrokTest({ state: "error", msg: String(e) });
    }
  };

  const openChrome = async (target: "veo" | "grok" | "aistudio") => {
    const setter = target === "veo" ? setVeoOpen : target === "grok" ? setGrokOpen : setAistudioOpen;
    setter({ state: "loading" });
    try {
      const res = await fetch("/api/chrome/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string };
      setter({ state: data.ok ? "ok" : "error", msg: data.message });
    } catch (e) {
      setter({ state: "error", msg: String(e) });
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => onOpenChange(false)}>
      <div
        className="w-full max-w-2xl rounded-2xl bg-[color:var(--color-bg-elev-1)] border border-[color:var(--color-border-strong)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[color:var(--color-border)]">
          <h2 className="text-base font-semibold">Settings</h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 w-8 grid place-items-center rounded-md hover:bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-muted)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <Section title="VEO 3 Ultra">
            <Row label="Account tier">
              <select
                value={settings?.accountType || "ULTRA"}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, accountType: e.target.value as AppSettings["accountType"] } : s))
                }
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              >
                <option value="ULTRA">ULTRA</option>
                <option value="PRO">PRO</option>
                <option value="NORMAL">NORMAL</option>
              </select>
            </Row>
            <Row label="Project ID (optional, auto-detect)">
              <input
                type="text"
                value={settings?.veoProjectId || ""}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, veoProjectId: e.target.value } : s))
                }
                placeholder="Auto-detect on first login"
                className="flex-1 bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              />
            </Row>
            <Row label="Session ID (optional)">
              <input
                type="text"
                value={settings?.veoSessionId || ""}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, veoSessionId: e.target.value } : s))
                }
                placeholder="Auto-detect"
                className="flex-1 bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              />
            </Row>
            <Row label="Create Image Model">
              <select
                value={settings?.createImageModel || "Nano Banana 2"}
                onChange={(e) => setSettings((s) => (s ? { ...s, createImageModel: e.target.value } : s))}
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              >
                {["Nano Banana 2", "Nano Banana pro", "Nano Banana", "Imagen 4"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Row>

            <div className="rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] p-2.5 space-y-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
              <p className="font-medium text-[color:var(--color-fg)]">Cách đăng nhập VEO:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Bấm <b>Open VEO Chrome</b> → cửa sổ Chrome riêng sẽ mở tới <code>labs.google/fx/vi/tools/flow</code></li>
                <li>Đăng nhập Google account (VEO 3 Ultra) trong cửa sổ đó</li>
                <li>Tạo/mở 1 project bất kỳ trong Flow để trigger <code>createProject</code> + <code>_next/data</code></li>
                <li>Quay lại đây, bấm <b>Test VEO session</b> để bắt token</li>
              </ol>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => openChrome("veo")}
                className="h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] hover:border-[color:var(--color-accent)] text-xs flex items-center gap-1.5"
              >
                {veoOpen.state === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
                <ExternalLink className="h-3 w-3" />
                Open VEO Chrome
              </button>
              <button
                type="button"
                onClick={testVeo}
                className="h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] hover:border-[color:var(--color-accent)] text-xs flex items-center gap-1.5"
              >
                {veoTest.state === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
                Test VEO session
              </button>
            </div>
            {veoOpen.state === "ok" && <span className="text-xs text-[color:var(--color-ok)]">✓ {veoOpen.msg}</span>}
            {veoOpen.state === "error" && <span className="text-xs text-red-400 break-words">✗ {veoOpen.msg}</span>}
            {veoTest.state === "ok" && <span className="text-xs text-[color:var(--color-ok)]">✓ {veoTest.msg}</span>}
            {veoTest.state === "error" && <span className="text-xs text-red-400 break-words">✗ {veoTest.msg}</span>}
          </Section>

          <Section title="Grok Imagine">
            <div className="rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] p-2.5 space-y-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
              <p className="font-medium text-[color:var(--color-fg)]">Cách đăng nhập Grok:</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>Bấm <b>Open Grok Chrome</b> → cửa sổ Chrome riêng mở <code>grok.com</code></li>
                <li>Đăng nhập X/Twitter account có gói Super Grok Heavy</li>
                <li>Mở <code>grok.com/imagine</code> 1 lần để trigger <code>x-statsig-id</code></li>
                <li>Quay lại đây, bấm <b>Test Grok session</b></li>
              </ol>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => openChrome("grok")}
                className="h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] hover:border-[color:var(--color-accent)] text-xs flex items-center gap-1.5"
              >
                {grokOpen.state === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
                <ExternalLink className="h-3 w-3" />
                Open Grok Chrome
              </button>
              <button
                type="button"
                onClick={testGrok}
                className="h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] hover:border-[color:var(--color-accent)] text-xs flex items-center gap-1.5"
              >
                {grokTest.state === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
                Test Grok session
              </button>
            </div>
            {grokOpen.state === "ok" && <span className="text-xs text-[color:var(--color-ok)]">✓ {grokOpen.msg}</span>}
            {grokOpen.state === "error" && <span className="text-xs text-red-400 break-words">✗ {grokOpen.msg}</span>}
            {grokTest.state === "ok" && <span className="text-xs text-[color:var(--color-ok)]">✓ {grokTest.msg}</span>}
            {grokTest.state === "error" && <span className="text-xs text-red-400 break-words">✗ {grokTest.msg}</span>}
          </Section>

          <Section title="Queue (concurrency)">
            <div className="rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] p-2.5 space-y-1 text-[11px] text-[color:var(--color-fg-muted)]">
              <p>Giới hạn số job chạy song song cho từng provider. Các job vượt giới hạn sẽ ở trạng thái <b>queued</b> trên canvas và tự chạy khi có slot.</p>
              <p>Khuyến nghị: VEO = 1 (để tránh Google flag UNUSUAL_ACTIVITY khi nhiều reCAPTCHA cùng lúc), Grok = 1-2.</p>
            </div>
            <Row label="VEO concurrency">
              <input
                type="number"
                min={1}
                max={5}
                value={settings?.veoConcurrency ?? 1}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, veoConcurrency: Math.max(1, Math.min(5, Number(e.target.value) || 1)) } : s))
                }
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none w-24"
              />
            </Row>
            <Row label="Grok concurrency">
              <input
                type="number"
                min={1}
                max={5}
                value={settings?.grokConcurrency ?? 1}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, grokConcurrency: Math.max(1, Math.min(5, Number(e.target.value) || 1)) } : s))
                }
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none w-24"
              />
            </Row>
          </Section>

          <Section title="Download / Export">
            <div className="rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] p-2.5 space-y-1 text-[11px] text-[color:var(--color-fg-muted)]">
              <p>
                File gốc luôn giữ trong <code>Workflows/&lt;id&gt;/assets/outputs/</code> để preview
                và re-run chạy được. Nút Download sẽ{" "}
                <b>hardlink</b> sang thư mục bên dưới (cùng ổ đĩa = 0 byte thêm, khác ổ sẽ fallback copy).
              </p>
              <p>
                Để trống → rơi về hành vi cũ (trình duyệt tự lưu vào Downloads của OS).
              </p>
            </div>
            <Row label="Export folder (absolute path)">
              <input
                type="text"
                value={settings?.exportDir || ""}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, exportDir: e.target.value } : s))
                }
                placeholder={
                  // Hint a Windows path since this project ships with chrome_user_data on Windows.
                  "VD: D:\\Videos\\workflow-space-exports"
                }
                spellCheck={false}
                className="flex-1 bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none font-mono"
              />
            </Row>
          </Section>

          <Section title="ChatGPT GPT Action (OAuth)">
            <div className="rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] p-2.5 space-y-1 text-[11px] text-[color:var(--color-fg-muted)]">
              <p>
                Expose WSU as a ChatGPT Custom GPT Action. WSU must be reachable from the internet
                (set <code>WSU_PUBLIC_BASE_URL</code> to a tunnel — ngrok / cloudflared /
                Tailscale Funnel). Paste the 4 URLs below into the Custom GPT editor + your client
                id + the one-shot secret.
              </p>
            </div>
            <OAuthClientsSection />
          </Section>

          <Section title="Seed">
            <Row label="Mode">
              <select
                value={settings?.seedMode || "Random"}
                onChange={(e) => setSettings((s) => (s ? { ...s, seedMode: e.target.value as AppSettings["seedMode"] } : s))}
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              >
                <option value="Random">Random</option>
                <option value="Fixed">Fixed</option>
              </select>
            </Row>
            {settings?.seedMode === "Fixed" && (
              <Row label="Seed value">
                <input
                  type="number"
                  value={settings.seedValue}
                  onChange={(e) => setSettings((s) => (s ? { ...s, seedValue: Number(e.target.value) } : s))}
                  className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none w-32"
                />
              </Row>
            )}
          </Section>

          <Section title="Clone Video">
            <div className="rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] p-2.5 space-y-1 text-[11px] text-[color:var(--color-fg-muted)]">
              <p>Upload video → AI phân tích cắt scenes → tự tạo workflow. Lấy Gemini API key <b>miễn phí</b> tại{" "}
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-[color:var(--color-accent)] underline">aistudio.google.com/apikey</a>
              </p>
            </div>
            <Row label="Gemini API Key">
              <div className="flex-1 flex items-center gap-2">
                <KeyRound className="h-3.5 w-3.5 text-[color:var(--color-fg-muted)] shrink-0" />
                <input
                  type="password"
                  value={settings?.geminiApiKey || ""}
                  onChange={(e) =>
                    setSettings((s) => (s ? { ...s, geminiApiKey: e.target.value } : s))
                  }
                  placeholder="AIza..."
                  spellCheck={false}
                  className="flex-1 bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none font-mono"
                />
              </div>
            </Row>
            <Row label="Provider">
              <select
                value={settings?.videoAnalyzerProvider || "gemini-api"}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, videoAnalyzerProvider: e.target.value as AppSettings["videoAnalyzerProvider"] } : s))
                }
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              >
                <option value="gemini-api">Gemini API Key (recommended)</option>
                <option value="gemini-playwright">Gemini Playwright (gemini.google.com UI)</option>
                <option value="chatgpt-playwright">ChatGPT Playwright (coming soon)</option>
              </select>
            </Row>
            {settings?.videoAnalyzerProvider === "gemini-playwright" && (
              <>
                <div className="rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] p-2.5 space-y-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
                  <p className="font-medium text-[color:var(--color-fg)]">Cách dùng Gemini Playwright:</p>
                  <ol className="list-decimal list-inside space-y-0.5">
                    <li>Cần tài khoản <b>Gemini Advanced</b> (Google One AI Premium) — tier miễn phí không upload được video.</li>
                    <li>Bấm <b>Open Gemini Chrome</b> bên dưới → đăng nhập Google account có Gemini Advanced.</li>
                    <li>Clone video: Playwright sẽ tự mở tab <code>gemini.google.com/app</code> → upload → gửi prompt → scrape response.</li>
                  </ol>
                  <p>Không cần API key — authenticate hoàn toàn qua cookie của Chrome profile. Mỗi lần phân tích tốn 1 turn Gemini Advanced (giống hệt user làm thủ công).</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => openChrome("aistudio")}
                    className="h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] hover:border-[color:var(--color-accent)] text-xs flex items-center gap-1.5"
                  >
                    {aistudioOpen.state === "loading" && <Loader2 className="h-3 w-3 animate-spin" />}
                    <ExternalLink className="h-3 w-3" />
                    Open Gemini Chrome
                  </button>
                </div>
                {aistudioOpen.state === "ok" && <span className="text-xs text-[color:var(--color-ok)]">✓ {aistudioOpen.msg}</span>}
                {aistudioOpen.state === "error" && <span className="text-xs text-red-400 break-words">✗ {aistudioOpen.msg}</span>}
              </>
            )}
            <Row label="Gemini Model">
              <select
                value={settings?.geminiModel || "gemini-2.5-flash"}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, geminiModel: e.target.value as AppSettings["geminiModel"] } : s))
                }
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              >
                <option value="gemini-2.5-flash">Gemini 2.5 Flash (nhanh, free quota cao)</option>
                <option value="gemini-2.5-pro">Gemini 2.5 Pro (chính xác hơn)</option>
              </select>
            </Row>
          </Section>

          <Section title="Clone TTS (voice-over)">
            <div className="rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] p-2.5 space-y-1 text-[11px] text-[color:var(--color-fg-muted)]">
              <p>
                Khi bật trong Clone Video, Gemini sẽ transcribe voice-over theo
                từng scene từ audio gốc, và bạn có thể sinh TTS bằng giọng
                Google bên dưới. Audio là file WAV rời để download — KHÔNG được
                ghép vào video tạo ra.
              </p>
              <p>
                Dùng chung <b>Gemini API Key</b> ở section Clone Video trên.
              </p>
            </div>
            <Row label="TTS Model">
              <select
                value={settings?.geminiTtsModel || "gemini-3.1-flash-tts-preview"}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, geminiTtsModel: e.target.value as AppSettings["geminiTtsModel"] } : s))
                }
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              >
                <option value="gemini-3.1-flash-tts-preview">Gemini 3.1 Flash TTS Preview (mới nhất)</option>
                <option value="gemini-2.5-flash-preview-tts">Gemini 2.5 Flash Preview TTS</option>
                <option value="gemini-2.5-pro-preview-tts">Gemini 2.5 Pro Preview TTS (chất lượng cao nhất)</option>
              </select>
            </Row>
            <Row label="Default voice">
              <select
                value={settings?.geminiTtsVoice || "Kore"}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, geminiTtsVoice: e.target.value } : s))
                }
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              >
                {GEMINI_TTS_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Default language">
              <select
                value={settings?.geminiTtsLanguage || "auto"}
                onChange={(e) =>
                  setSettings((s) => (s ? { ...s, geminiTtsLanguage: e.target.value } : s))
                }
                className="bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] rounded-md px-2 py-1 text-sm outline-none"
              >
                {GEMINI_TTS_LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </Row>
          </Section>
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[color:var(--color-border)]">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs hover:border-[color:var(--color-border-strong)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!settings}
            className={cn(
              "h-8 px-3 rounded-md text-xs font-semibold text-white",
              "bg-gradient-to-r from-pink-500 to-rose-500 hover:opacity-95 disabled:opacity-40"
            )}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--color-fg-muted)]">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-[color:var(--color-fg-muted)] w-52 shrink-0">{label}</span>
      <div className="flex-1 flex items-center gap-2">{children}</div>
    </div>
  );
}
