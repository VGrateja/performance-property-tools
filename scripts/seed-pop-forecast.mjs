// seed-pop-forecast.mjs — load the population.gov.au (Centre for Population)
// forward projections of the components of population change into Forge, so the
// derived "Forecasted Population" data point can roll each region/capital forward.
//
// Source workbook: Downloads/"Population Forecast for Selling_Buying Slides.xlsx"
//   • State sheet          → state-level projected NI/NOM/NIM (8 states)
//   • FORECAST - Cap Cities → capital-level projected NI/NOM/NIM (8 capitals + national)
// Both are pasted from https://population.gov.au/data-and-forecasts/projections .
//
// Stored as new metrics in rdp_raw_series (source 'population.gov.au'):
//   pop_proj_ni · pop_proj_nom · pop_proj_nim   (freq 'A')
// region_slug = st-XX (states) / capital slug / 'australia'; period = the
// financial-year-ENDING calendar year (2025-26 → 2026-01-01), matching the pop
// year the flow produces. Upsert-only, additive — never touches the actuals.
// Dry-run by DEFAULT; --write upserts + logs rdp_runs.
import XLSX from 'xlsx';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
try { for (const ln of readFileSync('.env','utf8').split(/\r?\n/)){const m=ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');} } catch {}
const sb = createClient(process.env.SUPABASE_URL||'https://cannojsxduvlewimwoxa.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
const WRITE = process.argv.includes('--write');
const FILE = join(homedir(),'Downloads','Population Forecast for Selling_Buying Slides.xlsx');
const wb = XLSX.readFile(FILE);
const num = v => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() && !isNaN(+v.replace(/,/g,'')) ? +v.replace(/,/g,'') : null);
const period = endYear => endYear + '-01-01';   // 2025-26 → '2026-01-01'
const rows = [];   // { region_slug, metric, period, value }
const push = (slug, comp, endYear, val) => { if (val != null) rows.push({ region_slug: slug, metric: 'pop_proj_' + comp, period: period(endYear), value: val }); };

// ── STATE projections (State sheet): A=state, B=component, C..G = 2024-25..2028-29 ──
const ST = { NSW:'st-nsw', VIC:'st-vic', QLD:'st-qld', SA:'st-sa', WA:'st-wa', TAS:'st-tas', NT:'st-nt', ACT:'st-act' };
const STATE_YEARS = [ [3,2026], [4,2027], [5,2028], [6,2029] ];   // col index → pop-ending year (skip C=2024-25 base flow)
{ const g = XLSX.utils.sheet_to_json(wb.Sheets['State'], { header:1, raw:true, defval:'' });
  for (const r of g){ const slug = ST[String(r[0]||'').trim()]; if (!slug) continue;
    const comp = /natural/i.test(r[1]) ? 'ni' : /overseas/i.test(r[1]) ? 'nom' : /interstate|internal/i.test(r[1]) ? 'nim' : null; if (!comp) continue;
    for (const [ci, ey] of STATE_YEARS) push(slug, comp, ey, num(r[ci])); } }

// ── CAPITAL + NATIONAL projections (FORECAST - Cap Cities sheet) ──
// flow blocks: NI/NOM/NIM at cols (3,4,5)=2026 (7,8,9)=2027 (11,12,13)=2028 (15,16,17)=2029 (19,20,21)=2030
const CAP = { 'NATIONAL':'australia', 'Canberra':'canberra', 'Greater Sydney':'sydney', 'Darwin':'darwin', 'Brisbane':'brisbane', 'Adelaide':'adelaide', 'Hobart':'hobart', 'Melbourne':'melbourne', 'Greater Perth':'perth' };
const CAP_BLOCKS = [ [3,2026], [7,2027], [11,2028], [15,2029], [19,2030] ];   // NI col → pop-ending year
{ const g = XLSX.utils.sheet_to_json(wb.Sheets['FORECAST - Cap Cities'], { header:1, raw:true, defval:'' });
  for (const r of g){ const slug = CAP[String(r[1]||'').trim()]; if (!slug) continue;
    for (const [ni, ey] of CAP_BLOCKS){ push(slug, 'ni', ey, num(r[ni])); push(slug, 'nom', ey, num(r[ni+1])); push(slug, 'nim', ey, num(r[ni+2])); } } }

// ── report ──
const bySlug = {}; for (const r of rows){ (bySlug[r.region_slug] ||= []).push(r); }
console.log('Extracted ' + rows.length + ' projection points across ' + Object.keys(bySlug).length + ' regions:');
for (const slug of Object.keys(bySlug).sort()){ const rs = bySlug[slug];
  const yrs = [...new Set(rs.map(r => r.period.slice(0,4)))].sort();
  console.log('  ' + slug.padEnd(11) + ' ' + rs.length + ' pts · ' + yrs[0] + '..' + yrs[yrs.length-1]); }
const sample = rows.filter(r => r.region_slug === 'st-nsw');
console.log('\nst-nsw sample:', JSON.stringify(sample));

if (!WRITE){ console.log('\nDRY RUN — re-run with --write to upsert into rdp_raw_series.'); process.exit(0); }
let n = 0;
for (let i = 0; i < rows.length; i += 500){ const chunk = rows.slice(i, i+500).map(r => ({ source:'population.gov.au', region_slug:r.region_slug, metric:r.metric, freq:'A', period:r.period, value:r.value }));
  const { error } = await sb.from('rdp_raw_series').upsert(chunk, { onConflict:'source,region_slug,metric,freq,period' });
  if (error){ console.error('  ✗', error.message); process.exit(1); } n += chunk.length; }
await sb.from('rdp_runs').insert({ dataset:'pop_forecast', source_month:'population.gov.au projections', row_count:n, status:'ok', notes:n + ' projected NI/NOM/NIM points (states + capitals + national)' });
console.log('\n✓ Seeded ' + n + ' projection points into rdp_raw_series.');
