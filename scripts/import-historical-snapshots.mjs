// import-historical-snapshots.mjs — one-off: load the historical monthly Demand Score
// workbooks (Downloads) into forge_demand_snapshots so the Demand Score Dashboard's
// Prev-v-Current dropdown + hover cover Jan 2025 → Jul 2026.
// Per region per type: { ds, rw, pop, listings, avr, rg, median }.  Dry-run by default.
import XLSX from 'xlsx';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
try { for (const ln of readFileSync('.env','utf8').split(/\r?\n/)){const m=ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');} } catch {}
const sb = createClient(process.env.SUPABASE_URL||'https://cannojsxduvlewimwoxa.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });
const WRITE = process.argv.includes('--write');
const DL = join(homedir(),'Downloads');
const slugify = s => String(s||'').replace(/\([^)]*\)/g,' ').replace(/,\s*(act|nsw|nt|qld|sa|tas|vic|wa)\b/ig,' ').replace(/\bgreater\b/ig,' ').replace(/\bregional\b/ig,' ').replace(/-hastings/ig,' ').replace(/\s+/g,' ').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

// label (YYYY-MM) -> filename stub (House/Units prefix added). 2026 Apr-Jun carry a 'V1 - ' prefix.
const MONTHS = [
  ['2025-01','Jan 2025'],['2025-02','Feb 2025'],['2025-03','Mar 2025'],['2025-04','Apr 2025'],
  ['2025-05','May 2025'],['2025-06','June 2025'],['2025-07','July 2025'],['2025-08','August 2025'],
  ['2025-09','September 2025'],['2025-10','October 2025'],['2025-11','November 2025'],['2025-12','December 2025'],
  ['2026-01','January 2026'],['2026-02','February 2026'],['2026-03','March 2026'],
  ['2026-04','V1 - :April 2026'],['2026-05','V1 - :May 2026'],['2026-06','V1 - :June 2026'],
];
const LABEL = { '2025-01':'Jan 2025','2025-02':'Feb 2025','2025-03':'Mar 2025','2025-04':'Apr 2025','2025-05':'May 2025','2025-06':'Jun 2025','2025-07':'Jul 2025','2025-08':'Aug 2025','2025-09':'Sep 2025','2025-10':'Oct 2025','2025-11':'Nov 2025','2025-12':'Dec 2025','2026-01':'Jan 2026','2026-02':'Feb 2026','2026-03':'Mar 2026','2026-04':'Apr 2026','2026-05':'May 2026','2026-06':'Jun 2026' };
const file = (type, stub) => stub.includes('V1 - :') ? join(DL, 'V1 - '+type+' '+stub.replace('V1 - :','')+' - Demand Score.xlsx') : join(DL, type+' '+stub+' - Demand Score.xlsx');

function extractType(path){
  const wb = XLSX.readFile(path, { cellFormula:false });
  const data = wb.Sheets['DATA'], rvd = wb.Sheets['Runway v Demand'], imp = wb.Sheets['Imported Data'];
  const gv = (ws,r,c) => { const cell=ws[XLSX.utils.encode_cell({r,c})]; return cell?cell.v:null; };
  // DATA: A market, D pop, E listings, G adjVR, J rentGrowth(frac), O score-v-benchmark(DS)
  const out = {};
  { const rng=XLSX.utils.decode_range(data['!ref']);
    for(let r=2;r<=rng.e.r;r++){ const name=gv(data,r,0); if(!name||typeof name!=='string'||name==='Benchmark') continue; const slug=slugify(name); if(!slug) continue;
      const ds=gv(data,r,14), pop=gv(data,r,3), list=gv(data,r,4), avr=gv(data,r,6), rg=gv(data,r,9);
      if(ds==null&&pop==null) continue;
      out[slug]={ ds: (typeof ds==='number')?ds:null, pop:pop, listings:list, avr:avr, rg:(typeof rg==='number')?Math.round(rg*10000)/100:null }; } }
  // Runway v Demand: A region, B runway
  if (rvd){ const rng=XLSX.utils.decode_range(rvd['!ref']);
    for(let r=1;r<=rng.e.r;r++){ const name=gv(rvd,r,0); if(!name||typeof name!=='string') continue; const slug=slugify(name); if(out[slug]) out[slug].rw=gv(rvd,r,1); } }
  // Imported Data: A region, F H-median, G U-median  (type decides which median we keep)
  if (imp){ const rng=XLSX.utils.decode_range(imp['!ref']); const isU=/Units/i.test(path);
    for(let r=1;r<=rng.e.r;r++){ const name=gv(imp,r,0); if(!name||typeof name!=='string') continue; const slug=slugify(name); if(out[slug]) out[slug].median=gv(imp,r,isU?6:5); } }
  return out;
}

const snapshots = {};
for (const [ver, stub] of MONTHS) {
  try {
    const houses = extractType(file('House', stub));
    const units  = extractType(file('Units', stub));
    snapshots[ver] = { houses, units, label: LABEL[ver], hc: Object.keys(houses).length, uc: Object.keys(units).length };
  } catch(e){ console.error('  ✗ '+ver+': '+e.message); }
}

console.log('Extracted months:');
for (const [ver,stub] of MONTHS){ const s=snapshots[ver]; if(s) console.log('  '+ver+'  H:'+String(s.hc).padStart(2)+' U:'+String(s.uc).padStart(2)+'  ('+s.label+')'); }

// validation: Jan 2025 Adelaide + rg-mapping check vs existing 2026-06 snapshot
const j = snapshots['2025-01'];
if (j){ const a=j.houses['adelaide']; console.log('\nJan-2025 Adelaide (house):', JSON.stringify(a)); }
const jun = snapshots['2026-06'];
if (jun){ const { data:ex } = await sb.from('forge_demand_snapshots').select('data').eq('version','2026-06').single();
  const exH = ex && ex.data && ex.data.houses && ex.data.houses['adelaide'];
  console.log('\nrg/ds/rw cross-check — Adelaide 2026-06:');
  console.log('  workbook:', JSON.stringify(jun.houses['adelaide']));
  console.log('  existing snapshot:', exH?JSON.stringify({ds:exH.ds,rw:exH.rw,rg:exH.rg,avr:exH.avr,median:exH.median}):'(none)'); }

if (!WRITE){ console.log('\nDRY RUN — re-run with --write to upsert '+MONTHS.length+' months into forge_demand_snapshots.'); process.exit(0); }
let n=0;
for (const [ver] of MONTHS){ const s=snapshots[ver]; if(!s) continue;
  // don't clobber the live-captured 2026-06 (leave it as-is)
  if (ver==='2026-06'){ console.log('  skip 2026-06 (keep live-captured)'); continue; }
  const payload = { houses:s.houses, units:s.units };
  const { error } = await sb.from('forge_demand_snapshots').upsert({ version:ver, label:s.label, data:payload, captured_at:'2026-07-14T00:00:00Z', captured_by:'historical-import' }, { onConflict:'version' });
  if (error){ console.error('  ✗ '+ver+': '+error.message); } else { n++; console.log('  ✓ '+ver); }
}
console.log('\nWrote '+n+' historical snapshots.');
