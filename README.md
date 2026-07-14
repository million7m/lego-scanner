# Brick Ledger

Offline-first Lego inventory scanner with a barcode lookup proxy.

## What it includes

- Static PWA frontend in `files/`
- `server.js` proxy for `/api/identify` requests
- `render.yaml` for deployment on Render free tier

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:8123`.

## Deploy to Render

The repo ships a `render.yaml` blueprint, so deployment is one click:

1. Push this repo to GitHub (already wired to `origin`).
2. On [render.com](https://render.com) → **New +** → **Blueprint** → connect GitHub and
   pick this repo. Render reads `render.yaml` and creates a free Node web service
   (`buildCommand: npm install`, `startCommand: npm start`, health check on `/`).
3. When prompted for the env vars (they're `sync: false`, so they're never stored in
   the repo), paste your keys — see below — and **Apply**.
4. After ~2–3 min you get an HTTPS URL like `https://brick-ledger.onrender.com`.

Open that HTTPS URL on your phone to test scanning — mobile browsers only allow the
camera on a secure (HTTPS) origin, which Render provides automatically.

### Environment variables

| Variable | Needed? | Effect |
|----------|---------|--------|
| `REBRICKABLE_KEY` | Recommended | Validates the parsed set number and adds the real theme, official name, image, and piece count. |
| `BRICKOWL_KEY` | Optional | Barcode→set lookup. Currently returns 403 and is disabled in `server.js`. |
| `BARCODELOOKUP_KEY` | Optional | Non-LEGO fallback. Currently returns 403 and is disabled in `server.js`. |

With no keys set the app still works: it identifies via UPCitemdb + a web-title
fallback, parses the set number out of the title, and keyword-matches common themes.
A `REBRICKABLE_KEY` makes theme/image/piece-count reliable.

### Free-tier notes

- The service **sleeps after ~15 min idle**; the first request then takes ~30–60 s to wake.
- The UPCitemdb 24 h rate-limit backoff is kept **in memory**, so a redeploy/restart resets it.

## How lookup works

`GET /api/identify?code=<barcode>` runs server-side (so the browser never makes a
cross-origin call and CORS can't fail):

1. UPCitemdb trial lookup → product title, description, price.
2. If that's rate-limited, scrape the UPCitemdb / Barcode Lookup result page title.
3. **Enrich**: parse the LEGO set number from the title (ignoring piece counts), then —
   if `REBRICKABLE_KEY` is set — verify it against Rebrickable and pull the theme,
   official name, image, and piece count. Otherwise fall back to a keyword theme guess.

Keys can also be supplied per-request from the app's **Settings** (sent as
`x-bo-key` / `x-rb-key` / `x-bl-key` headers); env vars take priority.
