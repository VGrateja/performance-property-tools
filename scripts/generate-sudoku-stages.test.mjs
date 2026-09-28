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
  generateStages, verifyRecords, reproduceStage, BANDS, isBoss, geometry, TECHNIQUES
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
