#!/usr/bin/env node
/* =============================================================================
 * scripts/generate-sudoku-stages.mjs — the Arena Sudoku stage set
 *
 * A seeded puzzle generator + a human-technique grading solver for
 * tools/arena-sudoku.html (migration 122). Everything here is deterministic:
 * the same seed always yields the same grid, the same holes and the same grade.
 *
 * WHAT IT BUILDS
 *   Stages 1..N (default 300) on a monotonic difficulty curve, graded by the
 *   HARDEST human technique the greedy solver needs (always trying the easiest
 *   technique first), with the clue count ramping down inside each band:
 *
 *     1–20    Basic    singles only, many clues
 *     21–60   Medium   naked / hidden pairs and triples
 *     61–120  Hard     pointing pairs, box/line reduction, X-Wing
 *     121–200 Expert   XY-Wing, Swordfish
 *     201–260 Master   simple colouring, X-Chains, XY-Chains
 *     261–300 Extreme  trial & error (graded by guess depth)
 *
 *   Every 25th stage is a BOSS: an X-Sudoku (both long diagonals must also
 *   hold 1–9) graded with the diagonals as extra units, in its band.
 *   Every puzzle is proven to have exactly ONE solution by a counting solver.
 *
 * SECRECY — why the production seed is NOT in this file
 *   This repo is public. If the master seed were committed, anyone could run
 *   this script and print every puzzle and every solution before playing, and
 *   the whole server-side race (migration 122 keeps the solution and even the
 *   puzzle away from clients until a stage starts) would be pointless. So the
 *   generator is committed and deterministic, and the MASTER SEED is private:
 *   it comes from SUDOKU_MASTER_SEED (env or .env) or scratch/sudoku-master-
 *   seed.txt (gitignored). Each stage's own derived seed + generator settings
 *   are stored with its solution in the private table, so any single stage can
 *   be regenerated and checked with --reproduce.
 *
 * USAGE
 *   node scripts/generate-sudoku-stages.mjs --out scratch/sudoku-stages.json
 *        [--count 300] [--seed <master>]            generate + print distribution
 *   node scripts/generate-sudoku-stages.mjs --verify scratch/sudoku-stages.json
 *                                                     re-prove uniqueness + grades
 *   node scripts/generate-sudoku-stages.mjs --apply scratch/sudoku-stages.json
 *        [--force]                                   seed the DB (service role
 *                                                     from .env, in-process; never
 *                                                     overwrites a played stage)
 *   node scripts/generate-sudoku-stages.mjs --reproduce scratch/sudoku-stages.json
 *                                                     regenerate every stage from
 *                                                     its stored seed and compare
 *
 * Tests: node --test scripts/generate-sudoku-stages.test.mjs
 * ========================================================================== */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const GEN_VERSION = 1;

/* ───────────────────────────── PRNG (seeded) ───────────────────────────── */
function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= (h2 ^ h3 ^ h4); h2 ^= h1; h3 ^= h1; h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}
function sfc32(a, b, c, d) {
  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}
/** A seeded PRNG returning floats in [0,1). */
export function rngFromSeed(seed) {
  const h = cyrb128(String(seed));
  const r = sfc32(h[0], h[1], h[2], h[3]);
  for (let i = 0; i < 12; i++) r();          // warm up
  return r;
}
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/* ───────────────────────────── bit helpers ─────────────────────────────── */
export const ALL = 0x1ff;                       // digits 1..9 → bits 0..8
export const bit = d => 1 << (d - 1);
const POP = new Uint8Array(512);
for (let m = 1; m < 512; m++) POP[m] = POP[m >> 1] + (m & 1);
export const popcount = m => POP[m & ALL];
const lowDigit = m => 32 - Math.clz32(m & -m);   // lowest set bit → digit
export function digitsOf(mask) {
  const out = [];
  for (let d = 1; d <= 9; d++) if (mask & bit(d)) out.push(d);
  return out;
}

/* ───────────────────────────── geometry ────────────────────────────────── */
const GEO = {};
/**
 * The constraint geometry. 'classic' = 9 rows, 9 columns, 9 boxes;
 * 'x' adds the main diagonal and the anti-diagonal as two more units.
 */
export function geometry(variant = 'classic') {
  if (GEO[variant]) return GEO[variant];
  if (variant !== 'classic' && variant !== 'x') throw new Error('unknown variant ' + variant);
  const units = [], kinds = [];
  for (let r = 0; r < 9; r++) { const u = []; for (let c = 0; c < 9; c++) u.push(r * 9 + c); units.push(u); kinds.push('row'); }
  for (let c = 0; c < 9; c++) { const u = []; for (let r = 0; r < 9; r++) u.push(r * 9 + c); units.push(u); kinds.push('col'); }
  for (let b = 0; b < 9; b++) {
    const br = Math.floor(b / 3) * 3, bc = (b % 3) * 3, u = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) u.push((br + i) * 9 + bc + j);
    units.push(u); kinds.push('box');
  }
  if (variant === 'x') {
    const d1 = [], d2 = [];
    for (let i = 0; i < 9; i++) { d1.push(i * 9 + i); d2.push(i * 9 + (8 - i)); }
    units.push(d1); kinds.push('diag');
    units.push(d2); kinds.push('anti');
  }
  const unitsOf = Array.from({ length: 81 }, () => []);
  units.forEach((u, ui) => u.forEach(c => unitsOf[c].push(ui)));
  const peers = Array.from({ length: 81 }, (_, c) => {
    const s = new Set();
    unitsOf[c].forEach(ui => units[ui].forEach(p => { if (p !== c) s.add(p); }));
    return [...s].sort((a, b) => a - b);
  });
  const peerSet = peers.map(p => { const a = new Uint8Array(81); p.forEach(x => { a[x] = 1; }); return a; });
  /* box × line intersections with 2+ shared cells (pointing / box-line). For
     X-Sudoku this includes the three boxes each diagonal passes through. */
  const inters = [];
  for (let bx = 0; bx < units.length; bx++) {
    if (kinds[bx] !== 'box') continue;
    for (let ln = 0; ln < units.length; ln++) {
      if (kinds[ln] === 'box') continue;
      const shared = units[bx].filter(c => units[ln].includes(c));
      if (shared.length < 2) continue;
      const sharedSet = new Uint8Array(81); shared.forEach(c => { sharedSet[c] = 1; });
      inters.push({ box: bx, line: ln, shared, sharedSet });
    }
  }
  GEO[variant] = { variant, units, kinds, unitsOf, peers, peerSet, inters };
  return GEO[variant];
}

/* ───────────────────────────── grid helpers ────────────────────────────── */
export function parseGrid(s) {
  if (typeof s !== 'string' || !/^[0-9.]{81}$/.test(s)) throw new Error('grid must be 81 chars of 0-9');
  const g = new Int8Array(81);
  for (let i = 0; i < 81; i++) { const ch = s[i]; g[i] = ch === '.' ? 0 : ch.charCodeAt(0) - 48; }
  return g;
}
export const gridToString = g => Array.from(g, v => String(v)).join('');
export const clueCount = g => { let n = 0; for (let i = 0; i < 81; i++) if (g[i]) n++; return n; };

