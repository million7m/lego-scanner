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

function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function lookupWebFallback(code) {
  const fallbackUrls = [
    `https://www.upcitemdb.com/upc/${encodeURIComponent(code)}`,
    `https://www.barcodelookup.com/${encodeURIComponent(code)}`,
  ];

  for (const url of fallbackUrls) {
    try {
      console.log('Web fallback URL:', url);
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!r.ok) {
        console.error('Web fallback HTTP error:', r.status, 'for', url);
        continue;
      }
      const html = await r.text();
      const titleRaw = (
        html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
        html.match(/<title>([^<]+)<\/title>/i)?.[1] ||
        ''
      ).trim();
      const descRawMatch = html.match(/<meta[^>]*name=["']Description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']Description["'][^>]*>/i);
      const descRaw = descRawMatch ? descRawMatch[1] : '';
      const title = decodeHtmlEntities(titleRaw);
      let name = '';
      const titleMatch = title.match(/^\s*UPC\s*\d+\s*[-–]\s*(.+?)(?:\s*[|].*)?$/i);
      if (titleMatch) {
        name = titleMatch[1].trim();
      } else {
        const normalized = title.replace(/\s*[|].*$/, '').trim();
        if (normalized && !/^UPC\s*\d+$/i.test(normalized)) {
          name = normalized;
        }
      }
      if (!name && descRaw) {
        const desc = decodeHtmlEntities(descRaw);
        const descMatch = desc.match(/product\s+(.+?)(?:,|$)/i);
        if (descMatch) name = descMatch[1].trim();
      }
      if (!name) {
        console.log('Web fallback parse failed for', url);
        continue;
      }
      const result = { name, source: 'WebFallback' };
      console.log('Web fallback found:', result);
      return result;
    } catch (e) {
      console.error('Web fallback exception for', url, e.message);
    }
  }
  return null;
}

/* Pull likely LEGO set numbers (4–7 digits) out of a product title, skipping
   piece counts like "(7541 pieces)" so we don't mistake those for the set #. */
function setNumberCandidates(name) {
  const cleaned = String(name || '')
    .replace(/\(([^)]*\b(?:piece|pieces|pcs|teile|stück)\b[^)]*)\)/gi, ' ')
    .replace(/\b\d{3,7}\s*(?:piece|pieces|pcs)\b/gi, ' ');
  return [...new Set(cleaned.match(/\b\d{4,7}\b/g) || [])];
}

/* Keyword fallback for theme when Rebrickable isn't available. */
const KNOWN_THEMES = ['Star Wars', 'Technic', 'Harry Potter', 'Speed Champions', 'Super Mario',
  'Super Heroes', 'Marvel', 'Jurassic World', 'Lord of the Rings', 'City', 'Creator', 'Friends',
  'Ninjago', 'Duplo', 'Architecture', 'Ideas', 'Minecraft', 'Disney', 'Icons', 'Botanical',
  'Classic', 'Mindstorms', 'Batman', 'Avatar', 'Wednesday', 'Hogwarts'];
function guessTheme(name) {
  const n = String(name || '');
  return KNOWN_THEMES.find(t => new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(n)) || '';
}

const THEME_CACHE = new Map();
async function rebrickableTheme(themeId, rb) {
  if (!themeId || !rb) return '';
  if (THEME_CACHE.has(themeId)) return THEME_CACHE.get(themeId);
  const t = await getJson(`https://rebrickable.com/api/v3/lego/themes/${themeId}/`, { Authorization: 'key ' + rb });
  const name = t?.name || '';
  THEME_CACHE.set(themeId, name);
  return name;
}

/* Given a lookup result that has a product title, fill in set number + theme
   (+ image + piece count). Validates candidate set numbers against Rebrickable
   so we only accept a number that's a real set; falls back to a best-guess set
   number and keyword theme when there's no Rebrickable key. */
async function enrichLegoSet(result, rb) {
  if (!result?.name) return result;
  const candidates = setNumberCandidates(result.name);
  if (rb) {
    for (const c of candidates.slice(0, 5)) {
      const setNum = c.includes('-') ? c : c + '-1';
      const s = await getJson(`https://rebrickable.com/api/v3/lego/sets/${encodeURIComponent(setNum)}/`, { Authorization: 'key ' + rb });
      if (s?.set_num) {
        result.name = s.name || result.name;
        result.setNum = s.set_num;
        result.numParts = s.num_parts;
        result.imgUrl = s.set_img_url;
        result.theme = await rebrickableTheme(s.theme_id, rb);
        result.source = result.source ? result.source + ' + Rebrickable' : 'Rebrickable';
        return result;
      }
    }
  }
  // no key, or nothing resolved — best effort from the title alone
  if (!result.setNum && candidates.length) result.setNum = candidates[0] + '-1';
  if (!result.theme) result.theme = guessTheme(result.name);
  return result;
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
    if (upcResult) { const out = await enrichLegoSet(upcResult, rb); console.log('Identified (enriched):', out); return out; }
  } catch (e) { console.error('UPCitemdb error:', e.message); }

  // 5) Web fallback using barcode result page title
  try {
    console.log('Trying web fallback for:', code);
    const webResult = await lookupWebFallback(code);
    console.log('Web fallback result:', webResult);
    if (webResult) { const out = await enrichLegoSet(webResult, rb); console.log('Identified (enriched):', out); return out; }
  } catch (e) { console.error('Web fallback error:', e.message); }

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
