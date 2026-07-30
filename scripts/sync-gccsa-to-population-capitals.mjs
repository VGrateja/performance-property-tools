// PUBLISH step — make `population` GCCSA for the 8 capitals so EVERY consumer
// (Online Reports, Demand Score, VR forecast, B/S At-a-Glance) reads GCCSA for
// capitals with no per-tool change. Regionals keep SUA (no GCCSA exists).
//
// Runs AFTER GATHER (which re-writes SUA into `population` from ABS each cycle),
// so it must re-apply every publish — one-time overwrites revert on the 10th.
//
//   node scripts/sync-gccsa-to-population-capitals.mjs            # dry run
//   node scripts/sync-gccsa-to-population-capitals.mjs --write    # apply
//   node scripts/sync-gccsa-to-population-capitals.mjs --write --stash
//     --stash also preserves the current SUA capital rows as metric `population_sua`
//     (one-time, for reversibility; do NOT run --stash on later cycles or it would
//      capture the already-GCCSA value).
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
try { if (existsSync('.env')) for (const ln of readFileSync('.env','utf8').split(/\r?\n/)) { const m=ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^["']|["']$/g,''); } } catch {}
const WRITE = process.argv.includes('--write');
const STASH = process.argv.includes('--stash');
const URL = process.env.SUPABASE_URL || 'https://cannojsxduvlewimwoxa.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) { console.error('Missing SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sb = createClient(URL, KEY, { auth:{ persistSession:false } });

// capitals = the cluster='capital' regions that actually have a GCCSA series
const { data: reg, error: e0 } = await sb.from('rdp_regions').select('slug,cluster');
if (e0) { console.error('rdp_regions read failed:', e0.message); process.exit(1); }
const capitalSlugs = new Set((reg||[]).filter(r=>r.cluster==='capital').map(r=>r.slug));

const pull = async metric => { let all=[],from=0; for(;;){ const {data,error}=await sb.from('rdp_raw_series').select('region_slug,period,value,source,freq').eq('metric',metric).range(from,from+999); if(error)throw error; all=all.concat(data||[]); if(!data||data.length<1000)break; from+=1000; } return all; };
const [gcc, cur] = await Promise.all([ pull('population_gccsa'), pull('population') ]);
const capG = gcc.filter(r=>capitalSlugs.has(r.region_slug));
const curByKey = Object.fromEntries(cur.filter(r=>capitalSlugs.has(r.region_slug)).map(r=>[r.region_slug+'|'+r.period, r]));

// Only sync periods that already exist in `population` (keep the metric's span)
const rows = capG.filter(r => curByKey[r.region_slug+'|'+r.period]);
const caps = [...new Set(rows.map(r=>r.region_slug))].sort();
console.log('GCCSA→population sync | capitals:', caps.length, '| rows to set:', rows.length, (WRITE?'':'(dry run)'));
const latest = {};
for (const r of rows){ const k=r.region_slug; if(!latest[k]||r.period>latest[k].period) latest[k]={period:r.period, gccsa:+r.value, sua:+curByKey[k+'|'+r.period].value}; }
for (const c of caps){ const L=latest[c]; const d=L.gccsa-L.sua; console.log('  '+c.padEnd(11)+' '+String(L.period).slice(0,4)+'  SUA '+L.sua.toLocaleString().padStart(10)+'  → GCCSA '+L.gccsa.toLocaleString().padStart(10)+'  ('+(d>=0?'+':'')+d.toLocaleString()+')'); }

if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write (add --stash on the FIRST run to preserve SUA as population_sua).'); process.exit(0); }

const chunk = (a,n)=>{ const o=[]; for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n)); return o; };
if (STASH) {
  const stash = rows.map(r=>{ const s=curByKey[r.region_slug+'|'+r.period]; return { source:s.source||'abs', region_slug:r.region_slug, metric:'population_sua', freq:s.freq||'A', period:r.period, value:+s.value }; });
  for (const c of chunk(stash,500)){ const {error}=await sb.from('rdp_raw_series').upsert(c,{onConflict:'source,region_slug,metric,freq,period'}); if(error){console.error('stash failed:',error.message);process.exit(1);} }
  console.log('✓ Stashed', stash.length, 'SUA capital rows as population_sua.');
}
const up = rows.map(r=>({ source:r.source||'abs', region_slug:r.region_slug, metric:'population', freq:r.freq||'A', period:r.period, value:+r.value }));
for (const c of chunk(up,500)){ const {error}=await sb.from('rdp_raw_series').upsert(c,{onConflict:'source,region_slug,metric,freq,period'}); if(error){console.error('write failed:',error.message);process.exit(1);} }
console.log('✓ Set population = GCCSA for', caps.length, 'capitals ('+up.length+' rows).');
await sb.from('rdp_runs').insert({ dataset:'gccsa_to_population_capitals', source_month:new Date().toISOString().slice(0,7), row_count:up.length, status:'ok', notes:'capitals population set to GCCSA'+(STASH?'; SUA stashed as population_sua':'') }).then(()=>{},()=>{});
