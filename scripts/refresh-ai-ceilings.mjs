/* =============================================================================
   Refresh the Runway Workbook's AI-ceiling peak snapshot.

   tools/runway-workbook.html embeds `const AI_CEILINGS = {…}` — the peak bases
   behind the "Ultimate peak / 2-peak avg / 3-peak avg" selector. "Currently used"
   is untouched by all this — the tool reads that live from the mart.

   SOURCE (default, 2026-09-14): the HUB's own affordability-index history —
   rdp_report_feed years[].ai_pi_house / ai_pi_unit (annual P&I ÷ annual income,
   1980→), the same definition the AI Ceiling workbook uses. Per market × type, over
   the years BEFORE the current one (Shaene's rule: "excluding the current year"):
     p1 = the highest AI, p2 = mean of the top two, p3 = mean of the top three.
   p3 is exactly what apply-ai-ceilings.mjs --from-hub writes into the live ceiling,
   so after both have run "Currently used" and "3-peak avg" agree.

   LEGACY: --xlsx="<AI Ceiling workbook>" reads the old "AI - Summary" layout
   ("Market H/U" labels with p1/p2/p3 columns). The 2026-09 layout carries only the
   3-peak column, so the hub is now the complete source.

     node scripts/refresh-ai-ceilings.mjs                    # compare only
     node scripts/refresh-ai-ceilings.mjs --write            # rewrite the const
     node scripts/refresh-ai-ceilings.mjs --exclude-from=2027  # next year's refresh
   ============================================================================= */
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const arg = n => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : null; };
const WRITE = process.argv.includes('--write');
const XLSX_PATH = arg('xlsx');
const EXCLUDE_FROM = +(arg('exclude-from') || new Date().getFullYear());   // years < this count
const TOOL = 'tools/runway-workbook.html';

const slugify = s => String(s).trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const round4 = v => Math.round(Number(v) * 1e4) / 1e4;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

const next = {};
let sourceLabel;
if (XLSX_PATH) {
  /* legacy sheet layout: ["Adelaide H", cur, p1, p2, p3] */
  if (!existsSync(XLSX_PATH)) { console.error('Workbook not found: ' + XLSX_PATH); process.exit(1); }
  const wb = XLSX.readFile(XLSX_PATH, { cellFormula: false });
  const SHEET = 'AI - Summary';
  if (!wb.Sheets[SHEET]) { console.error('Sheet "' + SHEET + '" not found. Sheets: ' + wb.SheetNames.join(', ')); process.exit(1); }
  for (const r of XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, raw: true })) {
    const label = String((r && r[0]) || '').trim(); if (!label) continue;
    const p1 = r[2], p2 = r[3], p3 = r[4];
    if ([p1, p2, p3].some(v => typeof v !== 'number' || !isFinite(v))) continue;
    const m = label.match(/^(.*?)\s+([HU])$/i); if (!m) continue;
    (next[slugify(m[1])] ||= {})[m[2].toLowerCase()] = { p1: round4(p1), p2: round4(p2), p3: round4(p3) };
  }
  sourceLabel = 'legacy sheet ' + XLSX_PATH.split(/[\\/]/).pop();
} else {
  const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data: feeds, error } = await sb.from('rdp_report_feed').select('region_slug,payload');
  if (error) { console.error(error.message); process.exit(1); }
  const { data: cfg } = await sb.from('rdp_runway_config').select('key,value').eq('key', 'ai_ceiling').maybeSingle();
  const markets = cfg && cfg.value ? Object.keys(cfg.value) : null;   // the 36 the runway is built for
  for (const f of feeds || []) {
    if (markets && !markets.includes(f.region_slug)) continue;
    for (const [t, key] of [['h', 'ai_pi_house'], ['u', 'ai_pi_unit']]) {
      const vals = ((f.payload && f.payload.years) || []).filter(y => +y.year < EXCLUDE_FROM).map(y => +y[key]).filter(v => isFinite(v) && v > 0).sort((a, b) => b - a);
      if (vals.length < 3) continue;
      (next[f.region_slug] ||= {})[t] = { p1: round4(vals[0]), p2: round4(mean(vals.slice(0, 2))), p3: round4(mean(vals.slice(0, 3))) };
    }
  }
  sourceLabel = `hub feed (rdp_report_feed ai_pi_*), years < ${EXCLUDE_FROM}`;
}
const marketCount = Object.keys(next).length;
console.log(`Source: ${sourceLabel} → ${marketCount} markets, ${Object.values(next).reduce((n, m) => n + Object.keys(m).length, 0)} market×type rows`);

const html = readFileSync(TOOL, 'utf8');
const RE = /const AI_CEILINGS = (\{.*?\});/s;
const found = html.match(RE);
if (!found) { console.error('Could not find `const AI_CEILINGS = {…};` in ' + TOOL); process.exit(1); }
let current; try { current = JSON.parse(found[1]); } catch (e) { console.error('Embedded AI_CEILINGS is not parseable JSON.'); process.exit(1); }

/* ── compare ── */
const slugs = [...new Set([...Object.keys(current), ...Object.keys(next)])].sort();
const changes = [], added = [], removed = [];
for (const s of slugs) {
  if (!next[s]) { removed.push(s); continue; }
  if (!current[s]) { added.push(s); continue; }
  for (const t of ['h', 'u']) {
    const a = (current[s] || {})[t], b = (next[s] || {})[t];
    if (!a && !b) continue;
    if (!a || !b) { changes.push(s + ' ' + t.toUpperCase() + ': ' + (a ? 'removed' : 'added')); continue; }
    for (const k of ['p1', 'p2', 'p3']) if (a[k] !== b[k]) changes.push(s + ' ' + t.toUpperCase() + ' ' + k + ': ' + a[k] + ' -> ' + b[k]);
  }
}
console.log('markets embedded: ' + Object.keys(current).length + '   from source: ' + marketCount);
if (added.length)   console.log('NEW markets: ' + added.join(', '));
if (removed.length) console.log('markets embedded but NOT in the source (kept if you do not --write): ' + removed.join(', '));
if (!changes.length && !added.length && !removed.length) { console.log('\nNo change — the embedded snapshot already matches the source.'); if (!WRITE) process.exit(0); }
else { console.log('\n' + changes.length + ' value change(s):'); changes.slice(0, 30).forEach(c => console.log('   ' + c)); if (changes.length > 30) console.log('   … and ' + (changes.length - 30) + ' more'); }

if (!WRITE) { console.log('\nDry run — re-run with --write to update ' + TOOL + '.'); process.exit(0); }
if (marketCount < 30) { console.error('\nRefusing to write: only ' + marketCount + ' markets (expected ~36).'); process.exit(1); }
const out = html.replace(RE, () => 'const AI_CEILINGS = ' + JSON.stringify(next) + ';');
if (out === html) { console.error('Replacement produced no change — aborting.'); process.exit(1); }
writeFileSync(TOOL, out);
console.log('\n✓ Updated ' + TOOL + ' (' + sourceLabel + '). Reload the Runway Workbook: "3-peak avg" should now equal "Currently used" for every market.');
