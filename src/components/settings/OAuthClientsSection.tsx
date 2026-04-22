"use client";

import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

interface ClientSummary {
  id: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
  createdAt: number;
}

interface OAuthConfig {
  publicBaseUrl: string;
  isLocal: boolean;
  urls: {
    authorizationUrl: string;
    tokenUrl: string;
    revokeUrl: string;
    openapiUrl: string;
  };
}

/**
 * Settings section for the ChatGPT GPT Action. Lists registered OAuth clients,
 * lets the user create new ones, rotate secrets, manage redirect URIs, and
 * copy-paste the 4 URLs ChatGPT needs for the Custom GPT Action editor.
 *
 * The plaintext client secret is returned by the server exactly once after
 * creation or rotation. We surface it with a one-shot reveal block — closing
 * the block discards the value from memory so nothing leaks to screenshots or
 * Redux devtools.
 */
export default function OAuthClientsSection() {
  const [config, setConfig] = useState<OAuthConfig | null>(null);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [freshSecret, setFreshSecret] = useState<{ clientId: string; secret: string } | null>(null);
  const [newName, setNewName] = useState("ChatGPT");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [cfgRes, listRes] = await Promise.all([
        fetch("/api/oauth/config", { cache: "no-store" }),
        fetch("/api/oauth/clients", { cache: "no-store" }),
      ]);
      const cfg = (await cfgRes.json()) as OAuthConfig;
      const list = (await listRes.json()) as { clients: ClientSummary[] };
      setConfig(cfg);
      setClients(list.clients ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = (await res.json()) as {
        client?: ClientSummary;
        secret?: string;
        error?: string;
      };
      if (!res.ok || !data.client || !data.secret) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setFreshSecret({ clientId: data.client.id, secret: data.secret });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [newName, refresh]);

  const rotate = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/oauth/clients/${id}/rotate`, { method: "POST" });
        const data = (await res.json()) as { secret?: string; error?: string };
        if (!res.ok || !data.secret) throw new Error(data.error ?? `HTTP ${res.status}`);
        setFreshSecret({ clientId: id, secret: data.secret });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!confirm("Delete this OAuth client? All its tokens will be revoked.")) return;
      try {
        const res = await fetch(`/api/oauth/clients/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const updateRedirects = useCallback(
    async (id: string, redirectUris: string[]) => {
      try {
        const res = await fetch(`/api/oauth/clients/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirectUris }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  return (
    <div className="space-y-3">
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-[color:var(--color-fg-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading OAuth config…
        </div>
      ) : null}

      {config ? <UrlsPanel config={config} /> : null}

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}

      {freshSecret ? (
        <SecretReveal
          clientId={freshSecret.clientId}
          secret={freshSecret.secret}
          onClose={() => setFreshSecret(null)}
        />
      ) : null}

      <div className="space-y-2">
        {clients.map((c) => (
          <ClientCard
            key={c.id}
            client={c}
            onRotate={() => rotate(c.id)}
            onDelete={() => remove(c.id)}
            onUpdateRedirects={(uris) => updateRedirects(c.id, uris)}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev-2)] p-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New client name (e.g. 'ChatGPT Prod')"
          className="flex-1 bg-transparent text-sm outline-none"
        />
        <button
          type="button"
          onClick={create}
          disabled={creating || !newName.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-gradient-to-r from-pink-500 to-rose-500 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Create client
        </button>
      </div>
    </div>
  );
}

function UrlsPanel({ config }: { config: OAuthConfig }) {
  const rows = useMemo(
    () => [
      { label: "Authorization URL", value: config.urls.authorizationUrl },
      { label: "Token URL", value: config.urls.tokenUrl },
      { label: "OpenAPI schema URL", value: config.urls.openapiUrl },
    ],
    [config],
  );
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev-2)] p-2.5 space-y-2">
      {config.isLocal ? (
        <div className="flex items-start gap-2 rounded bg-amber-500/10 p-2 text-[11px] text-amber-200 ring-1 ring-amber-500/30">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <code>WSU_PUBLIC_BASE_URL</code> is still <code>{config.publicBaseUrl}</code>. ChatGPT
            cannot reach localhost — start a tunnel (ngrok / cloudflared) and set the env var before
            configuring the Custom GPT.
          </span>
        </div>
      ) : null}
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-xs">
          <span className="w-44 shrink-0 text-[color:var(--color-fg-muted)]">{r.label}</span>
          <code className="flex-1 truncate font-mono text-[11px] text-[color:var(--color-fg)]" title={r.value}>
            {r.value}
          </code>
          <CopyButton value={r.value} />
        </div>
      ))}
    </div>
  );
}

function ClientCard({
  client,
  onRotate,
  onDelete,
  onUpdateRedirects,
}: {
  client: ClientSummary;
  onRotate: () => void;
  onDelete: () => void;
  onUpdateRedirects: (uris: string[]) => void;
}) {
  const [newUri, setNewUri] = useState("");
  const addUri = () => {
    const trimmed = newUri.trim();
    if (!trimmed) return;
    if (client.redirectUris.includes(trimmed)) {
      setNewUri("");
      return;
    }
    onUpdateRedirects([...client.redirectUris, trimmed]);
    setNewUri("");
  };
  const removeUri = (uri: string) => {
    onUpdateRedirects(client.redirectUris.filter((u) => u !== uri));
  };

  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev-2)] p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-[color:var(--color-fg)]">{client.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
            <span>Client ID</span>
            <code className="font-mono">{client.id}</code>
            <CopyButton value={client.id} small />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onRotate}
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] px-2 py-1 text-[11px] hover:border-[color:var(--color-accent)]"
            title="Rotate secret — old tokens are revoked"
          >
            <KeyRound className="h-3 w-3" /> Rotate secret
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        </div>
      </div>

      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wider text-[color:var(--color-fg-muted)]">
          Redirect URIs
        </div>
        {client.redirectUris.length === 0 ? (
          <div className="rounded border border-dashed border-[color:var(--color-border)] p-2 text-[11px] text-[color:var(--color-fg-muted)]">
            No redirect URIs yet. Paste the one from ChatGPT (looks like
            <code className="mx-1">https://chatgpt.com/aip/g-XXXXX/oauth/callback</code>).
          </div>
        ) : (
          <ul className="space-y-1">
            {client.redirectUris.map((uri) => (
              <li
                key={uri}
                className="flex items-center gap-2 rounded bg-[color:var(--color-bg)] px-2 py-1 text-[11px]"
              >
                <code className="flex-1 truncate font-mono" title={uri}>
                  {uri}
                </code>
                <button
                  type="button"
                  onClick={() => removeUri(uri)}
                  className="text-red-300 hover:text-red-400"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-1 flex items-center gap-1.5">
          <input
            type="text"
            value={newUri}
            onChange={(e) => setNewUri(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addUri();
              }
            }}
            placeholder="https://chatgpt.com/aip/g-xxx/oauth/callback"
            className="flex-1 rounded bg-[color:var(--color-bg)] px-2 py-1 text-[11px] outline-none"
          />
          <button
            type="button"
            onClick={addUri}
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] px-2 py-1 text-[11px] hover:border-[color:var(--color-accent)]"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>
      </div>
    </div>
  );
}

function SecretReveal({
  clientId,
  secret,
  onClose,
}: {
  clientId: string;
  secret: string;
  onClose: () => void;
}) {
  return (
    <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-100 space-y-2">
      <div className="flex items-center gap-2 font-semibold">
        <KeyRound className="h-3.5 w-3.5" /> New client secret (shown once)
      </div>
      <p className="text-[11px] text-emerald-200/80">
        Paste this into the ChatGPT Custom GPT Action editor now — WSU only keeps a sha-256 hash, so
        there is no way to recover it later. If you lose it, rotate again.
      </p>
      <div className="flex items-center gap-1.5">
        <code className="flex-1 break-all font-mono text-[11px]">{secret}</code>
        <CopyButton value={secret} />
      </div>
      <div className="flex items-center justify-between pt-1">
        <span className="text-[10px] text-emerald-200/60">client: {clientId}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-emerald-500/40 px-2 py-1 text-[11px] hover:bg-emerald-500/20"
        >
          I have copied it — hide
        </button>
      </div>
    </div>
  );
}

function CopyButton({ value, small }: { value: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] px-1.5 hover:border-[color:var(--color-accent)]",
        small ? "py-0.5 text-[10px]" : "py-1 text-[11px]",
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