/** true when no unit holds a digit twice (blanks ignored). */
export function isConsistent(grid, variant = 'classic') {
  const geo = geometry(variant);
  for (const u of geo.units) {
    let seen = 0;
    for (const c of u) {
      const v = grid[c]; if (!v) continue;
      const b = bit(v); if (seen & b) return false; seen |= b;
    }
  }
  return true;
}
/** true when the grid is full and every unit (incl. diagonals for 'x') holds 1–9. */
export function isValidSolution(grid, variant = 'classic') {
  for (let i = 0; i < 81; i++) if (!(grid[i] >= 1 && grid[i] <= 9)) return false;
  return isConsistent(grid, variant);
}

/* ───────────────────── counting solver (uniqueness proof) ───────────────── */
/**
 * Counts solutions up to `limit` with an MRV depth-first search over unit
 * bitmasks. Returns 0 (no solution / contradictory givens), 1, or `limit`.
 */
export function countSolutions(grid0, variant = 'classic', limit = 2) {
  const geo = geometry(variant);
  const grid = Int8Array.from(grid0);
  const nu = geo.units.length;
  const used = new Uint16Array(nu);
  for (let c = 0; c < 81; c++) {
    const v = grid[c]; if (!v) continue;
    const b = bit(v);
    for (const u of geo.unitsOf[c]) { if (used[u] & b) return 0; used[u] |= b; }
  }
  const empties = [];
  for (let c = 0; c < 81; c++) if (!grid[c]) empties.push(c);
  const n = empties.length;
  let count = 0;
  const uo = geo.unitsOf;
  function dfs(k) {
    if (k === n) { count++; return count >= limit; }
    let best = -1, bestMask = 0, bestCount = 10;
    for (let i = k; i < n; i++) {
      const c = empties[i], us = uo[c];
      let m = ALL;
      for (let j = 0; j < us.length; j++) m &= ~used[us[j]];
      const pc = POP[m];
      if (pc < bestCount) { bestCount = pc; best = i; bestMask = m; if (pc <= 1) break; }
    }
    if (bestCount === 0) return false;
    const c = empties[best]; empties[best] = empties[k]; empties[k] = c;
    const us = uo[c];
    let m = bestMask;
    while (m) {
      const b = m & -m; m ^= b;
      for (let j = 0; j < us.length; j++) used[us[j]] |= b;
      if (dfs(k + 1)) return true;
      for (let j = 0; j < us.length; j++) used[us[j]] &= ~b;
    }
    return false;
  }
  dfs(0);
  return count;
}
/** The (first) solution of a puzzle, or null. */
export function solve(grid0, variant = 'classic') {
  const geo = geometry(variant);
  const grid = Int8Array.from(grid0);
  const used = new Uint16Array(geo.units.length);
  for (let c = 0; c < 81; c++) {
    const v = grid[c]; if (!v) continue;
    const b = bit(v);
    for (const u of geo.unitsOf[c]) { if (used[u] & b) return null; used[u] |= b; }
  }
  const empties = [];
  for (let c = 0; c < 81; c++) if (!grid[c]) empties.push(c);
  const n = empties.length, uo = geo.unitsOf;
  function dfs(k) {
    if (k === n) return true;
    let best = -1, bestMask = 0, bestCount = 10;
    for (let i = k; i < n; i++) {
      const c = empties[i], us = uo[c];
      let m = ALL;
      for (let j = 0; j < us.length; j++) m &= ~used[us[j]];
      const pc = POP[m];
      if (pc < bestCount) { bestCount = pc; best = i; bestMask = m; if (pc <= 1) break; }
    }
    if (bestCount === 0) return false;
    const c = empties[best]; empties[best] = empties[k]; empties[k] = c;
    const us = uo[c];
    let m = bestMask;
    while (m) {
      const b = m & -m; m ^= b;
      for (let j = 0; j < us.length; j++) used[us[j]] |= b;
      grid[c] = lowDigit(b);
      if (dfs(k + 1)) return true;
      for (let j = 0; j < us.length; j++) used[us[j]] &= ~b;
    }
    grid[c] = 0;
    return false;
  }
  return dfs(0) ? grid : null;
}

/* ───────────────────────── random complete grid ─────────────────────────── */
export function randomSolution(variant, rng) {
  const geo = geometry(variant);
  const grid = new Int8Array(81);
  const used = new Uint16Array(geo.units.length);
  const empties = shuffle(Array.from({ length: 81 }, (_, i) => i), rng);
  const uo = geo.unitsOf;
  function dfs(k) {
    if (k === 81) return true;
    let best = -1, bestMask = 0, bestCount = 10;
    for (let i = k; i < 81; i++) {
      const c = empties[i], us = uo[c];
      let m = ALL;
      for (let j = 0; j < us.length; j++) m &= ~used[us[j]];
      const pc = POP[m];
      if (pc < bestCount) { bestCount = pc; best = i; bestMask = m; if (pc <= 1) break; }
    }
    if (bestCount === 0) return false;
    const c = empties[best]; empties[best] = empties[k]; empties[k] = c;
    const us = uo[c];
    const ds = shuffle(digitsOf(bestMask), rng);
    for (const d of ds) {
      const b = bit(d);
      for (let j = 0; j < us.length; j++) used[us[j]] |= b;
      grid[c] = d;
      if (dfs(k + 1)) return true;
      for (let j = 0; j < us.length; j++) used[us[j]] &= ~b;
    }
    grid[c] = 0;
    return false;
  }
  if (!dfs(0)) throw new Error('could not build a solution grid');
  return grid;
}

/* ════════════════════ the human-technique grading solver ═══════════════════
 * A candidate-based solver that always applies the EASIEST technique that
 * makes progress, one step at a time, and records what it used. The grade of
 * a puzzle is the hardest technique on that path. With `solution` supplied,
 * every step is audited: a technique that ever removes the true digit or
 * places a wrong one throws — so a buggy technique can never grade a stage.
 * ══════════════════════════════════════════════════════════════════════════ */
export const TECHNIQUES = [
  { key: 'naked-single',  label: 'Naked single',       rank: 1,  cost: 0,   weight: 0.02 },
  { key: 'hidden-single', label: 'Hidden single',      rank: 2,  cost: 0,   weight: 0.05 },
  { key: 'naked-pair',    label: 'Naked pair',         rank: 3,  cost: 30,  weight: 1.0 },
  { key: 'hidden-pair',   label: 'Hidden pair',        rank: 4,  cost: 40,  weight: 1.4 },
  { key: 'naked-triple',  label: 'Naked triple',       rank: 5,  cost: 50,  weight: 2.0 },
  { key: 'hidden-triple', label: 'Hidden triple',      rank: 6,  cost: 60,  weight: 2.6 },
  { key: 'pointing',      label: 'Pointing pair',      rank: 7,  cost: 25,  weight: 1.2 },
  { key: 'box-line',      label: 'Box/line reduction', rank: 8,  cost: 30,  weight: 1.5 },
  { key: 'x-wing',        label: 'X-Wing',             rank: 9,  cost: 90,  weight: 3.5 },
  { key: 'xy-wing',       label: 'XY-Wing',            rank: 10, cost: 120, weight: 4.5 },
  { key: 'swordfish',     label: 'Swordfish',          rank: 11, cost: 150, weight: 5.5 },
  { key: 'colouring',     label: 'Simple colouring',   rank: 12, cost: 180, weight: 6.5 },
  { key: 'x-chain',       label: 'X-Chain',            rank: 13, cost: 210, weight: 7.5 },
  { key: 'xy-chain',      label: 'XY-Chain',           rank: 14, cost: 240, weight: 8.0 },
  { key: 'trial',         label: 'Trial & error',      rank: 15, cost: 300, weight: 12.0 }
];
export const TECH_BY_KEY = Object.fromEntries(TECHNIQUES.map(t => [t.key, t]));
/** tier (1..6) a hardest-technique rank belongs to */
export function tierOfRank(rank) {
  if (rank <= 2) return 1;
  if (rank <= 6) return 2;
  if (rank <= 9) return 3;
  if (rank <= 11) return 4;
  if (rank <= 14) return 5;
  return 6;
}

