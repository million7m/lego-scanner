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

Render will use `render.yaml` to deploy the app as a Node web service.

Set the following environment variables in Render if you want API lookup support:

- `BRICKOWL_KEY`
- `REBRICKABLE_KEY`
- `BARCODELOOKUP_KEY`
