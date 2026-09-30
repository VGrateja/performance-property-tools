/* =============================================================================
 * scripts/generate-sudoku-stages.test.mjs — tests for the Arena Sudoku engine
 *
 *   node --test scripts/generate-sudoku-stages.test.mjs
 *
 * Engine tests always run (fast, fixed public test seeds). The stage-set tests
 * also run over the REAL seeded set when it is present locally —
 * scratch/sudoku-stages.json (gitignored, produced by the generator with the
 * private master seed) or the file named in SUDOKU_STAGES_FILE — and prove:
 * exactly one solution for every stage, grades reproduce, bands strictly
 * harder than the one before, clue counts never rising inside a band, and
 * every boss a valid X-Sudoku.
 * ========================================================================== */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rngFromSeed, randomSolution, countSolutions, solve, parseGrid, gridToString, clueCount,
  isValidSolution, isConsistent, grade, buildCandidate, candidateSeed, applyXform, randomXform,
  generateStages, verifyRecords, reproduceStage, BANDS, isBoss, geometry, TECHNIQUES,
  addDays, isoWeekday, isoWeekOf, dailyBandOf, specialSeed, generateDaily, generateSprints,
  verifySpecials, reproduceSpecial, DAILY_BANDS, SPRINT_SLOTS
} from './generate-sudoku-stages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIKI = '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const WIKI_SOLUTION = '534678912672195348198342567859761423426853791713924856961537284287419635345286179';
const ESCARGOT = '100007090030020008009600500005300900010080002600004000300000010040000007007000300';

test('counting solver: unique, multiple and contradictory grids', () => {
  assert.equal(countSolutions(parseGrid(WIKI), 'classic', 2), 1);
  assert.equal(countSolutions(new Int8Array(81), 'classic', 2), 2);
  const bad = parseGrid(WIKI); bad[1] = 5;                 // two 5s in row 1
  assert.equal(countSolutions(bad, 'classic', 2), 0);
  assert.equal(gridToString(solve(parseGrid(WIKI), 'classic')), WIKI_SOLUTION);
});

test('geometry: classic has 27 units, X-Sudoku 29 with the diagonal box intersections', () => {
  assert.equal(geometry('classic').units.length, 27);
  assert.equal(geometry('x').units.length, 29);
  assert.equal(geometry('classic').peers[0].length, 20);
  assert.equal(geometry('x').peers[40].length, 32);          // centre sits on both diagonals
  assert.equal(geometry('x').inters.length - geometry('classic').inters.length, 6);
});

test('seeded RNG and random grids are deterministic and valid', () => {
  const a = rngFromSeed('same'), b = rngFromSeed('same');
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  for (const v of ['classic', 'x']) {
    const g1 = randomSolution(v, rngFromSeed('grid-' + v));
    const g2 = randomSolution(v, rngFromSeed('grid-' + v));
    assert.equal(gridToString(g1), gridToString(g2));
    assert.ok(isValidSolution(g1, v), v + ' grid valid');
  }
  // an X grid satisfies both diagonals; a classic grid usually does not
  const x = randomSolution('x', rngFromSeed('diag'));
  const d1 = new Set(), d2 = new Set();
  for (let i = 0; i < 9; i++) { d1.add(x[i * 9 + i]); d2.add(x[i * 9 + 8 - i]); }
  assert.equal(d1.size, 9); assert.equal(d2.size, 9);
});

test('grader: known puzzles land where they should', () => {
  const easy = grade(WIKI, 'classic', { solution: WIKI_SOLUTION });
  assert.ok(easy.ok); assert.equal(easy.hardest, 'naked-single'); assert.equal(easy.solution, WIKI_SOLUTION);
  const hard = grade(ESCARGOT, 'classic', { solution: gridToString(solve(parseGrid(ESCARGOT), 'classic')) });
  assert.ok(hard.ok); assert.equal(hard.hardest, 'trial'); assert.equal(hard.trialDepth, 2);
});

