#!/usr/bin/env node
/* ============================================================
   harvest-barcodes.js — build data/barcodes.json by reading the
   EAN/UPC off each set's public Brickset page.

   Why this exists: no keyless API maps a box barcode to a LEGO set.
   Brickset publishes the barcodes on each set page, but its search
   does not index them, so there's no way to query by barcode — the
   only route is to read them once and keep our own table.

   How it behaves:
     - Only ever fetches /sets/{setNum}, which robots.txt allows.
       (/search, /export and the page- prefixes are disallowed; we
       need none of them.)
     - Measured safe rate is ~2s between requests; 1.5s trips a 429.
       Starts at 2s, backs off hard on 429, eases back down slowly.
     - Checkpoints after every batch, so Ctrl+C is safe and a rerun
       resumes exactly where it stopped.
     - Walks newest sets first, so the table is useful long before
       the full run finishes.

   Run:      node tools/harvest-barcodes.js
   Resume:   same command
   Limited:  node tools/harvest-barcodes.js --limit 500
   Reset:    node tools/harvest-barcodes.js --reset

   Keeping it current:
     A plain rerun only fetches set numbers it has never seen, so
     picking up newly released sets is cheap — rebuild sets.json
     first, then rerun.

     It will NOT revisit a set that was checked and had no barcode.
     Brickset's barcode data is volunteer-contributed and grows over
     time, so those gaps do fill in eventually. To go back for them:

       --recheck-missing         requeue sets checked but still blank
       --since 2000              ...only those from this year onward
       --dry-run                 size the queue without fetching anything

     Recheck is additive: new sets are still harvested in the same run.
     It skips merchandise, which will never have a set barcode.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const SETS_FILE = path.join(DATA, 'sets.json');
const BARCODES_FILE = path.join(DATA, 'barcodes.json');
const PRICES_FILE = path.join(DATA, 'prices.json');
const DATES_FILE = path.join(DATA, 'dates.json');
/* Deliberately gitignored: current market value is Brickset's own derived
   analytics, not a catalogue fact, so it stays on this machine rather than
   being republished. */
const VALUES_FILE = path.join(DATA, 'values.json');
const STATE_FILE = path.join(DATA, 'harvest-state.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MIN_DELAY = 2500;   // 1.5s 429s immediately, 2s still does occasionally
const MAX_DELAY = 20000;
const SAVE_EVERY = 25;
const MAX_RETRIES = 5;

const args = process.argv.slice(2);
/* Careful: `+args[i+1] || Infinity` would turn an explicit `--limit 0` into
   "no limit", which is the opposite of what it asks for. */
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i < 0) return Infinity;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) && n >= 0 ? n : Infinity;
})();
const DRY_RUN = args.includes('--dry-run');
const RESET = args.includes('--reset');
const RECHECK = args.includes('--recheck-missing');
const PRICES = args.includes('--prices');
const SINCE = (() => {
  const i = args.indexOf('--since');
  return i > -1 ? +args[i + 1] || 0 : 0;
})();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};

function flatten(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&pound;/g, '£')
    .replace(/&euro;/g, '€')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/* Brickset renders the barcodes as a definition list; flattening tags first
   makes "UPC: 673419267656" match regardless of the surrounding markup. */
function extractBarcodes(flat) {
  const ean = flat.match(/EAN:\s*(\d{8,14})/i);
  const upc = flat.match(/UPC:\s*(\d{8,14})/i);
  return { ean: ean?.[1] || '', upc: upc?.[1] || '' };
}

