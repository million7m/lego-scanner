# Brick Ledger

Offline-first Lego inventory scanner with a barcode lookup proxy.

## What it includes

- Static PWA frontend in `files/`
- `server.js` proxy for `/api/identify` requests
- `data/` the local barcode→set database the lookup runs on
- `tools/` scripts that build and grow that database
- `render.yaml` for deployment on Render free tier

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:8123`.

## The barcode database

Barcode lookup is backed by a **local table**, not a live API. No keys, no rate
limits, no scraping at scan time, and it answers instantly even on a cold dyno.

| File | Contents | Built by |
|------|----------|----------|
| `data/sets.json` | 27,810 sets → name, year, theme, subtheme, piece count, image | `npm run build:sets` |
| `data/barcodes.json` | EAN/UPC → set number | `npm run harvest` |
| `data/contributed.json` | barcodes you resolved by hand in the app | the app, at runtime |

### Why it's built this way

No keyless API maps a LEGO box barcode to a set number:

- **BrickOwl** has the right endpoint (`catalog/id_lookup` with `id_type=our_ean`
  or `our_upc`) but will not issue a key. *The old code in `server.js` also called
  `catalog/search`, which is free-text search and never matches a barcode.*
- **Rebrickable** publishes keyless bulk CSVs, but stores **no barcodes**.
- **Brickset** publishes the EAN and UPC on every set page, but its search does
  **not** index barcodes — so there's no way to query by one.

So the two keyless sources are combined: Rebrickable's CSV gives the complete set
list and all metadata, and Brickset is read once per set for the one field only it
has. That yields an exact table, which is the point — the previous approach scraped
a product title and guessed which number in it was the set number, and a title like
`LEGO Star Wars 75192 Millennium Falcon 7541 pieces 2017` has three plausible
candidates.

### Rebuilding it

```bash
npm run build:sets   # ~10s, two keyless downloads
npm run harvest      # long-running, resumable — see below
```

`harvest-barcodes.js` only ever fetches `/sets/{setNum}`, which Brickset's
`robots.txt` allows. Measured limits: **1.5s between requests gets a 429, 2s
occasionally does**, so it runs at 2.5s and backs off hard on any 429, easing back
down after a clean streak. Full catalog is roughly **19 hours**.

It checkpoints every 25 sets, so `Ctrl+C` is safe and rerunning resumes exactly
where it stopped. Genuine boxed sets are harvested first (newest first), so the
table is useful long before the run ends — the last ~9,000 entries are non-set
merchandise (Jibbitz, books, shoes) that mostly have no barcode worth having.
Barcode coverage on real boxed sets measured **~97%**, including 1990s sets.

```bash
npm run harvest -- --limit 500   # short run
npm run harvest -- --dry-run     # size the queue, fetch nothing
npm run harvest -- --reset       # start over
```

### Keeping it current

**New sets** are cheap to pick up — a rerun only fetches set numbers it has never
seen, so this is minutes, not another 21 hours. Worth doing monthly:

```bash
npm run build:sets    # refresh the set list (data/cache has a 24h TTL)
npm run harvest       # fetches only what's new
```

**Sets that came back blank are never revisited automatically.** A set is marked
done as soon as its page is read, even if it had no barcode — so the ~9,200 blanks
are skipped by every future run. Brickset's barcode data is volunteer-contributed
and does grow, so go back for them occasionally:

```bash
npm run harvest -- --recheck-missing --since 2000   # 5,271 sets, ~3h40m
npm run harvest -- --recheck-missing                # all 9,215, ~6h20m
```

Recheck skips merchandise (it will never have a set barcode) and is additive — new
sets are still harvested in the same run. It reports `newly filled` so you can see
whether the pass was worth it.

Rechecking pre-2000 sets is mostly pointless: those boxes carried no retail barcode,
which is why `--since 2000` is the sensible default.

**After any of these, restart the server** — `loadDb()` reads the JSON files once at
boot, so on-disk changes don't take effect until then. Runtime contributions are the
exception; they update the live table immediately.

### Growing it from scans

When a scan misses, type the set number from the box and save. The app posts it to
`POST /api/contribute`, which persists it to `data/contributed.json`; contributions
take priority over harvested values, so a hand correction always wins.

**On Render's free tier the disk is wiped on every deploy.** Pull contributions down
and commit them to keep them:

```bash
curl https://brick-ledger.onrender.com/api/contributions -o data/contributed.json
```

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

**All optional.** LEGO set lookup needs no keys at all — it runs off `data/`.

| Variable | Needed? | Effect |
|----------|---------|--------|
| `REBRICKABLE_KEY` | Optional | Only used by the fallback chain, for barcodes not in the local table. |
| `BRICKOWL_KEY` | Unused | No key issued; the code path is disabled. |
| `BARCODELOOKUP_KEY` | Unused | No key issued; the code path is disabled. |

### Free-tier notes

- The service **sleeps after ~15 min idle**; the first request then takes ~30–60 s to wake.
  Local-table lookups are instant once awake, so a miss no longer costs an extra API round-trip.
- The filesystem is **ephemeral** — see the note about committing `contributed.json` above.
- The UPCitemdb 24 h rate-limit backoff is kept **in memory**, so a redeploy/restart resets it.

## How lookup works

`GET /api/identify?code=<barcode>` runs server-side (so the browser never makes a
cross-origin call and CORS can't fail):

1. **Local table** — `contributed.json`, then `barcodes.json`, joined against
   `sets.json` for the metadata. Exact, keyless, instant. This is the normal path.
   Barcodes are normalised first, so a UPC-A resolves whether the scanner reports
   12 digits or zero-pads it to 13.
2. UPCitemdb trial lookup → product title, description, price. *(fallback)*
3. If that's rate-limited, scrape the UPCitemdb / Barcode Lookup result page title.
4. **Enrich**: parse a LEGO set number out of the title, then verify it against
   Rebrickable if `REBRICKABLE_KEY` is set.

Steps 2–4 are guesswork and now only apply to barcodes the table doesn't know —
including non-LEGO items, which is the case they're genuinely good for.

### Other endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/set?num=75192` | Resolve a set number to metadata from the local catalog (no key). |
| `POST /api/contribute` | `{"barcode":"…","setNum":"…"}` — teach the table a new barcode. |
| `GET /api/contributions` | Download `contributed.json` for committing. |
| `GET /api/debug` | Table sizes and which env vars are present. |

Keys can also be supplied per-request from the app's **Settings** (sent as
`x-bo-key` / `x-rb-key` / `x-bl-key` headers); env vars take priority.