test('grader is sound: no technique ever removes the true digit (audit over random puzzles)', () => {
  // grade(…, {solution}) throws on any invalid elimination or placement
  const rng = rngFromSeed('audit');
  let graded = 0;
  const seen = new Set();
  for (const v of ['classic', 'x']) {
    for (let k = 0; k < (v === 'classic' ? 60 : 20); k++) {
      const sol = randomSolution(v, rng);
      const p = Int8Array.from(sol);
      // dig random single cells while the puzzle stays unique → hard, varied grids
      for (const i of Array.from({ length: 81 }, (_, j) => j).sort(() => rng() - 0.5)) {
        const keep = p[i]; p[i] = 0;
        if (countSolutions(p, v, 2) !== 1) p[i] = keep;
      }
      const g = grade(p, v, { solution: sol });
      if (g.ok) { graded++; g.techniques.forEach(t => seen.add(t)); }
    }
  }
  assert.ok(graded >= 60, 'graded enough puzzles (' + graded + ')');
  assert.ok(seen.has('hidden-single'));
  assert.ok(seen.size >= 8, 'the audit exercised many techniques (' + [...seen].join(', ') + ')');
});

test('buildCandidate is deterministic and honours its spec', () => {
  const spec = { variant: 'classic', target: 34, lo: 3, hi: 4, tol: 2 };
  let found = null;
  for (let k = 0; k < 400 && !found; k++) {
    const seed = candidateSeed('unit-test', 'classic', 'pairs', k);
    const c = buildCandidate(seed, spec);
    if (c) found = { seed, c };
  }
  assert.ok(found, 'a pairs candidate within 400 tries');
  const again = buildCandidate(found.seed, spec);
  assert.equal(gridToString(again.puzzle), gridToString(found.c.puzzle));
  assert.ok(found.c.grade.rank >= 3 && found.c.grade.rank <= 4);
  assert.ok(Math.abs(clueCount(found.c.puzzle) - 34) <= 2);
  assert.equal(countSolutions(found.c.puzzle, 'classic', 2), 1);
});

test('symmetry transforms keep grids valid, puzzles unique and the solution aligned', () => {
  const rng = rngFromSeed('xform');
  for (const v of ['classic', 'x']) {
    for (let k = 0; k < 40; k++) {
      const sol = randomSolution(v, rng);
      const x = randomXform(v, rng);
      const ts = applyXform(gridToString(sol), x);
      assert.ok(isValidSolution(parseGrid(ts), v), v + ' transformed solution valid');
    }
  }
  // a real puzzle: transformed puzzle stays unique and solves to the transformed solution
  const sol = gridToString(solve(parseGrid(WIKI), 'classic'));
  for (let k = 0; k < 20; k++) {
    const x = randomXform('classic', rng);
    const tp = applyXform(WIKI, x), tsol = applyXform(sol, x);
    assert.equal(clueCount(parseGrid(tp)), clueCount(parseGrid(WIKI)));
    assert.equal(countSolutions(parseGrid(tp), 'classic', 2), 1);
    assert.equal(gridToString(solve(parseGrid(tp), 'classic')), tsol);
    assert.equal(grade(tp, 'classic', { solution: tsol }).hardest, grade(WIKI, 'classic').hardest);
  }
  // X: build an X puzzle, transform it, it stays X-unique
  let xc = null;
  for (let k = 0; k < 200 && !xc; k++) xc = buildCandidate(candidateSeed('unit-test', 'x', 'boss', k), { variant: 'x', target: 30, lo: 3, hi: 9, tol: 3 });
  assert.ok(xc, 'an X candidate');
  for (let k = 0; k < 20; k++) {
    const x = randomXform('x', rng);
    const tp = applyXform(gridToString(xc.puzzle), x), tsol = applyXform(gridToString(xc.solution), x);
    assert.ok(isValidSolution(parseGrid(tsol), 'x'));
    assert.equal(countSolutions(parseGrid(tp), 'x', 2), 1);
    assert.equal(grade(tp, 'x', { solution: tsol }).hardest, xc.grade.hardest);
  }
});

