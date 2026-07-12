#!/usr/bin/env node
/* ============================================================
   Brick Ledger — static host + barcode-lookup proxy.

   Serves the PWA in ./files and exposes ONE endpoint:

     GET /api/identify?code=<barcode>

   The proxy runs the identify chain (BrickOwl -> Rebrickable, then
   generic barcode DBs) server-side, so the browser never makes a
   cross-origin call and CORS can't fail. Keys come from env vars
   (preferred) or, failing that, from the caller's own request headers
   (the key the user pasted in Settings). No keys are logged.

   Run:   node server.js           (defaults to port 8123)
   Keys:  BRICKOWL_KEY=... REBRICKABLE_KEY=... BARCODELOOKUP_KEY=... node server.js
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'files');
const PORT = process.env.PORT || 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* --- helpers (mirror the client so results are shaped identically) --- */
async function getJson(url, headers) {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
function deriveSetNum(name) {
  const g = String(name || '').match(/\d{3,7}/g);
  return g && g.length ? g[g.length - 1] + '-1' : '';
}
function cleanSetName(name) {
  return String(name || '').replace(/^lego\s+/i, '').replace(/\s+\d{3,7}\s*$/, '').trim();
}

/* --- the identify chain, ported from the old Android app --- */
async function lookupBarcodeLookup(code, key) {
  if (!key) return null;
  const d = await getJson(`https://api.barcodelookup.com/v2/products?barcode=${encodeURIComponent(code)}&formatted=y&key=${encodeURIComponent(key)}`);
  const p = (d?.products || [])[0];
  if (p) {
    const st = (p.stores || [])[0];
    return {
      name: p.product_name || p.title || '',
      note: p.description || '',
      price: st?.store_price ? (st.currency_symbol || '') + st.store_price : '',
      source: 'Barcode Lookup',
    };
  }
  return null;
}

async function lookupUpcitemdb(code) {
  const d = await getJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`);
  const it = (d?.items || [])[0];
  if (it?.title) {
    return {
      name: it.title,
      note: it.description || '',
      price: it.highest_recorded_price ? String(it.highest_recorded_price) : '',
      source: 'UPCitemdb',
    };
  }
  return null;
}

async function identify(code, keys) {
  const { bo, rb, bl } = keys;

  // 1) BrickOwl: box barcode -> set
  if (bo) {
    const d = await getJson(`https://api.brickowl.com/v1/catalog/search?key=${encodeURIComponent(bo)}&query=${encodeURIComponent(code)}`);
    const hit = (d?.results || []).find(x => x.type === 'Set') || (d?.results || [])[0];
    if (hit?.name) {
      const setNum = deriveSetNum(hit.name);
      const out = { name: cleanSetName(hit.name), setNum, source: 'BrickOwl' };
      // 2) Rebrickable enriches with image + piece count
      if (setNum && rb) {
        const s = await getJson(`https://rebrickable.com/api/v3/lego/sets/${encodeURIComponent(setNum)}/`, { Authorization: 'key ' + rb });
        if (s) { out.name = out.name || s.name; out.numParts = s.num_parts; out.imgUrl = s.set_img_url; }
      }
      return out;
    }
  }

  // 3) Barcode Lookup (non-LEGO / unlisted)
  const blResult = await lookupBarcodeLookup(code, bl);
  if (blResult) return blResult;

  // 4) UPCitemdb trial (keyless last resort)
  const upcResult = await lookupUpcitemdb(code);
  if (upcResult) return upcResult;

  return null;
}

/* --- server --- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (u.pathname === '/api/identify') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const code = (u.searchParams.get('code') || '').trim();
    if (!code) { res.writeHead(400); return res.end('{"error":"missing code"}'); }
    const keys = {
      bo: process.env.BRICKOWL_KEY || req.headers['x-bo-key'] || '',
      rb: process.env.REBRICKABLE_KEY || req.headers['x-rb-key'] || '',
      bl: process.env.BARCODELOOKUP_KEY || req.headers['x-bl-key'] || '',
    };
    let result = null;
    try { result = await identify(code, keys); } catch (e) { console.error('identify error:', e); result = null; }
    res.writeHead(200);
    return res.end(JSON.stringify({ result, debug: { boKey: !!keys.bo, rbKey: !!keys.rb, blKey: !!keys.bl } }));
  }

  if (u.pathname === '/api/debug') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    return res.end(JSON.stringify({
      env: {
        BRICKOWL_KEY: !!process.env.BRICKOWL_KEY,
        REBRICKABLE_KEY: !!process.env.REBRICKABLE_KEY,
        BARCODELOOKUP_KEY: !!process.env.BARCODELOOKUP_KEY,
      },
      canReach: {
        brickowl: 'test by scanning',
        barcodelookup: 'test by scanning',
        upcitemdb: 'always tried',
      },
    }));
  }

  // static files
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Brick Ledger running on http://localhost:${PORT}`));