/* Brickset prints availability as "Launch/exit 27 Nov 20 - 31 Dec 23".
   The exit date is the retirement date. Either side can be absent for a set
   that never shipped at retail or is still available. */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function parseBricksetDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2})$/);
  if (!m) return '';
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return '';
  /* Two-digit years across a catalogue spanning 1949-2027. Anything under 50
     is this century; the rest belong to the last one. */
  const yy = Number(m[3]);
  const year = yy < 50 ? 2000 + yy : 1900 + yy;
  return `${year}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function extractDates(flat) {
  const i = flat.search(/Launch\/exit/i);
  if (i < 0) return null;
  const seg = flat.slice(i + 11, i + 61).split(/Tags|Availability|Barcodes|Notes|Rating/)[0];
  const m = seg.match(/(\d{1,2}\s+[A-Za-z]{3}\s+\d{2})?\s*-\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{2})?/);
  if (!m) return null;
  const launched = parseBricksetDate(m[1]);
  const retired = parseBricksetDate(m[2]);
  return (launched || retired) ? { launched, retired } : null;
}

/* Current aftermarket value, as "Current value New: ~$1085 Used: ~$531".

   Unlike RRP this is a moving number — one set read $1077 and then $1085 six
   days later — so every entry is stamped with the date it was read. A value
   without a date is worse than no value: it looks authoritative and quietly
   goes wrong. Only retired sets carry one; anything still on sale has none. */
function extractValues(flat) {
  const i = flat.search(/Current value/i);
  if (i < 0) return null;
  const seg = flat.slice(i + 13, i + 93).split(/Price per piece|Age range|Packaging|Barcodes|RRP|Tags/)[0];
  const money = re => {
    const m = seg.match(re);
    if (!m) return 0;
    const v = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const isNew = money(/New:\s*~?\$([\d,]+(?:\.\d+)?)/i);
  const used = money(/Used:\s*~?\$([\d,]+(?:\.\d+)?)/i);
  return (isNew || used) ? { new: isNew, used } : null;
}

/* Launch RRP, as "RRP £474.99, $549.99, €549.99".

   Two traps on the same page: a second "RRP (inflated)" line giving today's
   inflation-adjusted figure, and a "Current value" line giving resale prices.
   Neither is the MSRP. Anchoring on the first RRP and cutting the segment at
   any of those labels keeps them out — splitting on /RRP/ also terminates at
   "RRP (inflated)" itself. */
function extractPrices(flat) {
  const i = flat.search(/\bRRP\b/);
  if (i < 0) return null;
  const seg = flat.slice(i + 3, i + 83).split(/RRP|Current value|Price per piece|Age range|Packaging|Barcodes/)[0];
  const num = sym => {
    const m = seg.match(new RegExp('\\' + sym + '\\s?([\\d,]+(?:\\.\\d+)?)'));
    if (!m) return 0;
    const v = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const usd = num('$'), gbp = num('£'), eur = num('€');
  return (usd || gbp || eur) ? { usd, gbp, eur } : null;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

(async () => {
  if (!fs.existsSync(SETS_FILE)) {
    console.error('data/sets.json missing — run `node tools/build-sets.js` first.');
    process.exit(1);
  }

  if (RESET) {
    for (const f of [BARCODES_FILE, STATE_FILE]) if (fs.existsSync(f)) fs.unlinkSync(f);
    console.log('Reset harvest state.');
  }

  const sets = readJson(SETS_FILE, {});
  const barcodes = readJson(BARCODES_FILE, {});
  const prices = readJson(PRICES_FILE, {});
  const dates = readJson(DATES_FILE, {});
  const values = readJson(VALUES_FILE, {});
  const state = readJson(STATE_FILE, { done: [], stats: { found: 0, none: 0, failed: 0 } });
  const done = new Set(state.done);
  /* Page details (RRP, launch/exit dates) are tracked separately from
     barcodes: the barcode pass finished before either was being collected, so
     "visited for a barcode" says nothing about whether we read them. Without
     its own list, sets that genuinely have no RRP would be refetched forever.

     This list is deliberately distinct from the older pricesDone: those sets
     were visited before dates were extracted, so they still need one more
     pass. Reusing that list would have left half the catalogue dateless. */
  const detailsSeen = new Set(state.detailsDone || []);

  /* Rebrickable's catalog also carries non-set merchandise — Jibbitz, shoes,
     lunch bags, books — which have no parts, usually 404 on Brickset, and
     never carry a set barcode worth having. Harvest genuine boxed sets first
     (newest first within each tier) so the table is useful early; the rest
     still get visited, just last. */
  const NON_SET_THEMES = new Set(['Gear', 'Books']);
  const SET_NUM_RE = /^\d{3,7}-\d+$/;
  function tier(sn) {
    const [, , theme, parts] = sets[sn];
    const boxed = parts > 0 && !NON_SET_THEMES.has(theme);
    if (boxed && SET_NUM_RE.test(sn)) return 0;   // real, conventionally numbered sets
    if (boxed) return 1;                          // real sets with odd numbering
    return 2;                                     // merchandise, books, promos
  }

  /* A set counts as "still blank" if it was checked but no barcode ever landed
     against it. Those are only revisited on request — Brickset genuinely has
     nothing for most of them (pre-2000 boxes carried no retail barcode), so
     sweeping them every run would be hours of guaranteed-empty requests. */
  const setsWithBarcode = new Set(Object.values(barcodes));
  /* Rechecking merchandise is guaranteed waste — those entries 400/404 on
     Brickset or have no set barcode at all, and that won't change. Recheck
     only revisits real sets. */
  const missing = RECHECK
    ? Object.keys(sets).filter(sn => done.has(sn) && !setsWithBarcode.has(sn) && tier(sn) < 2)
    : [];

  /* Detail backfill: real sets whose page we've never read for RRP and
     launch/exit dates. Merchandise is skipped for the same reason as barcodes
     — it carries neither. */
  const needDetails = PRICES
    ? Object.keys(sets).filter(sn => !detailsSeen.has(sn) && tier(sn) < 2)
    : [];

  const fresh = Object.keys(sets).filter(sn => !done.has(sn));
  const queue = [...new Set([...fresh, ...missing, ...needDetails])]
    .filter(sn => !SINCE || (sets[sn][1] || 0) >= SINCE)
    .sort((a, b) => tier(a) - tier(b) || (sets[b][1] || 0) - (sets[a][1] || 0));

  const tierCounts = [0, 0, 0];
  for (const sn of queue) tierCounts[tier(sn)]++;
  console.log(`Queue tiers — boxed sets: ${tierCounts[0]}, other sets: ${tierCounts[1]}, merchandise: ${tierCounts[2]}`);

  const target = Math.min(queue.length, LIMIT);
  console.log(`Sets total: ${Object.keys(sets).length}`);
  console.log(`Already harvested: ${done.size}`);
  if (RECHECK) {
    const shown = queue.filter(sn => setsWithBarcode.has(sn) === false && done.has(sn)).length;
    console.log(`Rechecking blanks: ${shown} of ${missing.length} still-blank sets` +
      (SINCE ? ` (from ${SINCE} onward)` : ''));
  } else if (SINCE) {
    console.log(`Restricted to sets from ${SINCE} onward`);
  }
  if (PRICES) {
    console.log(`Detail backfill: ${needDetails.length} sets never read for RRP or dates`);
  }
  console.log(`New sets queued: ${fresh.filter(sn => !SINCE || (sets[sn][1] || 0) >= SINCE).length}`);
  console.log(`This run: ${target}`);
  console.log(`Barcodes known: ${Object.keys(barcodes).length}`);
  console.log(`Prices known: ${Object.keys(prices).length}`);
  console.log(`Dates known: ${Object.keys(dates).length}`);
  console.log(`Market values known: ${Object.keys(values).length}`);
  if (!target) { console.log('\nNothing left to harvest.'); return; }
  console.log(`Estimated time at ${MIN_DELAY / 1000}s/set: ${fmtDuration(target * MIN_DELAY)}`);
  if (DRY_RUN) { console.log('\n--dry-run: queue sized, nothing fetched.'); return; }
  console.log('');

  let delay = MIN_DELAY;
  let streak = 0, processed = 0;
  let stopping = false;
  const started = Date.now();
  /* state.stats is a lifetime tally across every run ever; these are scoped to
     this run, which is what you actually want to read at the end of one. */
  const run = { found: 0, none: 0, failed: 0, filled: 0, priced: 0, dated: 0, valued: 0 };
  const today = new Date().toISOString().slice(0, 10);

  const save = () => {
    state.done = [...done];
    state.detailsDone = [...detailsSeen];
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(BARCODES_FILE, JSON.stringify(barcodes));
    fs.writeFileSync(PRICES_FILE, JSON.stringify(prices));
    fs.writeFileSync(DATES_FILE, JSON.stringify(dates));
    fs.writeFileSync(VALUES_FILE, JSON.stringify(values));
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  };

  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nStopping — saving checkpoint (Ctrl+C again to force)…');
  });

  for (const setNum of queue.slice(0, target)) {
    if (stopping) break;

    let html = null, status = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const r = await fetch(`https://brickset.com/sets/${encodeURIComponent(setNum)}`, {
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
        });
        status = r.status;
        if (r.status === 429) {
          delay = Math.min(Math.round(delay * 1.5), MAX_DELAY);
          streak = 0;
          const penalty = delay * 3;
          console.log(`  429 — slowing to ${delay}ms, pausing ${Math.round(penalty / 1000)}s`);
          await sleep(penalty);
          continue;
        }
        /* 404 = no such set. 400 = the set number isn't one Brickset accepts at
           all, which is what Rebrickable's own bookkeeping entries hit
           ("Build-a-Mini-2024", "DATABASE-2001"). Both are permanent answers —
           retrying either just loops forever. */
        if (r.status === 404 || r.status === 400) break;
        if (!r.ok) { await sleep(delay); continue; }
        html = await r.text();
        break;
      } catch (e) {
        console.log(`  ${setNum} network error (${e.message}) — retrying`);
        await sleep(delay * 2);
      }
    }

    processed++;
    if (html) {
      const flat = flatten(html);

      /* Always read the RRP off a page we've fetched anyway — even on a plain
         barcode run. The page is already in hand; not parsing it would mean
         another 12-hour crawl later to get it. */
      const rrp = extractPrices(flat);
      if (rrp) { prices[setNum] = [rrp.usd, rrp.gbp, rrp.eur]; run.priced++; }

      /* Launch/exit dates come off the same page. The exit date is what the
         app reports as the retirement date. */
      const worth = extractValues(flat);
      if (worth) { values[setNum] = [worth.new, worth.used, today]; run.valued++; }

      const when = extractDates(flat);
      if (when) { dates[setNum] = [when.launched, when.retired]; if (when.retired) run.dated++; }

      detailsSeen.add(setNum);

      const { ean, upc } = extractBarcodes(flat);
      const wasBlank = !setsWithBarcode.has(setNum);
      if (ean) barcodes[ean] = setNum;
      if (upc) barcodes[upc] = setNum;
      if (ean || upc) {
        state.stats.found++;
        run.found++;
        setsWithBarcode.add(setNum);
        // a blank that finally filled in — the reason --recheck-missing exists
        if (wasBlank && done.has(setNum)) run.filled++;
      } else {
        state.stats.none++;
        run.none++;
      }
      done.add(setNum);
      streak++;
      /* Ease back toward the floor once the site is clearly happy. */
      if (streak >= 40 && delay > MIN_DELAY) {
        delay = Math.max(MIN_DELAY, Math.round(delay * 0.85));
        streak = 0;
      }
    } else if (status === 404 || status === 400) {
      state.stats.none++;
      run.none++;
      done.add(setNum);
    } else {
      state.stats.failed++;                    // leave undone so a rerun retries it
      run.failed++;
    }

    if (processed % SAVE_EVERY === 0) {
      save();
      const rate = (Date.now() - started) / processed;
      const left = target - processed;
      const pct = ((processed / target) * 100).toFixed(1);
      console.log(
        `[${pct}%] ${processed}/${target} · barcodes ${Object.keys(barcodes).length} · ` +
        `found ${run.found} none ${run.none} failed ${run.failed}` +
        (RECHECK ? ` filled ${run.filled}` : '') +
        ` · prices ${Object.keys(prices).length}` +
        ` · ${delay}ms · ETA ${fmtDuration(left * rate)}`
      );
    }

    await sleep(delay);
  }

  save();
  /* Coverage is counted from the table itself, not from the lifetime tallies —
     those double-count any set a recheck run visited more than once. */
  const covered = setsWithBarcode.size;
  console.log(`\nDone this run: ${processed} sets in ${fmtDuration(Date.now() - started)}`);
  console.log(`  found ${run.found} · none ${run.none} · failed ${run.failed}` +
    (RECHECK ? ` · newly filled ${run.filled}` : ''));
  console.log(`Barcodes in table: ${Object.keys(barcodes).length}`);
  console.log(`Coverage: ${covered}/${done.size} checked sets have a barcode` +
    (done.size ? ` (${((covered / done.size) * 100).toFixed(1)}%)` : ''));
  /* Can go negative: the resume list keeps sets that Rebrickable has since
     delisted, so "done" can exceed the current catalogue. Nothing is wrong,
     but a negative count reads like a bug. */
  const remaining = Math.max(0, Object.keys(sets).length - done.size);
  console.log(`Remaining unchecked: ${remaining}`);
  if (remaining) console.log('Rerun the same command to continue.');
  else if (!RECHECK) {
    const blanks = done.size - covered;
    console.log(`\n${blanks} checked sets still have no barcode. Brickset's data grows over`);
    console.log('time, so to go back for them later:');
    console.log('  node tools/harvest-barcodes.js --recheck-missing --since 2000');
  }
})().catch(e => { console.error('harvest failed:', e.message); process.exit(1); });
