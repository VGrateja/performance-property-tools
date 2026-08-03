/* =============================================================================
 * verify-traffic-lights.mjs — proves shared/traffic-lights-engine.js reproduces
 * Traffic Lights.xlsx (Scoring Model, 2026-08 revision: 6-indicator confidence
 * with damped-trend forecasts, normalised Value / S&D averages, veto OFF).
 *
 * For each sample sheet (Melbourne, Canberra, Darwin, Townsville) it rebuilds
 * the engine's inputs FROM THE WORKBOOK'S OWN COLUMNS and:
 *   1. independently recomputes every current confidence signal (double entry)
 *      and compares the engine against it, and
 *   2. for the region the Scoring Model was last calculated on (B2), compares
 *      against the workbook's own CACHED verdicts/signals — the exactness anchor.
 *
 * Usage: node scripts/verify-traffic-lights.mjs ["path to Traffic Lights.xlsx"]
 * ========================================================================== */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

// the engine is a browser classic-script (sets self.PP_TL_ENGINE); sandbox it
const sandbox = {};
new Function('self', readFileSync(join(__dir, '..', 'shared', 'traffic-lights-engine.js'), 'utf8'))(sandbox);
const ENGINE = sandbox.PP_TL_ENGINE;

const wbPath = process.argv[2] || 'C:/Users/vandolf_performancep/Downloads/Traffic Lights.xlsx';
const wb = XLSX.readFile(wbPath, { cellFormula: true });
const SM = wb.Sheets['Scoring Model'];
const DSRW = wb.Sheets['DS-RW'];
const cellV = (ws, addr) => { const c = ws[addr]; return c && c.v !== undefined && c.v !== '' ? c.v : null; };

// column letters → numeric values in row order (rows 2..1200, trailing nulls trimmed)
function colVals(ws, col, from = 2, to = 1200) {
  const out = [];
  for (let r = from; r <= to; r++) {
    const c = ws[col + r];
    out.push(c && typeof c.v === 'number' ? c.v : null);
  }
  while (out.length && out[out.length - 1] == null) out.pop();
  return out;
}
function rangeVals(ws, col, r0, r1) {
  const out = [];
  for (let r = r0; r <= r1; r++) { const c = ws[col + r]; out.push(c && typeof c.v === 'number' ? c.v : null); }
  return out;
}

// DS-RW row for a market: RW-H/DS-H/RW-U/DS-U over the last 6 months (4 cols/month)
const DSRW_COLS = {
  rwH: ['AX', 'BB', 'BF', 'BJ', 'BN', 'BR'], dsH: ['AY', 'BC', 'BG', 'BK', 'BO', 'BS'],
  rwU: ['AZ', 'BD', 'BH', 'BL', 'BP', 'BT'], dsU: ['BA', 'BE', 'BI', 'BM', 'BQ', 'BU']
};
function dsrwRow(name) {
  for (let r = 1; r <= 1000; r++) { const c = DSRW['A' + r]; if (c && String(c.v).trim() === name) return r; }
  return null;
}

const MARKETS = ['Melbourne', 'Canberra', 'Darwin', 'Townsville'];
const anchorRegion = String(cellV(SM, 'B2') || '').trim();
let pass = 0, fail = 0;
const expect = (label, got, want) => {
  const ok = String(got) === String(want);
  if (ok) pass++; else { fail++; console.log('  ✗ ' + label + ': engine ' + got + ' ≠ workbook ' + want); }
};