class Board {
  constructor(geo, grid, solution) {
    this.geo = geo;
    this.grid = Int8Array.from(grid);
    this.cand = new Uint16Array(81);
    this.solution = solution || null;
    const used = new Uint16Array(geo.units.length);
    let filled = 0;
    for (let c = 0; c < 81; c++) {
      const v = this.grid[c]; if (!v) continue;
      filled++;
      for (const u of geo.unitsOf[c]) used[u] |= bit(v);
    }
    for (let c = 0; c < 81; c++) {
      if (this.grid[c]) continue;
      let m = ALL;
      for (const u of geo.unitsOf[c]) m &= ~used[u];
      this.cand[c] = m;
    }
    this.filled = filled;
  }
  clone() {
    const b = Object.create(Board.prototype);
    b.geo = this.geo; b.grid = Int8Array.from(this.grid); b.cand = Uint16Array.from(this.cand);
    b.solution = null; b.filled = this.filled;
    return b;
  }
  place(c, d) {
    if (this.solution && this.solution[c] !== d) throw new Error('invalid placement r' + (Math.floor(c / 9) + 1) + 'c' + (c % 9 + 1) + '=' + d);
    this.grid[c] = d; this.cand[c] = 0; this.filled++;
    const b = bit(d), ps = this.geo.peers[c];
    for (let i = 0; i < ps.length; i++) this.cand[ps[i]] &= ~b;
  }
  elim(c, mask) {
    if (this.grid[c] || !(this.cand[c] & mask)) return false;
    if (this.solution && (mask & bit(this.solution[c]))) throw new Error('invalid elimination of ' + this.solution[c] + ' at r' + (Math.floor(c / 9) + 1) + 'c' + (c % 9 + 1));
    this.cand[c] &= ~mask;
    return true;
  }
  /** a hypothesis has broken: a cell with no candidates, or a unit that can no longer hold a digit */
  broken() {
    const { grid, cand, geo } = this;
    for (let c = 0; c < 81; c++) if (!grid[c] && !cand[c]) return true;
    for (const u of geo.units) {
      let have = 0;
      for (let i = 0; i < 9; i++) { const c = u[i]; have |= grid[c] ? bit(grid[c]) : cand[c]; }
      if (have !== ALL) return true;
      let seen = 0;
      for (let i = 0; i < 9; i++) { const v = grid[u[i]]; if (!v) continue; const b = bit(v); if (seen & b) return true; seen |= b; }
    }
    return false;
  }
}

function placedMask(b, cells) {
  let m = 0;
  for (let i = 0; i < cells.length; i++) { const v = b.grid[cells[i]]; if (v) m |= bit(v); }
  return m;
}

/* ── singles ── */
function tNakedSingle(b) {
  const { grid, cand } = b;
  for (let c = 0; c < 81; c++) if (!grid[c] && POP[cand[c]] === 1) { b.place(c, lowDigit(cand[c])); return true; }
  return false;
}
function tHiddenSingle(b) {
  const { units } = b.geo, { grid, cand } = b;
  for (let u = 0; u < units.length; u++) {
    const cells = units[u], placed = placedMask(b, cells);
    for (let d = 1; d <= 9; d++) {
      const bd = bit(d); if (placed & bd) continue;
      let pos = -1, n = 0;
      for (let i = 0; i < 9; i++) { const c = cells[i]; if (!grid[c] && (cand[c] & bd)) { n++; pos = c; if (n > 1) break; } }
      if (n === 1) { b.place(pos, d); return true; }
    }
  }
  return false;
}

/* ── subsets ── */
function combos(arr, k, fn) {                     // fn(combo) → true to stop
  const n = arr.length, idx = [];
  function rec(start, depth) {
    if (depth === k) return fn(idx.map(i => arr[i]));
    for (let i = start; i <= n - (k - depth); i++) { idx[depth] = i; if (rec(i + 1, depth + 1)) return true; }
    return false;
  }
  return rec(0, 0);
}
function tNakedSubset(b, k) {
  const { units } = b.geo, { grid, cand } = b;
  for (let u = 0; u < units.length; u++) {
    const empt = units[u].filter(c => !grid[c]);
    if (empt.length <= k) continue;
    const pool = empt.filter(c => POP[cand[c]] >= 2 && POP[cand[c]] <= k);
    if (pool.length < k) continue;
    const hit = combos(pool, k, combo => {
      let m = 0; for (const c of combo) m |= cand[c];
      if (POP[m] !== k) return false;
      let changed = false;
      for (const c of empt) if (!combo.includes(c)) changed = b.elim(c, m) || changed;
      return changed;
    });
    if (hit) return true;
  }
  return false;
}
function tHiddenSubset(b, k) {
  const { units } = b.geo, { grid, cand } = b;
  for (let u = 0; u < units.length; u++) {
    const cells = units[u];
    let emptyCount = 0; for (const c of cells) if (!grid[c]) emptyCount++;
    if (emptyCount <= k) continue;
    const placed = placedMask(b, cells);
    const ds = [], pos = [];
    for (let d = 1; d <= 9; d++) {
      const bd = bit(d); if (placed & bd) continue;
      let pm = 0;
      for (let i = 0; i < 9; i++) { const c = cells[i]; if (!grid[c] && (cand[c] & bd)) pm |= 1 << i; }
      if (POP[pm] >= 2 && POP[pm] <= k) { ds.push(d); pos.push(pm); }
    }
    if (ds.length < k) continue;
    const idx = ds.map((_, i) => i);
    const hit = combos(idx, k, combo => {
      let union = 0, dm = 0;
      for (const i of combo) { union |= pos[i]; dm |= bit(ds[i]); }
      if (POP[union] !== k) return false;
      let changed = false;
      for (let i = 0; i < 9; i++) if (union & (1 << i)) changed = b.elim(cells[i], ALL & ~dm) || changed;
      return changed;
    });
    if (hit) return true;
  }
  return false;
}

/* ── intersections (box ∩ line; for X-Sudoku the diagonals count as lines) ── */
function tPointing(b) {
  const { units, inters } = b.geo, { grid, cand } = b;
  for (const it of inters) {
    const boxCells = units[it.box], lineCells = units[it.line], ss = it.sharedSet;
    for (let d = 1; d <= 9; d++) {
      const bd = bit(d);
      let inS = 0, outS = 0;
      for (const c of boxCells) if (!grid[c] && (cand[c] & bd)) { if (ss[c]) inS++; else { outS++; break; } }
      if (!inS || outS) continue;
      let changed = false;
      for (const c of lineCells) if (!ss[c]) changed = b.elim(c, bd) || changed;
      if (changed) return true;
    }
  }
  return false;
}
function tBoxLine(b) {
  const { units, inters } = b.geo, { grid, cand } = b;
  for (const it of inters) {
    const boxCells = units[it.box], lineCells = units[it.line], ss = it.sharedSet;
    for (let d = 1; d <= 9; d++) {
      const bd = bit(d);
      let inS = 0, outS = 0;
      for (const c of lineCells) if (!grid[c] && (cand[c] & bd)) { if (ss[c]) inS++; else { outS++; break; } }
      if (!inS || outS) continue;
      let changed = false;
      for (const c of boxCells) if (!ss[c]) changed = b.elim(c, bd) || changed;
      if (changed) return true;
    }
  }
  return false;
}

