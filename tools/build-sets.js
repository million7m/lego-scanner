#!/usr/bin/env node
/* ============================================================
   build-sets.js — build data/sets.json from Rebrickable's public
   bulk CSV downloads.

   These downloads need no API key. They give us every LEGO set
   number in exactly the format Brickset uses in its URLs
   (e.g. "75192-1"), plus the name/year/theme/piece count. That
   makes them both the master set list for the barcode harvester
   and the metadata table the server joins against at scan time.

   Rebrickable does NOT publish barcodes — that's what
   harvest-barcodes.js is for.

   Run:  node tools/build-sets.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA = path.join(__dirname, '..', 'data');
const CACHE = path.join(DATA, 'cache');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BASE = 'https://cdn.rebrickable.com/media/downloads';

/* Rebrickable serves every set image from a predictable path, so we only
   store img_url when it deviates — saves ~1.5MB in the shipped JSON. */
const IMG_PREFIX = 'https://cdn.rebrickable.com/media/sets/';
const IMG_SUFFIX = '.jpg';

/* --- minimal RFC4180 CSV parser (set names contain commas and quotes) --- */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toObjects(rows) {
  const head = rows[0];
  return rows.slice(1)
    .filter(r => r.length === head.length)
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

async function download(name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const gzPath = path.join(CACHE, name + '.csv.gz');
  if (fs.existsSync(gzPath)) {
    const ageH = (Date.now() - fs.statSync(gzPath).mtimeMs) / 3.6e6;
    if (ageH < 24) {
      console.log(`  ${name}.csv.gz — cached (${ageH.toFixed(1)}h old)`);
      return zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8');
    }
  }
  const url = `${BASE}/${name}.csv.gz`;
  console.log(`  ${name}.csv.gz — downloading…`);
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(gzPath, buf);
  return zlib.gunzipSync(buf).toString('utf8');
}

/* Rebrickable themes are a tree ("Star Wars > Episode IV"). The app shows one
   theme label, so resolve each set to its ROOT theme and keep the leaf as the
   subtheme — that matches how people actually describe a set. */
function themeResolver(themes) {
  const byId = new Map(themes.map(t => [t.id, t]));
  const rootCache = new Map();
  function root(id) {
    if (rootCache.has(id)) return rootCache.get(id);
    const seen = new Set();
    let cur = byId.get(id);
    while (cur && cur.parent_id && byId.has(cur.parent_id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent_id);
    }
    const name = cur ? cur.name : '';
    rootCache.set(id, name);
    return name;
  }
  return id => ({ theme: root(id), subtheme: byId.get(id)?.name || '' });
}

(async () => {
  console.log('Fetching Rebrickable bulk data (no API key required)…');
  const [setsCsv, themesCsv] = await Promise.all([download('sets'), download('themes')]);

  const themes = toObjects(parseCsv(themesCsv));
  const sets = toObjects(parseCsv(setsCsv));
  const resolve = themeResolver(themes);
  console.log(`  parsed ${sets.length} sets, ${themes.length} themes`);

  /* Compact row form keeps the shipped file small; the server expands it.
     [name, year, theme, numParts, subtheme, imgOverride] */
  const out = {};
  let customImg = 0;
  for (const s of sets) {
    if (!s.set_num) continue;
    const { theme, subtheme } = resolve(s.theme_id);
    const expected = IMG_PREFIX + s.set_num + IMG_SUFFIX;
    const img = s.img_url && s.img_url !== expected ? s.img_url : '';
    if (img) customImg++;
    out[s.set_num] = [
      s.name || '',
      +s.year || 0,
      theme,
      +s.num_parts || 0,
      subtheme === theme ? '' : subtheme,
      img,
    ];
  }

  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, 'sets.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const mb = (fs.statSync(file).size / 1048576).toFixed(2);
  console.log(`\nWrote data/sets.json — ${Object.keys(out).length} sets, ${mb} MB`);
  console.log(`  ${customImg} sets needed an explicit image URL; the rest are derived.`);
  console.log('\nNext: node tools/harvest-barcodes.js');
})().catch(e => { console.error('build-sets failed:', e.message); process.exit(1); });
