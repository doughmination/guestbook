# guestbook-worker

Cloudflare Worker backing the guestbook on [c.stupid.cat](https://c.stupid.cat).

No database — entries live in **Workers KV** as a single JSON array under the
key `entries`. Think of it as a JSON file on Cloudflare's edge.

## API

| Method | Path | Description |
| ------ | ---- | ----------- |
| `GET`  | `/?limit=50&offset=0` | List entries, newest first. Returns `{ entries, total, limit, offset }`. |
| `POST` | `/` | Add an entry. JSON body: `{ name, message, website?, turnstileToken?, url2? }`. |

`url2` is a hidden honeypot — leave it empty. Anti-spam: honeypot + per-IP
rate limit (30s) + optional [Turnstile](https://developers.cloudflare.com/turnstile/).

## Setup

```bash
pnpm install

# 1. Create the KV namespaces (prod + preview for `wrangler dev`)
pnpx wrangler kv namespace create GUESTBOOK
pnpx wrangler kv namespace create GUESTBOOK --preview
# -> paste both ids into wrangler.toml (id + preview_id)

# 2. (optional) enable the captcha
#    Create a Turnstile widget in the Cloudflare dashboard, then:
pnpx wrangler secret put TURNSTILE_SECRET
#    Put the matching SITE key into the site's js/guestbook.js (TURNSTILE_SITE_KEY).
#    Skip this step to run with just honeypot + rate limiting.

# 3. Run locally / deploy
pnpm dev
pnpm deploy
```