/* ── fish: X-Wing (2) and Swordfish (3) on rows/columns ── */
function tFish(b, size) {
  const { grid, cand } = b;
  const at = (orient, line, pos) => orient ? pos * 9 + line : line * 9 + pos;
  for (let d = 1; d <= 9; d++) {
    const bd = bit(d);
    for (let orient = 0; orient < 2; orient++) {
      const base = [];
      for (let L = 0; L < 9; L++) {
        let m = 0;
        for (let x = 0; x < 9; x++) { const c = at(orient, L, x); if (!grid[c] && (cand[c] & bd)) m |= 1 << x; }
        if (POP[m] >= 2 && POP[m] <= size) base.push({ L, m });
      }
      if (base.length < size) continue;
      const hit = combos(base, size, combo => {
        let union = 0; for (const e of combo) union |= e.m;
        if (POP[union] !== size) return false;
        const lines = combo.map(e => e.L);
        let changed = false;
        for (let x = 0; x < 9; x++) {
          if (!(union & (1 << x))) continue;
          for (let L2 = 0; L2 < 9; L2++) if (!lines.includes(L2)) changed = b.elim(at(orient, L2, x), bd) || changed;
        }
        return changed;
      });
      if (hit) return true;
    }
  }
  return false;
}

/* ── XY-Wing ── */
function tXYWing(b) {
  const { grid, cand } = b, ps = b.geo.peerSet;
  const bv = [];
  for (let c = 0; c < 81; c++) if (!grid[c] && POP[cand[c]] === 2) bv.push(c);
  for (const P of bv) {
    const pm = cand[P];
    const wings = bv.filter(c => c !== P && ps[P][c] && POP[cand[c] & pm] === 1);
    for (let i = 0; i < wings.length; i++) for (let j = i + 1; j < wings.length; j++) {
      const A = wings[i], B = wings[j], am = cand[A], bm = cand[B];
      if ((am & pm) === (bm & pm)) continue;
      const z = am & bm & ~pm;
      if (POP[z] !== 1) continue;
      let changed = false;
      for (let c = 0; c < 81; c++) if (c !== A && c !== B && c !== P && ps[A][c] && ps[B][c]) changed = b.elim(c, z) || changed;
      if (changed) return true;
    }
  }
  return false;
}

/* ── single-digit strong links (conjugate pairs) ── */
function strongLinks(b, bd) {
  const { units } = b.geo, { grid, cand } = b;
  const map = new Map();
  for (const u of units) {
    let a = -1, n = 0, c2 = -1;
    for (const c of u) if (!grid[c] && (cand[c] & bd)) { n++; if (n === 1) a = c; else if (n === 2) c2 = c; else break; }
    if (n !== 2) continue;
    if (!map.has(a)) map.set(a, new Set());
    if (!map.has(c2)) map.set(c2, new Set());
    map.get(a).add(c2); map.get(c2).add(a);
  }
  return map;
}

/* ── simple colouring (colour wrap + colour trap) ── */
function tColouring(b) {
  const { grid, cand } = b, ps = b.geo.peerSet;
  for (let d = 1; d <= 9; d++) {
    const bd = bit(d);
    const links = strongLinks(b, bd);
    if (!links.size) continue;
    const color = new Int8Array(81).fill(-1), comp = new Int16Array(81).fill(-1);
    let compId = 0;
    for (const start of [...links.keys()].sort((x, y) => x - y)) {
      if (color[start] !== -1) continue;
      const members = [[], []];
      const queue = [start]; color[start] = 0; comp[start] = compId;
      while (queue.length) {
        const x = queue.shift();
        members[color[x]].push(x);
        for (const y of links.get(x)) if (color[y] === -1) { color[y] = 1 - color[x]; comp[y] = compId; queue.push(y); }
      }
      const thisComp = compId++;
      if (members[0].length + members[1].length < 3) continue;
      // colour wrap: two cells of one colour see each other → that colour is false
      for (let col = 0; col < 2; col++) {
        const m = members[col];
        let wrap = false;
        for (let i = 0; i < m.length && !wrap; i++) for (let j = i + 1; j < m.length; j++) if (ps[m[i]][m[j]]) { wrap = true; break; }
        if (wrap) {
          let changed = false;
          for (const c of m) changed = b.elim(c, bd) || changed;
          if (changed) return true;
        }
      }
      // colour trap: an outside cell that sees both colours can't be d
      let changed = false;
      for (let c = 0; c < 81; c++) {
        if (grid[c] || !(cand[c] & bd) || comp[c] === thisComp) continue;
        let s0 = false, s1 = false;
        for (const x of members[0]) if (ps[c][x]) { s0 = true; break; }
        if (!s0) continue;
        for (const x of members[1]) if (ps[c][x]) { s1 = true; break; }
        if (s1) changed = b.elim(c, bd) || changed;
      }
      if (changed) return true;
    }
  }
  return false;
}

/* ── X-Chain: single-digit alternating chain, strong–weak–…–strong ── */
function tXChain(b, maxLinks = 7, budget = 60000) {
  const { grid, cand } = b, ps = b.geo.peerSet;
  let spent = 0;
  for (let d = 1; d <= 9; d++) {
    const bd = bit(d);
    const nodes = [];
    for (let c = 0; c < 81; c++) if (!grid[c] && (cand[c] & bd)) nodes.push(c);
    if (nodes.length < 4) continue;
    const links = strongLinks(b, bd);
    if (links.size < 4) continue;
    const visited = new Uint8Array(81);
    const starts = [...links.keys()].sort((x, y) => x - y);
    for (const S of starts) {
      visited[S] = 1;
      const dfs = (on, n) => {
        if (++spent > budget) return false;
        if (n >= 3) {
          let changed = false;
          for (const c of nodes) if (c !== S && c !== on && ps[S][c] && ps[on][c]) changed = b.elim(c, bd) || changed;
          if (changed) return true;
        }
        if (n + 2 > maxLinks) return false;
        for (const Y of nodes) {
          if (visited[Y] || !ps[on][Y]) continue;
          const sy = links.get(Y); if (!sy) continue;
          visited[Y] = 1;
          for (const Z of sy) {
            if (visited[Z]) continue;
            visited[Z] = 1;
            if (dfs(Z, n + 2)) return true;
            visited[Z] = 0;
          }
          visited[Y] = 0;
        }
        return false;
      };
      for (const X of links.get(S)) {
        visited[X] = 1;
        if (dfs(X, 1)) return true;
        visited[X] = 0;
      }
      visited[S] = 0;
      if (spent > budget) return false;
    }
  }
  return false;
}

