// =============================================================================
// backfill-cot-captures.mjs — write the Demand Score Dashboard's Cotality-basis
// history straight FROM the Runway v Demand V3 timeline.
//
// WHY THIS RATHER THAN RECOMPUTING
// --------------------------------
// The dashboard scores a month live from whatever inputs it can reach in the
// browser; V3 is built offline from the Cotality exports. Making the two agree
// by aligning every input turned out to mean chasing vintages one at a time
// (the rent window, then days on market), and each fix moved the numbers again.
// Van, 2026-09-18: the numbers are already decided — they are the ones on the
// chart — so the history is COPIED from V3 rather than re-derived.
//
// That makes the two tools agree by construction. There is no arithmetic here
// that could drift: each capture's demand score and runway ARE the timeline's.
//
// WHAT EACH CAPTURE CARRIES
// -------------------------
//   ds, rw          from V3 (rw converted back to the fraction captures store)
//   pop, listings,
//   median          from that month's existing SQM capture — all three are
//                   basis-independent, so the month's own record is the right
//                   source and keeps the two bases comparable on the things
//                   that do not depend on the vacancy series.
//
// Deliberately NOT carried for these months: dom, the raw vacancy, the rents
// and the supply-rule stamp. Those exist so the compare view can explain a move
// input by input, and the dashboard already says so honestly when they are
// absent rather than guessing. Van only wants the notes on Aug->Sep 2026, and
// August already has a full capture written by make-cot-capture.mjs.
//
// Dry-run by DEFAULT; --write upserts. August is SKIPPED unless --redo-august,
// because the full capture there is worth more than this thinner one.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const WRITE = process.argv.includes('--write');
const REDO_AUG = process.argv.includes('--redo-august');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const verOf = label => { const m = String(label).match(/^([A-Za-z]{3})\s+(\d{4})$/); if (!m) return null;
  const i = MON.indexOf(m[1]); return i < 0 ? null : m[2] + '-' + String(i + 1).padStart(2, '0'); };

const { data: v3row } = await sb.from('forge_cotality').select('data').eq('id', 'rvd_v3').maybeSingle();
if (!v3row) { console.error('no rvd_v3 timeline to copy from'); process.exit(1); }
const months = v3row.data.months || [];

const { data: regions } = await sb.from('rdp_regions').select('slug,name');
const SLUG = {}; for (const r of regions || []) SLUG[r.name] = r.slug;
const canon = s => String(s).toLowerCase().replace(/[^a-z]/g, '').replace(/^greater/, '');
const SLUG_C = {}; for (const r of regions || []) SLUG_C[canon(r.name)] = r.slug;

const { data: snaps } = await sb.from('forge_demand_snapshots').select('version,data').like('version', '20%');
const SNAP = {}; for (const s of snaps || []) SNAP[s.version] = s.data;

let wrote = 0, skipped = 0;
const rwMismatch = [];
for (const m of months) {
  const ver = verOf(m.label);
  if (!ver) { console.log('  ' + m.label + ' — unparseable label, skipped'); continue; }
  if (ver === '2026-08' && !REDO_AUG) { console.log('  ' + m.label + ' — already has the FULL capture (make-cot-capture.mjs); left alone'); skipped++; continue; }
  const base = SNAP[ver];                       /* that month's SQM capture, for the basis-independent fields */
  const out = { houses: {}, units: {} };
  let n = 0, noBase = 0;
  for (const [grp, key] of [['houses', 'houses'], ['units', 'units']]) {
    for (const r of m[grp] || []) {
      const slug = SLUG[r.city] || SLUG_C[canon(r.city)];
      if (!slug) continue;
      const b = base ? (base[key] || {})[slug] : null;
      if (!b) noBase++;
      /* V3 stores runway as a percent (22.95); a capture stores the fraction
         (0.2295). Convert, and check against the month's own SQM capture --
         runway is basis-independent, so the two MUST agree. */
      const rw = r.rw != null ? r.rw / 100 : (b ? b.rw : null);
      if (b && b.rw != null && r.rw != null && Math.abs(b.rw - r.rw / 100) > 0.0002) {
        rwMismatch.push(ver + ' ' + grp + '/' + slug + ': capture ' + b.rw + ' vs V3 ' + (r.rw / 100).toFixed(4));
      }
      out[grp][slug] = {
        ds: r.ds, rw,
        pop: b ? b.pop : null, listings: b ? b.listings : null, median: b ? b.median : null,
        basis: 'cotality',
      };
      n++;
    }
  }
  console.log('  ' + m.label.padEnd(10) + '-> cot-' + ver + '   ' + n + ' markets'
    + (base ? '' : '   (no SQM capture for this month — pop/listings/median left null)')
    + (noBase && base ? '   (' + noBase + ' markets absent from the SQM capture)' : ''));
  if (!WRITE) { wrote++; continue; }
  const { error } = await sb.from('forge_demand_snapshots').upsert({
    version: 'cot-' + ver, label: m.label, data: { houses: out.houses, units: out.units, basis: 'cotality' },
    captured_at: new Date().toISOString(), captured_by: 'backfill-cot-captures.mjs (copied from rvd_v3)',
  }, { onConflict: 'version' });
  if (error) { console.error('write failed for cot-' + ver + ': ' + error.message); process.exit(1); }
  wrote++;
}

if (rwMismatch.length) {
  console.log('\nRUNWAY DISAGREES with the month’s own capture on ' + rwMismatch.length + ' market-months — runway is basis-independent, so this should be empty:');
  rwMismatch.slice(0, 8).forEach(x => console.log('   ' + x));
}
console.log('\n' + (WRITE ? 'wrote ' : 'would write ') + wrote + ' captures   skipped ' + skipped);
if (!WRITE) console.log('Dry run. Re-run with --write to store.');
