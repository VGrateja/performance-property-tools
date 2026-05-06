#!/usr/bin/env node
/* ============================================================================
 * One-time setup: create the JSONBin that holds shared Documents state
 * (the folder/card library), then print the BIN_ID to paste into the Netlify
 * env var JSONBIN_DOCUMENTS_BIN.
 *
 * Usage:
 *   JSONBIN_MASTER_KEY=<your-key> node scripts/setup-documents-bin.mjs
 *
 * Idempotent flag — refuses to run if JSONBIN_DOCUMENTS_BIN is already set
 * unless you pass --force (which orphans the existing bin).
 *
 * The bin starts with an empty sections array. The page treats a bin
 * with no `lastEdited` marker as "fresh / seed only" and never lets it
 * overwrite an admin's local edits — so seeding default folders here
 * would cause the page to clobber real local content on first load.
 * The page falls back to in-memory WS_DEFAULTS when the bin is empty,
 * so users still see the canonical four folders before any admin has
 * touched the cloud.
 *
 * Requires Node 18+ (built-in fetch).
 * ========================================================================== */

const SEED_STATE = { sections: [] };

const MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const FORCE      = process.argv.includes('--force');

if (!MASTER_KEY) {
  console.error('ERROR: JSONBIN_MASTER_KEY env var is required.');
  console.error('       Run with:  JSONBIN_MASTER_KEY=<key> node scripts/setup-documents-bin.mjs');
  process.exit(1);
}

if (process.env.JSONBIN_DOCUMENTS_BIN && !FORCE) {
  console.error('ERROR: JSONBIN_DOCUMENTS_BIN is already set.');
  console.error('       Re-running would create a fresh bin and orphan the existing library.');
  console.error('       Pass --force only if that is what you want.');
  process.exit(1);
}

process.stdout.write('Creating documents bin … ');
try {
  const res = await fetch('https://api.jsonbin.io/v3/b', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': MASTER_KEY,
      'X-Bin-Name': 'ppa-documents',
      'X-Bin-Private': 'true',
    },
    body: JSON.stringify(SEED_STATE),
  });
  const data = await res.json();
  if (!res.ok || !data.metadata || !data.metadata.id) {
    console.log(`FAILED (${res.status}): ${JSON.stringify(data)}`);
    process.exit(2);
  }
  const id = data.metadata.id;
  console.log(id);
  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log('Paste these into Netlify → Site settings → Environment variables:');
  console.log('──────────────────────────────────────────────────────────────────\n');
  console.log('  JSONBIN_DOCUMENTS_BIN    = ' + id);
  console.log('  DOCUMENTS_WRITE_SECRET   = <a random string of your choice>');
  console.log('\nThe DOCUMENTS_WRITE_SECRET must also match the constant');
  console.log('WS_WRITE_TOKEN in tools/whitepapers-strategies.html — that\'s');
  console.log('how the page authenticates PUT calls. Pick something long and');
  console.log('random, and update both sides whenever you rotate it.');
  console.log('──────────────────────────────────────────────────────────────────\n');
} catch (e) {
  console.log(`FAILED: ${e.message || e}`);
  process.exit(2);
}