/* ── XY-Chain: a chain of bivalue cells whose two ends share the target digit ── */
function tXYChain(b, maxLen = 8, budget = 60000) {
  const { grid, cand } = b, ps = b.geo.peerSet;
  const bv = [];
  for (let c = 0; c < 81; c++) if (!grid[c] && POP[cand[c]] === 2) bv.push(c);
  if (bv.length < 3) return false;
  let spent = 0;
  const visited = new Uint8Array(81);
  for (const C1 of bv) {
    for (const a of digitsOf(cand[C1])) {
      const ab = bit(a);
      const exit0 = lowDigit(cand[C1] & ~ab);
      visited[C1] = 1;
      const dfs = (cur, exitD, len) => {
        if (++spent > budget) return false;
        const eb = bit(exitD);
        for (const N of bv) {
          if (visited[N] || !ps[cur][N] || !(cand[N] & eb)) continue;
          const next = lowDigit(cand[N] & ~eb);
          if (next === a && len + 1 >= 3) {
            let changed = false;
            for (let c = 0; c < 81; c++) if (c !== C1 && c !== N && ps[C1][c] && ps[N][c]) changed = b.elim(c, ab) || changed;
            if (changed) return true;
          }
          if (len + 1 < maxLen) {
            visited[N] = 1;
            if (dfs(N, next, len + 1)) return true;
            visited[N] = 0;
          }
        }
        return false;
      };
      const hit = dfs(C1, exit0, 1);
      visited[C1] = 0;
      if (hit) return true;
      if (spent > budget) return false;
    }
  }
  return false;
}

/* technique ladder, easiest first — index = rank-1 */
const LADDER = [
  b => tNakedSingle(b),
  b => tHiddenSingle(b),
  b => tNakedSubset(b, 2),
  b => tHiddenSubset(b, 2),
  b => tNakedSubset(b, 3),
  b => tHiddenSubset(b, 3),
  b => tPointing(b),
  b => tBoxLine(b),
  b => tFish(b, 2),
  b => tXYWing(b),
  b => tFish(b, 3),
  b => tColouring(b),
  b => tXChain(b),
  b => tXYChain(b)
];
const INNER = 8;   // techniques available INSIDE a trial hypothesis: singles..box/line

/** propagate a hypothesis: 'broken' | 'solved' | 'stuck' */
function propagate(h, depth) {
  for (let guard = 0; guard < 400; guard++) {
    if (h.broken()) return 'broken';
    if (h.filled === 81) return 'solved';
    let moved = false;
    for (let t = 0; t < INNER; t++) if (LADDER[t](h)) { moved = true; break; }
    if (moved) continue;
    if (depth > 1 && trialStep(h, depth - 1)) continue;
    return 'stuck';
  }
  return 'stuck';
}
/** one trial-and-error elimination at the given depth, on bivalue cells */
function trialStep(b, depth) {
  const cells = [];
  for (let c = 0; c < 81; c++) if (!b.grid[c] && POP[b.cand[c]] === 2) cells.push(c);
  for (const c of cells) {
    for (const v of digitsOf(b.cand[c])) {
      const h = b.clone();
      h.place(c, v);
      if (propagate(h, depth) === 'broken') { b.elim(c, bit(v)); return true; }
    }
  }
  return false;
}

/**
 * Grade a puzzle. Returns
 *   { ok, rank, hardest, tier, techniques[], counts{}, trialDepth, trialCount,
 *     difficulty, parSec, empties }
 * ok=false with reason when the ladder (incl. depth-2 trials) cannot finish.
 */
export function grade(puzzle, variant = 'classic', opts = {}) {
  const geo = geometry(variant);
  const p = typeof puzzle === 'string' ? parseGrid(puzzle) : puzzle;
  const solution = opts.solution ? (typeof opts.solution === 'string' ? parseGrid(opts.solution) : opts.solution) : null;
  const b = new Board(geo, p, solution);
  const counts = {};
  let rank = 0, trialDepth = 0, trialCount = 0, guard = 0;
  const empties = 81 - b.filled;
  const maxTrialDepth = opts.maxTrialDepth || 2;
  outer:
  while (b.filled < 81) {
    if (++guard > 2000) return { ok: false, reason: 'loop' };
    if (b.broken()) return { ok: false, reason: 'contradiction' };
    for (let t = 0; t < LADDER.length; t++) {
      if (LADDER[t](b)) {
        const key = TECHNIQUES[t].key;
        counts[key] = (counts[key] || 0) + 1;
        if (t + 1 > rank) rank = t + 1;
        continue outer;
      }
    }
    let done = false;
    for (let dpt = 1; dpt <= maxTrialDepth; dpt++) {
      if (trialStep(b, dpt)) {
        counts.trial = (counts.trial || 0) + 1;
        trialCount++; if (dpt > trialDepth) trialDepth = dpt;
        rank = 15; done = true; break;
      }
    }
    if (!done) return { ok: false, reason: 'stuck', counts };
  }
  if (!isValidSolution(b.grid, variant)) return { ok: false, reason: 'invalid' };
  const techniques = TECHNIQUES.filter(t => counts[t.key]).map(t => t.key);
  const hardest = TECHNIQUES[rank - 1].key;
  const tier = tierOfRank(rank);
  /* par: a steady per-cell pace for the tier, plus the thinking time of each
     advanced technique — the first use at full cost, each repeat at half
     (spotting the same pattern again is quicker). */
  let difficulty = 0, techSec = 0;
  for (const t of TECHNIQUES) {
    const n = counts[t.key] || 0; if (!n) continue;
    difficulty += n * t.weight;
    const unit = t.cost * (t.key === 'trial' ? trialDepth : 1);
    techSec += unit * (1 + 0.5 * (n - 1));
  }
  if (trialDepth) difficulty += 6 * trialDepth;
  let parSec = 30 + empties * (3 + tier) + techSec;
  if (variant === 'x') parSec *= 1.1;
  parSec = Math.ceil(parSec / 15) * 15;
  return {
    ok: true, rank, hardest, tier, techniques, counts, trialDepth, trialCount,
    difficulty: Math.round(difficulty * 100) / 100, parSec, empties,
    solution: gridToString(b.grid)
  };
}

/* ═════════════════════════ puzzle construction ═════════════════════════════
 * Holes are dug in 180°-rotational pairs (the classic newspaper look). Each
 * removal is kept only if the counting solver still finds exactly one
 * solution. Easy stages dig DOWN to a target clue count; harder stages dig to
 * a minimal puzzle and then ADD clues back (never lowering the grade below the
 * band) until the target count is reached — adding a correct clue can never
 * create a second solution, and it lets hard grades sit at higher clue counts.
 * ══════════════════════════════════════════════════════════════════════════ */
function digSymmetric(solution, variant, rng, targetClues) {
  const puzzle = Int8Array.from(solution);
  const pairs = shuffle(Array.from({ length: 41 }, (_, i) => i), rng);
  let clues = 81;
  for (const i of pairs) {
    const j = 80 - i, cost = i === j ? 1 : 2;
    if (targetClues && clues - cost < targetClues) continue;
    const a = puzzle[i], bb = puzzle[j];
    puzzle[i] = 0; puzzle[j] = 0;
    if (countSolutions(puzzle, variant, 2) === 1) clues -= cost;
    else { puzzle[i] = a; puzzle[j] = bb; }
    if (targetClues && clues <= targetClues) break;
  }
  return puzzle;
}

/**
 * Build one candidate puzzle from a seed.
 *   spec = { variant, target, lo, hi, tol=1, fan=10 }
 * lo..hi is the allowed hardest-technique rank range; the clue count must land
 * within ±tol of target. Returns { puzzle, solution, grade } or null when this
 * seed can't be shaped into the band.
 *
 * Harder bands: dig a minimal puzzle, then walk clues back in. Each step grades
 * `fan` candidate clue pairs and keeps the best one — in the band beats above
 * it, then closest to the target count; a pair that would drop the grade below
 * the band is never taken. Adding a correct clue keeps the solution unique.
 */
