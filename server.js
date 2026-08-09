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

/* ============================================================
   Local barcode database — the primary lookup.

   data/barcodes.json   barcode -> set number   (harvested from Brickset)
   data/sets.json       set number -> metadata  (Rebrickable bulk CSV)
   data/contributed.json  barcodes resolved by hand in the app

   This is an exact table, so it replaces the old approach of scraping a
   product title and guessing which number in it was the set number. It
   needs no API keys, can't be rate-limited, and answers instantly even
   on a cold dyno. The online chain below is now only a fallback for
   barcodes the table doesn't have (including non-LEGO items).
   ============================================================ */
const DATA_DIR = path.join(__dirname, 'data');
const CONTRIB_FILE = path.join(DATA_DIR, 'contributed.json');
const IMG_PREFIX = 'https://cdn.rebrickable.com/media/sets/';

const DB = { barcodes: new Map(), sets: new Map(), contributed: new Map(), prices: new Map() };

function loadJsonFile(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`Failed to read data/${name}:`, e.message);
    return null;
  }
}

function loadDb() {
  const barcodes = loadJsonFile('barcodes.json') || {};
  const sets = loadJsonFile('sets.json') || {};
  const contributed = loadJsonFile('contributed.json') || {};
  const prices = loadJsonFile('prices.json') || {};
  DB.barcodes = new Map(Object.entries(barcodes));
  DB.sets = new Map(Object.entries(sets));
  DB.contributed = new Map(Object.entries(contributed));
  DB.prices = new Map(Object.entries(prices));
  FACETS = null;                                  // rebuilt lazily from the new data
  console.log(`Local DB: ${DB.barcodes.size} harvested barcodes, ${DB.sets.size} sets, ` +
    `${DB.prices.size} prices, ${DB.contributed.size} contributed`);
  if (!DB.barcodes.size) {
    console.warn('  No barcodes.json yet — run tools/build-sets.js then tools/harvest-barcodes.js');
  }
}

/* Scanners report the same product in more than one form: a UPC-A may arrive
   as 12 digits or zero-padded to 13, and EAN-8 sometimes carries padding.
   Try every equivalent form so a match isn't missed on formatting alone. */
function codeVariants(code) {
  const d = String(code || '').replace(/\D/g, '');
  const out = new Set();
  if (!d) return [];
  out.add(d);
  if (d.length === 12) out.add('0' + d);
  if (d.length === 13 && d.startsWith('0')) out.add(d.slice(1));
  if (d.length === 14 && d.startsWith('0')) out.add(d.slice(1));
  out.add(d.replace(/^0+/, ''));
  return [...out].filter(Boolean);
}

/* Rebrickable's catalogue also carries merchandise — Jibbitz, shoes, books,
   database bookkeeping entries. Including those in a completion report would
   bury the actual sets, and nobody is trying to "complete" a lunch bag. Same
   rule the harvester uses to decide what's worth fetching. */
const NON_SET_THEMES = new Set(['Gear', 'Books']);
const REAL_SET_NUM = /^\d{3,7}-\d+$/;
function isRealSet(setNum, row) {
  return row && row[3] > 0 && !NON_SET_THEMES.has(row[2]) && REAL_SET_NUM.test(setNum);
}

