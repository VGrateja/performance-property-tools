/* =============================================================================
 * scripts/adelaide-returns-math.test.mjs — tests for client/adelaide-returns-math.js
 *
 *   node --test scripts/adelaide-returns-math.test.mjs
 *
 * The expected values are hand calculations written out as explicit products of
 * the seed's calendar-year returns (seed-benchmarks.json, researched 2026-10-14),
 * NOT computed by the module: window = 7.8 years ending 2026-09-30, i.e.
 * 2018.95 → 2026.75 (0.05 of 2018, all of 2019–2025, all of the 9-month 2026 YTD).
 * ========================================================================== */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'client/adelaide-returns-math.js'), 'utf8'), sandbox);
const M = sandbox.ADLMath;

const YEARS = ['2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026YTD'];
const row = (arr) => Object.fromEntries(YEARS.map((y, i) => [y, arr[i]]));
const DEPOSIT = 636250 * 0.185;   // 117,706.25
const base = (benchmarks, extra = {}) => ({
  years: YEARS,
  window: { endDate: '2026-09-30', ytdEnd: '2026-09-30' },
  pp: { medianPurchasePrice: 636250, depositPct: 0.185, medianHoldYears: 7.8, medianIrr: null },
  benchmarks, ...extra,
});
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b}`);

test('the window is 2018.95 → 2026.75 (month grid)', () => {
  assert.equal(M.decYear('2026-09-30'), 2026.75);
  assert.equal(M.decYear('2018-12-31'), 2019);
  const w = M.windowOf(base([]));
  close(w.start, 2018.95, 1e-12, 'start');
  close(w.end, 2026.75, 1e-12, 'end');
});

test('hand check 1 — cash (AusBond Bank Bill), total return', () => {
  const cash = { key: 'cash', kind: 'total', annual: row([0.023, 0.021, 0.017, 0.019, 0.015, 0.004, 0.000, 0.013, 0.039, 0.045, 0.040, 0.0313]) };
  // by hand: 1.019^0.05 × 1.015 × 1.004 × 1.000 × 1.013 × 1.039 × 1.045 × 1.040 × 1.0313
  //        = 1.000941 × 1.202153 = 1.203284
  const r = M.annualise(cash, base([cash]), DEPOSIT);
  close(r.factor, 1.203284, 5e-7, 'factor');
  close(r.covered, 7.8, 1e-9, 'years covered');
  close(r.end, 141634.04, 0.01, 'end value of the deposit');
  close(r.total, 0.203284, 5e-7, 'total %');
  close(r.pa, 0.0240086, 1e-6, '% p.a. (1.203284^(1/7.8) − 1)');
  assert.equal(r.short, false);
});

test('hand check 2 — Adelaide dwellings, growth + gross yield', () => {
  const adl = { key: 'adl_resi', kind: 'growth+yield',
    annual: row([-0.001, 0.042, 0.030, 0.013, -0.002, 0.059, 0.232, 0.101, 0.088, 0.131, 0.088, 0.018]),
    yield: row([0.043, 0.044, 0.044, 0.044, 0.044, 0.043, 0.039, 0.040, 0.039, 0.037, 0.035, 0.036]) };
  // by hand, r = growth + yield (the 9-month YTD adds 0.75 × 3.6% = 2.7%):
  //   1.057^0.05 × 1.042 × 1.102 × 1.271 × 1.141 × 1.127 × 1.168 × 1.123 × 1.045
  //   = 1.002776 × 2.572428 = 2.579568
  const p = base([adl]);
  const r = M.annualise(adl, p, DEPOSIT);
  close(r.factor, 2.579568, 5e-7, 'factor');
  close(r.end, 303631.33, 0.01, 'end value of the deposit');
  close(r.pa, 0.129178, 5e-6, '% p.a.');
  // selection uses growth only: 1.013^0.05 × 0.998 × 1.059 × 1.232 × 1.101 × 1.088 × 1.131 × 1.088 × 1.018 = 1.955119
  const g = M.annualise(adl, p, null, true);
  close(g.factor, 1.955119, 5e-7, 'growth-only factor');
  close(g.pa, 0.089759, 5e-6, 'growth-only % p.a.');
});

test('a window ending inside the YTD period pro-rates it against the YTD span', () => {
  // window 2025.5 → 2026.5: half of 2025 (+10%), then 0.5 of the 0.75-year YTD (+6%)
  // by hand: 1.10^0.5 × 1.06^(0.5/0.75) = 1.0488088 × 1.0396103 = 1.090352
  const b = { key: 'x', kind: 'total', annual: { '2025': 0.10, '2026YTD': 0.06 } };
  const p = { years: ['2025', '2026YTD'], window: { endDate: '2026-06-30', ytdEnd: '2026-09-30' }, pp: { medianHoldYears: 1 }, benchmarks: [b] };
  const r = M.annualise(b, p, 100);
  close(r.factor, 1.090352, 5e-7, 'factor');
  close(r.pa, 0.090352, 5e-7, '% p.a. over exactly one year');
});

test('a window that starts before the data is flagged short, not padded', () => {
  const b = { key: 'x', kind: 'total', annual: { '2025': 0.10 } };
  const p = { years: ['2025'], window: { endDate: '2025-12-31', ytdEnd: '2025-12-31' }, pp: { medianHoldYears: 2 }, benchmarks: [b] };
  const r = M.annualise(b, p, 100);
  close(r.covered, 1, 1e-9, 'covered');
  assert.equal(r.short, true);
  close(r.pa, 0.10, 1e-12, '% p.a. over the years covered');
});

test('PP deposit path = deposit × (1 + IRR)^years; blank IRR gives no PP result', () => {
  const pp = M.ppGrowth(DEPOSIT, 0.14, 7.8);
  close(pp.end, DEPOSIT * Math.pow(1.14, 7.8), 1e-6, 'PP end');
  close(pp.end, 327082.54, 0.01, 'PP end (by hand: ln 1.14 × 7.8 = 1.022020, e^1.022020 = 2.778804; × 117,706.25)');
  const out = M.compute(base([]));
  assert.equal(out.pp, null);
  close(out.deposit, 117706.25, 1e-9, 'deposit = 636,250 × 18.5%');
});
