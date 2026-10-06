// =============================================================================
// scripts/sold-check/_env.mjs — shared setup for the Sold Check scripts.
// Reads the repo's .env IN-PROCESS (never printed, never passed on): the
// service role is needed because the scheduled checker runs without a hub
// sign-in. Exports the admin client, the repo root and a tiny arg parser.
// =============================================================================
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = resolve(ROOT, '.env');
if (existsSync(envFile)) {
  for (const ln of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY is missing from .env'); process.exit(1); }
export const admin = createClient(URL, KEY, { auth: { persistSession: false } });

/* --key=value and --flag; everything else is positional */
export function parseArgs(argv) {
  const opts = {}, pos = [];
  for (const a of argv) {
    const m = a.match(/^--([a-z0-9-]+)(?:=(.*))?$/i);
    if (m) opts[m[1]] = m[2] === undefined ? true : m[2]; else pos.push(a);
  }
  return { opts, pos };
}

/* page through a select (PostgREST caps a response at 1000 rows) */
export async function fetchAll(table, cols, apply) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from(table).select(cols).order('id').range(from, from + 999);
    if (apply) q = apply(q);
    const { data, error } = await q;
    if (error) throw new Error(table + ': ' + error.message);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
