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
const UPCITEMDB_BACKOFF_MS = 24 * 60 * 60 * 1000;
let upcitemdbBackoffUntil = 0;

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
    if (!r.ok) {
      const text = await r.text();
      console.error(`HTTP ${r.status} from ${new URL(url).hostname}:`, text.slice(0, 200));
      return null;
    }
    return await r.json();
  } catch (e) {
    console.error('getJson exception:', e.message);
    return null;
  }
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
  if (Date.now() < upcitemdbBackoffUntil) {
    console.log('Skipping UPCitemdb due to backoff until', new Date(upcitemdbBackoffUntil).toISOString());
    return null;
  }
  try {
    const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`;
    console.log('UPCitemdb URL:', url);
    const r = await fetch(url);
    if (r.status === 429) {
      upcitemdbBackoffUntil = Date.now() + UPCITEMDB_BACKOFF_MS;
      const text = await r.text();
      console.error('UPCitemdb rate limit hit; backing off until', new Date(upcitemdbBackoffUntil).toISOString(), text.slice(0, 200));
      return null;
    }
    if (!r.ok) {
      const text = await r.text();
      console.error(`HTTP ${r.status} from api.upcitemdb.com:`, text.slice(0, 200));
      return null;
    }
    const d = await r.json();
    console.log('UPCitemdb raw response:', JSON.stringify(d).slice(0, 300));
    const it = (d?.items || [])[0];
    if (it?.title) {
      const result = {
        name: it.title,
        note: it.description || '',
        price: it.highest_recorded_price ? String(it.highest_recorded_price) : '',
        source: 'UPCitemdb',
      };
      console.log('UPCitemdb found:', result);
      return result;
    }
    console.log('UPCitemdb no items found for:', code, 'items count:', (d?.items || []).length);
    return null;
  } catch (e) {
    console.error('UPCitemdb exception:', e.message);
    return null;
  }
}

async function lookupOpenFoodFacts(code) {
  try {
    const url = `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code)}.json`;
    console.log('OpenFoodFacts URL:', url);
    const d = await getJson(url);
    if (!d || d.status !== 1) {
      console.log('OpenFoodFacts no product found for:', code, 'status:', d?.status);
      return null;
    }
    const p = d.product || {};
    const result = {
      name: p.product_name || p.generic_name || '',
      note: p.brands ? `Brand: ${p.brands}` : '',
      source: 'OpenFoodFacts',
    };
    if (!result.name) return null;
    console.log('OpenFoodFacts found:', result);
    return result;
  } catch (e) {
    console.error('OpenFoodFacts exception:', e.message);
    return null;
  }
}

async function identify(code, keys) {
  const { bo, rb, bl } = keys;

  // 1) BrickOwl: box barcode -> set
  /*
  if (bo) {
    try {
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
    } catch (e) { console.error('BrickOwl error:', e.message); }
  }
  */
  if (bo) {
    console.log('BrickOwl lookup currently disabled due to broken 403 API access.');
  }

  // 3) Barcode Lookup (non-LEGO / unlisted)
  /*
  try {
    const blResult = await lookupBarcodeLookup(code, bl);
    if (blResult) { console.log('BL result:', blResult); return blResult; }
  } catch (e) { console.error('BarcodeLookup error:', e.message); }
  */
  if (bl) {
    console.log('BarcodeLookup lookup currently disabled due to broken 403 API access.');
  }

  // 4) UPCitemdb trial (keyless last resort)
  try {
    console.log('Trying UPCitemdb for:', code);
    const upcResult = await lookupUpcitemdb(code);
    console.log('UPC result:', upcResult);
    if (upcResult) return upcResult;
  } catch (e) { console.error('UPCitemdb error:', e.message); }

  // 5) OpenFoodFacts fallback for general barcodes
  try {
    console.log('Trying OpenFoodFacts for:', code);
    const offResult = await lookupOpenFoodFacts(code);
    console.log('OpenFoodFacts result:', offResult);
    if (offResult) return offResult;
  } catch (e) { console.error('OpenFoodFacts error:', e.message); }

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
