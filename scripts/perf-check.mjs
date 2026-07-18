// =============================================================================
// perf-check.mjs — compare key transfer sizes between the live Pages site and
// a Vercel deployment (the "on-par-or-lighter" gate for the Vercel migration).
//
//   node scripts/perf-check.mjs                       # Pages vs murex prod
//   node scripts/perf-check.mjs <pages> <vercel>      # explicit bases
//
// Read-only HEAD requests. Images are checked as the raw file on Pages and via
// /_vercel/image (AVIF) on Vercel — the same routing shared/vercel-img.js does.
// =============================================================================
const PAGES_BASE = process.argv[2] || 'https://tools.performanceproperty.com.au';
const VERCEL_BASE = process.argv[3] || 'https://performance-property-tools-murex.vercel.app';

const HTML = ['/', '/tools/online-reports.html', '/tools/market-compare.html', '/tools/buying-selling-slides.html'];
const IMGS = [
  { path: '/assets/Reports/brisbane-coverpage.jpg', w: 1920 },
  { path: '/assets/Reports/global-coverpage.jpg', w: 1920 },
  { path: '/assets/Reports/market-position-clock.png', w: 1280 },
  { path: '/assets/Reports/white-circle-logo.png', w: 1280 },
  { path: '/assets/Reports/Contact-Us-Background.jpg', w: 1920 },
  { path: '/assets/Reports/client-case-studies.jpg', w: 1920 },
  { path: '/assets/leaderboard-scrabble.jpg', w: 828 },
];

const kb = n => n ? (n / 1024).toFixed(n > 1024 * 512 ? 0 : 1) + ' KB' : '—';
async function head(url, accept) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: accept ? { Accept: accept } : {} });
    return { n: +r.headers.get('content-length') || 0, ct: (r.headers.get('content-type') || '').split(';')[0], s: r.status };
  } catch (e) { return { n: 0, ct: 'unreachable', s: 0 }; }
}
const optUrl = (base, path, w) => base + '/_vercel/image?url=' + encodeURIComponent(path) + '&w=' + w + '&q=75';

console.log('perf-check — Pages: ' + PAGES_BASE + '  vs  Vercel: ' + VERCEL_BASE + '\n');
let worse = 0;

async function body(url) {
  try { const r = await fetch(url, { redirect: 'follow' }); const buf = await r.arrayBuffer(); return { n: buf.byteLength, s: r.status }; }
  catch (e) { return { n: 0, s: 0 }; }
}
console.log('HTML (identical bytes expected — same commit on both hosts):');
for (const p of HTML) {
  const [a, b] = await Promise.all([body(PAGES_BASE + p), body(VERCEL_BASE + p)]);
  const note = a.n === b.n ? 'identical' : 'differs (branches out of sync?)';
  const flag = b.n > a.n * 1.02 ? '  ← HEAVIER' : '';
  if (flag) worse++;
  console.log('  ' + p.padEnd(38) + kb(a.n).padStart(9) + '  →' + kb(b.n).padStart(9) + '  ' + note + flag);
}

console.log('\nImages (raw on Pages → optimized on Vercel):');
for (const { path, w } of IMGS) {
  const [a, b] = await Promise.all([
    head(PAGES_BASE + path),
    head(optUrl(VERCEL_BASE, path, w), 'image/avif,image/webp,image/*'),
  ]);
  const ratio = a.n && b.n ? ' (' + (a.n / b.n).toFixed(0) + 'x lighter)' : '';
  const flag = (!b.n || b.s !== 200 || b.n >= a.n) ? '  ← CHECK' : '';
  if (flag) worse++;
  console.log('  ' + path.split('/').pop().padEnd(38) + kb(a.n).padStart(9) + '  →' + kb(b.n).padStart(9) + '  ' + b.ct + ratio + flag);
}

console.log('\n' + (worse ? 'RESULT: ' + worse + ' item(s) flagged — investigate before syncing os-next.' : 'RESULT: on-par-or-lighter — all clear.'));
process.exit(worse ? 1 : 0);
