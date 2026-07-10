// =============================================================================
// scripts/refresh-report-cache.mjs
//
// ⚠ DEPRECATED / LEGACY — Apps-Script-sourced. Since the Forge cutover the
// snapshots are refreshed FROM FORGE by scripts/refresh-snapshots-from-forge.mjs
// (run in the PUBLISH workflow) and by the reports' "⤓ Save data" buttons.
// Running THIS script overwrites those Forge-built snapshots with Google
// Apps Script data — an emergency fallback only, not the monthly routine.
//
// Legacy behaviour: refresh of the report-data snapshot cache (table
// report_data_cache, migration 040). Its workflow
// (.github/workflows/refresh-report-cache.yml) has its cron disabled and is
// gated behind a typed confirmation; manual run:
// `node scripts/refresh-report-cache.mjs`.
//
// For each feed (the four regional clusters + national + commercial):
//   1. Fetch the Apps Script feed JSON (the slow cold-start path).
//   2. Upsert it into report_data_cache using the SERVICE-ROLE key
//      (server-side, bypasses RLS — never ships to the browser).
// Sequential with one retry: firing all six at Google in parallel makes
// Apps Script queue them and the heavy feeds (qld/nsw) time out.
//
// This is the unattended twin of shared/report-cache.js updateAllSnapshots —
// itself deprecated + guarded for the same reason.
//
// Required env vars (GitHub Secrets, already present for the PDF renderer):
//   SUPABASE_URL                https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   service-role key (server-side write)
//
// Local quickstart:
//   set -a && source .env && set +a
//   node scripts/refresh-report-cache.mjs
// =============================================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}

const TABLE = 'report_data_cache';

/* Every report feed, keyed by its snapshot `source`.
   KEEP IN SYNC with shared/report-cache.js (FEEDS) and the per-report page
   code (online-reports.html REPORTS_DATA_URLS; national/commercial
   REPORT_DATA_URL) if a feed URL ever changes. */
const FEEDS = {
  capital:    'https://script.google.com/macros/s/AKfycbwCpEAXvYXh0Jrm46DfgaIA-iDM5dsF0XKK9z55JNALbkoM-OqyKm8DAyAeNanTYC_N/exec',
  qld:        'https://script.google.com/macros/s/AKfycbwEkGUCmJL1svxkxoiiKFeGvn7OVA0PNSsRAtB7wEESdmKmwpKqrsFuKoz9ASL_3DE/exec',
  nsw:        'https://script.google.com/macros/s/AKfycbzWkMzOZWBK-jYT2tqE3XvECux_-eYbYU-d_cY3s6nDDOEFcmLSmqznLOCjiqf_BF4/exec',
  vicwatas:   'https://script.google.com/macros/s/AKfycbzEZzKiKojm1sh-ABhiUTwPxmLBsPHk4rCY6u7NQw9W94GUONJq9ffqaPYVrDEgu7uG/exec',
  national:   'https://script.google.com/macros/s/AKfycbxTYz5pzmKvpHLwYLLjJo68prVjQWNYA5WXc-iR8QQZiho-kez-M_i0Ci1vXLGSxnmsGQ/exec',
  commercial: 'https://script.google.com/macros/s/AKfycbzToEKHw7bxEBNgxnPNC5hn70p2H18Extzxq_e1DMgGTXQi72sPN_2U0ahn9JB-Nco/exec',
};

const FETCH_TIMEOUT_MS = 60000;   // heavy feeds (qld/nsw) can be slow to assemble
const MAX_ATTEMPTS     = 2;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function fetchFeed(source) {
  const url = FEEDS[source];
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(to); }
}

async function refreshOne(source) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const data = await fetchFeed(source);
      if (!data) throw new Error('empty feed');
      const { error } = await sb.from(TABLE).upsert(
        { source, data, updated_at: new Date().toISOString() },
        { onConflict: 'source' }
      );
      if (error) throw new Error(error.message || JSON.stringify(error));
      return;
    } catch (e) {
      lastErr = e;
      const reason = (e && e.name === 'AbortError') ? 'timed out' : (e && e.message) || String(e);
      console.warn(`[refresh] ${source} attempt ${attempt}/${MAX_ATTEMPTS} failed: ${reason}`);
    }
  }
  throw lastErr;
}

const sources = Object.keys(FEEDS);
const ok = [], failed = [];
for (const source of sources) {           // sequential — avoid Apps Script queueing
  try {
    await refreshOne(source);
    ok.push(source);
    console.log(`[refresh] ${source} OK`);
  } catch (e) {
    failed.push(source);
    console.error(`[refresh] ${source} FAILED: ${(e && e.message) || e}`);
  }
}

console.log(`\nRefreshed ${ok.length}/${sources.length} feeds: ${ok.join(', ') || '(none)'}`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);    // surface the failure in the Actions run
}
console.log('All report snapshots refreshed.');
