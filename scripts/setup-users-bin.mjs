#!/usr/bin/env node
/* ============================================================================
 * One-time setup: create the JSONBin that holds registered users for the
 * tier system (Tier 3 client + Tier 4 guest accounts), then print the
 * BIN_ID to paste into the Netlify env var JSONBIN_USERS_BIN_ID.
 *
 * Usage:
 *   JSONBIN_MASTER_KEY=<your-key> node scripts/setup-users-bin.mjs
 *
 * Idempotent flag — refuses to run if JSONBIN_USERS_BIN_ID is already set
 * unless you pass --force (which orphans the existing bin).
 *
 * The bin starts with the empty-state shape so the function never sees
 * a missing record: { users: [] }.
 *
 * Requires Node 18+ (built-in fetch).
 * ========================================================================== */

const EMPTY_STATE = { users: [] };

const MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const FORCE      = process.argv.includes('--force');

if (!MASTER_KEY) {
  console.error('ERROR: JSONBIN_MASTER_KEY env var is required.');
  console.error('       Run with:  JSONBIN_MASTER_KEY=<key> node scripts/setup-users-bin.mjs');
  process.exit(1);
}

if (process.env.JSONBIN_USERS_BIN_ID && !FORCE) {
  console.error('ERROR: JSONBIN_USERS_BIN_ID is already set.');
  console.error('       Re-running would create a fresh bin and orphan all existing users.');
  console.error('       Pass --force only if that is what you want.');
  process.exit(1);
}

process.stdout.write('Creating users bin … ');
try {
  const res = await fetch('https://api.jsonbin.io/v3/b', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': MASTER_KEY,
      'X-Bin-Name': 'ppa-users',
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
  console.log('  JSONBIN_USERS_BIN_ID  = ' + id);
  console.log('  USERS_ADMIN_SECRET    = <a random string of your choice>');
  console.log('\nThe USERS_ADMIN_SECRET must also match USERS_ADMIN_TOKEN in');
  console.log('shared/auth.js — that\'s how the admin UI authenticates approve/');
  console.log('reject calls. Pick something long and random.');
  console.log('──────────────────────────────────────────────────────────────────\n');
} catch (e) {
  console.log(`FAILED: ${e.message || e}`);
  process.exit(2);
}