export function buildCandidate(seed, spec) {
  const { variant = 'classic', target, lo, hi } = spec;
  const tol = spec.tol == null ? 1 : spec.tol;
  const fan = spec.fan || 10;
  const rng = rngFromSeed(seed);
  const sol = randomSolution(variant, rng);
  const done = (p, g) => (countSolutions(p, variant, 2) === 1 ? { puzzle: p, solution: sol, grade: g } : null);
  if (hi <= 2) {
    // Basic band: dig straight down to the target count, then grade.
    const p = digSymmetric(sol, variant, rng, target);
    const g = grade(p, variant, { solution: sol });
    if (!g.ok || g.rank < lo || g.rank > hi) return null;
    if (Math.abs(clueCount(p) - target) > tol) return null;
    return done(p, g);
  }
  const p = digSymmetric(sol, variant, rng, 0);           // minimal (for pair-digging)
  let g = grade(p, variant, { solution: sol });
  if (!g.ok || g.rank < lo) return null;                  // too easy: adding clues only makes it easier
  const inBand = x => x.ok && x.rank >= lo && x.rank <= hi;
  let clues = clueCount(p);
  const pool = [];
  for (let i = 0; i <= 40; i++) if (!p[i]) pool.push(i);
  shuffle(pool, rng);
  for (let step = 0; step < 40; step++) {
    if (inBand(g) && Math.abs(clues - target) <= tol) return done(p, g);
    if (clues > target + tol || !pool.length) return null;
    let pick = null;
    const tries = Math.min(pool.length, fan);
    for (let t = 0; t < tries; t++) {
      const i = pool[t], j = 80 - i;
      const q = Int8Array.from(p); q[i] = sol[i]; q[j] = sol[j];
      const g2 = grade(q, variant, { solution: sol });
      if (!g2.ok || g2.rank < lo) continue;
      const qc = clues + (i === j ? 1 : 2);
      const score = (inBand(g2) ? 0 : 100) + Math.abs(qc - target);
      if (!pick || score < pick.score) pick = { t, q, g: g2, qc, score };
      if (inBand(g2) && Math.abs(qc - target) <= tol) break;
    }
    if (!pick) return null;
    p.set(pick.q); g = pick.g; clues = pick.qc; pool.splice(pick.t, 1);
  }
  return null;
}

/* ═══════════════════════════ the stage plan ════════════════════════════════ */
/* Each band = the brief's technique band; `subs` split it so the techniques
   also progress inside the band (pairs before triples, intersections before
   X-Wing, …). Clue ramps follow what symmetric minimal puzzles can reach
   (24–32 clues); a later sub-tier is capped at the previous one's lowest
   count, so the clue count never rises inside a band. */
export const BANDS = [
  { band: 1, tier: 'Basic',   from: 1,   to: 20,  lo: 1,  hi: 2,  clues: [46, 36],
    subs: [{ from: 1, to: 20, lo: 1, hi: 2, tol: 1 }] },
  { band: 2, tier: 'Medium',  from: 21,  to: 60,  lo: 3,  hi: 6,  clues: [35, 29],
    subs: [{ from: 21, to: 45, lo: 3, hi: 4, tol: 2 }, { from: 46, to: 60, lo: 5, hi: 6, tol: 2, fan: 20 }] },
  { band: 3, tier: 'Hard',    from: 61,  to: 120, lo: 7,  hi: 9,  clues: [32, 27],
    subs: [{ from: 61, to: 95, lo: 7, hi: 8, tol: 2 }, { from: 96, to: 120, lo: 9, hi: 9, tol: 2, fan: 20 }] },
  { band: 4, tier: 'Expert',  from: 121, to: 200, lo: 10, hi: 11, clues: [31, 26],
    subs: [{ from: 121, to: 170, lo: 10, hi: 10, tol: 2 }, { from: 171, to: 200, lo: 11, hi: 11, tol: 2, fan: 20 }] },
  { band: 5, tier: 'Master',  from: 201, to: 260, lo: 12, hi: 14, clues: [30, 25],
    subs: [{ from: 201, to: 220, lo: 12, hi: 12, tol: 2 }, { from: 221, to: 240, lo: 13, hi: 13, tol: 2, fan: 20 },
           { from: 241, to: 260, lo: 14, hi: 14, tol: 2 }] },
  { band: 6, tier: 'Extreme', from: 261, to: 300, lo: 15, hi: 15, clues: [28, 24],
    subs: [{ from: 261, to: 300, lo: 15, hi: 15, tol: 2 }] }
];
export const BOSS_EVERY = 25;
export const isBoss = n => n > 0 && n % BOSS_EVERY === 0;
export function bandOf(n) {
  for (const b of BANDS) if (n >= b.from && n <= b.to) return b;
  return BANDS[BANDS.length - 1];
}
/** target clue count for a stage: linear ramp inside its band */
export function targetClues(n) {
  const b = bandOf(n);
  const span = Math.max(1, b.to - b.from);
  return Math.round(b.clues[0] + (b.clues[1] - b.clues[0]) * (n - b.from) / span);
}
function subOf(n) {
  const b = bandOf(n);
  for (const s of b.subs) if (n >= s.from && n <= s.to) return s;
  return b.subs[b.subs.length - 1];
}

const sha = s => createHash('sha256').update(s).digest('hex');
/** the per-candidate seed, derived from the private master seed */
export function candidateSeed(master, variant, slot, k) {
  return sha('arena-sudoku|v' + GEN_VERSION + '|' + master + '|' + variant + '|' + slot + '|' + k).slice(0, 24);
}

/**
 * Generate the stage set. Returns an array of stage records (see toRecord).
 * opts: { master, count=300, log, maxTries }
 */
