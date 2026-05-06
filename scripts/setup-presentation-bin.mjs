#!/usr/bin/env node
/* ============================================================================
 * One-time setup: create the JSONBin that holds shared Presentation state
 * (custom decks + per-slide overlays + per-slide backgrounds), then print
 * the BIN_ID to paste into the Netlify env var JSONBIN_PRESENTATION_BIN.
 *
 * Usage:
 *   JSONBIN_MASTER_KEY=<your-key> node scripts/setup-presentation-bin.mjs
 *
 * Idempotent flag — refuses to run if JSONBIN_PRESENTATION_BIN is already set
 * unless you pass --force (which orphans the existing bin).
 *
 * The bin starts with the empty-state shape so the function never sees
 * a missing record:
 *   { customDecks: [], overlays: {}, slideBgs: {} }
 *
 * Requires Node 18+ (built-in fetch).
 * ========================================================================== */

const EMPTY_STATE = { customDecks: [], overlays: {}, slideBgs: {} };

const MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const FORCE      = process.argv.includes('--force');

if (!MASTER_KEY) {
  console.error('ERROR: JSONBIN_MASTER_KEY env var is required.');
  console.error('       Run with:  JSONBIN_MASTER_KEY=<key> node scripts/setup-presentation-bin.mjs');
  process.exit(1);
}

if (process.env.JSONBIN_PRESENTATION_BIN && !FORCE) {
  console.error('ERROR: JSONBIN_PRESENTATION_BIN is already set.');
  console.error('       Re-running would create a fresh bin and orphan all existing decks/overlays.');
  console.error('       Pass --force only if that is what you want.');
  process.exit(1);
}

process.stdout.write('Creating presentation bin … ');
try {
  const res = await fetch('https://api.jsonbin.io/v3/b', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': MASTER_KEY,
      'X-Bin-Name': 'ppa-presentation',
      'X-Bin-Private': 'true',
    },
    body: JSON.stringify(EMPTY_STATE),
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
  console.log('  JSONBIN_PRESENTATION_BIN   = ' + id);
  console.log('  PRESENTATION_WRITE_SECRET  = <a random string of your choice>');
  console.log('\nThe PRESENTATION_WRITE_SECRET must also match the constant');
  console.log('PRES_WRITE_TOKEN in tools/presentation.html — that\'s how the');
  console.log('page authenticates PUT calls. Pick something long and random,');
  console.log('and update both sides whenever you rotate it.');
  console.log('──────────────────────────────────────────────────────────────────\n');
} catch (e) {
  console.log(`FAILED: ${e.message || e}`);
  process.exit(2);
}
