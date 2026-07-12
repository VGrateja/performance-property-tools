// =============================================================================
// verify-traffic-lights.mjs — model check for shared/traffic-lights-engine.js.
// Feeds the workbook's OWN per-capital values (baked into traffic-lights.html's
// DATA) back through scoreRegion() and asserts the engine reproduces the
// workbook's signals, conf scores, and the 6 verdicts. Isolates the MODEL from
// live-data drift. No DB, no network.  node scripts/verify-traffic-lights.mjs
// =============================================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
// The engine is a browser classic-script (sets self.PP_TL_ENGINE). Load it into
// a sandbox object so this .mjs can call it without ESM/CJS interop headaches.
const sandbox = {};
new Function('self', readFileSync(join(__dir, '..', 'shared', 'traffic-lights-engine.js'), 'utf8'))(sandbox);
const { scoreRegion } = sandbox.PP_TL_ENGINE;

const html = readFileSync(join(__dir, '..', 'tools', 'traffic-lights.html'), 'utf8');
const m = html.match(/const DATA=(\{[\s\S]*?\});\s*\nconst regions/);
if (!m) { console.error('could not extract DATA from traffic-lights.html'); process.exit(1); }
const DATA = JSON.parse(m[1]);

const pct = s => { if (s == null) return null; s = String(s).trim(); if (s === '--' || s === '') return null; const pp = /pp$/.test(s); const n = parseFloat(s.replace(/[+,%p]/g, '')); return isNaN(n) ? null : n / 100; };
const num = s => { if (s == null) return null; const n = parseFloat(String(s).replace(/[+,%]/g, '')); return isNaN(n) ? null : n; };
const IND = { 'Stock on Market': 'som', 'Average Days on Market': 'adom', 'Retail Turnover': 'retail', 'Business Investment': 'bizinv', 'Job Creation Index': 'jci', 'Lending Flows (OO+INV)': 'lending', 'Mortgage Arrears': 'arrears' };

function buildInput(d) {
  const inp = {};
  for (const ind of d.indicators) {
    const k = IND[ind.name];
    if (k) inp[k] = pct(ind.change);
    else if (ind.name === 'Unemployment') { inp.unemp_level = pct(ind.latest); inp.unemp_change = pct(ind.change); }
    else if (ind.name === 'Cash Rate vs. Inflation') inp.real_cash_rate = pct(ind.latest);
  }
  for (const vi of d.value_inds) {
    if (vi.name === 'Ranking House' || vi.name === 'Ranking Unit') {
      const mm = (vi.meta || '').match(/Rank\s+([\d.]+)\s+vs\s+avg\s+([\d.]+)/i);
      const pj = (vi.sub || '').match(/Projected rank:\s*([\d.]+)/i);
      const pre = vi.name === 'Ranking House' ? 'rank_h' : 'rank_u';
      if (mm) { inp[pre] = +mm[1]; inp[pre + '_avg'] = +mm[2]; }
      if (pj) inp[pre + '_fcst'] = +pj[1];
    } else if (vi.name === 'Runway House' || vi.name === 'Runway Unit') {
      const pre = vi.name === 'Runway House' ? 'runway_h' : 'runway_u';
      inp[pre] = pct(vi.right);
      const pj = (vi.sub || '').match(/Projected:\s*([\d.]+)%/i);
      if (pj) inp[pre + '_fcst'] = +pj[1] / 100;
    }
  }
  for (const si of d.sd_inds) {
    const pre = si.name.includes('House') ? 'ds_h' : 'ds_u';
    inp[pre] = num(si.right);
    const pj = (si.sub || '').match(/Projected:\s*([\d.]+)/i);
    if (pj) inp[pre + '_fcst'] = +pj[1];
  }
  return inp;
}

let pass = 0, fail = 0;
for (const region of Object.keys(DATA)) {
  const d = DATA[region];
  const out = scoreRegion(buildInput(d));
  const problems = [];
  // per-indicator signals
  const byName = {}; out.indicators.forEach((o, i) => { byName[d.indicators[i].name] = o.signal; });
  d.indicators.forEach(ind => { if (byName[ind.name] && byName[ind.name] !== ind.signal) problems.push(`${ind.name}: got ${byName[ind.name]} want ${ind.signal}`); });
  // scores
  if (Math.abs(out.conf_score - d.conf_score) > 0.02) problems.push(`conf_score ${out.conf_score} vs ${d.conf_score}`);
  if (Math.abs(out.conf_fcst_score - d.conf_fcst_score) > 0.02) problems.push(`conf_fcst_score ${out.conf_fcst_score} vs ${d.conf_fcst_score}`);
  // verdicts
  const V = [['sd', 'sd'], ['sd_fcst', 'sd_fcst'], ['value', 'value'], ['value_fcst', 'value_fcst'], ['confidence', 'confidence'], ['conf_fcst', 'conf_fcst']];
  for (const [a, b] of V) if (out[a] !== d[b]) problems.push(`${a}: got ${out[a]} want ${d[b]}`);
  if (problems.length) { fail++; console.log(`✗ ${region}\n    ` + problems.join('\n    ')); }
  else { pass++; console.log(`✓ ${region}  SD ${out.sd}/${out.sd_fcst}  Value ${out.value}/${out.value_fcst}  Conf ${out.confidence}/${out.conf_fcst} (${out.conf_score}→${out.conf_fcst_score})`); }
}
console.log(`\n${pass}/${pass + fail} capitals reproduce the workbook exactly.`);
process.exit(fail ? 1 : 0);