export function generateStages(opts) {
  const master = opts.master;
  if (!master) throw new Error('master seed required');
  const count = opts.count || 300;
  const log = opts.log || (() => {});
  const maxTries = opts.maxTries || 25000;
  const out = new Map();
  const bands = BANDS.filter(b => b.from <= count);
  for (const band of bands) {
    const last = Math.min(band.to, count);
    let cap = 81;                                  // clue cap for the next sub-tier
    for (const sub of band.subs) {
      if (sub.from > last) break;
      const nos = [];
      for (let n = sub.from; n <= Math.min(sub.to, last); n++) if (!isBoss(n)) nos.push(n);
      // 1) one candidate per classic slot; the slot's target follows the ramp
      const pool = [];
      for (const n of nos) {
        const target = Math.min(targetClues(n), cap);
        const spec = { variant: 'classic', target, lo: sub.lo, hi: sub.hi, tol: sub.tol, fan: sub.fan };
        let found = null;
        for (let k = 0; k < maxTries && !found; k++) {
          const seed = candidateSeed(master, 'classic', n, k);
          const cand = buildCandidate(seed, spec);
          if (cand && clueCount(cand.puzzle) <= cap) found = { seed, spec, ...cand, tries: k + 1 };
        }
        if (!found) throw new Error('no candidate for stage ' + n + ' (target ' + target + ', ranks ' + sub.lo + '–' + sub.hi + ')');
        pool.push(found);
        log('  slot ' + n + ': ' + found.grade.hardest + ' · ' + clueCount(found.puzzle) + ' clues · ' + found.tries + ' tries');
      }
      // 2) order the sub-tier: fewer clues later; within a count, easier first
      pool.sort((a, b) => (clueCount(b.puzzle) - clueCount(a.puzzle)) || (a.grade.rank - b.grade.rank) || (a.grade.difficulty - b.grade.difficulty));
      nos.forEach((n, i) => out.set(n, { n, ...pool[i] }));
      if (pool.length) cap = Math.min(cap, ...pool.map(p => clueCount(p.puzzle)));
    }
    // 3) boss X-Sudoku stages, fitted between their neighbours' clue counts
    for (let n = band.from; n <= last; n++) {
      if (!isBoss(n)) continue;
      const prev = out.get(n - 1), next = (n + 1 <= last) ? out.get(n + 1) : null;
      const hiClues = prev ? clueCount(prev.puzzle) : band.clues[0];
      const loClues = next ? clueCount(next.puzzle) : Math.max(17, hiClues - 4);
      const target = Math.round((hiClues + loClues) / 2);
      const spec = { variant: 'x', target, lo: band.lo, hi: band.hi, tol: Math.max(1, Math.ceil((hiClues - loClues) / 2)) };
      let found = null;
      for (let k = 0; k < maxTries && !found; k++) {
        const seed = candidateSeed(master, 'x', n, k);
        const cand = buildCandidate(seed, spec);
        if (!cand) continue;
        const cc = clueCount(cand.puzzle);
        if (cc > hiClues || cc < loClues) continue;
        found = { seed, spec, ...cand, tries: k + 1 };
      }
      if (!found) throw new Error('no boss candidate for stage ' + n);
      out.set(n, { n, ...found });
      log('  boss ' + n + ': ' + found.grade.hardest + ' · ' + clueCount(found.puzzle) + ' clues · ' + found.tries + ' tries');
    }
  }
  return [...out.values()].sort((a, b) => a.n - b.n).map(toRecord);
}

function toRecord(s) {
  const band = bandOf(s.n);
  const g = s.grade;
  return {
    stage: s.n,
    variant: s.spec.variant,
    tier: band.tier,
    tier_rank: band.band,
    techniques: g.techniques.map(k => TECH_BY_KEY[k].label),
    technique_keys: g.techniques,
    hardest: g.hardest,
    hardest_rank: g.rank,
    trial_depth: g.trialDepth,
    clue_count: clueCount(s.puzzle),
    par_ms: g.parSec * 1000,
    difficulty: g.difficulty,
    puzzle: gridToString(s.puzzle),
    solution: gridToString(s.solution),
    seed: s.seed,
    gen: { v: GEN_VERSION, variant: s.spec.variant, target: s.spec.target, lo: s.spec.lo, hi: s.spec.hi,
      tol: s.spec.tol == null ? 1 : s.spec.tol, fan: s.spec.fan || 10 }
  };
}

/** regenerate one stage from its stored seed + settings */
export function reproduceStage(rec) {
  const g = rec.gen;
  const c = buildCandidate(rec.seed, { variant: g.variant, target: g.target, lo: g.lo, hi: g.hi, tol: g.tol, fan: g.fan });
  return c ? { puzzle: gridToString(c.puzzle), solution: gridToString(c.solution) } : null;
}

/* ═══════════════ symmetry transforms (mirror of the SQL in 122) ════════════
 * A restart or replay gets the SAME stage with its rows, columns and digits
 * relabelled — identical logic and difficulty, but a remembered answer is
 * useless. x = { r:[9], c:[9], d:[10], t:0|1 }:
 *   target(R,C) = d[ S'(r[R], c[C]) ],  S' = transpose(S) when t=1.
 * Classic: r, c are independent band-preserving permutations.
 * X-Sudoku: r is from the 24-element group that fixes the diagonal pair, and
 * c = r or its mirror — so both diagonals stay diagonals.
 * ══════════════════════════════════════════════════════════════════════════ */
export function applyXform(grid, x) {
  const s = typeof grid === 'string' ? grid : gridToString(grid);
  if (!x) return s;
  let out = '';
  for (let R = 0; R < 9; R++) for (let C = 0; C < 9; C++) {
    let sr = x.r[R], sc = x.c[C];
    if (x.t) { const t = sr; sr = sc; sc = t; }
    const v = s.charCodeAt(sr * 9 + sc) - 48;
    out += String(x.d[v]);
  }
  return out;
}
export function randomXform(variant, rng) {
  const perm3 = () => shuffle([0, 1, 2], rng);
  const bandPerm = () => {
    const bands = perm3(), r = [];
    for (let B = 0; B < 3; B++) { const w = perm3(); for (let j = 0; j < 3; j++) r.push(bands[B] * 3 + w[j]); }
    return r;
  };
  let r, c;
  if (variant === 'x') {
    const q = perm3(), swap = rng() < 0.5, mid = rng() < 0.5;
    r = new Array(9);
    for (let j = 0; j < 3; j++) { r[j] = (swap ? 6 : 0) + q[j]; r[8 - j] = 8 - r[j]; }
    r[3] = mid ? 5 : 3; r[4] = 4; r[5] = 8 - r[3];
    c = rng() < 0.5 ? r.slice() : r.map(v => 8 - v);
  } else {
    r = bandPerm(); c = bandPerm();
  }
  const d = [0, ...shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rng)];
  return { r, c, d, t: rng() < 0.5 ? 1 : 0 };
}

/* ═══════════════════════════════ CLI ═══════════════════════════════════════ */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

