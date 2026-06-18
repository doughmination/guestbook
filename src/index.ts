export interface Env {
  /** KV namespace holding the guestbook entries + rate-limit keys. */
  GUESTBOOK: KVNamespace;
  /** Origin allowed to call the API (CORS). Defaults to "*". */
  ALLOWED_ORIGIN?: string;
  /** Turnstile secret key. When unset, the captcha check is skipped. */
  TURNSTILE_SECRET?: string;
}

interface GuestbookEntry {
  id: string;
  name: string;
  message: string;
  website: string;
  ts: number;
}

interface PostBody {
  name?: unknown;
  message?: unknown;
  website?: unknown;
  url2?: unknown; // honeypot
  turnstileToken?: unknown;
  "cf-turnstile-response"?: unknown;
}

const ENTRIES_KEY = "entries";
const MAX_ENTRIES = 1000; // keep the JSON blob bounded
const RATE_LIMIT_SECONDS = 60; // min seconds between posts from one IP (also KV's minimum expirationTtl)

const LIMITS = {
  name: 40,
  message: 500,
  website: 200,
} as const;

function corsHeaders(env: Env): Record<string, string> {
  const origin = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env),
    },
  });
}

// Collapse whitespace, trim, and strip control chars. We do NOT store HTML;
// the page renders everything as text, so this is just tidy-up.
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Accept only http(s) links; otherwise drop it.
function cleanWebsite(value: unknown): string {
  const v = clean(value, LIMITS.website);
  if (!v) return "";
  let url = v;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString().slice(0, LIMITS.website);
  } catch {
    return "";
  }
}

async function verifyTurnstile(
  token: unknown,
  ip: string,
  env: Env
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // Turnstile not configured -> skip
  if (typeof token !== "string" || !token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

async function readEntries(env: Env): Promise<GuestbookEntry[]> {
  const raw = await env.GUESTBOOK.get(ENTRIES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GuestbookEntry[]) : [];
  } catch {
    return [];
  }
}

async function handleGet(url: URL, env: Env): Promise<Response> {
  const entries = await readEntries(env);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "") || 50, 1),
    200
  );
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "") || 0, 0);
  return json(
    {
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      limit,
      offset,
    },
    200,
    env
  );
}

async function handlePost(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") || "";

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return json({ error: "Invalid JSON body." }, 400, env);
  }

  // Honeypot: real users never fill this hidden field.
  if (clean(body.url2 ?? "", 100)) {
    return json({ ok: true, skipped: true }, 200, env); // pretend success
  }

  // Turnstile (only enforced if a secret is configured)
  const turnstileOk = await verifyTurnstile(
    body.turnstileToken ?? body["cf-turnstile-response"],
    ip,
    env
  );
  if (!turnstileOk) {
    return json({ error: "Captcha verification failed. Please try again." }, 403, env);
  }

  const name = clean(body.name, LIMITS.name);
  const message = clean(body.message, LIMITS.message);
  const website = cleanWebsite(body.website);

  if (!name) return json({ error: "Please enter a name." }, 400, env);
  if (!message) return json({ error: "Please enter a message." }, 400, env);

  // Rate limit per IP
  if (ip) {
    const rlKey = "rl:" + ip;
    const recent = await env.GUESTBOOK.get(rlKey);
    if (recent) {
      return json(
        { error: `Slow down a moment — you can post again in ~${RATE_LIMIT_SECONDS}s.` },
        429,
        env
      );
    }
    await env.GUESTBOOK.put(rlKey, "1", { expirationTtl: RATE_LIMIT_SECONDS });
  }

  const entry: GuestbookEntry = {
    id: crypto.randomUUID(),
    name,
    message,
    website,
    ts: Date.now(),
  };

  const entries = await readEntries(env);
  entries.unshift(entry); // newest first
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  await env.GUESTBOOK.put(ENTRIES_KEY, JSON.stringify(entries));

  return json({ ok: true, entry }, 201, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(env) });
      }
      if (request.method === "GET") {
        return await handleGet(url, env);
      }
      if (request.method === "POST") {
        return await handlePost(request, env);
      }
      return json({ error: "Method not allowed." }, 405, env);
    } catch (err) {
      // Always attach CORS headers, even on unexpected errors, so the browser
      // surfaces a real message instead of a masked CORS/network error.
      console.error("[guestbook] unhandled error", err);
      return json({ error: "Internal error." }, 500, env);
    }
  },
} satisfies ExportedHandler<Env>;
