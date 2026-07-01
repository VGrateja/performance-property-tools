// =============================================================================
// seed-runway-config.mjs  —  one-time lift of the Runway Workbook's CONFIG into
// the DB (rdp_runway_config), so the runway calc no longer reads the workbook
// and the Google Sheet can be RETIRED.
//
// Extracts: rates (cash / bank margin / APRA buffer -> current & forecast
// variable rate), wage-growth assumptions (regional/capital annual %, years),
// and per-region AI Ceilings (house = Houses IC col F; unit = Units IC col E).
//
// Dry-run by DEFAULT (prints the config); --write upserts (needs migration 052).
// =============================================================================
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

try { if (existsSync('.env')) for (const ln of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch {}

const ST = 'act|nsw|nt|qld|sa|tas|vic|wa';
const SLUGS = new Set(['australia','sydney','melbourne','brisbane','perth','adelaide','canberra','hobart','darwin','mackay','bundaberg','ipswich','rockhampton','gladstone','cairns','townsville','sunshine-coast','toowoomba','gold-coast','albury','central-coast','coffs-harbour','newcastle','orange','port-macquarie','tamworth','wagga-wagga','wollongong','dubbo','ballarat','bendigo','geelong','wodonga','mildura','mandurah','rockingham','bunbury','launceston']);
const resolveCity = l => { if (l == null) return null; let s = String(l).trim(); if (!s) return null; if (/^national$/i.test(s)) return 'australia'; s = s.replace(/\([^)]*\)/g, ' ').replace(new RegExp(',\\s*(' + ST + ')\\b', 'ig'), ' ').replace(/\b\d{3,4}\b/g, ' ').replace(/\bgreater\b/ig, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); if (SLUGS.has(s)) return s; return [...SLUGS].find(g => s.startsWith(g + '-')) || null; };   // prefix fallback: "port-macquarie-hastings"→port-macquarie, "tamworth-regional"→tamworth
const numv = v => (typeof v === 'number' && isFinite(v)) ? v : null;

const FILE = process.argv.slice(2).find(a => !a.startsWith('--')) || join(homedir(), 'Downloads', 'Runway Workbook - Encrypted (updated_ 11Mar2025).xlsx');
const wb = XLSX.readFile(FILE);
const H = wb.Sheets['Houses Runway - IC'], U = wb.Sheets['Units Runway - IC'];
const cv = (ws, a) => numv(ws[a] && ws[a].v);

// rates: current variable = P8 + P9 (variable base + APRA); forecast = R6 + R8 + R9 (cash + margin + APRA)
const rates = {
  current: { cash: cv(H, 'P6'), variable_base: cv(H, 'P8'), apra: cv(H, 'P9'), rate: cv(H, 'P10') },
  forecast: { cash: cv(H, 'R6'), margin: cv(H, 'R8'), apra: cv(H, 'R9'), rate: cv(H, 'R10') },
};
// wage growth assumptions (Wage growth Prediction tab I7/I8/I9)
const wgs = wb.Sheets['Wage growth Prediction'];
const wage_growth = { regional: cv(wgs, 'I7'), capital: cv(wgs, 'I8'), years: cv(wgs, 'I9') };

// per-region AI ceilings: house = Houses IC col F (idx5), unit = Units IC col E (idx4); rows 16-51
function ceilings(ws, col) { const g = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }); const out = {}; for (let r = 16; r <= 51; r++) { const a = g[r - 1]; if (!a) continue; const slug = resolveCity(a[1]); if (slug) out[slug] = numv(a[col]); } return out; }
const aiH = ceilings(H, 5), aiU = ceilings(U, 4);
const ai_ceiling = {};
for (const s of new Set([...Object.keys(aiH), ...Object.keys(aiU)])) ai_ceiling[s] = { h: aiH[s] ?? null, u: aiU[s] ?? null };

console.log('rates:', JSON.stringify(rates));
console.log('wage_growth:', JSON.stringify(wage_growth));
console.log('ai_ceiling regions:', Object.keys(ai_ceiling).length, '— e.g. adelaide=' + JSON.stringify(ai_ceiling.adelaide) + ' sydney=' + JSON.stringify(ai_ceiling.sydney));

if (!process.argv.includes('--write')) { console.log('\nDry run. Re-run with --write to upsert into rdp_runway_config (needs migration 052).'); process.exit(0); }
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const rows = [{ key: 'rates', value: rates }, { key: 'wage_growth', value: wage_growth }, { key: 'ai_ceiling', value: ai_ceiling }];
for (const r of rows) { const { error } = await sb.from('rdp_runway_config').upsert({ key: r.key, value: r.value, updated_at: new Date().toISOString() }, { onConflict: 'key' }); if (error) { console.error(r.key, error.message); process.exit(1); } }
console.log('✓ Seeded rdp_runway_config (rates, wage_growth, ai_ceiling).');