function loadEnv() {
  const f = join(ROOT, '.env');
  if (!existsSync(f)) return;
  for (const ln of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function masterSeed(explicit) {
  if (explicit) return explicit;
  if (process.env.SUDOKU_MASTER_SEED) return process.env.SUDOKU_MASTER_SEED;
  const f = join(ROOT, 'scratch', 'sudoku-master-seed.txt');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  return null;
}

export function distribution(recs) {
  const lines = [];
  for (const b of BANDS) {
    const rs = recs.filter(r => r.stage >= b.from && r.stage <= b.to);
    if (!rs.length) continue;
    const tech = {};
    rs.forEach(r => { tech[r.hardest] = (tech[r.hardest] || 0) + 1; });
    const clues = rs.map(r => r.clue_count), pars = rs.map(r => r.par_ms / 1000);
    const fmt = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
    lines.push(b.tier.padEnd(8) + ' ' + String(b.from).padStart(3) + '–' + String(Math.min(b.to, rs[rs.length - 1].stage)).padEnd(3) +
      ' n=' + String(rs.length).padStart(3) + '  clues ' + Math.max(...clues) + '→' + Math.min(...clues) +
      '  par ' + fmt(Math.min(...pars)) + '–' + fmt(Math.max(...pars)) +
      '  bosses ' + rs.filter(r => r.variant === 'x').map(r => r.stage).join(',') +
      '  hardest: ' + Object.entries(tech).sort((x, y) => TECH_BY_KEY[x[0]].rank - TECH_BY_KEY[y[0]].rank).map(([k, v]) => k + '×' + v).join(' '));
  }
  return lines.join('\n');
}

/**
 * Every check the stage set must pass. Returns a list of problems (empty = ok):
 *   exactly one solution (counting solver) · solution valid (incl. diagonals on
 *   bosses) · givens agree with it · the grade reproduces · hardest technique
 *   inside its band (and its sub-tier for classic stages) · bands strictly
 *   harder than the previous band · clue count never rises inside a band ·
 *   bosses are exactly the X-Sudoku stages · stage numbers 1..N contiguous.
 */
export function verifyRecords(recs) {
  const problems = [];
  let prevBand = 0, prevClues = 99, prevBandMax = 0, bandMax = 0;
  recs.forEach((r, i) => {
    if (r.stage !== i + 1) problems.push('stage numbering broken at index ' + i);
    const p = parseGrid(r.puzzle), s = parseGrid(r.solution);
    if (countSolutions(p, r.variant, 2) !== 1) problems.push(r.stage + ': not exactly one solution');
    if (!isValidSolution(s, r.variant)) problems.push(r.stage + ': invalid solution');
    for (let k = 0; k < 81; k++) if (p[k] && p[k] !== s[k]) { problems.push(r.stage + ': givens disagree with solution'); break; }
    if (clueCount(p) !== r.clue_count) problems.push(r.stage + ': clue_count wrong');
    const g = grade(p, r.variant, { solution: s });
    if (!g.ok) problems.push(r.stage + ': grade failed ' + g.reason);
    else if (g.hardest !== r.hardest || g.rank !== r.hardest_rank) problems.push(r.stage + ': grade drift ' + r.hardest + ' → ' + g.hardest);
    const band = bandOf(r.stage);
    if (r.hardest_rank < band.lo || r.hardest_rank > band.hi) problems.push(r.stage + ': rank ' + r.hardest_rank + ' outside band ' + band.tier);
    if (r.variant === 'classic') {
      const sub = subOf(r.stage);
      if (r.hardest_rank < sub.lo || r.hardest_rank > sub.hi) problems.push(r.stage + ': rank ' + r.hardest_rank + ' outside its sub-tier ' + sub.lo + '–' + sub.hi);
    }
    if (band.band !== prevBand) {
      if (prevBand && band.lo <= prevBandMax) problems.push(r.stage + ': band ' + band.tier + ' not harder than the previous band');
      prevBandMax = bandMax; prevBand = band.band; prevClues = 99; bandMax = 0;
    }
    bandMax = Math.max(bandMax, r.hardest_rank);
    if (prevBandMax && r.hardest_rank <= prevBandMax) problems.push(r.stage + ': not harder than every stage of the previous band');
    if (r.clue_count > prevClues) problems.push(r.stage + ': clue count rises inside band (' + prevClues + ' → ' + r.clue_count + ')');
    prevClues = r.clue_count;
    if ((r.variant === 'x') !== isBoss(r.stage)) problems.push(r.stage + ': boss/variant mismatch');
    if (!(r.par_ms > 0)) problems.push(r.stage + ': no par time');
  });
  return problems;
}

async function applyToDb(recs, force) {
  loadEnv();
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env');
  const { createClient } = await import('@supabase/supabase-js');
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const { data: played, error: pe } = await admin.from('arena_sudoku_attempts').select('stage').limit(100000);
  if (pe) throw new Error('reading attempts: ' + pe.message);
  const playedSet = new Set((played || []).map(r => r.stage));
  const { data: existing, error: ee } = await admin.from('arena_sudoku_stage_secrets').select('stage, puzzle, solution');
  if (ee) throw new Error('reading stage secrets: ' + ee.message);
  const have = new Map((existing || []).map(r => [r.stage, r]));
  const pub = [], sec = [];
  let skipped = 0, same = 0;
  for (const r of recs) {
    const cur = have.get(r.stage);
    if (cur && cur.puzzle === r.puzzle && cur.solution === r.solution) { same++; }
    else if (cur && playedSet.has(r.stage) && !force) { skipped++; continue; }
    pub.push({ stage: r.stage, variant: r.variant, tier: r.tier, tier_rank: r.tier_rank, techniques: r.techniques,
      hardest: r.hardest, hardest_rank: r.hardest_rank, clue_count: r.clue_count, par_ms: r.par_ms, difficulty: r.difficulty });
    sec.push({ stage: r.stage, puzzle: r.puzzle, solution: r.solution, seed: r.seed, gen: r.gen });
  }
  for (let i = 0; i < pub.length; i += 100) {
    const { error } = await admin.from('arena_sudoku_stages').upsert(pub.slice(i, i + 100), { onConflict: 'stage' });
    if (error) throw new Error('upsert stages: ' + error.message);
  }
  for (let i = 0; i < sec.length; i += 100) {
    const { error } = await admin.from('arena_sudoku_stage_secrets').upsert(sec.slice(i, i + 100), { onConflict: 'stage' });
    if (error) throw new Error('upsert secrets: ' + error.message);
  }
  return { written: pub.length, unchanged: same, skippedPlayed: skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  loadEnv();
  if (opt('--verify')) {
    const recs = JSON.parse(readFileSync(resolve(opt('--verify')), 'utf8'));
    const t0 = Date.now();
    const problems = verifyRecords(recs);
    console.log(distribution(recs));
    console.log(problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : 'verified ' + recs.length + ' stages: all unique, grades reproduce, bands monotonic (' + (Date.now() - t0) + ' ms)');
    process.exitCode = problems.length ? 1 : 0;
    return;
  }
  if (opt('--reproduce')) {
    const recs = JSON.parse(readFileSync(resolve(opt('--reproduce')), 'utf8'));
    let bad = 0;
    for (const r of recs) {
      const x = reproduceStage(r);
      if (!x || x.puzzle !== r.puzzle || x.solution !== r.solution) { bad++; console.log('stage ' + r.stage + ' does NOT reproduce'); }
    }
    console.log(bad ? bad + ' stage(s) failed to reproduce' : 'all ' + recs.length + ' stages reproduce from their stored seeds');
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (opt('--apply')) {
    const recs = JSON.parse(readFileSync(resolve(opt('--apply')), 'utf8'));
    const problems = verifyRecords(recs);
    if (problems.length) { console.log('refusing to apply — verification failed:\n  ' + problems.join('\n  ')); process.exitCode = 1; return; }
    const res = await applyToDb(recs, args.includes('--force'));
    console.log('applied: ' + res.written + ' written (' + res.unchanged + ' already identical), ' + res.skippedPlayed + ' skipped because players have attempts');
    return;
  }
  const outFile = opt('--out');
  if (!outFile) {
    console.log('usage: --out <file> [--count 300] [--seed <master>] | --verify <file> | --reproduce <file> | --apply <file> [--force]');
    return;
  }
  let master = masterSeed(opt('--seed'));
  if (!master) {
    master = randomBytes(16).toString('hex');
    const dir = join(ROOT, 'scratch');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sudoku-master-seed.txt'), master + '\n');
    console.log('no master seed found — created scratch/sudoku-master-seed.txt (gitignored; keep it private)');
  }
  const count = Number(opt('--count') || 300);
  const t0 = Date.now();
  const recs = generateStages({ master, count, log: args.includes('--quiet') ? null : (s => console.log(s)) });
  const problems = verifyRecords(recs);
  const dest = resolve(outFile);
  if (!existsSync(dirname(dest))) mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(recs, null, 1));
  console.log('\n' + distribution(recs));
  console.log('\n' + recs.length + ' stages → ' + outFile + ' in ' + Math.round((Date.now() - t0) / 1000) + ' s; verification: ' + (problems.length ? problems.length + ' problem(s)\n  ' + problems.join('\n  ') : 'clean'));
  if (problems.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
}
