// =============================================================================
// stamp-shared-assets.mjs — cache-bust the shared CSS/JS so ONLINE always
// matches OFFLINE the instant a shared file changes.
//
// WHY: this is a no-build static site served from GitHub Pages, which caches
// assets in the browser (and its CDN). When a file in shared/ changes, returning
// browsers keep serving the OLD cached copy until the cache expires — so the
// live site can look different from the local/offline copy for a while. (This
// bit the Google-login button/divider: the deployed common.css was correct but
// browsers held a stale copy.)
//
// FIX: append ?v=<content-hash> to every shared/*.css and shared/*.js reference.
// The hash changes ONLY when the file's contents change, so:
//   • edit a shared file  -> new hash -> new URL -> every browser fetches it
//     immediately (no waiting on cache expiry), so online == offline.
//   • unchanged files keep their hash -> stay cached (no needless re-downloads).
//
// USAGE: run from the repo root WHENEVER you change anything in shared/, before
// committing:   node scripts/stamp-shared-assets.mjs
// It rewrites the <link>/<script> references in index.html + tools/*.html in
// place. Idempotent: re-running with no shared changes produces no diff. It only
// touches query strings — never any visual/behavioural markup.
// =============================================================================
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'shared');

// 1. Hash every shared CSS/JS file (8-char sha1 of its contents).
const hashes = {};
for (const f of readdirSync(SHARED)) {
  if (!/\.(css|js)$/i.test(f)) continue;
  hashes[f] = createHash('sha1').update(readFileSync(join(SHARED, f))).digest('hex').slice(0, 8);
}

// 2. The live-site HTML: index.html + every tools/*.html (skip node_modules,
//    the docs/_*.html exports, etc — they aren't served as the app).
const htmlFiles = ['index.html'];
for (const f of readdirSync(join(ROOT, 'tools'))) {
  if (f.endsWith('.html')) htmlFiles.push(join('tools', f));
}

// 3. Rewrite (href|src)="…shared/<name>.(css|js)[?…]" → "…shared/<name>?v=<hash>".
//    The \2 backreference makes the closing quote match the opening one so we
//    never mangle mixed-quote attributes.
const RE = /((?:href|src)\s*=\s*)(["'])((?:\.\.\/)?shared\/([A-Za-z0-9._-]+\.(?:css|js)))(?:\?[^"']*)?\2/g;

let totalRefs = 0, unknown = new Set();
for (const rel of htmlFiles) {
  const p = join(ROOT, rel);
  const before = readFileSync(p, 'utf8');
  let n = 0;
  const after = before.replace(RE, (m, pre, q, path, name) => {
    const h = hashes[name];
    if (!h) { unknown.add(name); return m; }   // not a known shared file — leave alone
    n++;
    return `${pre}${q}${path}?v=${h}${q}`;
  });
  if (after !== before) { writeFileSync(p, after); }
  if (n) { totalRefs += n; console.log(`  ${rel}: ${n} ref(s)`); }
}

console.log(`\nStamped ${totalRefs} shared-asset reference(s) across ${htmlFiles.length} HTML files.`);
console.log(`Shared files hashed: ${Object.keys(hashes).length}.`);
if (unknown.size) console.log(`Note: referenced but not found in shared/ (left as-is): ${[...unknown].join(', ')}`);
