// =============================================================================
// seed-all-regions.mjs
//
// Bulk-seed every "Suburb Selection - <Region>, <STATE>[ (Houses|Units)].xlsx" in a
// folder into region_dashboard_reference. Derives each region's slug + property type
// from the filename, reuses extractReference() from seed-region-dashboard.mjs, and
// prints a per-region summary with sanity flags (0 LGAs/suburbs/price, LGAs>suburbs).
//
// Usage:  node scripts/seed-all-regions.mjs ["<downloads-dir>"]
//   (defaults to ~/Downloads; reads the service-role key from .env)
// =============================================================================
import { extractReference } from './seed-region-dashboard.mjs';   // .env loads on import
import { createClient } from '@supabase/supabase-js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dir = process.argv[2] || join(homedir(), 'Downloads');
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY — put it in a local .env file (repo root).'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });

const STATE = /^(act|nsw|nt|qld|sa|tas|vic|wa)$/i;
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const files = readdirSync(dir).filter(f => /^Suburb Selection - .+\.xlsx$/i.test(f) && !f.startsWith('~$')).sort();
console.log(`Found ${files.length} workbooks in ${dir}\n`);

const summary = [];
for (const f of files) {
  const labelFull = f.replace(/^Suburb Selection - /i, '').replace(/\.xlsx$/i, '');   // "Sydney, NSW (Units)"
  const tMatch = labelFull.match(/\((house|unit)s?\)/i);
  const propertyType = tMatch && /unit/i.test(tMatch[1]) ? 'U' : 'H';
  const typeWord = tMatch ? (propertyType === 'U' ? 'units' : 'houses') : '';
  const core = labelFull.replace(/\s*\((?:house|unit)s?\)\s*/i, '').trim();           // "Sydney, NSW"
  const ci = core.lastIndexOf(',');
  const name = (ci >= 0 ? core.slice(0, ci) : core).trim();
  const state = (ci >= 0 ? core.slice(ci + 1) : '').trim();
  if (!STATE.test(state)) { console.log(`SKIP  ${f}  — cannot parse a state from the name`); summary.push({ slug: '(skipped)', label: labelFull, warn: 'no state' }); continue; }
  const slug = [slugify(name), typeWord, state.toLowerCase()].filter(Boolean).join('-');
  try {
    const reference = extractReference(join(dir, f));
    reference.propertyType = propertyType;
    const L = reference.selection.lgas.length, S = reference.selection.suburbs.length, P = reference.price.length;
    const warns = [];
    if (!L) warns.push('0 LGAs'); if (!S) warns.push('0 suburbs'); if (!P) warns.push('0 price rows'); if (L > S) warns.push('LGAs>suburbs?');
    const { error } = await sb.from('region_dashboard_reference').upsert({ region: slug, label: labelFull, reference, updated_at: new Date().toISOString() }, { onConflict: 'region' });
    if (error) { console.log(`FAIL  ${slug}: ${error.message}`); summary.push({ slug, label: labelFull, warn: 'upsert: ' + error.message }); continue; }
    console.log(`✓ ${slug.padEnd(28)} ${propertyType}  ${String(L).padStart(3)} LGA  ${String(S).padStart(4)} sub  ${String(P).padStart(6)} px${warns.length ? '   ⚠ ' + warns.join(', ') : ''}`);
    summary.push({ slug, label: labelFull, type: propertyType, L, S, P, warn: warns.join(', ') });
  } catch (e) { console.log(`ERROR ${slug}: ${e.message}`); summary.push({ slug, label: labelFull, warn: e.message }); }
}

const ok = summary.filter(s => !s.warn).length;
console.log(`\nSeeded ${ok}/${files.length}.`);
const flagged = summary.filter(s => s.warn);
if (flagged.length) { console.log('FLAGGED (review these):'); for (const s of flagged) console.log(`  ${s.slug} (${s.label}): ${s.warn}`); }