for (const name of MARKETS) {
  const ws = wb.Sheets[name];
  if (!ws) { console.log(name + ': sheet missing'); continue; }
  console.log('\n── ' + name + (name === anchorRegion ? '  (Scoring Model anchor)' : ''));

  // ── engine inputs from the sheet's own columns ──
  const bundle = {
    jobads: colVals(ws, 'L'),          // IVI job ads (monthly)
    bizfinQ: colVals(ws, 'S'),         // total business finance $m (quarterly)
    housfinQ: colVals(ws, 'V'),        // total housing finance $m (quarterly)
    cciAnnual: colVals(ws, 'I'),       // national CCI (annual rows)
    bizconf: colVals(ws, 'Y'),         // NAB state confidence
    bizconfFreq: String(cellV(ws, 'AJ1') || 'M'),
    underemp: colVals(ws, 'H')         // state underemployment (annual fraction)
  };
  const conf = ENGINE.confInputsFrom(bundle);

  const row = dsrwRow(name);
  const six = (k) => DSRW_COLS[k].map(c => cellV(DSRW, c + row));
  const rankH = rangeVals(ws, 'AB', 26, 48), rankU = rangeVals(ws, 'AC', 26, 48);
  const last5 = (a) => a.filter(v => v != null).slice(-5);
  const meanOf = (a) => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

  const inp = Object.assign({
    ds_h: cellV(ws, 'AG2'), ds_u: cellV(ws, 'AG3'),
    ds_h_fcst: Math.round(ENGINE.linForecast(six('dsH'), 9)),
    ds_u_fcst: Math.round(ENGINE.linForecast(six('dsU'), 9)),
    rank_h: cellV(ws, 'AB48'), rank_h_avg: meanOf(rankH),
    rank_h_fcst: Math.round(ENGINE.linForecast(last5(rankH), 6) * 10) / 10,
    rank_u: cellV(ws, 'AC48'), rank_u_avg: meanOf(rankU),
    rank_u_fcst: Math.round(ENGINE.linForecast(last5(rankU), 6) * 10) / 10,
    runway_h: cellV(ws, 'AF2'), runway_u: cellV(ws, 'AF3'),
    runway_h_fcst: Math.round(ENGINE.linForecast(six('rwH'), 9) * 1000) / 1000,
    runway_u_fcst: Math.round(ENGINE.linForecast(six('rwU'), 9) * 1000) / 1000
  }, conf);
  const out = ENGINE.scoreRegion(inp);

  // ── 1. independent recomputation of the current confidence signals ──
  const lastNum = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
  const backK = (a, k) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) { const j = i - k; return j >= 0 ? a[j] : null; } return null; };
  const sig3 = (E, g, r) => E == null ? 'ORANGE' : E >= g ? 'GREEN' : E <= r ? 'RED' : 'ORANGE';
  const indep = {
    jobads: sig3((() => { const c = lastNum(bundle.jobads), d = backK(bundle.jobads, 12); return c != null && d ? c / d - 1 : null; })(), 0.03, -0.03),
    bizfin: sig3((() => { const c = lastNum(bundle.bizfinQ), d = backK(bundle.bizfinQ, 4); return c != null && d ? c / d - 1 : null; })(), 0.03, -0.03),
    housfin: sig3((() => { const c = lastNum(bundle.housfinQ), d = backK(bundle.housfinQ, 4); return c != null && d ? c / d - 1 : null; })(), 0.03, -0.03),
    cci: (() => { const c = lastNum(bundle.cciAnnual); return c == null ? 'ORANGE' : c >= 100 ? 'GREEN' : c <= 97 ? 'RED' : 'ORANGE'; })(),
    bizconf: (() => { const c = lastNum(bundle.bizconf); return c == null ? 'ORANGE' : c >= 0 ? 'GREEN' : c <= -5 ? 'RED' : 'ORANGE'; })(),
    underemp: (() => {
      const c = lastNum(bundle.underemp), d = backK(bundle.underemp, 1);
      if (c == null) return 'ORANGE';
      const e = d != null ? c - d : null;
      if (c <= 0.06 && e != null && e <= 0) return 'GREEN';
      if (c >= 0.075 || (e != null && e > 0.003)) return 'RED';
      return 'ORANGE';
    })()
  };
  for (const ind of out.indicators) expect('current ' + ind.key, ind.signal, indep[ind.key]);

  console.log('  verdicts: SD ' + out.sd + '/' + out.sd_fcst + ' · VALUE ' + out.value + '/' + out.value_fcst +
    ' · CONF ' + out.confidence + '/' + out.conf_fcst + ' (score ' + out.conf_score + ' → ' + out.conf_fcst_score + ')');

  // ── 2. exactness anchor: the Scoring Model's cached values for its region ──
  if (name === anchorRegion) {
    expect('S&D verdict', out.sd, cellV(SM, 'B4'));
    expect('S&D forecast', out.sd_fcst, cellV(SM, 'C4'));
    expect('VALUE verdict', out.value, cellV(SM, 'B5'));
    expect('VALUE forecast', out.value_fcst, cellV(SM, 'C5'));
    expect('CONF verdict', out.confidence, cellV(SM, 'B6'));
    expect('CONF forecast', out.conf_fcst, cellV(SM, 'C6'));
    const rows = { jobads: 10, bizfin: 11, housfin: 12, cci: 13, bizconf: 14, underemp: 15 };
    for (const ind of out.indicators) {
      expect('cur signal ' + ind.key, ind.signal, cellV(SM, 'J' + rows[ind.key]));
      expect('fcst signal ' + ind.key, ind.fsignal, cellV(SM, 'W' + rows[ind.key]));
    }
    expect('conf score', out.conf_score, Math.round(cellV(SM, 'L16') * 100) / 100);
    expect('conf fcst score', out.conf_fcst_score, Math.round(cellV(SM, 'N16') * 100) / 100);
    expect('rank H signal', out.value_inds[0].signal, cellV(SM, 'H27'));
    expect('rank U signal', out.value_inds[1].signal, cellV(SM, 'H28'));
    expect('runway H signal', out.value_inds[2].signal, cellV(SM, 'H29'));
    expect('runway U signal', out.value_inds[3].signal, cellV(SM, 'H30'));
    expect('rank H fcst', out.value_inds[0].fcst, cellV(SM, 'L27'));
    expect('rank U fcst', out.value_inds[1].fcst, cellV(SM, 'L28'));
    expect('runway H fcst', out.value_inds[2].fcst, cellV(SM, 'L29'));
    expect('runway U fcst', out.value_inds[3].fcst, cellV(SM, 'L30'));
    expect('DS H signal', out.sd_inds[0].signal, cellV(SM, 'F35'));
    expect('DS U signal', out.sd_inds[1].signal, cellV(SM, 'F36'));
    expect('DS H fcst sig', out.sd_inds[0].fcst, cellV(SM, 'H35'));
    expect('DS U fcst sig', out.sd_inds[1].fcst, cellV(SM, 'H36'));
    expect('DS H proj', inp.ds_h_fcst, cellV(SM, 'G35'));
    expect('DS U proj', inp.ds_u_fcst, cellV(SM, 'G36'));
    expect('runway H proj', inp.runway_h_fcst, cellV(SM, 'K29'));
    expect('runway U proj', inp.runway_u_fcst, cellV(SM, 'K30'));
    expect('rank H proj', inp.rank_h_fcst, cellV(SM, 'K27'));
    expect('rank U proj', inp.rank_u_fcst, cellV(SM, 'K28'));
  }
}

console.log('\n' + pass + ' checks passed, ' + fail + ' failed → ' + (fail === 0 ? 'PASS' : 'FAIL'));
process.exit(fail === 0 ? 0 : 1);