test('end to end: a small stage set (bands 1–2, one boss) builds and verifies', () => {
  const recs = generateStages({ master: 'unit-test-master', count: 30 });
  assert.equal(recs.length, 30);
  assert.deepEqual(verifyRecords(recs), []);
  assert.equal(recs[24].variant, 'x');
  for (const r of recs.slice(0, 6)) {
    const again = reproduceStage(r);
    assert.equal(again.puzzle, r.puzzle);
    assert.equal(again.solution, r.solution);
  }
});

const STAGES_FILE = process.env.SUDOKU_STAGES_FILE || join(ROOT, 'scratch', 'sudoku-stages.json');
test('the seeded stage set (when present locally)', { skip: !existsSync(STAGES_FILE) && 'no local stage file' }, () => {
  const recs = JSON.parse(readFileSync(STAGES_FILE, 'utf8'));
  assert.ok(recs.length >= 300, 'at least 300 stages');
  // uniqueness on every stage, grading reproduces, monotonic bands, clue ramps, bosses
  assert.deepEqual(verifyRecords(recs), []);
  // bosses are exactly every 25th stage and are valid X-Sudoku
  for (const r of recs) {
    assert.equal(r.variant === 'x', isBoss(r.stage));
    if (r.variant === 'x') {
      assert.ok(isValidSolution(parseGrid(r.solution), 'x'), 'boss ' + r.stage + ' diagonals');
      assert.equal(countSolutions(parseGrid(r.puzzle), 'x', 2), 1);
    }
    assert.ok(isConsistent(parseGrid(r.puzzle), r.variant));
  }
  // every band is harder than the one before it
  let prevMax = 0;
  for (const b of BANDS) {
    const rs = recs.filter(r => r.stage >= b.from && r.stage <= b.to);
    if (!rs.length) continue;
    const min = Math.min(...rs.map(r => r.hardest_rank)), max = Math.max(...rs.map(r => r.hardest_rank));
    assert.ok(min > prevMax, b.tier + ' harder than the previous band');
    prevMax = max;
  }
  // chips name real techniques
  const labels = new Set(TECHNIQUES.map(t => t.label));
  for (const r of recs) for (const t of r.techniques) assert.ok(labels.has(t));
});

/* ── daily challenge + weekly sprint (migration 124) ── */
test('calendar helpers: ISO weekdays, ISO weeks across year ends, leap days, the daily rhythm', () => {
  assert.equal(isoWeekday('2026-09-28'), 1);                       // Monday
  assert.equal(isoWeekday('2026-10-04'), 7);                       // Sunday
  assert.deepEqual(isoWeekOf('2026-09-30'), { monday: '2026-09-28', year: 2026, week: 40, label: '2026-W40' });
  assert.equal(isoWeekOf('2027-01-03').label, '2026-W53');          // 2026 has 53 ISO weeks
  assert.equal(isoWeekOf('2027-01-04').label, '2027-W01');
  assert.equal(isoWeekOf('2026-01-01').label, '2026-W01');
  assert.equal(isoWeekOf('2021-01-03').label, '2020-W53');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-09-29', 400), '2027-11-03');
  assert.throws(() => addDays('2026-02-30', 1));
  assert.deepEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map(dailyBandOf),
    ['medium', 'medium', 'medium', 'hard', 'hard', 'hard', 'hard']);
  assert.notEqual(specialSeed('m', 'daily', '2026-09-30', 1, 0), specialSeed('m', 'sprint', '2026-09-30', 1, 0));
});

