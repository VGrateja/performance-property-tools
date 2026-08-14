// =============================================================================
// seed-vr-workforce.mjs — move the infrastructure workforce figures OUT of the
// public repo and into public.vr_workforce (migration 100).
//
// Deliberately holds NO NUMBERS. It reads the values that build-vr-demand.mjs
// already wrote into rdp_vr_forecast.payload.demand.v1 (wf1/wf2) and copies
// them into the new table. That keeps the figures behind auth end to end —
// they never pass through a file in this repository.
//
// One-time migration. After this, the quarterly update is an edit to
// public.vr_workforce, not a code change and not a deploy.
//
// Usage:
//   node scripts/seed-vr-workforce.mjs                    # dry run
//   node scripts/seed-vr-workforce.mjs --write            # upsert
//   node scripts/seed-vr-workforce.mjs --write --reviewed="November 2026"
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}
const WRITE = process.argv.includes('--write');
const REVIEWED = (process.argv.find(a => a.startsWith('--reviewed=')) || '--reviewed=August 2026').split('=').slice(1).join('=');

const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co', KEY, { auth: { persistSession: false } });

const { data, error } = await sb.from('rdp_vr_forecast').select('region_slug,payload');
if (error) { console.error('read failed:', error.message); process.exit(1); }

const rows = [];
for (const r of data || []) {
  const d = r.payload && r.payload.demand;
  // Read V2, not V1. V1 repeats year 1 wholesale (its wf2 is deliberately set
  // equal to wf1), so only V2 preserves the true year-2 workforce figure.
  const src = (d && d.v2) || (d && d.v1);
  if (!src || !src.wf1) continue;                     // only markets that carry a workforce
  rows.push({ region_slug: r.region_slug, y1: +src.wf1, y2: +src.wf2, reviewed: REVIEWED });
}
rows.sort((a, b) => a.region_slug.localeCompare(b.region_slug));

if (!rows.length) {
  console.error('No workforce figures found in rdp_vr_forecast.payload.demand.v1 — run build-vr-demand.mjs --write first.');
  process.exit(1);
}

console.log(`Infrastructure workforce → public.vr_workforce (reviewed "${REVIEWED}")\n`);
console.log('market            year 1     year 2');
for (const r of rows) console.log('  ' + r.region_slug.padEnd(16) + String(r.y1).padStart(10) + String(r.y2).padStart(11));
console.log(`\n${rows.length} markets.`);

// Does the destination exist yet?
const probe = await sb.from('vr_workforce').select('region_slug').limit(1);
if (probe.error) {
  console.error(`\n✗ public.vr_workforce is not reachable: ${probe.error.message}`);
  console.error('  Apply supabase/migrations/100_vr_workforce.sql first.');
  process.exit(1);
}

if (!WRITE) { console.log('\nDry run. Re-run with --write to upsert.'); process.exit(0); }

const { error: wErr } = await sb.from('vr_workforce').upsert(rows, { onConflict: 'region_slug' });
if (wErr) { console.error('\nwrite failed:', wErr.message); process.exit(1); }
console.log(`\n✓ Upserted ${rows.length} markets into public.vr_workforce.`);
console.log('  shared/vr-workforce.js will now read from the table instead of the payload fallback.');
