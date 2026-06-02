// =============================================================================
// scripts/check-static.mjs
//
// Pre-deploy sanity gate for this no-build static site. Two cheap checks
// that catch the exact failure modes we keep hitting by hand:
//
//   1. JS SYNTAX — `node --check` every .js/.mjs in shared/ and scripts/.
//      Catches the stray brace / typo before it ships to GitHub Pages,
//      where there's no build step to surface it.
//
//   2. BROKEN LOCAL REFS — scan every .html (root + tools/) and .css
//      (shared/) for src="…", href="…", and url(…) that point at a LOCAL
//      file, resolve each against its source file, and assert the target
//      exists on disk. Catches a renamed asset / moved shared file that a
//      tool still references (e.g. sydney-coverpage.jpg → global-coverpage.jpg).
//
// No dependencies — Node built-ins only. Run locally with `npm run check`
// or in CI via .github/workflows/ci.yml. Exits non-zero on any failure.
//
// Deliberately conservative on refs: only flags paths that are
// unambiguously local + static. Skips protocol URLs, data:, #anchors,
// mailto:/tel:/javascript:, query/hash suffixes, and anything that looks
// templated (${…}, {{…}}). JS-built URLs never appear as static attribute
// values, so they're out of scope by construction.
// =============================================================================

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ── helpers ───────────────────────────────────────────────────── */
function listFiles(dir, exts) {
  const out = [];
  let entries;
  try { entries = readdirSync(join(ROOT, dir)); } catch { return out; }
  for (const name of entries) {
    const rel = join(dir, name);
    const abs = join(ROOT, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isFile() && exts.some(e => name.endsWith(e))) out.push(rel);
  }
  return out;
}

const failures = [];
function fail(msg) { failures.push(msg); }

/* ── check 1: JS syntax ────────────────────────────────────────── */
const jsFiles = [
  ...listFiles('shared',  ['.js', '.mjs']),
  ...listFiles('scripts', ['.js', '.mjs']),
];
let jsChecked = 0;
for (const rel of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, rel)], { stdio: 'pipe' });
    jsChecked++;
  } catch (e) {
    const detail = (e.stderr ? e.stderr.toString() : (e.message || '')).trim();
    fail(`JS syntax: ${rel}\n    ${detail.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

/* ── check 2: broken local refs ─────────────────────────────────
   These tools are single-file: huge inline <script> blocks live in
   the same .html as the markup. Scanning raw text matched JS like
   `URL(blob)` / `el.href = x` as if they were asset refs, so we
   first MASK the JS: blank <script>…</script> before reading
   attributes, and only read url(…) from inside <style>…</style>
   (or real .css files). Masking is newline-preserving so the line
   numbers in error messages stay accurate. */
const SKIP_PREFIX = ['http:', 'https:', '//', 'data:', 'mailto:', 'tel:', 'javascript:', '#'];
function isLocalRef(ref) {
  if (!ref) return false;
  const r = ref.trim();
  if (!r) return false;
  if (SKIP_PREFIX.some(p => r.toLowerCase().startsWith(p))) return false;
  if (r.includes('${') || r.includes('{{') || r.includes('<')) return false; // templated/JS
  return true;
}
function cleanRef(ref) {
  // Drop query + hash so "../index.html?x=1#y" resolves to "../index.html".
  return ref.split('#')[0].split('?')[0].trim();
}
/* Replace a matched region with same-length blanks, preserving \n so
   downstream line numbers are unchanged. */
function blankMatches(text, re) {
  return text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}
/* Blank everything EXCEPT the inner text of <style> blocks (newline-
   preserving) so url(…) is only read from CSS, never from JS. */
function keepOnlyStyles(text) {
  let out = text.replace(/[^\n]/g, ' ');
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleRe.exec(text)) !== null) {
    const inner = m[1];
    const innerStart = m.index + m[0].length - ('</style>'.length) - inner.length;
    out = out.slice(0, innerStart) + inner + out.slice(innerStart + inner.length);
  }
  return out;
}

const ATTR_RE = /(?:\bsrc|\bhref)\s*=\s*["']([^"']+)["']/gi;
const URL_RE  = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/gi;

function checkRef(rel, baseDir, raw, lineNo) {
  if (!isLocalRef(raw)) return;
  const cleaned = cleanRef(raw);
  if (!cleaned) return;
  // Leading "/" = root-relative (GitHub Pages serves from domain root).
  const target = cleaned.startsWith('/')
    ? join(ROOT, cleaned.slice(1))
    : resolve(baseDir, cleaned);
  if (!existsSync(target)) {
    fail(`Missing ref: ${rel}:${lineNo} → "${raw}" (resolved ${relative(ROOT, target)})`);
  }
}
function scanLines(rel, baseDir, text, re) {
  text.split('\n').forEach((line, i) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) checkRef(rel, baseDir, m[1], i + 1);
  });
}
function scanRefs(rel) {
  const abs = join(ROOT, rel);
  const baseDir = dirname(abs);
  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { return; }
  if (rel.endsWith('.css')) {
    scanLines(rel, baseDir, text, URL_RE);
    return;
  }
  // HTML: attributes from script-masked markup; url() from styles only.
  scanLines(rel, baseDir, blankMatches(text, /<script\b[\s\S]*?<\/script>/gi), ATTR_RE);
  scanLines(rel, baseDir, keepOnlyStyles(text), URL_RE);
}

const refFiles = [
  ...listFiles('.',      ['.html']),
  ...listFiles('tools',  ['.html']),
  ...listFiles('shared', ['.css']),
];
refFiles.forEach(scanRefs);

/* ── report ────────────────────────────────────────────────────── */
console.log(`Checked ${jsChecked}/${jsFiles.length} JS files and ${refFiles.length} HTML/CSS files for local refs.`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} problem(s):\n`);
  for (const f of failures) console.error('  • ' + f);
  console.error('');
  process.exit(1);
}
console.log('✓ All checks passed.');
