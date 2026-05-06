#!/usr/bin/env node
/* ============================================================================
 * One-time setup: create 35 JSONBin bins (one per region) for Online Reports
 * server-side state, then print the slug → binId map ready to paste into the
 * Netlify env var JSONBIN_REPORTS_BINS.
 *
 * Usage:
 *   JSONBIN_MASTER_KEY=<your-key> node scripts/setup-reports-bins.mjs
 *
 * Idempotent flag — running again WITH `--force` re-creates bins (you'd lose
 * any existing state). Without --force, the script refuses if it sees an
 * existing JSONBIN_REPORTS_BINS env var to avoid accidental wipes.
 *
 * Each bin starts with the empty-state shape so the client always has
 * something to read on first load:
 *   { texts: [], shapes: [], images: [], pageBgs: {}, pageOrder: [],
 *     customPages: [], pageLabels: {}, bands: [] }
 *
 * Requires Node 18+ (built-in fetch).
 * ========================================================================== */

const REGION_SLUGS = [
  // Capital Cities
  'sydney', 'melbourne', 'brisbane', 'adelaide', 'perth', 'hobart', 'canberra', 'darwin',
  // QLD Regions
  'mackay', 'bundaberg', 'ipswich', 'rockhampton', 'gladstone', 'cairns', 'townsville',
  'sunshine-coast', 'toowoomba', 'gold-coast',
  // NSW Regions
  'albury', 'central-coast', 'coffs-harbour', 'orange', 'port-macquarie', 'newcastle',
  'tamworth', 'wagga-wagga', 'wollongong',
  // VIC / WA / TAS Regions
  'ballarat', 'bendigo', 'geelong', 'wodonga', 'mildura', 'rockingham', 'bunbury', 'launceston',
];

const EMPTY_STATE = {
  texts: [],
  shapes: [],
  images: [],
  pageBgs: {},
  pageOrder: [],
  customPages: [],
  pageLabels: {},
  bands: [],
};

const MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const FORCE = process.argv.includes('--force');

if (!MASTER_KEY) {
  console.error('ERROR: JSONBIN_MASTER_KEY env var is required.');
  console.error('       Run with:  JSONBIN_MASTER_KEY=<key> node scripts/setup-reports-bins.mjs');
  process.exit(1);
}

if (process.env.JSONBIN_REPORTS_BINS && !FORCE) {
  console.error('ERROR: JSONBIN_REPORTS_BINS is already set. Re-running would create new bins.');
  console.error('       Pass --force to acknowledge you want fresh bins (existing state will be orphaned).');
  process.exit(1);
}

const result = {};
let created = 0;
let failed = 0;

for (const slug of REGION_SLUGS) {
  process.stdout.write(`Creating bin for ${slug.padEnd(18)} … `);
  try {
    const res = await fetch('https://api.jsonbin.io/v3/b', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': MASTER_KEY,
        'X-Bin-Name': 'ppa-reports-' + slug,
        'X-Bin-Private': 'true',
      },
      body: JSON.stringify(EMPTY_STATE),
    });
    const data = await res.json();
    if (!res.ok || !data.metadata || !data.metadata.id) {
      console.log(`FAILED (${res.status}): ${JSON.stringify(data)}`);
      failed++;
      continue;
    }
    result[slug] = data.metadata.id;
    console.log(data.metadata.id);
    created++;
  } catch (e) {
    console.log(`FAILED: ${e.message || e}`);
    failed++;
  }
}

console.log(`\nDone. Created ${created}, failed ${failed} of ${REGION_SLUGS.length} regions.`);

if (Object.keys(result).length) {
  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log('Paste this single line into Netlify → Site settings → Environment');
  console.log('variables → JSONBIN_REPORTS_BINS:');
  console.log('──────────────────────────────────────────────────────────────────\n');
  console.log(JSON.stringify(result));
  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log('Also set REPORTS_WRITE_SECRET to a random string of your choice');
  console.log('(must match the REPORTS_WRITE_TOKEN constant in online-reports.html).');
  console.log('──────────────────────────────────────────────────────────────────');
}

if (failed) process.exit(2);
