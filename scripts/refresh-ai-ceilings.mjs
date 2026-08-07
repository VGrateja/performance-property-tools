/* =============================================================================
   Refresh the Runway Workbook's AI-ceiling peak snapshot.

   tools/runway-workbook.html embeds `const AI_CEILINGS = {…}` — the peak bases
   behind the "Ultimate peak / 2-peak avg / 3-peak avg" selector. They are a
   SNAPSHOT of the "AI - Summary" sheet in the AI Ceiling workbook, which is a
   local file, so they cannot refresh themselves.

   WHY THIS ISN'T FULLY AUTOMATIC: the peaks are computed over the workbook's
   per-year AI history sheets, and that history is NOT in Forge — the mart holds
   only the single current ceiling (rdp_runway.payload.ai_ceiling {h,u}). Making
   the refresh automatic would mean ingesting the AI history as a Forge data
   point first; until then this script turns the annual job into one command.

   The "currently used" basis is untouched by all this — the tool reads that
   live from the mart.

     node scripts/refresh-ai-ceilings.mjs                    # compare only
     node scripts/refresh-ai-ceilings.mjs --write            # rewrite the const
     node scripts/refresh-ai-ceilings.mjs --xlsx="C:/path/to/AI Ceiling.xlsx"
   ============================================================================= */
import XLSX from 'xlsx';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const arg = n => { const a = process.argv.find(x => x.startsWith('--' + n + '=')); return a ? a.split('=').slice(1).join('=') : null; };
const WRITE = process.argv.includes('--write');
const XLSX_PATH = arg('xlsx') || 'C:/Users/vandolf_performancep/Downloads/AI Ceiling (Average).xlsx';
const TOOL = 'tools/runway-workbook.html';
const SHEET = 'AI - Summary';

if (!existsSync(XLSX_PATH)) { console.error('Workbook not found: ' + XLSX_PATH + '\nPass --xlsx="…" if it lives elsewhere.'); process.exit(1); }

/* Region label -> slug. The tool keys on the lowercased-hyphenated region name,
   which matched all 36 markets when the snapshot was first taken. */
const slugify = s => String(s).trim().toLowerCase()
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const round4 = v => Math.round(Number(v) * 1e4) / 1e4;

const wb = XLSX.readFile(XLSX_PATH, { cellFormula: false });
if (!wb.Sheets[SHEET]) { console.error('Sheet "' + SHEET + '" not found. Sheets: ' + wb.SheetNames.join(', ')); process.exit(1); }
const rows = XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, raw: true });

/* Data rows look like:  ["Adelaide H", 0.53, 0.6073…, 0.5785…, 0.5578…]
   Section headers ("CAPITAL CITIES") and blanks have no numbers — skipped. */
const next = {};
let skippedNoNumbers = 0, badType = 0;
for (const r of rows) {
  const label = String((r && r[0]) || '').trim();
  if (!label) continue;
  const p1 = r[2], p2 = r[3], p3 = r[4];
  if ([p1, p2, p3].some(v => typeof v !== 'number' || !isFinite(v))) { if (label) skippedNoNumbers++; continue; }
  const m = label.match(/^(.*?)\s+([HU])$/i);
  if (!m) { badType++; console.warn('  ? row label without a trailing H/U, skipped: "' + label + '"'); continue; }
  const slug = slugify(m[1]), type = m[2].toLowerCase();
  (next[slug] || (next[slug] = {}))[type] = { p1: round4(p1), p2: round4(p2), p3: round4(p3) };
}
const marketCount = Object.keys(next).length;
console.log('Read "' + SHEET + '": ' + marketCount + ' markets, '
  + Object.values(next).reduce((n, m) => n + Object.keys(m).length, 0) + ' market×type rows'
  + (skippedNoNumbers ? '   (' + skippedNoNumbers + ' non-data rows skipped)' : ''));

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
    for (const k of ['p1', 'p2', 'p3'])
      if (a[k] !== b[k]) changes.push(s + ' ' + t.toUpperCase() + ' ' + k + ': ' + a[k] + ' -> ' + b[k]);
  }
}
console.log('markets embedded: ' + Object.keys(current).length + '   in workbook: ' + marketCount);
if (added.length)   console.log('NEW markets in the workbook: ' + added.join(', '));
if (removed.length) console.log('markets embedded but NOT in the workbook (kept if you do not --write): ' + removed.join(', '));
if (!changes.length && !added.length && !removed.length) {
  console.log('\nNo change — the embedded snapshot already matches the workbook.');
  if (!WRITE) process.exit(0);
} else {
  console.log('\n' + changes.length + ' value change(s):');
  changes.slice(0, 40).forEach(c => console.log('   ' + c));
  if (changes.length > 40) console.log('   … and ' + (changes.length - 40) + ' more');
}

if (!WRITE) { console.log('\nDry run — re-run with --write to update ' + TOOL + '.'); process.exit(0); }
if (marketCount < 30) { console.error('\nRefusing to write: only ' + marketCount + ' markets parsed (expected ~36). Check the sheet layout.'); process.exit(1); }

const out = html.replace(RE, 'const AI_CEILINGS = ' + JSON.stringify(next) + ';');
if (out === html) { console.error('Replacement produced no change — aborting.'); process.exit(1); }
writeFileSync(TOOL, out);
console.log('\n✓ Updated ' + TOOL + '. Reload the Runway Workbook and spot-check one market against the sheet.');