test('daily puzzles: one per day, deterministic, unique, in band and par window, reproducible', () => {
  const a = generateDaily({ master: 'unit-test-master', from: '2026-09-28', count: 7 });
  const b = generateDaily({ master: 'unit-test-master', from: '2026-09-28', count: 7 });
  assert.equal(a.length, 7);
  assert.deepEqual(a.map(r => r.puzzle), b.map(r => r.puzzle));
  assert.deepEqual(verifySpecials(a), []);
  assert.deepEqual(a.map(r => r.day), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  for (const r of a) {
    const band = DAILY_BANDS[dailyBandOf(r.day)];
    assert.equal(r.kind, 'daily'); assert.equal(r.slot, 1); assert.equal(r.tier, band.tier);
    assert.ok(r.hardest_rank >= band.lo && r.hardest_rank <= band.hi);
    assert.ok(r.par_ms >= 360000 && r.par_ms <= 600000, 'par 6–10 min');
    assert.equal(countSolutions(parseGrid(r.puzzle), 'classic', 2), 1);
    const x = reproduceSpecial(r); assert.equal(x.puzzle, r.puzzle); assert.equal(x.solution, r.solution);
  }
  const other = generateDaily({ master: 'another-master', from: '2026-09-28', count: 1 });
  assert.notEqual(other[0].puzzle, a[0].puzzle, 'a different master seed gives different puzzles');
});

test('sprint weeks: five slots Basic → Master keyed by the Monday, verified and reproducible', () => {
  const recs = generateSprints({ master: 'unit-test-master', from: '2026-10-01', weeks: 2 });   // from mid-week → that week's Monday
  assert.equal(recs.length, 10);
  assert.deepEqual([...new Set(recs.map(r => r.day))], ['2026-09-28', '2026-10-05']);
  assert.deepEqual(recs.slice(0, 5).map(r => r.tier), SPRINT_SLOTS.map(s => s.tier));
  assert.deepEqual(verifySpecials(recs), []);
  for (const r of recs) {
    const band = SPRINT_SLOTS[r.slot - 1];
    assert.ok(r.hardest_rank >= band.lo && r.hardest_rank <= band.hi, r.slot + ' in band');
    assert.ok(r.par_ms >= band.par[0] * 1000 && r.par_ms <= band.par[1] * 1000, r.slot + ' par window');
    assert.equal(reproduceSpecial(r).puzzle, r.puzzle);
  }
});

test('verifySpecials catches gaps, wrong bands, duplicates, broken weeks and broken grids', () => {
  const d = generateDaily({ master: 'unit-test-master', from: '2026-09-28', count: 3 });
  const s = generateSprints({ master: 'unit-test-master', from: '2026-09-28', weeks: 1 });
  const has = (recs, re) => verifySpecials(recs).some(p => re.test(p));
  assert.ok(has([d[0], d[2]], /gap/), 'a missing day');
  assert.ok(has([d[0], { ...d[1], tier: 'Hard', tier_rank: 3 }, d[2]], /tier/), 'a Tuesday graded as Hard');
  assert.ok(has([d[0], d[0]], /duplicate|repeat/), 'the same day twice');
  assert.ok(has(s.slice(0, 4), /slots/), 'a week without its Master slot');
  assert.ok(has([{ ...s[0], day: '2026-09-29' }, ...s.slice(1)], /Monday/), 'a sprint not keyed by its Monday');
  const open = '0'.repeat(81);
  assert.ok(has([{ ...d[0], puzzle: open, clue_count: 0 }], /exactly one solution/), 'an empty grid');
  assert.ok(has([{ ...d[0], par_ms: 900000 }], /par/), 'par outside the window');
});

const SPECIALS_FILE = process.env.SUDOKU_SPECIALS_FILE || join(ROOT, 'scratch', 'sudoku-specials.json');
test('the seeded daily / sprint set (when present locally)', { skip: !existsSync(SPECIALS_FILE) && 'no local specials file' }, () => {
  const recs = JSON.parse(readFileSync(SPECIALS_FILE, 'utf8'));
  const d = recs.filter(r => r.kind === 'daily'), s = recs.filter(r => r.kind === 'sprint');
  assert.ok(d.length >= 400, 'at least 400 days of dailies');
  assert.ok(s.length >= 50 * 5 && s.length % 5 === 0, 'whole sprint weeks');
  assert.deepEqual(verifySpecials(recs), []);
});