let FACETS = null;
function catalogFacets() {
  if (FACETS) return FACETS;
  const years = new Map(), themes = new Map();
  for (const [setNum, row] of DB.sets) {
    if (!isRealSet(setNum, row)) continue;
    const [, year, theme] = row;
    if (year) years.set(year, (years.get(year) || 0) + 1);
    if (theme) themes.set(theme, (themes.get(theme) || 0) + 1);
  }
  FACETS = {
    years: [...years.entries()].sort((a, b) => b[0] - a[0]),
    themes: [...themes.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  };
  return FACETS;
}

/* Launch RRP, harvested from Brickset. Stored compactly as [usd, gbp, eur];
   0 means that currency wasn't listed, which is not the same as free. */
function msrpFor(setNum) {
  const row = DB.prices.get(setNum);
  if (!row) return {};
  const [usd, gbp, eur] = row;
  const out = {};
  if (usd) out.msrp = usd;                       // the app displays USD
  if (usd || gbp || eur) out.msrpAll = { usd: usd || undefined, gbp: gbp || undefined, eur: eur || undefined };
  return out;
}

function setDetails(setNum) {
  const row = DB.sets.get(setNum);
  if (!row) return { setNum };
  const [name, year, theme, numParts, subtheme, img] = row;
  return {
    name,
    setNum,
    year: year || undefined,
    theme: theme || '',
    subtheme: subtheme || undefined,
    numParts: numParts || undefined,
    /* Rebrickable's image path is the set number lowercased — checked against
       all 27,810 sets, every stored override differs from the plain form only
       by case, so deriving covers rows that have no override too. */
    imgUrl: img || IMG_PREFIX + setNum.toLowerCase() + '.jpg',
    ...msrpFor(setNum),
  };
}

/* Exact lookup against the local table. Contributions win over the harvest:
   if someone corrected a barcode by hand, that's the better answer. */
function lookupLocal(code) {
  for (const v of codeVariants(code)) {
    const setNum = DB.contributed.get(v) || DB.barcodes.get(v);
    if (setNum) {
      const hand = DB.contributed.has(v);
      return {
        ...setDetails(setNum),
        source: hand ? 'Brick Ledger DB (contributed)' : 'Brick Ledger DB',
        exact: true,
      };
    }
  }
  return null;
}

/* GS1 mod-10 check digit. Product text is full of long numbers — item codes,
   ASINs, dimensions run together — and retrying the table with each of them
   would invite false matches. A valid check digit means it's really a GTIN. */
function gtinCheckDigitValid(d) {
  if (!/^(\d{8}|\d{12,14})$/.test(d)) return false;
  const digits = [...d].map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/* Pull every plausible GTIN out of a lookup result: the provider's own
   identifier fields first, then anything GTIN-shaped in the title or
   description. Excludes the code we already tried. */
function gtinCandidates(result, scanned) {
  const seen = new Set(codeVariants(scanned));
  const out = [];
  const add = v => {
    const d = String(v || '').replace(/\D/g, '');
    if (!d || seen.has(d) || !gtinCheckDigitValid(d)) return;
    seen.add(d);
    out.push(d);
  };
  for (const c of result?.codes || []) add(c);
  const text = `${result?.name || ''} ${result?.note || ''}`;
  // labelled first — "GTIN: 5702016616897" is a much stronger signal
  for (const m of text.matchAll(/\b(?:GTIN|EAN|UPC)[^\d]{0,4}(\d{8,14})\b/gi)) add(m[1]);
  for (const m of text.matchAll(/\b\d{12,14}\b/g)) add(m[0]);
  return out;
}

/* The scanned symbol isn't always the code the set is catalogued under —
   UPC-E, a regional variant, or an inner carton code will miss the table
   while the product's real GTIN sits right there in the lookup result. Retry
   with those before falling back to guessing a set number from the title. */
function resolveViaGtin(result, scanned) {
  for (const gtin of gtinCandidates(result, scanned)) {
    const hit = lookupLocal(gtin);
    if (hit) {
      console.log(`Resolved ${scanned} via GTIN ${gtin} -> ${hit.setNum}`);
      return { ...hit, source: hit.source + ` (via GTIN ${gtin})`, matchedGtin: gtin };
    }
  }
  return null;
}

/* Persist a hand-resolved barcode. Note the free Render tier has an ephemeral
   filesystem, so this survives restarts only until the next deploy — pull them
   down via GET /api/contributions and commit them to keep them for good. */
/* Variant suffixes aren't always numeric ("215-2B"), so a set number counts as
   complete once it has a dash — appending "-1" to those would invent a set. */
function normalizeSetNum(s) {
  const v = String(s || '').trim();
  return v && !v.includes('-') ? v + '-1' : v;
}

function saveContribution(code, setNum) {
  const digits = String(code || '').replace(/\D/g, '');
  const norm = normalizeSetNum(setNum);
  if (!digits || !norm) return null;
  DB.contributed.set(digits, norm);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONTRIB_FILE, JSON.stringify(Object.fromEntries(DB.contributed), null, 2));
  } catch (e) {
    console.error('Could not persist contribution:', e.message);
  }
  return { barcode: digits, setNum: norm, known: DB.sets.has(norm) };
}

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
        /* The response carries the product's own identifiers, which are often
           the proper GTIN when the scanned symbol was a shortened or regional
           variant. Kept so the caller can retry the local table with them. */
        codes: [it.gtin, it.ean, it.upc, it.elid].filter(Boolean).map(String),
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
      // keep the description: it often carries the product's GTIN
      const result = { name, note: decodeHtmlEntities(descRaw || ''), source: 'WebFallback' };
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

  // 0) Local barcode table — exact, keyless, instant. Almost always the answer.
  const local = lookupLocal(code);
  if (local) { console.log('Identified from local DB:', local.setNum, local.name); return local; }

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
    if (upcResult) {
      /* Prefer an exact table hit on the product's real GTIN over parsing a
         set number out of the title — the former is a fact, the latter a guess. */
      const viaGtin = resolveViaGtin(upcResult, code);
      if (viaGtin) return viaGtin;
      const out = await enrichLegoSet(upcResult, rb);
      console.log('Identified (enriched):', out);
      return out;
    }
  } catch (e) { console.error('UPCitemdb error:', e.message); }

  // 5) Web fallback using barcode result page title
  try {
    console.log('Trying web fallback for:', code);
    const webResult = await lookupWebFallback(code);
    console.log('Web fallback result:', webResult);
    if (webResult) {
      const viaGtin = resolveViaGtin(webResult, code);
      if (viaGtin) return viaGtin;
      const out = await enrichLegoSet(webResult, rb);
      console.log('Identified (enriched):', out);
      return out;
    }
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

  /* Year and theme pickers for the completion report. Computed from the same
     filtered catalogue the report uses, so every option returns results. */
  if (u.pathname === '/api/facets') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    return res.end(JSON.stringify(catalogFacets()));
  }

  /* The candidate list for a completion report. The app diffs this against
     your ledger locally — the server never sees what you own. */
  if (u.pathname === '/api/catalog') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const year = (u.searchParams.get('year') || '').trim();
    const theme = (u.searchParams.get('theme') || '').trim();
    if (!year && !theme) {
      res.writeHead(400);
      return res.end('{"error":"specify a year or a theme"}');
    }
    const sets = [];
    for (const [setNum, row] of DB.sets) {
      if (!isRealSet(setNum, row)) continue;
      if (year && String(row[1]) !== year) continue;
      if (theme && row[2] !== theme) continue;
      const price = DB.prices.get(setNum);
      sets.push([setNum, row[0], row[2], row[3], price ? price[0] : 0, row[1]]);
    }
    sets.sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
    res.writeHead(200);
    return res.end(JSON.stringify({ count: sets.length, sets }));
  }

  /* Resolve a set number straight from the local catalog — lets the app fill in
     name/theme/pieces/image with no Rebrickable key and no CSV import. */
  if (u.pathname === '/api/set') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const raw = (u.searchParams.get('num') || '').trim();
    if (!raw) { res.writeHead(400); return res.end('{"error":"missing num"}'); }
    const norm = normalizeSetNum(raw);
    const hit = DB.sets.has(norm) ? norm : (DB.sets.has(raw) ? raw : '');
    res.writeHead(200);
    return res.end(JSON.stringify({ result: hit ? setDetails(hit) : null }));
  }

  /* Teach the shared table a barcode the harvest didn't have. The app posts
     here whenever you save an item that has both a barcode and a set number. */
  if (u.pathname === '/api/contribute') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST') { res.writeHead(405); return res.end('{"error":"POST only"}'); }
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) { res.writeHead(413); return res.end('{"error":"too large"}'); }
      }
      const { barcode, setNum } = JSON.parse(body || '{}');
      if (!barcode || !setNum) { res.writeHead(400); return res.end('{"error":"barcode and setNum required"}'); }
      // Don't overwrite a harvested barcode that already resolves correctly.
      const existing = lookupLocal(barcode);
      if (existing && existing.setNum === normalizeSetNum(setNum)) {
        res.writeHead(200);
        return res.end(JSON.stringify({ ok: true, alreadyKnown: true, setNum: existing.setNum }));
      }
      const saved = saveContribution(barcode, setNum);
      if (!saved) { res.writeHead(400); return res.end('{"error":"invalid barcode or setNum"}'); }
      console.log(`Contributed: ${saved.barcode} -> ${saved.setNum} (in catalog: ${saved.known})`);
      res.writeHead(200);
      return res.end(JSON.stringify({ ok: true, ...saved, total: DB.contributed.size }));
    } catch (e) {
      console.error('contribute error:', e.message);
      res.writeHead(400);
      return res.end('{"error":"bad request"}');
    }
  }

  /* Download the hand-resolved barcodes so they can be committed to the repo —
     the free Render tier's disk is wiped on each deploy. */
  if (u.pathname === '/api/contributions') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contributed.json"');
    res.writeHead(200);
    return res.end(JSON.stringify(Object.fromEntries(DB.contributed), null, 2));
  }

  if (u.pathname === '/api/debug') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(200);
    return res.end(JSON.stringify({
      localDb: {
        harvestedBarcodes: DB.barcodes.size,
        contributedBarcodes: DB.contributed.size,
        sets: DB.sets.size,
        prices: DB.prices.size,
      },
      env: {
        BRICKOWL_KEY: !!process.env.BRICKOWL_KEY,
        REBRICKABLE_KEY: !!process.env.REBRICKABLE_KEY,
        BARCODELOOKUP_KEY: !!process.env.BARCODELOOKUP_KEY,
      },
      canReach: {
        brickowl: 'disabled (no key issued)',
        barcodelookup: 'disabled (no key issued)',
        upcitemdb: 'fallback only',
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

loadDb();
server.listen(PORT, () => console.log(`Brick Ledger running on http://localhost:${PORT}`));
