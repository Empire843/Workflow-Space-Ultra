import { getClient, isRedirectUriAllowed } from "@/server/oauth/clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Consent screen shown after GET /api/oauth/authorize redirects here.
 *
 * Single-user local app → the UI is intentionally minimal: summarise what
 * the Custom GPT is asking for, show the client name + redirect host so the
 * user can sanity-check they're not being phished via a crafted URL, and
 * expose Allow / Deny buttons. Both buttons POST back to
 * /api/oauth/authorize with the full original param set so the API route
 * stays stateless (no server-session storage needed between GET and POST).
 */

interface ConsentSearchParams {
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
}

function ErrorCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="w-full max-w-md rounded-2xl border border-rose-500/40 bg-rose-500/5 p-6 text-rose-100">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-rose-200/80">{detail}</p>
      <p className="mt-4 text-xs text-rose-200/60">
        Fix this in WSU Settings → OAuth Clients, then retry from ChatGPT.
      </p>
    </div>
  );
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<ConsentSearchParams>;
}) {
  const raw = await searchParams;
  const clientId = raw.client_id ?? "";
  const redirectUri = raw.redirect_uri ?? "";
  const state = raw.state ?? "";
  const scope = raw.scope ?? "";
  const codeChallenge = raw.code_challenge ?? "";
  const codeChallengeMethod = raw.code_challenge_method ?? "";

  if (!clientId || !redirectUri || !state) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
        <ErrorCard
          title="Invalid consent request"
          detail="Required parameters are missing. This page is only meant to be reached from a ChatGPT Action authorization redirect."
        />
      </main>
    );
  }

  const client = getClient(clientId);
  if (!client) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
        <ErrorCard title="Unknown OAuth client" detail={`No client found for id '${clientId}'.`} />
      </main>
    );
  }
  if (!isRedirectUriAllowed(client, redirectUri)) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
        <ErrorCard
          title="redirect_uri not registered"
          detail={`'${redirectUri}' is not in the whitelist for client '${client.name}'. This is usually a configuration bug — register the URI in WSU Settings → OAuth Clients.`}
        />
      </main>
    );
  }

  const requestedScopes = scope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const effectiveScopes = requestedScopes.length
    ? requestedScopes.filter((s) => client.scopes.includes(s))
    : client.scopes.slice();
  const displayScopes = effectiveScopes.length ? effectiveScopes : client.scopes.slice();

  let redirectHost = redirectUri;
  try {
    redirectHost = new URL(redirectUri).host;
  } catch {
    // Keep raw string as fallback.
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/90 p-6 shadow-2xl">
        <div className="mb-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">OAuth consent</div>
          <h1 className="mt-1 text-xl font-semibold text-zinc-100">
            Grant access to WSU?
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            <span className="font-medium text-zinc-200">{client.name}</span> is requesting
            permission to call Workflow Space Ultra on your behalf.
          </p>
        </div>

        <dl className="mb-5 divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-950/60 text-sm">
          <div className="flex justify-between gap-3 px-4 py-2.5">
            <dt className="text-zinc-500">Client</dt>
            <dd className="truncate font-mono text-xs text-zinc-200">{client.name}</dd>
          </div>
          <div className="flex justify-between gap-3 px-4 py-2.5">
            <dt className="text-zinc-500">Redirect to</dt>
            <dd className="truncate font-mono text-xs text-zinc-200" title={redirectUri}>
              {redirectHost}
            </dd>
          </div>
          <div className="flex justify-between gap-3 px-4 py-2.5">
            <dt className="text-zinc-500">Scopes</dt>
            <dd className="text-right text-xs text-zinc-200">
              {displayScopes.map((s) => (
                <span
                  key={s}
                  className="ml-1 inline-block rounded bg-fuchsia-500/20 px-1.5 py-0.5 font-mono text-[11px] text-fuchsia-200"
                >
                  {s}
                </span>
              ))}
            </dd>
          </div>
        </dl>

        <ul className="mb-5 space-y-1 text-xs text-zinc-400">
          <li>• Trigger VEO / Grok image &amp; video generation using your logged-in Chrome sessions.</li>
          <li>• Read and create workflow graphs under <code className="text-zinc-300">Workflows/</code>.</li>
          <li>• Inspect the in-memory job queue.</li>
        </ul>

        <form method="post" action="/api/oauth/authorize" className="flex flex-col gap-2">
          <input type="hidden" name="response_type" value="code" />
          <input type="hidden" name="client_id" value={clientId} />
          <input type="hidden" name="redirect_uri" value={redirectUri} />
          <input type="hidden" name="state" value={state} />
          <input type="hidden" name="scope" value={scope} />
          {codeChallenge ? <input type="hidden" name="code_challenge" value={codeChallenge} /> : null}
          {codeChallengeMethod ? (
            <input type="hidden" name="code_challenge_method" value={codeChallengeMethod} />
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              type="submit"
              name="decision"
              value="deny"
              className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-700"
            >
              Deny
            </button>
            <button
              type="submit"
              name="decision"
              value="allow"
              className="rounded-md bg-gradient-to-r from-fuchsia-500 to-pink-500 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-pink-500/20 hover:from-fuchsia-600 hover:to-pink-600"
            >
              Allow
            </button>
          </div>
        </form>

        <p className="mt-4 text-xs text-zinc-600">
          This grant is single-user and local. Access tokens are hashed and
          stored in <code>data_general/oauth/tokens.json</code>. You can revoke
          any time under Settings → OAuth Clients.
        </p>
      </div>
    </main>
  );
}
