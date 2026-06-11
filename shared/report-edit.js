/* ═════════════════════════════════════════════════════════════════
   Performance Property — Report Edit System (shared module)
   ─────────────────────────────────────────────────────────────────
   This file is the in-tool editor for the National + Commercial
   research reports. It's a direct port of the regional
   online-reports.html edit system, packaged as a shared module so
   both new tools use the same code. The regional tool keeps its own
   inline copy (no risk of regression).

   Slice contracts (port progresses one slice at a time):
     Slice 1 (already inlined in the host HTML):
       - ACTIVE_REGION, RS_BUCKET_KEYS, rsBundleFromCache,
         rsApplyToCache, rsAppendAudit, rsSetStatus,
         rsLoadFromServer, rsScheduleSave, rsDoSave, rsBoot
       - View/Edit pill toggle wired in HTML
     Slice 2 (THIS FILE):
       - Custom-text overlays (load/save/render/etc.) with the
         right-side formatting panel: font, size, bold, italic,
         underline, align, color, link, copy-to-pages, delete
       - Per-word selection styling that survives blur
       - Group multi-select + group drag
       - Plain-text paste
       - Undo / Redo (Ctrl+Z / Ctrl+Y, snapshots all overlay state)
       - Side TOC: rebuild with .num + .lbl + actions row
       - TOC drag-and-drop reorder
       - TOC inline rename
       - TOC duplicate / delete page
       - Page-num auto-injection
       - +Text / +Page / Grid buttons on the pager
       - Page CRUD (add blank / duplicate / delete / reorder)
     Slice 3 (NEXT):
       - Shape overlays + shape panel (fill/stroke/gradient/link)
       - Image overlays + resize handles
       - Page-background editor + bulk apply
     Slice 4 (NEXT):
       - Backup (download / import / restore)
       - Sync modal (apply this region's customisations to others)
       - Audit-log modal (read-only edit history)
       - Reference Bands modal

   Stubs in this file (Slice 3 fills them in):
     - _shEntries, shSave, shRenderAll, shDeselectAll → no-op
     - _imgEntries, imgSave, imgRenderAll, imgDeselectAll → no-op
     - loadPageBgs / savePageBgs / applyStoredPageBgs / setPageBg /
       setPageBgs / _setPageBgInto → operate as no-ops so undo
       snapshots round-trip without crashing
   ═════════════════════════════════════════════════════════════════ */

/* The host HTML defines ACTIVE_REGION + rsScheduleSave + rsAppendAudit
   + getCurrentUserDisplay/Email as globals (Slice 1 + shared/auth.js).
   Read them defensively so this module also works when loaded into
   an environment that hasn't initialised them yet. */
function _rs_scheduleSave() {
  if (typeof rsScheduleSave === 'function') rsScheduleSave();
}
function _rs_appendAudit(action, details, force) {
  if (typeof rsAppendAudit === 'function') rsAppendAudit(action, details, force);
}
function _rs_active() {
  return (typeof ACTIVE_REGION !== 'undefined') ? ACTIVE_REGION : '';
}

/* ─── localStorage key derivations (must match Slice 1's RS_BUCKET_KEYS) ─── */
const CT_STORAGE_KEY     = (slug) => 'ppa-online-reports-custom-texts-v2-' + slug;
const PAGE_ORDER_KEY     = (slug) => 'ppa-online-reports-page-order-v1-'   + slug;
const CUSTOM_PAGES_KEY   = (slug) => 'ppa-online-reports-custom-pages-v1-' + slug;
const PAGE_LABELS_KEY    = (slug) => 'ppa-online-reports-page-labels-v1-'  + slug;
const PAGE_BG_KEY        = (slug) => 'ppa-online-reports-page-bgs-v1-'     + slug;

function _readJson(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return (v === undefined || v === null) ? fallback : v; }
  catch { return fallback; }
}

/* ═════════════ Page metadata helpers ═════════════ */
function pageMetaList() {
  return Array.from(document.querySelectorAll('section.page[id]')).map(s => ({
    id: s.id,
    label: s.dataset.label || s.id,
  }));
}

/* Idempotent: nukes existing badges and re-injects so this can be
   called both at boot AND after add / delete / duplicate / reorder. */
function injectPageNumbers() {
  document.querySelectorAll('.page-num').forEach(el => el.remove());
  const meta = pageMetaList();
  const total = meta.length;
  meta.forEach((m, i) => {
    const page = document.getElementById(m.id);
    if (!page) return;
    const tag = document.createElement('div');
    tag.className = 'page-num';
    tag.textContent = (i + 1) + ' / ' + total;
    page.appendChild(tag);
  });
}

/* ═════════════ Page order / labels / custom pages / bgs ═════════════
   Each saver hooks rsScheduleSave so localStorage writes also push to
   Supabase. setPageLabel / setPageBg ALSO push history so Ctrl+Z
   undoes them. */
function loadPageOrder()    { return _readJson(PAGE_ORDER_KEY(_rs_active()),   null); }
function loadCustomPages()  { return _readJson(CUSTOM_PAGES_KEY(_rs_active()), []); }
function loadPageLabels()   { return _readJson(PAGE_LABELS_KEY(_rs_active()),  {}); }
function savePageOrder(ids) { localStorage.setItem(PAGE_ORDER_KEY(_rs_active()),   JSON.stringify(ids)); _rs_scheduleSave(); }
function saveCustomPages(p) { localStorage.setItem(CUSTOM_PAGES_KEY(_rs_active()), JSON.stringify(p));   _rs_scheduleSave(); }
function savePageLabels(m)  { localStorage.setItem(PAGE_LABELS_KEY(_rs_active()),  JSON.stringify(m));   _rs_scheduleSave(); }

/* Page-bg helpers — STUBBED for Slice 2. Slice 3 fills these in with
   the popover editor + bulk apply UI. Until then they still need to
   persist so undo snapshots can round-trip them. */
function loadPageBgs()      { return _readJson(PAGE_BG_KEY(_rs_active()), {}); }
function savePageBgs(m)     { localStorage.setItem(PAGE_BG_KEY(_rs_active()), JSON.stringify(m)); _rs_scheduleSave(); }
function applyStoredPageBgs() {
  const map = loadPageBgs();
  Object.entries(map).forEach(([id, value]) => {
    const sec = document.getElementById(id);
    if (sec && value) sec.style.background = value;
  });
}
function _setPageBgInto(map, pageId, value) {
  const sec = document.getElementById(pageId);
  if (!sec) return;
  if (value) { sec.style.background = value; map[pageId] = value; }
  else { sec.style.background = ''; delete map[pageId]; }
}
function setPageBg(pageId, value) {
  const map = loadPageBgs();
  _setPageBgInto(map, pageId, value);
  savePageBgs(map);
  if (!_ctRestoring) ctPushHistory();
}
function setPageBgs(pageIds, value) {
  if (!pageIds || !pageIds.length) return;
  const map = loadPageBgs();
  pageIds.forEach(id => _setPageBgInto(map, id, value));
  savePageBgs(map);
  if (!_ctRestoring) ctPushHistory();
}

/* Apply the stored labels map onto each section's data-label so the
   chrome (TOC + page-num) renders the saved names. */
function applyStoredLabels() {
  const map = loadPageLabels();
  Object.entries(map).forEach(([pageId, label]) => {
    const sec = document.getElementById(pageId);
    if (sec) sec.dataset.label = label;
  });
}

/* Commit a rename. */
function setPageLabel(pageId, label) {
  const sec = document.getElementById(pageId);
  if (!sec) return;
  sec.dataset.label = label;
  const map = loadPageLabels();
  map[pageId] = label;
  savePageLabels(map);
  refreshChrome();
  if (sec.dataset.custom === 'true') persistCustomPages();
  if (!_ctRestoring) ctPushHistory();
}

/* ═════════════ Custom-text overlay system ═════════════ */
function ctStorageKey() { return CT_STORAGE_KEY(_rs_active()); }

/* Pre-region legacy custom-text bucket (no region suffix). Only ever
   written by the old regional tool; migrated once into Sydney's v2
   bucket. Harmless for the research reports — the key never exists
   there, so the migration is a no-op. */
const CT_LEGACY_KEY = 'ppa-online-reports-custom-texts-v1';

function ctLoad() {
  /* One-time migration: fold any legacy (un-suffixed) entries into the
     Sydney bucket, then drop the legacy key. Sydney is hardcoded on
     purpose — that's where the pre-region data belongs. */
  try {
    const legacy = localStorage.getItem(CT_LEGACY_KEY);
    if (legacy && !localStorage.getItem(CT_STORAGE_KEY('sydney'))) {
      localStorage.setItem(CT_STORAGE_KEY('sydney'), legacy);
    }
    if (legacy) localStorage.removeItem(CT_LEGACY_KEY);
  } catch (_) { /* storage may be disabled — ignore */ }
  let entries;
  try { entries = JSON.parse(localStorage.getItem(ctStorageKey()) || '[]') || []; }
  catch (e) { entries = []; }
  /* Legacy whole-overlay URL → inline <a> migration. Older entries
     stored { url } separately; new shape is the link wrapping the
     entry's full text. After migration the entries are written back
     so a future load doesn't need to migrate again. */
  let migrated = false;
  entries.forEach(e => {
    if (e.url && typeof e.text === 'string') {
      const safeUrl  = String(e.url).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeText = e.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      e.text = '<a href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">' + safeText + '</a>';
      delete e.url;
      migrated = true;
    } else if (e.url) {
      delete e.url;
      migrated = true;
    }
  });
  if (migrated) {
    try { localStorage.setItem(ctStorageKey(), JSON.stringify(entries)); } catch (_) {}
  }
  return entries;
}

function ctSave(entries) {
  localStorage.setItem(ctStorageKey(), JSON.stringify(entries));
  if (!_ctRestoring) ctPushHistory();
  _rs_scheduleSave();
}

let _ctEntries = [];

/* ─── Undo / Redo — unified history. Snapshots all overlay state so
   Ctrl+Z reverts a text edit, a page rename, a label change, or a
   page reorder identically. Shapes / images / page-bgs ARE captured
   so the structure stays correct when Slice 3 adds the real ones. */
let _ctHistory = [];
let _ctHistoryIdx = -1;
let _ctRestoring = false;
const CT_HISTORY_MAX = 60;

/* Slice 3 — shape + image overlay systems (full port from regional).
   Storage keys mirror Slice 1's RS_BUCKET_KEYS so the sync layer
   bundles them automatically. */
const SH_STORAGE_KEY  = (slug) => 'ppa-online-reports-shapes-v1-' + slug;
const IMG_STORAGE_KEY = (slug) => 'ppa-online-reports-images-v1-' + slug;
function shStorageKey()  { return SH_STORAGE_KEY(_rs_active()); }
function imgStorageKey() { return IMG_STORAGE_KEY(_rs_active()); }

function shLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(shStorageKey()) || '[]') || [];
    return raw.map(_shNormalizeEntry);
  } catch { return []; }
}
function shSave(entries) {
  localStorage.setItem(shStorageKey(), JSON.stringify(entries));
  if (!_ctRestoring) ctPushHistory();
  _rs_scheduleSave();
}
function imgLoad() {
  try { return JSON.parse(localStorage.getItem(imgStorageKey()) || '[]') || []; }
  catch { return []; }
}
function imgSave(entries) {
  try { localStorage.setItem(imgStorageKey(), JSON.stringify(entries)); }
  catch (e) {
    /* localStorage quota is ~5-10MB; data-URL images can blow through
       it fast. Surface a clear message instead of failing silently. */
    if (e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e)))) {
      alert('Image storage is full. Delete a few images (or use smaller files) to make room.');
    }
    throw e;
  }
  if (!_ctRestoring) ctPushHistory();
  _rs_scheduleSave();
}

let _shEntries  = [];
let _imgEntries = [];

function _capturePagesHTML() {
  const wrap = document.querySelector('.page-outer-wrap');
  if (!wrap) return '';
  const tmp = wrap.cloneNode(true);
  tmp.querySelectorAll('.custom-text').forEach(el => el.remove());
  tmp.querySelectorAll('.shape').forEach(el => el.remove());
  tmp.querySelectorAll('.image-overlay').forEach(el => el.remove());
  tmp.querySelectorAll('.page-num').forEach(el => el.remove());
  return tmp.innerHTML;
}

function _ctSnapshot() {
  const last = _ctHistory[_ctHistoryIdx];
  const html = _capturePagesHTML();
  return {
    ctEntries: JSON.parse(JSON.stringify(_ctEntries)),
    pagesHTML: (last && last.pagesHTML === html) ? last.pagesHTML : html,
    pageLabels: loadPageLabels(),
    pageBgs: loadPageBgs(),
    shEntries: JSON.parse(JSON.stringify(_shEntries)),
    imgEntries: JSON.parse(JSON.stringify(_imgEntries)),
  };
}

function ctPushHistory() {
  _ctHistory = _ctHistory.slice(0, _ctHistoryIdx + 1);
  _ctHistory.push(_ctSnapshot());
  if (_ctHistory.length > CT_HISTORY_MAX) _ctHistory.shift();
  _ctHistoryIdx = _ctHistory.length - 1;
}

function ctUndo() {
  if (_ctHistoryIdx <= 0) return;
  _ctHistoryIdx--;
  _ctRestoreSnapshot(_ctHistory[_ctHistoryIdx]);
}
function ctRedo() {
  if (_ctHistoryIdx >= _ctHistory.length - 1) return;
  _ctHistoryIdx++;
  _ctRestoreSnapshot(_ctHistory[_ctHistoryIdx]);
}

function _ctRestoreSnapshot(snapshot) {
  _ctRestoring = true;
  try {
    const wrap = document.querySelector('.page-outer-wrap');
    if (wrap && typeof snapshot.pagesHTML === 'string') {
      wrap.innerHTML = snapshot.pagesHTML;
    }
    _ctEntries = JSON.parse(JSON.stringify(snapshot.ctEntries || []));
    ctSave(_ctEntries);
    persistOrderFromDOM();
    persistCustomPages();
    savePageLabels(snapshot.pageLabels || {});
    applyStoredLabels();
    savePageBgs(snapshot.pageBgs || {});
    applyStoredPageBgs();
    refreshChrome();
    _shEntries  = JSON.parse(JSON.stringify(snapshot.shEntries  || []));
    _imgEntries = JSON.parse(JSON.stringify(snapshot.imgEntries || []));
    shSave(_shEntries);
    imgSave(_imgEntries);
    ctRenderAll();
    shRenderAll();
    imgRenderAll();
    /* Re-init charts so pages that came back through the undo (their HTML was
       just replaced, wiping the ECharts canvases) repaint. Prefer the host's
       registered re-render hook — the regional tool renders via ACTIVE_REGION
       + PpaCharts, NOT renderAllCharts/REPORT_DATA, so without this hook undo
       left regional charts blank until a hard refresh. */
    if (typeof window !== 'undefined' && typeof window.PPA_RERENDER_CHARTS === 'function') {
      try { window.PPA_RERENDER_CHARTS(); } catch (_) {}
    } else if (typeof renderAllCharts === 'function' && typeof REPORT_DATA !== 'undefined' && REPORT_DATA) {
      try { renderAllCharts(REPORT_DATA); } catch (_) {}
    }
    ctDeselectAll();
    ctUpdateSidebar();
    shDeselectAll();
    imgDeselectAll();
  } finally {
    _ctRestoring = false;
  }
}

function setupUndoRedo() {
  document.addEventListener('keydown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    const isCtrl = ev.ctrlKey || ev.metaKey;
    if (!isCtrl) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    const k = (ev.key || '').toLowerCase();
    if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); ctUndo(); }
    else if (k === 'y' || (k === 'z' && ev.shiftKey)) { ev.preventDefault(); ctRedo(); }
  });
}

function ctEntryById(id) { return _ctEntries.find(e => e.id === id); }

/* ─── Render-time token substitution.
   Tokens are STORED as literal placeholders; substituted on render.
   For National + Commercial, only {year} and {region} / {REGION} make
   sense. {state} / {peer} / {kind} resolve to empty strings (those
   come from REGION_MANIFEST in the regional file). */
function ctRender(t) {
  if (t == null) return '';
  /* Pluggable token resolver. A host tool can set window.PPA_CT_TOKENS to
     a function(str) => str that does its own substitution — e.g. the
     regional Online Reports tool injects full REGION_MANIFEST-based
     {STATE}/{PEER}/{KIND} resolution. When unset (national/commercial),
     the built-in below runs unchanged. This is the seam that lets the
     regional tool reuse this shared ctRender without losing its richer
     token set during the #5 consolidation. */
  if (typeof window !== 'undefined' && typeof window.PPA_CT_TOKENS === 'function') {
    try { return window.PPA_CT_TOKENS(String(t)); }
    catch (_) { /* fall through to the built-in on any resolver error */ }
  }
  const slug = _rs_active();
  const regionName =
    (slug === 'national') ? 'National' :
    (slug === 'commercial') ? 'Commercial' :
    (slug.charAt(0).toUpperCase() + slug.slice(1));
  return String(t)
    .replace(/\{REGION\}/g, regionName.toUpperCase())
    .replace(/\{region\}/g, regionName)
    .replace(/\{STATE\}/g, '')
    .replace(/\{state\}/g, '')
    .replace(/\{PEER\}/g,  '')
    .replace(/\{peer\}/g,  '')
    .replace(/\{KIND\}/g,  '')
    .replace(/\{kind\}/g,  '')
    .replace(/\{year\}/g,  new Date().getFullYear());
}

/* ─── Shared Source Library (public.report_sources) ─────────────────────
   A "Source: …" overlay can carry a `sourceId` pointing at a shared row in
   report_sources. When set, the overlay renders the LIBRARY text (so editing
   a source once updates every region/report that references it) while keeping
   its own per-region position + styling. Unlinked overlays (no sourceId) are
   completely unaffected — this layer is additive. */
let _srcLib = Object.create(null);     // sourceId -> { label, text }
let _srcLibLoaded = false;

/* The text an overlay should display: shared library text when linked + the
   source is loaded, else the overlay's own cached text. */
function ctResolveText(entry) {
  if (entry && entry.sourceId && _srcLib[entry.sourceId]) return _srcLib[entry.sourceId].text;
  return entry ? entry.text : '';
}

async function loadReportSourceLib(opts) {
  opts = opts || {};
  if (typeof window === 'undefined' || !window.sb) {
    /* Supabase client not ready yet — retry briefly. Linked overlays fall
       back to their cached entry.text until the library arrives, so this is
       never blocking. */
    if ((opts._tries || 0) < 12) setTimeout(() => loadReportSourceLib({ _tries: (opts._tries || 0) + 1 }), 400);
    return;
  }
  try {
    const { data, error } = await window.sb.from('report_sources').select('id, label, text');
    if (error) { console.warn('report_sources load:', error.message || error); return; }
    const next = Object.create(null);
    (data || []).forEach(r => { next[r.id] = { label: r.label || '', text: r.text || '' }; });
    _srcLib = next;
    _srcLibLoaded = true;
    if (typeof ctRenderAll === 'function') ctRenderAll();   // re-render with shared text now available
  } catch (e) { console.warn('report_sources load failed:', e); }
}

/* Edit write-back: when a LINKED overlay's text is edited, persist it to the
   shared source row, update the cache, and re-render every overlay that
   references it (propagation). dev/admin only via RLS — the editor itself is
   already writer-gated. The re-render is deferred so it doesn't yank the
   element the caller is mid-commit on. */
async function ctSaveSourceText(sourceId, text) {
  if (!sourceId) return;
  if (_srcLib[sourceId]) _srcLib[sourceId].text = text;
  else _srcLib[sourceId] = { label: '', text: text };
  setTimeout(() => { if (typeof ctRenderAll === 'function') ctRenderAll(); }, 0);
  if (typeof window === 'undefined' || !window.sb) return;
  try {
    const { error } = await window.sb.from('report_sources').update({ text: text }).eq('id', sourceId);
    if (error) console.warn('report_sources save:', error.message || error);
  } catch (e) { console.warn('report_sources save failed:', e); }
}

/* ─── Chunk 3: Source Library UI (manage + link) ──────────────────────
   All built dynamically (no host HTML/CSS), so it works for all three
   report tools. Writes hit report_sources (RLS = dev/admin); the editor is
   already writer-gated, so a non-writer can't reach these. */
const _SRC_BTN = 'cursor:pointer;border:1px solid rgba(92,200,224,0.35);background:rgba(92,200,224,0.12);color:#cdeaf3;border-radius:6px;padding:6px 10px;font-size:12px;';

async function _srcCreate(label, text) {
  if (!window.sb) { alert('Sign-in required to create a shared source.'); return null; }
  try {
    const { data, error } = await window.sb.from('report_sources')
      .insert({ label: label || '', text: text || '' }).select('id, label, text').single();
    if (error) { console.warn('source create:', error.message || error); alert('Could not create source (dev/admin only).'); return null; }
    _srcLib[data.id] = { label: data.label || '', text: data.text || '' };
    return data.id;
  } catch (e) { console.warn('source create failed', e); return null; }
}
async function _srcUpdate(id, fields) {
  if (!id) return;
  if (_srcLib[id]) Object.assign(_srcLib[id], fields);
  if (typeof ctRenderAll === 'function') ctRenderAll();
  if (!window.sb) return;
  try { const { error } = await window.sb.from('report_sources').update(fields).eq('id', id);
    if (error) console.warn('source update:', error.message || error); }
  catch (e) { console.warn('source update failed', e); }
}
async function _srcDelete(id) {
  if (!id) return;
  delete _srcLib[id];
  /* Unlink any overlays in THIS region that referenced it — they keep their
     own cached text. (Other regions revert on their next load.) */
  _ctEntries.forEach(e => { if (e.sourceId === id) delete e.sourceId; });
  ctSave(_ctEntries);
  if (typeof ctRenderAll === 'function') ctRenderAll();
  if (!window.sb) return;
  try { const { error } = await window.sb.from('report_sources').delete().eq('id', id);
    if (error) console.warn('source delete:', error.message || error); }
  catch (e) { console.warn('source delete failed', e); }
}
function _ctSelectedEntry() {
  const el = (typeof ctGetSelectedEl === 'function') ? ctGetSelectedEl() : null;
  return el ? _ctEntries.find(e => e.id === el.dataset.id) : null;
}
function _ctLinkSelected(sourceId) {
  const entry = _srcModalEntry || _ctSelectedEntry();
  if (!entry) { alert('Select a source text overlay first.'); return; }
  entry.sourceId = sourceId;
  if (_srcLib[sourceId]) entry.text = _srcLib[sourceId].text;   /* cache for offline render */
  ctSave(_ctEntries);
  if (typeof ctRenderAll === 'function') ctRenderAll();
}
async function _ctMakeSelectedShared(label) {
  const entry = _srcModalEntry || _ctSelectedEntry();
  if (!entry) { alert('Select a source text overlay first.'); return; }
  const id = await _srcCreate(label, entry.text || '');
  if (!id) return;
  entry.sourceId = id;
  ctSave(_ctEntries);
  if (typeof ctRenderAll === 'function') ctRenderAll();
}
/* Current-region helper: group this region's UNLINKED, source-looking text
   overlays ("Source…") by identical text, create one shared source per group
   + link them. Then use "Apply to other regions" to carry the links across. */
/* Link the source overlays in ONE overlay array (a region's `texts` bucket)
   to the shared library: group UNLINKED, "Source…" overlays by text, reuse an
   existing library source when the text matches (else create one), set
   sourceId. Mutates the array entries in place. ONLY touches source overlays —
   every other overlay (incl. p3/p4 major-happenings annotations) is untouched.
   Returns { created, linked, changed }. Used by both the current-region link
   button and the all-regions source sync. */
async function _srcLinkOverlayArray(texts) {
  let created = 0, linked = 0, changed = false;
  if (!Array.isArray(texts)) return { created, linked, changed };
  const groups = Object.create(null);
  texts.forEach(e => {
    if (!e || e.sourceId) return;
    const plain = (e.text || '').replace(/<[^>]*>/g, '').trim();
    if (!/^source/i.test(plain)) return;
    const key = (e.text || '').trim();
    (groups[key] = groups[key] || []).push(e);
  });
  for (const key of Object.keys(groups)) {
    const target = key.trim();
    let id = Object.keys(_srcLib).find(sid => (_srcLib[sid].text || '').trim() === target);
    if (!id) { id = await _srcCreate(key.replace(/<[^>]*>/g, '').slice(0, 60), key); if (id) created++; }
    if (id) { groups[key].forEach(e => { e.sourceId = id; }); linked += groups[key].length; changed = true; }
  }
  return { created, linked, changed };
}

/* Current-region helper. */
async function ctLinkExistingTexts() {
  const candidates = _ctEntries.filter(e => e && !e.sourceId && /^source/i.test((e.text || '').replace(/<[^>]*>/g, '').trim()));
  if (!candidates.length) { alert('No unlinked "Source…" texts found in this region.'); return; }
  if (!confirm('Link this region’s ' + candidates.length + ' "Source…" overlay(s) to the shared library — reusing existing sources where the text matches, creating new ones otherwise? Other overlays are not touched.')) return;
  const r = await _srcLinkOverlayArray(_ctEntries);
  ctSave(_ctEntries);
  if (typeof ctRenderAll === 'function') ctRenderAll();
  alert('Linked ' + r.linked + ' overlay(s) — ' + r.created + ' new shared source(s) created.');
}

/* All-regions source sync. For every regional report: read its OWN `texts`
   bucket from reports_state, link only its "Source…" overlays to the shared
   library (merge — sets sourceId; never adds/removes/moves any overlay), and
   write the bucket back. Major-happenings annotations live in the same bucket
   but are read + written back unchanged, so they're never clobbered. */
async function syncSourcesAllRegions() {
  if (typeof window === 'undefined' || !window.sb) { alert('Sign-in required.'); return; }
  if (typeof REGIONAL_REGIONS === 'undefined' || !REGIONAL_REGIONS) { alert('Region list unavailable.'); return; }
  const slugs = Object.keys(REGIONAL_REGIONS);
  if (!confirm('Link the "Source…" overlays in ALL ' + slugs.length + ' regional reports to the shared library?\n\nThis is a MERGE — it only sets source links and never adds, removes, or moves any other overlay, so each region keeps its own major-happenings annotations. New shared sources are created for any source text not already in the library.')) return;
  const active = _rs_active();
  let okCount = 0, totalLinked = 0, totalCreated = 0; const errors = [];
  for (const slug of slugs) {
    try {
      if (slug === active) {
        const r = await _srcLinkOverlayArray(_ctEntries);
        if (r.changed) { ctSave(_ctEntries); if (typeof ctRenderAll === 'function') ctRenderAll(); }
        okCount++; totalLinked += r.linked; totalCreated += r.created;
        continue;
      }
      const { data, error } = await window.sb.from('reports_state').select('payload').eq('region', slug).maybeSingle();
      if (error) throw error;
      const payload = (data && data.payload && typeof data.payload === 'object') ? data.payload : null;
      if (!payload || !Array.isArray(payload.texts) || !payload.texts.length) { okCount++; continue; }
      const r = await _srcLinkOverlayArray(payload.texts);
      if (r.changed) {
        const { error: wErr } = await window.sb.from('reports_state').upsert({ region: slug, payload: payload }, { onConflict: 'region' });
        if (wErr) throw wErr;
      }
      okCount++; totalLinked += r.linked; totalCreated += r.created;
    } catch (e) { errors.push(slug + ': ' + (e && (e.message || e.code) || e)); }
  }
  alert('Source sync complete.\nRegions processed: ' + okCount + '/' + slugs.length +
        '\nOverlays linked: ' + totalLinked + '\nNew shared sources created: ' + totalCreated +
        (errors.length ? '\n\nErrors:\n' + errors.slice(0, 8).join('\n') : ''));
}

let _srcModalEl = null;
let _srcModalEntry = null;
function closeSourcesModal() { if (_srcModalEl) _srcModalEl.style.display = 'none'; }
function openSourcesModal() {
  /* Capture the selected overlay NOW — clicking inside the modal (it's
     appended to <body>) fires the editor's document deselect handler, so by
     the time a modal button is clicked the overlay is no longer `.selected`. */
  _srcModalEntry = _ctSelectedEntry();
  if (!_srcModalEl) {
    _srcModalEl = document.createElement('div');
    _srcModalEl.id = 'src-lib-modal';
    _srcModalEl.style.cssText = 'position:fixed;inset:0;z-index:12000;display:none;align-items:center;justify-content:center;background:rgba(5,12,18,0.55);';
    _srcModalEl.addEventListener('click', ev => { if (ev.target === _srcModalEl) closeSourcesModal(); });
    const panel = document.createElement('div');
    panel.id = 'src-lib-panel';
    panel.style.cssText = 'background:#101c26;color:#e6eef5;border:1px solid rgba(92,200,224,0.3);border-radius:14px;max-width:640px;width:92%;max-height:84vh;overflow:auto;padding:20px 22px;font:14px/1.5 Roboto,system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.5);';
    _srcModalEl.appendChild(panel);
    document.body.appendChild(_srcModalEl);
  }
  _renderSourcesModal();
  _srcModalEl.style.display = 'flex';
}
function _renderSourcesModal() {
  const panel = _srcModalEl && _srcModalEl.querySelector('#src-lib-panel');
  if (!panel) return;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const selEntry = _srcModalEntry;
  const ids = Object.keys(_srcLib);
  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
    + '<h2 style="margin:0;font-size:18px;">Shared Sources</h2>'
    + '<button data-act="close" style="background:none;border:none;color:#9fb3c2;font-size:22px;cursor:pointer;line-height:1;">×</button></div>'
    + '<p style="margin:0 0 14px;color:#9fb3c2;font-size:12px;">A source’s text is shared by every region linked to it. Edit it once — here, or on any linked overlay — and all reports update.</p>';
  html += '<div style="border:1px solid rgba(92,200,224,0.2);border-radius:10px;padding:12px;margin-bottom:14px;">';
  if (selEntry) {
    const preview = esc((selEntry.text || '').replace(/<[^>]*>/g, '').slice(0, 80)) || '(empty)';
    html += '<div style="font-size:12px;color:#9fb3c2;margin-bottom:6px;">Selected overlay</div><div style="margin-bottom:8px;">“' + preview + '”</div>';
    if (selEntry.sourceId && _srcLib[selEntry.sourceId]) {
      html += '<div style="color:#5cc8e0;">🔗 Linked to <strong>' + esc(_srcLib[selEntry.sourceId].label || '(unlabeled)') + '</strong> '
        + '<button data-act="unlink" style="' + _SRC_BTN + 'margin-left:8px;">Unlink</button></div>';
    } else {
      html += '<button data-act="make-shared" style="' + _SRC_BTN + '">Make this a shared source</button> ';
      if (ids.length) {
        html += '<select data-act="link-existing" style="margin-left:8px;background:#0b141c;border:1px solid rgba(255,255,255,0.18);color:#e6eef5;border-radius:6px;padding:6px 8px;font-size:12px;">'
          + '<option value="">Link to existing…</option>'
          + ids.map(id => '<option value="' + esc(id) + '">' + esc(_srcLib[id].label || '(unlabeled)') + '</option>').join('') + '</select>';
      }
    }
  } else {
    html += '<div style="color:#9fb3c2;font-size:12px;">Select a source text overlay to link it. You can still manage the library below.</div>';
  }
  html += '</div><div style="font-size:12px;color:#9fb3c2;margin-bottom:6px;">Library</div>';
  if (!ids.length) html += '<div style="color:#9fb3c2;margin-bottom:10px;">No shared sources yet.</div>';
  ids.forEach(id => {
    const s = _srcLib[id];
    html += '<div data-src="' + esc(id) + '" style="border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;margin-bottom:8px;">'
      + '<input data-f="label" value="' + esc(s.label) + '" placeholder="Label" style="width:100%;box-sizing:border-box;margin-bottom:6px;background:#0b141c;border:1px solid rgba(255,255,255,0.15);color:#e6eef5;border-radius:6px;padding:6px 8px;">'
      + '<textarea data-f="text" rows="2" placeholder="Source text" style="width:100%;box-sizing:border-box;background:#0b141c;border:1px solid rgba(255,255,255,0.15);color:#e6eef5;border-radius:6px;padding:6px 8px;">' + esc(s.text) + '</textarea>'
      + '<div style="margin-top:6px;display:flex;gap:8px;"><button data-act="save-src" style="' + _SRC_BTN + '">Save</button>'
      + '<button data-act="del-src" style="cursor:pointer;border:1px solid rgba(248,113,113,0.4);background:rgba(248,113,113,0.12);color:#fca5a5;border-radius:6px;padding:6px 10px;font-size:12px;">Delete</button></div></div>';
  });
  html += '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">'
    + '<button data-act="new-src" style="' + _SRC_BTN + '">+ New source</button>'
    + '<button data-act="link-existing-bulk" style="' + _SRC_BTN + '">Link this region’s source texts</button>'
    + '<button data-act="sync-all-sources" style="' + _SRC_BTN + '" title="Link the Source… overlays in every regional report to the shared library — merge only, never touches other overlays">Sync sources → all regions</button></div>';
  panel.innerHTML = html;
  panel.onclick = async (ev) => {
    const t = ev.target.closest('[data-act]'); if (!t) return;
    const act = t.dataset.act;
    if (act === 'close') return closeSourcesModal();
    if (act === 'unlink') { const e = _srcModalEntry; if (e) { delete e.sourceId; ctSave(_ctEntries); if (typeof ctRenderAll === 'function') ctRenderAll(); _renderSourcesModal(); } return; }
    if (act === 'make-shared') { const e = _srcModalEntry; if (!e) { alert('Select a source text overlay first.'); return; } const label = prompt('Label for this shared source:', (e.text || '').replace(/<[^>]*>/g, '').slice(0, 60)); if (label === null) return; await _ctMakeSelectedShared(label); _renderSourcesModal(); return; }
    if (act === 'new-src') { const id = await _srcCreate('New source', ''); if (id) _renderSourcesModal(); return; }
    if (act === 'link-existing-bulk') { await ctLinkExistingTexts(); _renderSourcesModal(); return; }
    if (act === 'sync-all-sources') { await syncSourcesAllRegions(); _renderSourcesModal(); return; }
    const row = t.closest('[data-src]');
    if (act === 'save-src' && row) { await _srcUpdate(row.dataset.src, { label: row.querySelector('[data-f="label"]').value, text: row.querySelector('[data-f="text"]').value }); return; }
    if (act === 'del-src' && row) { if (confirm('Delete this shared source? Linked overlays revert to their own text.')) { await _srcDelete(row.dataset.src); _renderSourcesModal(); } return; }
  };
  panel.onchange = (ev) => {
    const sel = ev.target.closest('select[data-act="link-existing"]');
    if (sel && sel.value) { _ctLinkSelected(sel.value); _renderSourcesModal(); }
  };
}

/* Pin/unpin the selected text overlay(s) to a fixed RIGHT edge. Pinning locks
   the overlay's CURRENT right edge (no jump) so text grows leftward and it
   stays aligned regardless of length; unpinning restores left-anchoring at the
   current position. Then drag it to the box margin once and it stays there. */
function _ctTogglePinRight() {
  const els = Array.from(document.querySelectorAll('.custom-text.selected'));
  if (!els.length) { alert('Select a text overlay first.'); return; }
  els.forEach(el => {
    const entry = _ctEntries.find(e => e.id === el.dataset.id);
    if (!entry) return;
    if (entry.anchorRight) {
      const rx = (entry.rightX != null ? entry.rightX : entry.x) || 0;
      entry.x = Math.round(rx - el.offsetWidth);   /* restore left at current pos */
      delete entry.anchorRight; delete entry.rightX;
    } else {
      entry.rightX = Math.round((entry.x || 0) + el.offsetWidth);   /* lock current right edge */
      entry.anchorRight = true;
    }
  });
  ctSave(_ctEntries);
  if (typeof ctRenderAll === 'function') ctRenderAll();
}

/* Inject the "Sources" + "Pin right" triggers beside the text-format toolbar
   (visible when a text overlay is selected, i.e. edit mode). Graceful if the
   toolbar's absent in a given host. */
function setupSourcesUI() {
  try {
    const anchor = document.getElementById('ct-bold');
    if (!anchor || !anchor.parentNode) return;
    if (!document.getElementById('ct-sources-btn')) {
      const btn = document.createElement('button');
      btn.id = 'ct-sources-btn';
      btn.type = 'button';
      btn.title = 'Shared sources — link this overlay to a source shared across all regions';
      btn.textContent = '🔗 Sources';
      btn.style.cssText = 'margin-left:6px;' + _SRC_BTN;
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openSourcesModal(); });
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    }
    if (!document.getElementById('ct-pinright-btn')) {
      const pin = document.createElement('button');
      pin.id = 'ct-pinright-btn';
      pin.type = 'button';
      pin.title = 'Pin the selected text to a fixed RIGHT edge so it stays aligned no matter the length (click again to unpin)';
      pin.textContent = '⇥ Pin right';
      pin.style.cssText = 'margin-left:6px;' + _SRC_BTN;
      pin.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); _ctTogglePinRight(); });
      const ref = document.getElementById('ct-sources-btn') || anchor;
      anchor.parentNode.insertBefore(pin, ref.nextSibling);
    }
  } catch (_) {}
}

function ctApplyStyle(el, entry) {
  if (entry.fontSize)   el.style.fontSize   = entry.fontSize + 'px';
  if (entry.fontWeight) el.style.fontWeight = entry.fontWeight;
  if (entry.fontStyle)  el.style.fontStyle  = entry.fontStyle;
  if (entry.fontFamily) el.style.fontFamily = "'" + entry.fontFamily + "', 'Roboto', sans-serif";
  if (entry.textDecoration === 'underline' || entry.textDecoration === 'none') {
    el.dataset.deco = entry.textDecoration;
  } else {
    delete el.dataset.deco;
  }
  el.style.color = entry.color || '';
  el.style.textAlign = entry.textAlign || '';
  const sizePx = +entry.fontSize || 12;
  el.style.lineHeight = sizePx >= 20 ? '0.90' : '';
}

function _ctRgbToHex(rgb) {
  if (!rgb) return '#1a2838';
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return '#1a2838';
  return '#' + m.slice(0, 3).map(n =>
    Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')
  ).join('');
}

const CT_PAGE_W = 1200;   /* design page width (px) — basis for right-edge anchoring */
function ctMakeEl(entry) {
  const page = document.getElementById(entry.pageId);
  if (!page) return null;
  const el = document.createElement('div');
  el.className = 'custom-text' + (entry.cls ? ' ' + entry.cls : '');
  el.dataset.id = entry.id;
  /* Right-edge anchoring: a "pinned" overlay locks its RIGHT edge to a fixed
     page-x (entry.rightX) so text grows leftward and it stays aligned with the
     box edge no matter the length. Default overlays anchor by their left (x). */
  if (entry.anchorRight) {
    el.style.left  = 'auto';
    el.style.right = (CT_PAGE_W - (entry.rightX != null ? entry.rightX : entry.x)) + 'px';
  } else {
    el.style.left  = entry.x + 'px';
    el.style.right = '';
  }
  el.style.top  = entry.y + 'px';
  ctApplyStyle(el, entry);
  el.innerHTML = ctRender(ctResolveText(entry));
  ctAttachHandlers(el, entry);
  page.appendChild(el);
  return el;
}

function ctAttachHandlers(el, entry) {
  let dragging = false, sx = 0, sy = 0, moved = false;
  let groupItems = null;

  el.addEventListener('click', (ev) => {
    const target = ev.target;
    const link   = (target && target.closest) ? target.closest('a') : null;
    const isLink = link && el.contains(link);
    if (document.body.classList.contains('edit-mode')) {
      if (isLink) ev.preventDefault();
      return;
    }
    if (isLink) {
      ev.preventDefault();
      const href = link.getAttribute('href');
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
    }
  });

  el.addEventListener('mousedown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    if (el.classList.contains('editing')) return;

    const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
    const wasSelected = el.classList.contains('selected');
    if (additive) {
      el.classList.toggle('selected');
      ctUpdateSidebar();
      _selUpdateMultiClass();
      ev.preventDefault();
      return;
    }
    if (!wasSelected) {
      ctDeselectAll();
      shDeselectAll();
      el.classList.add('selected');
      ctUpdateSidebar();
      _selUpdateMultiClass();
    }
    groupItems = _captureGroupDragItems();
    dragging = true; moved = false;
    sx = ev.clientX; sy = ev.clientY;
    ev.preventDefault();
  });

  document.addEventListener('mousemove', ev => {
    if (!dragging) return;
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    if (groupItems) _applyGroupDragDelta(groupItems, dx, dy);
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (moved && groupItems) _commitGroupDrag(groupItems);
    groupItems = null;
  });

  el.addEventListener('dblclick', () => {
    if (!document.body.classList.contains('edit-mode')) return;
    el.classList.add('editing');
    el.contentEditable = 'true';
    el.innerHTML = entry.text || '';
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.focus();
  });

  el.addEventListener('paste', ev => {
    if (!el.classList.contains('editing')) return;
    ev.preventDefault();
    const cd = ev.clipboardData || window.clipboardData;
    const text = ((cd ? cd.getData('text/plain') : '') || '').replace(/\r\n?/g, '\n');
    if (!text) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  });

  el.addEventListener('keydown', ev => {
    if (!el.classList.contains('editing')) return;
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const nl = document.createTextNode('\n');
    range.insertNode(nl);
    range.setStartAfter(nl);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  });

  el.addEventListener('blur', () => {
    if (!el.classList.contains('editing')) return;
    setTimeout(() => {
      if (!el.classList.contains('editing')) return;
      const ae = document.activeElement;
      if (ae === el) return;
      if (ae && ae.closest && ae.closest('.ct-panel')) return;
      el.classList.remove('editing');
      el.contentEditable = 'false';
      entry.text = _ctReadEditableHtml(el).trim();
      if (entry.sourceId) ctSaveSourceText(entry.sourceId, entry.text);   /* shared source: write-back + propagate */
      el.innerHTML = ctRender(ctResolveText(entry));
      ctSave(_ctEntries);
      _ctClearSavedSel();
    }, 0);
  });
}

/* DOM walker → storage-safe HTML string. Handles text, <br>, <div>,
   <p>, <a>, <span style="…" with whitelisted props>, plus legacy
   <b>/<strong>/<u>/<i>/<em>/<font>. Anything else: drop the wrapper,
   keep its children. */
function _ctReadEditableHtml(root) {
  const parts = [];
  let blockSeen = false;
  const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ALLOWED = ['font-weight', 'font-style', 'font-size', 'font-family', 'color', 'text-decoration'];
  const cleanVal = (v) => String(v == null ? '' : v).replace(/[<>"\\]/g, '').trim();
  const stylesFromInline = (el) => {
    const out = [];
    ALLOWED.forEach(prop => {
      const v = el.style.getPropertyValue(prop);
      const safe = cleanVal(v);
      if (safe) out.push(prop + ':' + safe);
    });
    return out.join(';');
  };
  const emitSpanWith = (styleString, node) => {
    if (styleString) {
      parts.push('<span style="' + escAttr(styleString) + '">');
      node.childNodes.forEach(walk);
      parts.push('</span>');
    } else {
      node.childNodes.forEach(walk);
    }
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(escText(node.nodeValue || '')); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (tag === 'BR') { parts.push('\n'); return; }
    if (tag === 'DIV' || tag === 'P') {
      if (blockSeen) {
        const last = parts.length ? parts[parts.length - 1] : '';
        if (last && !/\n$/.test(last)) parts.push('\n');
      }
      blockSeen = true;
      node.childNodes.forEach(walk);
      return;
    }
    if (tag === 'A') {
      const rawHref = (node.getAttribute('href') || '').trim();
      const safeHref = /^javascript:/i.test(rawHref) ? '' : rawHref;
      if (safeHref) {
        const aStyles = [];
        ['text-decoration', 'border-bottom', 'padding-bottom'].forEach(prop => {
          const v = cleanVal(node.style.getPropertyValue(prop));
          if (!v) return;
          const imp = node.style.getPropertyPriority(prop) === 'important';
          aStyles.push(prop + ':' + v + (imp ? ' !important' : ''));
        });
        const styleAttr = aStyles.length ? ' style="' + escAttr(aStyles.join(';')) + '"' : '';
        parts.push('<a href="' + escAttr(safeHref) + '" target="_blank" rel="noopener noreferrer"' + styleAttr + '>');
        node.childNodes.forEach(walk);
        parts.push('</a>');
      } else {
        node.childNodes.forEach(walk);
      }
      return;
    }
    if (tag === 'SPAN') { emitSpanWith(stylesFromInline(node), node); return; }
    if (tag === 'B' || tag === 'STRONG') { emitSpanWith('font-weight:700', node); return; }
    if (tag === 'U') { emitSpanWith('text-decoration:underline', node); return; }
    if (tag === 'I' || tag === 'EM') { emitSpanWith('font-style:italic', node); return; }
    if (tag === 'FONT') {
      const styles = [];
      const c = cleanVal(node.getAttribute('color'));
      const f = cleanVal(node.getAttribute('face'));
      if (c) styles.push('color:' + c);
      if (f) styles.push('font-family:' + f);
      emitSpanWith(styles.join(';'), node);
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return parts.join('');
}

function ctRenderAll() {
  /* Idempotent: remove any previously-rendered text overlays first, so a
     re-render on an already-populated page (e.g. after the shared source
     library loads, or a source edit propagates) doesn't duplicate them. */
  document.querySelectorAll('.custom-text').forEach(el => el.remove());
  _ctEntries.forEach(ctMakeEl);
}

/* ═════════════ Group selection + group drag ═════════════ */
function _selUpdateMultiClass() {
  const ctSel = document.querySelectorAll('.custom-text.selected').length;
  document.body.classList.toggle('multi-select', ctSel > 1);
}

function _captureGroupDragItems() {
  const items = [];
  document.querySelectorAll('.custom-text.selected').forEach(el => {
    const entry = _ctEntries.find(e => e.id === el.dataset.id);
    if (!entry) return;
    items.push({
      kind: 'text', el, entry,
      startX: parseFloat(el.style.left) || 0,
      startY: parseFloat(el.style.top) || 0,
      anchorRight: !!entry.anchorRight,
      startRightX: (entry.rightX != null ? entry.rightX : (entry.x || 0)),
    });
  });
  document.querySelectorAll('.shape.selected').forEach(el => {
    const entry = _shEntries.find(e => e.id === el.dataset.id);
    if (!entry) return;
    items.push({
      kind: 'shape', el, entry,
      startX:  entry.x,  startY:  entry.y,
      startX1: entry.x1, startY1: entry.y1,
      startX2: entry.x2, startY2: entry.y2,
    });
  });
  document.querySelectorAll('.image-overlay.selected').forEach(el => {
    const entry = _imgEntries.find(e => e.id === el.dataset.id);
    if (!entry) return;
    items.push({
      kind: 'image', el, entry,
      startX: entry.x, startY: entry.y,
    });
  });
  return items;
}

/* Apply (dx, dy) to every captured drag item. Text overlays update only
   inline left/top during the drag (entry.x/y commits on mouseup, matching
   the single-item path). Shapes + images update entry geometry directly +
   redraw so handles/bbox track each frame; lines/arrows also translate both
   endpoints and re-derive the bbox. */
function _applyGroupDragDelta(items, dx, dy) {
  items.forEach(item => {
    if (item.kind === 'text') {
      if (item.anchorRight) {
        item.el.style.left  = 'auto';
        item.el.style.right = (CT_PAGE_W - (item.startRightX + dx)) + 'px';
      } else {
        item.el.style.left = (item.startX + dx) + 'px';
      }
      item.el.style.top  = (item.startY + dy) + 'px';
    } else if (item.kind === 'image') {
      item.entry.x = Math.round(item.startX + dx);
      item.entry.y = Math.round(item.startY + dy);
      imgRedraw(item.el, item.entry);
    } else {
      item.entry.x = Math.round(item.startX + dx);
      item.entry.y = Math.round(item.startY + dy);
      if (item.entry.type === 'line' || item.entry.type === 'arrow') {
        item.entry.x1 = Math.round(item.startX1 + dx);
        item.entry.y1 = Math.round(item.startY1 + dy);
        item.entry.x2 = Math.round(item.startX2 + dx);
        item.entry.y2 = Math.round(item.startY2 + dy);
        _shRecalcBbox(item.entry);
      }
      shRedraw(item.el, item.entry);
    }
  });
}

/* Commit a finished group drag: reconcile text entries from their live
   inline style, then write each storage bucket that changed and push exactly
   ONE undo snapshot for the whole drag (naive ctSave + shSave would push
   two history steps). */
function _commitGroupDrag(items) {
  let textChanged = false, shapeChanged = false, imageChanged = false;
  items.forEach(item => {
    if (item.kind === 'text') {
      const y = parseFloat(item.el.style.top) || 0;
      if (item.anchorRight) {
        const rx = CT_PAGE_W - (parseFloat(item.el.style.right) || 0);
        if (rx !== item.startRightX || y !== item.startY) {
          item.entry.rightX = Math.round(rx);
          item.entry.y = y;
          textChanged = true;
        }
      } else {
        const x = parseFloat(item.el.style.left) || 0;
        if (x !== item.startX || y !== item.startY) {
          item.entry.x = x;
          item.entry.y = y;
          textChanged = true;
        }
      }
    } else if (item.kind === 'image') {
      if (item.entry.x !== item.startX || item.entry.y !== item.startY) imageChanged = true;
    } else {
      if (item.entry.x !== item.startX || item.entry.y !== item.startY) shapeChanged = true;
    }
  });
  const n = (textChanged ? 1 : 0) + (shapeChanged ? 1 : 0) + (imageChanged ? 1 : 0);
  if (n >= 2) {
    if (textChanged)  localStorage.setItem(ctStorageKey(),  JSON.stringify(_ctEntries));
    if (shapeChanged) localStorage.setItem(shStorageKey(),  JSON.stringify(_shEntries));
    if (imageChanged) localStorage.setItem(imgStorageKey(), JSON.stringify(_imgEntries));
    if (!_ctRestoring) ctPushHistory();
    _rs_scheduleSave();
  } else if (textChanged) {
    ctSave(_ctEntries);
  } else if (shapeChanged) {
    shSave(_shEntries);
  } else if (imageChanged) {
    imgSave(_imgEntries);
  }
}

/* ─── Per-word selection styling. Stashed selection survives the
   panel-click blur cycle. _ctApplyToSelection wraps the highlighted
   text in <span style="…"> with the requested style props; returns
   true if a selection-mode apply happened, false to fall through to
   the entry-level apply. */
let _ctSavedSel = null;
function _ctSaveSel() {
  /* Null out on every fail path so a stale selection from a previous
     edit can't leak into a different text box's per-word styling. */
  const editing = document.querySelector('.custom-text.editing');
  if (!editing) { _ctSavedSel = null; return; }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { _ctSavedSel = null; return; }
  const range = sel.getRangeAt(0);
  if (!editing.contains(range.commonAncestorContainer)) { _ctSavedSel = null; return; }
  _ctSavedSel = { editing, range: range.cloneRange() };
}
function _ctClearSavedSel() { _ctSavedSel = null; }
function _ctRestoreSel() {
  if (!_ctSavedSel) return false;
  const { editing, range } = _ctSavedSel;
  /* Guard against use-after-blur: the editing element may have been
     removed, or had its 'editing' class cleared, since we saved. */
  if (!document.body.contains(editing) || !editing.classList.contains('editing')) return false;
  if (!editing.contains(range.commonAncestorContainer)) return false;
  editing.focus();
  const sel = window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}
function _ctApplyToSelection(stylesObj) {
  if (!_ctSavedSel || _ctSavedSel.range.collapsed) return false;
  if (!_ctRestoreSel()) return false;
  const editing = _ctSavedSel.editing;
  const range = _ctSavedSel.range;
  const span = document.createElement('span');
  Object.entries(stylesObj).forEach(([k, v]) => {
    /* Browser style props use camelCase; e.g. 'fontWeight' not 'font-weight'. */
    span.style[k] = v;
  });
  try {
    const frag = range.extractContents();
    span.appendChild(frag);
    range.insertNode(span);
  } catch (e) {
    console.warn('Selection apply failed', e);
    return false;
  }
  const entry = _ctEntries.find(e => e.id === editing.dataset.id);
  if (entry) {
    entry.text = _ctReadEditableHtml(editing);
    ctSave(_ctEntries);
  }
  /* Re-snapshot the selection at the span so chained edits land in
     the same place. */
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    _ctSavedSel = { editing, range: sel.getRangeAt(0).cloneRange() };
  }
  return true;
}

/* ═════════════ Add / Delete text overlay ═════════════ */
function ctVisiblePageId() {
  const vh = window.innerHeight;
  let bestId = null, bestArea = 0;
  document.querySelectorAll('.page').forEach(p => {
    const r = p.getBoundingClientRect();
    const top = Math.max(0, r.top);
    const bot = Math.min(vh, r.bottom);
    const area = Math.max(0, bot - top);
    if (area > bestArea) { bestArea = area; bestId = p.id; }
  });
  return bestId;
}

function ctAddNew(initialText) {
  const pageId = ctVisiblePageId();
  if (!pageId) return;
  const page = document.getElementById(pageId);
  const pageRect = page.getBoundingClientRect();
  const vh = window.innerHeight;
  const visibleTop = Math.max(0, pageRect.top);
  const visibleBot = Math.min(vh, pageRect.bottom);
  const visibleMid = (visibleTop + visibleBot) / 2;
  const yOnPage = visibleMid - pageRect.top;
  const xOnPage = page.clientWidth / 2 - 60;

  /* Dark-background pages need light text to stay readable. The set
     differs per report: the regional reports use p1 (cover) + p2
     (at-a-glance); the research reports use p1 (cover) + the contact
     page (commercial p25 / national p33, also tagged .cover). Scope
     the research-only IDs so a regional Perth p33 (a normal chart
     page) isn't wrongly treated as dark. */
  const _slug = _rs_active();
  const onDarkPage = REGIONAL_REGIONS[_slug]
    ? (pageId === 'p1' || pageId === 'p2')
    : (pageId === 'p1' || page.classList.contains('cover')
       || page.id === (_slug === 'commercial' ? 'p25' : 'p33'));

  const entry = {
    id: 'ct-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    pageId,
    x: Math.round(xOnPage),
    y: Math.round(yOnPage),
    text: (typeof initialText === 'string' && initialText) ? initialText : 'Double-click to edit. Tip: {year} auto-updates.',
    cls: onDarkPage ? 'light' : 'on-chart',
    fontSize: 12,
    fontFamily: 'Roboto',
  };
  _ctEntries.push(entry);
  ctSave(_ctEntries);
  const el = ctMakeEl(entry);
  if (!document.body.classList.contains('edit-mode')) {
    document.body.classList.add('edit-mode');
    document.getElementById('btn-mode-edit')?.classList.add('on');
    document.getElementById('btn-mode-view')?.classList.remove('on');
  }
  if (el) {
    ctDeselectAll();
    shDeselectAll();
    el.classList.add('selected');
    ctUpdateSidebar();
  }
}

function ctDeselectAll() {
  document.querySelectorAll('.custom-text.selected').forEach(el => {
    el.classList.remove('selected');
  });
  ctUpdateSidebar();
  _selUpdateMultiClass();
}
function ctGetSelectedEl()    { return document.querySelector('.custom-text.selected'); }
function ctGetSelectedEntry() {
  const el = ctGetSelectedEl();
  if (!el) return null;
  return _ctEntries.find(e => e.id === el.dataset.id);
}

function ctUpdateSidebar() {
  const panel = document.getElementById('ct-panel');
  if (!panel) return;
  const entry = ctGetSelectedEntry();
  if (!entry) { panel.classList.add('no-selection'); return; }
  panel.classList.remove('no-selection');
  const fontSel  = document.getElementById('ct-font');
  const sizeInp  = document.getElementById('ct-size');
  const boldBtn  = document.getElementById('ct-bold');
  const italBtn  = document.getElementById('ct-italic');
  const ulBtn    = document.getElementById('ct-underline');
  const colorInp = document.getElementById('ct-color');
  const hexInp   = document.getElementById('ct-color-hex');
  if (fontSel) fontSel.value = entry.fontFamily || 'Roboto';
  if (sizeInp) sizeInp.value = entry.fontSize   || 12;
  if (boldBtn) boldBtn.classList.toggle('on', (entry.fontWeight || 400) >= 700);
  if (italBtn) italBtn.classList.toggle('on', entry.fontStyle === 'italic');
  if (ulBtn)   ulBtn.classList.toggle('on',   entry.textDecoration === 'underline');
  ['left','center','right'].forEach(k => {
    const b = document.getElementById('ct-align-' + k);
    if (b) b.classList.toggle('on', entry.textAlign === k);
  });
  if (colorInp || hexInp) {
    let hex;
    if (entry.color) hex = entry.color;
    else {
      const el = document.querySelector('.custom-text[data-id="' + entry.id + '"]');
      hex = el ? _ctRgbToHex(getComputedStyle(el).color) : '#1a2838';
    }
    if (colorInp) colorInp.value = hex;
    if (hexInp)   { hexInp.value = hex; hexInp.classList.remove('invalid'); }
  }
}

function ctWithSelected(fn) {
  const el = ctGetSelectedEl();
  const entry = ctGetSelectedEntry();
  if (!el || !entry) return;
  fn(el, entry);
  ctSave(_ctEntries);
}

/* ═════════════ Panel wiring ═════════════ */
function ctInit() {
  ctRenderAll();
  /* Seed history so the first undo lands on the boot baseline. */
  ctPushHistory();
  setupUndoRedo();

  const btnAdd = document.getElementById('btn-add');
  if (btnAdd) btnAdd.addEventListener('click', ctAddNew);

  /* Click outside text/shape/image (in edit mode) deselects. */
  document.addEventListener('mousedown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    if (ev.target.closest('.custom-text')) return;
    if (ev.target.closest('.shape')) return;
    if (ev.target.closest('.image-overlay')) return;
    /* `.pager` is the regional tool's pager class; `.pp-pager` is the
       research reports'. Match both so clicking the pager never
       deselects an overlay mid-edit in either host. */
    if (ev.target.closest('.pp-pager, .pager')) return;
    if (ev.target.closest('.ct-panel')) return;
    if (ev.target.closest('.sh-panel')) return;
    if (ev.target.closest('.side-toc')) return;
    if (ev.target.closest('#sh-picker')) return;
    if (ev.target.closest('#bg-popover')) return;
    ctDeselectAll();
    shDeselectAll();
    imgDeselectAll();
  });

  const panel = document.getElementById('ct-panel');
  if (!panel) return;
  /* Save the contenteditable's selection before focus moves to a
     panel control — per-word style applies need the cached range. */
  panel.addEventListener('mousedown', ev => {
    _ctSaveSel();
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    ev.preventDefault();
  });
  /* When focus leaves the panel and the editor, finalise the edit. */
  panel.addEventListener('focusout', () => {
    setTimeout(() => {
      const editing = document.querySelector('.custom-text.editing');
      if (!editing) return;
      const ae = document.activeElement;
      if (ae === editing) return;
      if (ae && ae.closest && ae.closest('.ct-panel')) return;
      editing.classList.remove('editing');
      editing.contentEditable = 'false';
      const entry = _ctEntries.find(e => e.id === editing.dataset.id);
      if (entry) {
        entry.text = _ctReadEditableHtml(editing).trim();
        if (entry.sourceId) ctSaveSourceText(entry.sourceId, entry.text);   /* shared source: write-back + propagate */
        editing.innerHTML = ctRender(ctResolveText(entry));
        ctSave(_ctEntries);
      }
      _ctClearSavedSel();
    }, 0);
  });

  /* ── Font ── */
  const fontSel = document.getElementById('ct-font');
  if (fontSel) fontSel.addEventListener('change', ev => {
    if (_ctApplyToSelection({ fontFamily: "'" + ev.target.value + "', 'Roboto', sans-serif" })) return;
    ctWithSelected((el, entry) => {
      entry.fontFamily = ev.target.value;
      ctApplyStyle(el, entry);
    });
  });

  /* ── Size ── */
  const sizeInput = document.getElementById('ct-size');
  if (sizeInput) sizeInput.addEventListener('input', () => {
    let v = parseInt(sizeInput.value, 10);
    if (isNaN(v)) return;
    v = Math.max(8, Math.min(140, v));
    if (_ctApplyToSelection({ fontSize: v + 'px' })) return;
    ctWithSelected((el, entry) => {
      entry.fontSize = v;
      ctApplyStyle(el, entry);
    });
  });
  function _ctSelectionComputed(prop) {
    if (!_ctSavedSel) return null;
    const node = _ctSavedSel.range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return null;
    return getComputedStyle(el).getPropertyValue(prop);
  }
  function _ctSelectionSizePx() {
    const v = parseInt(_ctSelectionComputed('font-size'), 10);
    return Number.isFinite(v) ? v : 12;
  }
  const sizeMinus = document.getElementById('ct-size-minus');
  if (sizeMinus) sizeMinus.addEventListener('click', () => {
    if (_ctSavedSel && !_ctSavedSel.range.collapsed) {
      const next = Math.max(8, _ctSelectionSizePx() - 2);
      if (sizeInput) sizeInput.value = next;
      if (_ctApplyToSelection({ fontSize: next + 'px' })) return;
    }
    ctWithSelected((el, entry) => {
      entry.fontSize = Math.max(8, (entry.fontSize || 12) - 2);
      ctApplyStyle(el, entry);
      if (sizeInput) sizeInput.value = entry.fontSize;
    });
  });
  const sizePlus = document.getElementById('ct-size-plus');
  if (sizePlus) sizePlus.addEventListener('click', () => {
    if (_ctSavedSel && !_ctSavedSel.range.collapsed) {
      const next = Math.min(140, _ctSelectionSizePx() + 2);
      if (sizeInput) sizeInput.value = next;
      if (_ctApplyToSelection({ fontSize: next + 'px' })) return;
    }
    ctWithSelected((el, entry) => {
      entry.fontSize = Math.min(140, (entry.fontSize || 12) + 2);
      ctApplyStyle(el, entry);
      if (sizeInput) sizeInput.value = entry.fontSize;
    });
  });

  /* ── Bold / Italic ── */
  const boldBtn = document.getElementById('ct-bold');
  if (boldBtn) boldBtn.addEventListener('click', () => {
    if (_ctSavedSel && !_ctSavedSel.range.collapsed) {
      const cur = parseInt(_ctSelectionComputed('font-weight'), 10) || 400;
      const next = cur >= 700 ? '400' : '700';
      if (_ctApplyToSelection({ fontWeight: next })) return;
    }
    ctWithSelected((el, entry) => {
      const isBold = (entry.fontWeight || 400) >= 700;
      entry.fontWeight = isBold ? 400 : 700;
      el.style.fontWeight = entry.fontWeight;
      boldBtn.classList.toggle('on', !isBold);
    });
  });
  const italBtn = document.getElementById('ct-italic');
  if (italBtn) italBtn.addEventListener('click', () => {
    if (_ctSavedSel && !_ctSavedSel.range.collapsed) {
      const cur = (_ctSelectionComputed('font-style') || '').trim();
      const next = (cur === 'italic') ? 'normal' : 'italic';
      if (_ctApplyToSelection({ fontStyle: next })) return;
    }
    ctWithSelected((el, entry) => {
      const isItalic = entry.fontStyle === 'italic';
      entry.fontStyle = isItalic ? 'normal' : 'italic';
      el.style.fontStyle = entry.fontStyle;
      italBtn.classList.toggle('on', !isItalic);
    });
  });

  /* ── Underline ── */
  const ulBtn = document.getElementById('ct-underline');
  if (ulBtn) ulBtn.addEventListener('click', () => {
    if (_ctSavedSel && !_ctSavedSel.range.collapsed && _ctRestoreSel()) {
      const editing = _ctSavedSel.editing;
      const sel = window.getSelection();
      const range = sel.getRangeAt(0);
      try { document.execCommand('styleWithCSS', false, false); } catch (_) {}
      const hasUnderlineAtNode = (n) => {
        while (n && n !== editing) {
          if (n.nodeType === 1) {
            const cs = window.getComputedStyle(n);
            if (cs.textDecorationLine && cs.textDecorationLine.indexOf('underline') !== -1) return true;
          }
          n = n.parentNode;
        }
        return false;
      };
      const startNode = range.startContainer.nodeType === 3 ? range.startContainer.parentNode : range.startContainer;
      const endNode   = range.endContainer.nodeType   === 3 ? range.endContainer.parentNode   : range.endContainer;
      let isUnderlined = hasUnderlineAtNode(startNode) || hasUnderlineAtNode(endNode);
      if (!isUnderlined) isUnderlined = document.queryCommandState('underline');
      if (isUnderlined) {
        if (document.queryCommandState('underline')) document.execCommand('underline');
      } else {
        if (!document.queryCommandState('underline')) document.execCommand('underline');
      }
      const entry = _ctEntries.find(e => e.id === editing.dataset.id);
      if (entry) {
        entry.text = _ctReadEditableHtml(editing);
        ctSave(_ctEntries);
      }
      const sel2 = window.getSelection();
      if (sel2 && sel2.rangeCount > 0) {
        _ctSavedSel = { editing, range: sel2.getRangeAt(0).cloneRange() };
      }
      ulBtn.classList.toggle('on', !isUnderlined);
      return;
    }
    ctWithSelected((el, entry) => {
      const next = (entry.textDecoration === 'underline') ? 'none' : 'underline';
      entry.textDecoration = next;
      ctApplyStyle(el, entry);
      ulBtn.classList.toggle('on', next === 'underline');
    });
  });

  /* ── Align ── */
  function _ctSetAlign(value) {
    ctWithSelected((el, entry) => {
      const next = (entry.textAlign === value) ? '' : value;
      if (next) entry.textAlign = next; else delete entry.textAlign;
      ctApplyStyle(el, entry);
      ['left','center','right'].forEach(k => {
        const btn = document.getElementById('ct-align-' + k);
        if (btn) btn.classList.toggle('on', k === next);
      });
    });
  }
  ['left','center','right'].forEach(k => {
    const btn = document.getElementById('ct-align-' + k);
    if (btn) btn.addEventListener('click', () => _ctSetAlign(k));
  });

  /* ── Colour ── */
  const colorInput = document.getElementById('ct-color');
  const hexInput   = document.getElementById('ct-color-hex');
  function _ctParseHex(s) {
    const raw = String(s || '').trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return '#' + raw.toLowerCase();
    if (/^[0-9a-fA-F]{3}$/.test(raw)) return '#' + raw.split('').map(c => c + c).join('').toLowerCase();
    return null;
  }
  if (colorInput) colorInput.addEventListener('input', () => {
    if (_ctApplyToSelection({ color: colorInput.value })) {
      if (hexInput) { hexInput.value = colorInput.value; hexInput.classList.remove('invalid'); }
      return;
    }
    ctWithSelected((el, entry) => {
      entry.color = colorInput.value;
      el.style.color = entry.color;
      if (hexInput) { hexInput.value = entry.color; hexInput.classList.remove('invalid'); }
    });
  });
  if (hexInput) {
    hexInput.addEventListener('input', () => {
      const hex = _ctParseHex(hexInput.value);
      if (!hex) { hexInput.classList.toggle('invalid', hexInput.value.trim() !== ''); return; }
      hexInput.classList.remove('invalid');
      if (_ctApplyToSelection({ color: hex })) { if (colorInput) colorInput.value = hex; return; }
      ctWithSelected((el, entry) => {
        entry.color = hex;
        el.style.color = hex;
        if (colorInput) colorInput.value = hex;
      });
    });
    hexInput.addEventListener('blur', () => {
      const entry = ctGetSelectedEntry();
      if (entry && entry.color) { hexInput.value = entry.color; hexInput.classList.remove('invalid'); }
    });
  }
  const resetBtn = document.getElementById('ct-color-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    ctWithSelected((el, entry) => {
      delete entry.color;
      el.style.color = '';
      const hex = _ctRgbToHex(getComputedStyle(el).color);
      if (colorInput) colorInput.value = hex;
      if (hexInput)   { hexInput.value = hex; hexInput.classList.remove('invalid'); }
    });
  });

  /* ── Link / Unlink ── */
  function _ctEditingTarget() {
    const editing = document.querySelector('.custom-text.editing');
    if (!editing) { alert('Double-click a text box first, then highlight the words you want to link.'); return null; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      alert('Highlight the words you want to link first.');
      return null;
    }
    const range = sel.getRangeAt(0);
    if (!editing.contains(range.commonAncestorContainer)) {
      alert('Highlight text inside the editing text box first.');
      return null;
    }
    return { editing, sel, range };
  }
  const linkAddBtn = document.getElementById('ct-link-add');
  if (linkAddBtn) {
    linkAddBtn.addEventListener('mousedown', ev => ev.preventDefault());
    linkAddBtn.addEventListener('click', () => {
      const ctx = _ctEditingTarget();
      if (!ctx) return;
      const existing = (ctx.range.commonAncestorContainer.nodeType === 1
        ? ctx.range.commonAncestorContainer
        : ctx.range.commonAncestorContainer.parentElement);
      const existingA = existing && existing.closest ? existing.closest('a') : null;
      const seed = existingA ? existingA.getAttribute('href') || '' : '';
      const url = window.prompt('Link URL:', seed);
      if (url === null) return;
      const trimmed = url.trim();
      if (!trimmed) return;
      const a = document.createElement('a');
      a.setAttribute('href', trimmed);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      try {
        const fragment = ctx.range.extractContents();
        a.appendChild(fragment);
        ctx.range.insertNode(a);
        const after = document.createRange();
        after.setStartAfter(a);
        after.collapse(true);
        ctx.sel.removeAllRanges();
        ctx.sel.addRange(after);
      } catch (e) {
        console.error('Link insert failed', e);
        return;
      }
      ctx.editing.blur();
    });
  }
  const linkRemoveBtn = document.getElementById('ct-link-remove');
  if (linkRemoveBtn) {
    linkRemoveBtn.addEventListener('mousedown', ev => ev.preventDefault());
    linkRemoveBtn.addEventListener('click', () => {
      const ctx = _ctEditingTarget();
      if (!ctx) return;
      const all = ctx.editing.querySelectorAll('a');
      const hit = [];
      all.forEach(a => { if (ctx.range.intersectsNode(a)) hit.push(a); });
      if (!hit.length) { alert("The highlighted text isn't inside a link."); return; }
      hit.forEach(a => {
        const parent = a.parentNode;
        while (a.firstChild) parent.insertBefore(a.firstChild, a);
        parent.removeChild(a);
      });
      ctx.editing.normalize();
      ctx.editing.blur();
    });
  }

  /* ── Copy to other pages — simple prompt-based picker for Slice 2.
     Slice 4 will introduce the proper modal. */
  const applyAllBtn = document.getElementById('ct-apply-all-btn');
  if (applyAllBtn) applyAllBtn.addEventListener('click', () => {
    ctWithSelected((_el, entry) => {
      if (_ppCopyModalReady) { ppCopyPagesOpenForKind('text', entry); return; }
      const meta = pageMetaList();
      const others = meta.filter(m => m.id !== entry.pageId);
      if (!others.length) { alert('There are no other pages to copy this overlay to.'); return; }
      const list = others.map((m, i) => (i + 1) + '. ' + m.label).join('\n');
      const ans = window.prompt(
        'Copy this text overlay to which pages?\n\n' +
          'Type "all" for every page, OR a comma-separated list of numbers:\n\n' + list,
        'all'
      );
      if (ans == null) return;
      const trimmed = ans.trim().toLowerCase();
      let targets = [];
      if (trimmed === 'all' || trimmed === '*' || trimmed === '') {
        targets = others.map(m => m.id);
      } else {
        const nums = trimmed.split(/[,\s]+/).map(n => parseInt(n, 10) - 1).filter(n => n >= 0 && n < others.length);
        targets = nums.map(n => others[n].id);
      }
      if (!targets.length) { alert('No valid pages picked.'); return; }
      targets.forEach(pid => {
        const clone = Object.assign({}, entry, {
          id: 'ct-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          pageId: pid,
        });
        _ctEntries.push(clone);
        ctMakeEl(clone);
      });
      ctSave(_ctEntries);
    });
  });

  /* ── Delete ── */
  const delBtn = document.getElementById('ct-delete-btn');
  if (delBtn) delBtn.addEventListener('click', () => {
    ctWithSelected((el, entry) => {
      _ctEntries = _ctEntries.filter(e => e.id !== entry.id);
      el.remove();
      ctUpdateSidebar();
    });
  });

  /* Delete / Backspace removes selected overlays. */
  document.addEventListener('keydown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    const selected = Array.from(document.querySelectorAll('.custom-text.selected'))
      .filter(el => !el.classList.contains('editing'));
    if (!selected.length) return;
    ev.preventDefault();
    const ids = new Set(selected.map(el => el.dataset.id));
    _ctEntries = _ctEntries.filter(e => !ids.has(e.id));
    ctSave(_ctEntries);
    selected.forEach(el => el.remove());
    _selUpdateMultiClass();
  });
}

/* ═════════════════════════════════════════════════════════════════
   Shape overlay system — full port from regional online-reports.html
   ─────────────────────────────────────────────────────────────────
   Each shape entry owns a positioned wrapper div containing a single
   SVG element that draws the actual shape. Wrapper bbox is the
   user-controlled rect (left/top/width/height); the SVG fills it via
   100% width/height. Shapes drag to move, four corner handles drag
   to resize (line/arrow get two endpoint handles instead). The right-
   rail .sh-panel edits fill / stroke / gradient / stroke-width /
   link while a shape is selected.
   ═════════════════════════════════════════════════════════════════ */
function _shEscapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* Paint normalisation. Fill and stroke can each be solid, gradient,
   or none. Stored as { type, color, from, to, angle } so the panel
   can switch modes without losing the user's last solid colour or
   gradient stops. Older entries written as plain strings get upgraded
   transparently on read. */
function _shNormColor(v) {
  const def = { type: 'none', color: '#5cc8e0', from: '#5cc8e0', to: '#0f2b38', angle: 135 };
  if (!v || v === 'none') return Object.assign({}, def);
  if (typeof v === 'string') {
    return { type: 'solid', color: v, from: v, to: '#0f2b38', angle: 135 };
  }
  if (typeof v === 'object') {
    const t = (v.type === 'gradient' || v.type === 'none') ? v.type : 'solid';
    return {
      type:  t,
      color: v.color || v.from || '#5cc8e0',
      from:  v.from  || v.color || '#5cc8e0',
      to:    v.to    || '#0f2b38',
      angle: typeof v.angle === 'number' ? v.angle : 135,
    };
  }
  return Object.assign({}, def);
}

function _shNormalizeEntry(e) {
  e.fill   = _shNormColor(e.fill);
  e.stroke = _shNormColor(e.stroke);
  /* Line / arrow shapes carry explicit endpoints so shortening one
     end never rotates the line. Older entries with only bbox get
     endpoints derived from the top-left → bottom-right diagonal. */
  if ((e.type === 'line' || e.type === 'arrow') && typeof e.x1 !== 'number') {
    e.x1 = +e.x || 0;
    e.y1 = +e.y || 0;
    e.x2 = (+e.x || 0) + (+e.w || 0);
    e.y2 = (+e.y || 0) + (+e.h || 0);
    _shRecalcBbox(e);
  }
  return e;
}

/* Recompute the wrapper bbox for a line/arrow from its endpoints,
   adding generous padding so a thin stroke doesn't get clipped and
   the click target remains grabbable. Called after every endpoint
   mutation so x/y/w/h stay in sync with the source-of-truth
   endpoints. */
function _shRecalcBbox(e) {
  if (e.type !== 'line' && e.type !== 'arrow') return;
  const sw = Math.max(0, +e.strokeWidth || 0);
  const pad = Math.max(10, sw / 2 + 6);
  const minX = Math.min(e.x1, e.x2);
  const minY = Math.min(e.y1, e.y2);
  const maxX = Math.max(e.x1, e.x2);
  const maxY = Math.max(e.y1, e.y2);
  e.x = Math.round(minX - pad);
  e.y = Math.round(minY - pad);
  e.w = Math.round(maxX - minX + 2 * pad);
  e.h = Math.round(maxY - minY + 2 * pad);
}

/* Pick a single representative colour from a paint — used for the
   arrowhead's fill, which can't accept a gradient defined in the
   parent SVG's user coordinate system. We use the gradient's "to"
   stop because that's where the arrowhead lands. */
function _shFirstColor(v) {
  v = _shNormColor(v);
  if (v.type === 'none')     return null;
  if (v.type === 'solid')    return v.color;
  if (v.type === 'gradient') return v.to;
  return null;
}

/* Resolve a paint to its SVG attribute. Gradients get a uniquely-id'd
   <linearGradient> defs entry; solids return the hex; none returns
   "none". The angle is mapped to SVG's left-to-right default by
   rotating around the bbox centre. */
function _shResolvePaint(v, role, entryId, gradAccum) {
  v = _shNormColor(v);
  if (v.type === 'none')  return 'none';
  if (v.type === 'solid') return v.color;
  if (v.type === 'gradient') {
    const id  = 'sh-g-' + role + '-' + entryId;
    const rot = (v.angle - 90).toFixed(2);
    gradAccum.push(
      '<linearGradient id="' + _shEscapeAttr(id) +
      '" gradientUnits="objectBoundingBox" gradientTransform="rotate(' + rot + ', 0.5, 0.5)">' +
      '<stop offset="0%" stop-color="' + _shEscapeAttr(v.from) + '"/>' +
      '<stop offset="100%" stop-color="' + _shEscapeAttr(v.to) + '"/>' +
      '</linearGradient>'
    );
    return 'url(#' + id + ')';
  }
  return 'none';
}

/* Build the inner SVG markup for an entry. Coordinates are in raw
   pixel units matching the wrapper bbox so stroke width stays
   consistent regardless of shape size. */
function _shInnerSvg(entry) {
  const w  = Math.max(2, +entry.w || 2);
  const h  = Math.max(2, +entry.h || 2);
  const sw = Math.max(0, +entry.strokeWidth || 0);
  const sh = sw / 2;
  const defsParts = [];
  const fillStr   = _shResolvePaint(entry.fill,   'fill',   entry.id, defsParts);
  const strokeStr = _shResolvePaint(entry.stroke, 'stroke', entry.id, defsParts);
  const fa = _shEscapeAttr(fillStr);
  const sa = _shEscapeAttr(strokeStr);
  const fs = 'fill="' + fa + '" stroke="' + sa + '" stroke-width="' + sw + '" stroke-linejoin="round"';
  let body = '';
  switch (entry.type) {
    case 'rect':
    case 'square':
      body = '<rect x="' + sh + '" y="' + sh + '" width="' + Math.max(0, w - sw) + '" height="' + Math.max(0, h - sw) + '" ' + fs + '/>';
      break;
    case 'ellipse':
    case 'circle':
      body = '<ellipse cx="' + (w / 2) + '" cy="' + (h / 2) + '" rx="' + Math.max(0, (w - sw) / 2) + '" ry="' + Math.max(0, (h - sw) / 2) + '" ' + fs + '/>';
      break;
    case 'triangle':
      body = '<polygon points="' +
        (w / 2) + ',' + sh + ' ' +
        (w - sh) + ',' + (h - sh) + ' ' +
        sh + ',' + (h - sh) +
        '" ' + fs + '/>';
      break;
    case 'star': {
      const cx = w / 2, cy = h / 2;
      const rx = Math.max(0, (w - sw) / 2);
      const ry = Math.max(0, (h - sw) / 2);
      const irx = rx * 0.382, iry = ry * 0.382;
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const r = (i % 2 === 0) ? { x: rx, y: ry } : { x: irx, y: iry };
        pts.push((cx + r.x * Math.cos(a)).toFixed(2) + ',' + (cy + r.y * Math.sin(a)).toFixed(2));
      }
      body = '<polygon points="' + pts.join(' ') + '" ' + fs + '/>';
      break;
    }
    case 'heart': {
      const off = sh;
      const sx  = (w - sw) / 100;
      const sy  = (h - sw) / 100;
      const px  = (n) => (off + n * sx).toFixed(2);
      const py  = (n) => (off + n * sy).toFixed(2);
      const d = [
        'M', px(50), py(90),
        'C', px(50), py(90) + ',', px(10), py(60) + ',', px(10), py(30),
        'C', px(10), py(10) + ',', px(30), py(5)  + ',', px(50), py(25),
        'C', px(70), py(5)  + ',', px(90), py(10) + ',', px(90), py(30),
        'C', px(90), py(60) + ',', px(50), py(90) + ',', px(50), py(90), 'Z',
      ].join(' ');
      body = '<path d="' + d + '" ' + fs + ' stroke-linecap="round"/>';
      break;
    }
    case 'line': {
      const lx1 = (entry.x1 - entry.x).toFixed(2);
      const ly1 = (entry.y1 - entry.y).toFixed(2);
      const lx2 = (entry.x2 - entry.x).toFixed(2);
      const ly2 = (entry.y2 - entry.y).toFixed(2);
      body = '<line x1="' + lx1 + '" y1="' + ly1 + '" x2="' + lx2 + '" y2="' + ly2 +
             '" stroke="' + sa + '" stroke-width="' + sw + '" stroke-linecap="round"/>';
      break;
    }
    case 'arrow': {
      const lx1 = (entry.x1 - entry.x).toFixed(2);
      const ly1 = (entry.y1 - entry.y).toFixed(2);
      const lx2 = (entry.x2 - entry.x).toFixed(2);
      const ly2 = (entry.y2 - entry.y).toFixed(2);
      const headColor = _shFirstColor(entry.stroke) || _shFirstColor(entry.fill) || '#fff';
      const mid = 'sh-ah-' + entry.id;
      const ms  = Math.max(4, sw * 2.5);
      defsParts.push(
        '<marker id="' + _shEscapeAttr(mid) + '" viewBox="0 0 10 10" refX="8" refY="5" ' +
                'markerWidth="' + ms + '" markerHeight="' + ms + '" orient="auto-start-reverse">' +
          '<path d="M 0 0 L 10 5 L 0 10 z" fill="' + _shEscapeAttr(headColor) + '"/>' +
        '</marker>'
      );
      body = '<line x1="' + lx1 + '" y1="' + ly1 + '" x2="' + lx2 + '" y2="' + ly2 +
             '" stroke="' + sa + '" stroke-width="' + sw +
             '" stroke-linecap="round" marker-end="url(#' + _shEscapeAttr(mid) + ')"/>';
      break;
    }
    default:
      body = '';
  }
  const defs = defsParts.length ? '<defs>' + defsParts.join('') + '</defs>' : '';
  return defs + body;
}

function shMakeEl(entry) {
  const page = document.getElementById(entry.pageId);
  if (!page) return null;
  const el = document.createElement('div');
  el.className = 'shape';
  el.dataset.id = entry.id;
  el.style.left   = entry.x + 'px';
  el.style.top    = entry.y + 'px';
  el.style.width  = entry.w + 'px';
  el.style.height = entry.h + 'px';
  const isLineish = (entry.type === 'line' || entry.type === 'arrow');
  let handlesHtml;
  if (isLineish) {
    const sx1 = entry.x1 - entry.x;
    const sy1 = entry.y1 - entry.y;
    const sx2 = entry.x2 - entry.x;
    const sy2 = entry.y2 - entry.y;
    handlesHtml =
      '<div class="sh-handle endpoint" data-endpoint="start" style="left:' + sx1 + 'px; top:' + sy1 + 'px"></div>' +
      '<div class="sh-handle endpoint" data-endpoint="end"   style="left:' + sx2 + 'px; top:' + sy2 + 'px"></div>';
  } else {
    handlesHtml =
      '<div class="sh-handle nw" data-corner="nw"></div>' +
      '<div class="sh-handle ne" data-corner="ne"></div>' +
      '<div class="sh-handle sw" data-corner="sw"></div>' +
      '<div class="sh-handle se" data-corner="se"></div>';
  }
  const svgHtml =
    '<svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">' + _shInnerSvg(entry) + '</svg>';
  const wrappedSvg = entry.link
    ? '<a href="' + _shEscapeAttr(entry.link) + '" target="_blank" rel="noopener noreferrer">' + svgHtml + '</a>'
    : svgHtml;
  el.innerHTML = wrappedSvg + handlesHtml;
  if (entry.link) el.classList.add('has-link');
  shAttachHandlers(el, entry);
  page.appendChild(el);
  return el;
}

/* Live-update the <a> wrapper without re-rendering the SVG (which
   would drop the selection outline and handles briefly). */
function shUpdateLinkWrapper(el, entry) {
  if (!el) return;
  let existingA = null;
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'A') { existingA = child; break; }
  }
  if (entry.link) {
    if (existingA) {
      existingA.setAttribute('href', entry.link);
    } else {
      const svg = el.querySelector(':scope > svg');
      if (svg) {
        const a = document.createElement('a');
        a.setAttribute('href', entry.link);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        el.insertBefore(a, svg);
        a.appendChild(svg);
      }
    }
    el.classList.add('has-link');
  } else {
    if (existingA) {
      const svg = existingA.querySelector('svg');
      if (svg) el.insertBefore(svg, existingA);
      existingA.remove();
    }
    el.classList.remove('has-link');
  }
}

function shRedraw(el, entry) {
  el.style.left   = entry.x + 'px';
  el.style.top    = entry.y + 'px';
  el.style.width  = entry.w + 'px';
  el.style.height = entry.h + 'px';
  const svg = el.querySelector('svg');
  if (svg) svg.innerHTML = _shInnerSvg(entry);
  if (entry.type === 'line' || entry.type === 'arrow') {
    const start = el.querySelector('.sh-handle.endpoint[data-endpoint="start"]');
    const end   = el.querySelector('.sh-handle.endpoint[data-endpoint="end"]');
    if (start) {
      start.style.left = (entry.x1 - entry.x) + 'px';
      start.style.top  = (entry.y1 - entry.y) + 'px';
    }
    if (end) {
      end.style.left = (entry.x2 - entry.x) + 'px';
      end.style.top  = (entry.y2 - entry.y) + 'px';
    }
  }
}

function shRenderAll() {
  document.querySelectorAll('.shape').forEach(el => el.remove());
  _shEntries.forEach(entry => shMakeEl(entry));
}

function shEntryById(id) { return _shEntries.find(e => e.id === id); }
function shGetSelectedEl() { return document.querySelector('.shape.selected'); }
function shGetSelectedEntry() {
  const el = shGetSelectedEl();
  if (!el) return null;
  return shEntryById(el.dataset.id);
}
function shDeselectAll() {
  document.querySelectorAll('.shape.selected').forEach(el => el.classList.remove('selected'));
  shUpdatePanel();
  _selUpdateMultiClass();
}

function shAttachHandlers(el, entry) {
  let active = false;
  let mode = null;       /* 'drag' | 'resize' | 'endpoint' */
  let corner = null;
  let endpoint = null;
  let sx = 0, sy = 0;
  let s = null;
  let groupItems = null;
  let snapAxis = 'none';
  const SNAP_ENTER_PX = 6;
  const SNAP_EXIT_PX  = 18;

  el.addEventListener('mousedown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    const handle = ev.target.closest('.sh-handle');
    if (handle && handle.classList.contains('endpoint')) {
      mode = 'endpoint';
      endpoint = handle.dataset.endpoint;
      corner = null;
    } else if (handle) {
      mode = 'resize';
      corner = handle.dataset.corner;
      endpoint = null;
    } else {
      mode = 'drag';
      corner = null; endpoint = null;
    }

    const additive = (mode === 'drag') && (ev.ctrlKey || ev.metaKey || ev.shiftKey);
    const wasSelected = el.classList.contains('selected');

    if (additive) {
      el.classList.toggle('selected');
      shUpdatePanel();
      _selUpdateMultiClass();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    if (mode !== 'drag' || !wasSelected) {
      ctDeselectAll();
      shDeselectAll();
      el.classList.add('selected');
      shUpdatePanel();
      _selUpdateMultiClass();
    }

    active = true;
    sx = ev.clientX; sy = ev.clientY;
    s = {
      x: entry.x, y: entry.y, w: entry.w, h: entry.h,
      x1: entry.x1, y1: entry.y1, x2: entry.x2, y2: entry.y2,
    };
    groupItems = (mode === 'drag') ? _captureGroupDragItems() : null;
    if (mode === 'endpoint' && (entry.type === 'line' || entry.type === 'arrow')) {
      if (entry.y1 === entry.y2)      snapAxis = 'horizontal';
      else if (entry.x1 === entry.x2) snapAxis = 'vertical';
      else                             snapAxis = 'none';
    } else {
      snapAxis = 'none';
    }
    ev.preventDefault();
    ev.stopPropagation();
  });

  document.addEventListener('mousemove', ev => {
    if (!active) return;
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    const isLineish = (entry.type === 'line' || entry.type === 'arrow');

    if (mode === 'drag') {
      if (groupItems) { _applyGroupDragDelta(groupItems, dx, dy); return; }
      if (isLineish) {
        entry.x1 = Math.round(s.x1 + dx);
        entry.y1 = Math.round(s.y1 + dy);
        entry.x2 = Math.round(s.x2 + dx);
        entry.y2 = Math.round(s.y2 + dy);
        _shRecalcBbox(entry);
      } else {
        entry.x = Math.round(s.x + dx);
        entry.y = Math.round(s.y + dy);
      }
    } else if (mode === 'endpoint') {
      const movingStart = (endpoint === 'start');
      const rawX = (movingStart ? s.x1 : s.x2) + dx;
      const rawY = (movingStart ? s.y1 : s.y2) + dy;
      const otherX = movingStart ? s.x2 : s.x1;
      const otherY = movingStart ? s.y2 : s.y1;
      const distFromH = Math.abs(rawY - otherY);
      const distFromV = Math.abs(rawX - otherX);

      let ax = rawX, ay = rawY;
      if (snapAxis === 'horizontal' && distFromH < SNAP_EXIT_PX) {
        ay = otherY;
      } else if (snapAxis === 'vertical' && distFromV < SNAP_EXIT_PX) {
        ax = otherX;
      } else if (distFromH < SNAP_ENTER_PX && distFromH <= distFromV) {
        snapAxis = 'horizontal';
        ay = otherY;
      } else if (distFromV < SNAP_ENTER_PX) {
        snapAxis = 'vertical';
        ax = otherX;
      } else {
        snapAxis = 'none';
      }

      if (movingStart) {
        entry.x1 = Math.round(ax);
        entry.y1 = Math.round(ay);
      } else {
        entry.x2 = Math.round(ax);
        entry.y2 = Math.round(ay);
      }
      _shRecalcBbox(entry);
    } else {
      const MIN = 8;
      let x = s.x, y = s.y, w = s.w, h = s.h;
      if (corner === 'se') {
        w = Math.max(MIN, s.w + dx);
        h = Math.max(MIN, s.h + dy);
      } else if (corner === 'sw') {
        const newX = Math.min(s.x + s.w - MIN, s.x + dx);
        w = Math.max(MIN, s.w - dx);
        x = newX;
        h = Math.max(MIN, s.h + dy);
      } else if (corner === 'ne') {
        const newY = Math.min(s.y + s.h - MIN, s.y + dy);
        h = Math.max(MIN, s.h - dy);
        y = newY;
        w = Math.max(MIN, s.w + dx);
      } else if (corner === 'nw') {
        const newX = Math.min(s.x + s.w - MIN, s.x + dx);
        const newY = Math.min(s.y + s.h - MIN, s.y + dy);
        w = Math.max(MIN, s.w - dx);
        h = Math.max(MIN, s.h - dy);
        x = newX; y = newY;
      }
      entry.x = Math.round(x);
      entry.y = Math.round(y);
      entry.w = Math.round(w);
      entry.h = Math.round(h);
    }
    shRedraw(el, entry);
  });

  document.addEventListener('mouseup', () => {
    if (!active) return;
    active = false;
    if (mode === 'drag' && groupItems) {
      _commitGroupDrag(groupItems);
    } else {
      const changed = s && (entry.x !== s.x || entry.y !== s.y || entry.w !== s.w || entry.h !== s.h ||
                            entry.x1 !== s.x1 || entry.y1 !== s.y1 || entry.x2 !== s.x2 || entry.y2 !== s.y2);
      if (changed) shSave(_shEntries);
    }
    s = null; mode = null; corner = null; endpoint = null;
    groupItems = null;
  });
}

const SH_DEFAULTS = {
  rect:     { w: 220, h: 140 },
  square:   { w: 160, h: 160 },
  ellipse:  { w: 220, h: 140 },
  circle:   { w: 160, h: 160 },
  triangle: { w: 180, h: 160 },
  star:     { w: 160, h: 160 },
  heart:    { w: 160, h: 150 },
  line:     { w: 220, h: 4   },
  arrow:    { w: 220, h: 60  },
};

function shAddNew(type) {
  const pageId = ctVisiblePageId();
  if (!pageId) return;
  const page = document.getElementById(pageId);
  const def = SH_DEFAULTS[type] || SH_DEFAULTS.rect;
  const pageRect = page.getBoundingClientRect();
  const vh = window.innerHeight;
  const visibleTop = Math.max(0, pageRect.top);
  const visibleBot = Math.min(vh, pageRect.bottom);
  const visibleMid = (visibleTop + visibleBot) / 2;
  const yOnPage = visibleMid - pageRect.top - def.h / 2;
  const xOnPage = page.clientWidth / 2 - def.w / 2;

  const isLineish = (type === 'line' || type === 'arrow');
  const fill   = _shNormColor(isLineish ? 'none' : '#5cc8e0');
  const stroke = _shNormColor(isLineish ? '#5cc8e0' : '#0a1520');
  const strokeWidth = isLineish ? 3 : 2;

  const entry = {
    id: 'sh-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    pageId, type,
    x: Math.max(8, Math.round(xOnPage)),
    y: Math.max(8, Math.round(yOnPage)),
    w: def.w, h: def.h,
    fill, stroke, strokeWidth,
  };
  if (isLineish) {
    const length = def.w;
    const startX = page.clientWidth / 2 - length / 2;
    const yLine  = visibleMid - pageRect.top;
    entry.x1 = Math.max(8, Math.round(startX));
    entry.y1 = Math.round(yLine);
    entry.x2 = entry.x1 + length;
    entry.y2 = entry.y1;
    _shRecalcBbox(entry);
  }
  _shEntries.push(entry);
  shSave(_shEntries);
  const el = shMakeEl(entry);

  if (!document.body.classList.contains('edit-mode')) {
    document.body.classList.add('edit-mode');
    document.getElementById('btn-mode-edit')?.classList.add('on');
    document.getElementById('btn-mode-view')?.classList.remove('on');
  }
  ctDeselectAll();
  shDeselectAll();
  if (el) {
    el.classList.add('selected');
    shUpdatePanel();
  }
}

function shDelete(id) {
  const entry = shEntryById(id);
  if (!entry) return;
  _shEntries = _shEntries.filter(e => e.id !== id);
  shSave(_shEntries);
  const el = document.querySelector('.shape[data-id="' + id + '"]');
  if (el) el.remove();
  shUpdatePanel();
}

/* Apply a single role's paint to the panel: set active tab, populate
   colour inputs. We populate ALL inputs (solid + gradient stops +
   angle) on every refresh so switching tabs always shows the user's
   last choice rather than a default. */
function _shApplyPaintToPanel(role, value) {
  const v = _shNormColor(value);
  const tabs = document.querySelectorAll('#sh-' + role + '-tabs .sh-mini-tab');
  tabs.forEach(t => {
    const on = (t.dataset.mode === v.type);
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.sh-panel .sh-pane[data-role="' + role + '"]').forEach(p => {
    p.classList.toggle('on', p.dataset.mode === v.type);
  });
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setVal('sh-' + role + '-color',     v.color);
  setVal('sh-' + role + '-color-hex', v.color);
  setVal('sh-' + role + '-from',      v.from);
  setVal('sh-' + role + '-from-hex',  v.from);
  setVal('sh-' + role + '-to',        v.to);
  setVal('sh-' + role + '-to-hex',    v.to);
  setVal('sh-' + role + '-angle',     String(v.angle));
  setVal('sh-' + role + '-angle-num', String(v.angle));
}

function shUpdatePanel() {
  const panel = document.getElementById('sh-panel');
  if (!panel) return;
  const entry = shGetSelectedEntry();
  if (!entry) {
    panel.classList.remove('has-selection');
    document.body.classList.remove('shape-selected');
    return;
  }
  panel.classList.add('has-selection');
  document.body.classList.add('shape-selected');
  const lbl = document.getElementById('sh-type-label');
  if (lbl) lbl.textContent = entry.type;
  _shApplyPaintToPanel('fill',   entry.fill);
  _shApplyPaintToPanel('stroke', entry.stroke);
  const swEl = document.getElementById('sh-stroke-width');
  if (swEl) swEl.value = String(entry.strokeWidth || 0);
  const linkInput = document.getElementById('sh-link');
  if (linkInput) linkInput.value = entry.link || '';
  /* Hide fill row for line/arrow — they have no fill area. */
  const fillRow = document.getElementById('sh-fill-row');
  if (fillRow) fillRow.style.display = (entry.type === 'line' || entry.type === 'arrow') ? 'none' : '';
}

function shCommitSelected(mut) {
  const entry = shGetSelectedEntry();
  const el = shGetSelectedEl();
  if (!entry || !el) return;
  mut(entry);
  shRedraw(el, entry);
}

function _shWireColorRole(role) {
  const tabs = document.querySelectorAll('#sh-' + role + '-tabs .sh-mini-tab');
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      const mode = t.dataset.mode;
      shCommitSelected(e => {
        const cur = _shNormColor(e[role]);
        cur.type = mode;
        e[role] = cur;
      });
      shUpdatePanel();
      shSave(_shEntries);
    });
  });
  const pairColor = (col, hex, mut) => {
    if (!col || !hex) return;
    col.addEventListener('input', () => {
      hex.value = col.value;
      shCommitSelected(e => mut(_shNormColor(e[role]), col.value, e));
    });
    col.addEventListener('change', () => shSave(_shEntries));
    hex.addEventListener('input', () => {
      const v = hex.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) {
        col.value = v.toLowerCase();
        shCommitSelected(e => mut(_shNormColor(e[role]), v.toLowerCase(), e));
      }
    });
    hex.addEventListener('change', () => {
      hex.value = col.value;
      shSave(_shEntries);
    });
  };
  pairColor(
    document.getElementById('sh-' + role + '-color'),
    document.getElementById('sh-' + role + '-color-hex'),
    (cur, value, e) => { cur.type = 'solid'; cur.color = value; e[role] = cur; }
  );
  pairColor(
    document.getElementById('sh-' + role + '-from'),
    document.getElementById('sh-' + role + '-from-hex'),
    (cur, value, e) => { cur.type = 'gradient'; cur.from = value; e[role] = cur; }
  );
  pairColor(
    document.getElementById('sh-' + role + '-to'),
    document.getElementById('sh-' + role + '-to-hex'),
    (cur, value, e) => { cur.type = 'gradient'; cur.to = value; e[role] = cur; }
  );
  const ang  = document.getElementById('sh-' + role + '-angle');
  const angN = document.getElementById('sh-' + role + '-angle-num');
  if (!ang || !angN) return;
  const setAngle = (v) => {
    if (!Number.isFinite(v)) return;
    v = Math.max(0, Math.min(360, v));
    ang.value  = String(v);
    angN.value = String(v);
    shCommitSelected(e => {
      const cur = _shNormColor(e[role]);
      cur.type = 'gradient';
      cur.angle = v;
      e[role] = cur;
    });
  };
  ang.addEventListener('input',  () => setAngle(parseInt(ang.value,  10)));
  ang.addEventListener('change', () => shSave(_shEntries));
  angN.addEventListener('input',  () => setAngle(parseInt(angN.value, 10)));
  angN.addEventListener('change', () => shSave(_shEntries));
}

function setupShapes() {
  const btnAdd = document.getElementById('btn-add-shape');
  const picker = document.getElementById('sh-picker');
  if (btnAdd && picker) {
    btnAdd.addEventListener('click', ev => {
      ev.stopPropagation();
      if (picker.classList.contains('open')) { picker.classList.remove('open'); return; }
      const r = btnAdd.getBoundingClientRect();
      picker.style.left = Math.max(8, r.left) + 'px';
      picker.style.top  = (r.top - 200) + 'px';
      /* Picker is anchored ABOVE the pager (which sits at the bottom
         of the viewport) so it doesn't overflow off-screen. */
      picker.classList.add('open');
    });
    picker.querySelectorAll('button[data-shape]').forEach(b => {
      b.addEventListener('click', () => {
        picker.classList.remove('open');
        shAddNew(b.dataset.shape);
      });
    });
    document.addEventListener('mousedown', ev => {
      if (!picker.classList.contains('open')) return;
      if (picker.contains(ev.target)) return;
      if (ev.target === btnAdd) return;
      picker.classList.remove('open');
    }, true);
  }

  _shWireColorRole('fill');
  _shWireColorRole('stroke');

  const swEl   = document.getElementById('sh-stroke-width');
  const delBtn = document.getElementById('sh-delete-btn');
  if (swEl) {
    swEl.addEventListener('input', () => {
      let v = parseInt(swEl.value, 10);
      if (!Number.isFinite(v)) return;
      v = Math.max(0, Math.min(40, v));
      shCommitSelected(e => { e.strokeWidth = v; });
    });
    swEl.addEventListener('change', () => shSave(_shEntries));
  }
  const linkInput = document.getElementById('sh-link');
  const linkClear = document.getElementById('sh-link-clear');
  if (linkInput) {
    linkInput.addEventListener('input', () => {
      const raw = (linkInput.value || '').trim();
      shCommitSelected(e => { e.link = raw; });
      const el    = shGetSelectedEl();
      const entry = shGetSelectedEntry();
      if (el && entry) shUpdateLinkWrapper(el, entry);
    });
    linkInput.addEventListener('change', () => shSave(_shEntries));
  }
  if (linkClear) {
    linkClear.addEventListener('click', () => {
      if (linkInput) linkInput.value = '';
      shCommitSelected(e => { e.link = ''; });
      const el    = shGetSelectedEl();
      const entry = shGetSelectedEntry();
      if (el && entry) shUpdateLinkWrapper(el, entry);
      shSave(_shEntries);
    });
  }
  if (delBtn) delBtn.addEventListener('click', () => {
    const entry = shGetSelectedEntry();
    if (entry) shDelete(entry.id);
  });
  /* Slice 2's text panel Copy already uses a prompt-based picker.
     The shape Copy uses the same modal that Slice 3 adds (pp-modal). */
  const shCopyBtn = document.getElementById('sh-apply-all-btn');
  if (shCopyBtn) shCopyBtn.addEventListener('click', () => {
    const entry = shGetSelectedEntry();
    if (!entry) return;
    if (_ppCopyModalReady) ppCopyPagesOpenForKind('shape', entry);
    else _shCopyPagesOpen(entry);
  });

  document.addEventListener('keydown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    const selected = Array.from(document.querySelectorAll('.shape.selected'));
    if (!selected.length) return;
    ev.preventDefault();
    const ids = new Set(selected.map(el => el.dataset.id));
    _shEntries = _shEntries.filter(e => !ids.has(e.id));
    shSave(_shEntries);
    selected.forEach(el => el.remove());
    shUpdatePanel();
    _selUpdateMultiClass();
  });

  shRenderAll();
  shUpdatePanel();
}

/* Simple prompt-based copy for shapes — Slice 4 will swap in a modal. */
function _shCopyPagesOpen(entry) {
  const meta = pageMetaList();
  const others = meta.filter(m => m.id !== entry.pageId);
  if (!others.length) { alert('There are no other pages to copy this shape to.'); return; }
  const list = others.map((m, i) => (i + 1) + '. ' + m.label).join('\n');
  const ans = window.prompt(
    'Copy this shape to which pages?\n\nType "all" for every page, OR a comma-separated list of numbers:\n\n' + list,
    'all'
  );
  if (ans == null) return;
  const trimmed = ans.trim().toLowerCase();
  let targets = [];
  if (trimmed === 'all' || trimmed === '*' || trimmed === '') {
    targets = others.map(m => m.id);
  } else {
    const nums = trimmed.split(/[,\s]+/).map(n => parseInt(n, 10) - 1).filter(n => n >= 0 && n < others.length);
    targets = nums.map(n => others[n].id);
  }
  if (!targets.length) { alert('No valid pages picked.'); return; }
  targets.forEach(pid => {
    const clone = JSON.parse(JSON.stringify(entry));
    clone.id = 'sh-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    clone.pageId = pid;
    _shEntries.push(clone);
    shMakeEl(clone);
  });
  shSave(_shEntries);
}

/* ═════════════════════════════════════════════════════════════════
   Image overlay system
   ═════════════════════════════════════════════════════════════════ */
function imgEntryById(id) { return _imgEntries.find(e => e.id === id); }
function imgGetSelectedEl()    { return document.querySelector('.image-overlay.selected'); }
function imgGetSelectedEntry() {
  const el = imgGetSelectedEl();
  if (!el) return null;
  return imgEntryById(el.dataset.id);
}
function imgDeselectAll() {
  document.querySelectorAll('.image-overlay.selected').forEach(el => el.classList.remove('selected'));
  _selUpdateMultiClass();
}

function imgMakeEl(entry) {
  const page = document.getElementById(entry.pageId);
  if (!page) return null;
  const el = document.createElement('div');
  el.className = 'image-overlay';
  el.dataset.id = entry.id;
  el.style.left   = entry.x + 'px';
  el.style.top    = entry.y + 'px';
  el.style.width  = entry.w + 'px';
  el.style.height = entry.h + 'px';
  el.innerHTML =
    '<img alt="" draggable="false" />' +
    '<div class="ig-handle nw" data-corner="nw"></div>' +
    '<div class="ig-handle ne" data-corner="ne"></div>' +
    '<div class="ig-handle sw" data-corner="sw"></div>' +
    '<div class="ig-handle se" data-corner="se"></div>';
  imgAttachHandlers(el, entry);
  page.appendChild(el);
  /* Resolve the <img> source. A stored path → short-lived signed URL
     (re-signed lazily on cache expiry); a legacy base64 src → inline as-is.
     storagePath is async, so the element returns immediately and the src
     lands a tick later (the PDF renderer waits for .image-overlay imgs to
     finish loading before capture — see render-reports.mjs). */
  const imgEl = el.querySelector('img');
  if (imgEl) {
    if (entry.storagePath) {
      _imgGetSignedUrl(entry.storagePath).then(url => { if (url) imgEl.src = url; });
    } else if (entry.src) {
      imgEl.src = entry.src;
    }
  }
  return el;
}

function imgRedraw(el, entry) {
  el.style.left   = entry.x + 'px';
  el.style.top    = entry.y + 'px';
  el.style.width  = entry.w + 'px';
  el.style.height = entry.h + 'px';
}

function imgRenderAll() {
  document.querySelectorAll('.image-overlay').forEach(el => el.remove());
  _imgEntries.forEach(entry => imgMakeEl(entry));
}

function imgAttachHandlers(el, entry) {
  let active = false;
  let mode = null;
  let corner = null;
  let sx = 0, sy = 0;
  let s = null;
  let groupItems = null;

  el.addEventListener('mousedown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    const handle = ev.target.closest('.ig-handle');
    mode = handle ? 'resize' : 'drag';
    corner = handle ? handle.dataset.corner : null;

    const additive = (mode === 'drag') && (ev.ctrlKey || ev.metaKey || ev.shiftKey);
    const wasSelected = el.classList.contains('selected');
    if (additive) {
      el.classList.toggle('selected');
      _selUpdateMultiClass();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (mode !== 'drag' || !wasSelected) {
      ctDeselectAll();
      shDeselectAll();
      imgDeselectAll();
      el.classList.add('selected');
      _selUpdateMultiClass();
    }
    active = true;
    sx = ev.clientX; sy = ev.clientY;
    s = { x: entry.x, y: entry.y, w: entry.w, h: entry.h };
    groupItems = (mode === 'drag') ? _captureGroupDragItems() : null;
    ev.preventDefault();
    ev.stopPropagation();
  });

  document.addEventListener('mousemove', ev => {
    if (!active) return;
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    if (mode === 'drag') {
      if (groupItems) { _applyGroupDragDelta(groupItems, dx, dy); return; }
      entry.x = Math.round(s.x + dx);
      entry.y = Math.round(s.y + dy);
    } else {
      const MIN = 16;
      let x = s.x, y = s.y, w = s.w, h = s.h;
      if (corner === 'se') {
        w = Math.max(MIN, s.w + dx);
        h = Math.max(MIN, s.h + dy);
      } else if (corner === 'sw') {
        const newX = Math.min(s.x + s.w - MIN, s.x + dx);
        w = Math.max(MIN, s.w - dx);
        x = newX;
        h = Math.max(MIN, s.h + dy);
      } else if (corner === 'ne') {
        const newY = Math.min(s.y + s.h - MIN, s.y + dy);
        h = Math.max(MIN, s.h - dy);
        y = newY;
        w = Math.max(MIN, s.w + dx);
      } else if (corner === 'nw') {
        const newX = Math.min(s.x + s.w - MIN, s.x + dx);
        const newY = Math.min(s.y + s.h - MIN, s.y + dy);
        w = Math.max(MIN, s.w - dx);
        h = Math.max(MIN, s.h - dy);
        x = newX; y = newY;
      }
      entry.x = Math.round(x);
      entry.y = Math.round(y);
      entry.w = Math.round(w);
      entry.h = Math.round(h);
    }
    imgRedraw(el, entry);
  });

  document.addEventListener('mouseup', () => {
    if (!active) return;
    active = false;
    if (mode === 'drag' && groupItems) {
      _commitGroupDrag(groupItems);
    } else {
      const changed = s && (entry.x !== s.x || entry.y !== s.y || entry.w !== s.w || entry.h !== s.h);
      if (changed) imgSave(_imgEntries);
    }
    s = null; mode = null; corner = null;
    groupItems = null;
  });
}

/* ── Image overlay storage (#7, migration 033) ──────────────────────────────
   Uploaded images live in the PRIVATE `report-images` bucket as
   <regionSlug>/<overlayId>.<ext>; the entry carries `storagePath` instead of
   a base64 data URL, so reports_state.payload + the localStorage cache + every
   sync/backup stay tiny. Backward-compatible: legacy entries that still hold a
   base64 `src` render directly (see imgMakeEl) and are left untouched. Mirrors
   the presentation tool's proven path (migration 029). */
const IMG_BUCKET                = 'report-images';
const IMG_SIGNED_URL_TTL_SECONDS = 3600;             /* server-side expiry */
const IMG_SIGNED_URL_REFRESH_MS  = 55 * 60 * 1000;   /* re-sign 5 min early */
const _imgSignedUrlCache = new Map();                /* path -> { url, expiresAt } */

async function _imgGetSignedUrl(path) {
  if (!path) return null;
  if (typeof window === 'undefined' || !window.sb || !window.sb.storage) return null;
  const now = Date.now();
  const cached = _imgSignedUrlCache.get(path);
  if (cached && cached.expiresAt > now) return cached.url;
  try {
    const { data, error } = await window.sb.storage
      .from(IMG_BUCKET)
      .createSignedUrl(path, IMG_SIGNED_URL_TTL_SECONDS);
    if (error || !data || !data.signedUrl) return null;
    _imgSignedUrlCache.set(path, { url: data.signedUrl, expiresAt: now + IMG_SIGNED_URL_REFRESH_MS });
    return data.signedUrl;
  } catch (_) { return null; }
}

/* Resize + re-encode before upload so the bucket file isn't needlessly huge.
   Caps the longest side at 1600px (report pages render smaller anyway) and
   JPEGs non-transparent sources at q0.85. Keeps PNG if an alpha channel is
   detected. Falls back to the original if compression isn't a win. The probe
   Image is already decoded by the caller. */
const IMG_COMPRESS_MAX_DIM      = 1600;
const IMG_COMPRESS_JPEG_QUALITY = 0.85;
const IMG_COMPRESS_SKIP_BYTES   = 200 * 1024;

function _imgMaybeCompress(file, probeImg) {
  try {
    const srcW = probeImg.naturalWidth, srcH = probeImg.naturalHeight;
    if (!srcW || !srcH) return Promise.resolve(file);
    const maxSide = Math.max(srcW, srcH);
    const scale = maxSide > IMG_COMPRESS_MAX_DIM ? IMG_COMPRESS_MAX_DIM / maxSide : 1;
    if (scale === 1 && file.size < IMG_COMPRESS_SKIP_BYTES) return Promise.resolve(file);
    const w = Math.round(srcW * scale), h = Math.round(srcH * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(probeImg, 0, 0, w, h);
    let outType = 'image/jpeg', outQuality = IMG_COMPRESS_JPEG_QUALITY;
    if (file.type === 'image/png') {
      try {
        const sample = ctx.getImageData(0, 0, Math.min(w, 64), Math.min(h, 64)).data;
        for (let i = 3; i < sample.length; i += 4) {
          if (sample[i] < 255) { outType = 'image/png'; outQuality = undefined; break; }
        }
      } catch (_) { /* cross-origin canvas — default JPEG is fine */ }
    }
    return new Promise(resolve => {
      canvas.toBlob(blob => { resolve(!blob || blob.size >= file.size ? file : blob); }, outType, outQuality);
    });
  } catch (_) { return Promise.resolve(file); }
}

/* Upload to report-images/<slug>/<id>.<ext>; returns the path. upsert:true so
   re-adding the same overlay id replaces cleanly. Throws on failure so the
   caller can fall back to inlining a data URL. */
async function _imgUploadToStorage(blob, slug, id) {
  if (typeof window === 'undefined' || !window.sb || !window.sb.storage) throw new Error('Storage client not loaded');
  if (!slug || !id) throw new Error('Missing region/overlay id for upload');
  const mime = blob.type || 'image/png';
  let ext = (mime.split('/')[1] || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ext === 'jpeg') ext = 'jpg';
  const path = slug + '/' + id + '.' + ext;
  const { error } = await window.sb.storage.from(IMG_BUCKET).upload(path, blob, { upsert: true, contentType: mime });
  if (error) throw error;
  return path;
}

function imgAddFromFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    alert('Please pick an image file (PNG, JPG, GIF, SVG, WebP, etc.).');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const probe = new Image();
    probe.onload = async () => {
      const pageId = ctVisiblePageId();
      if (!pageId) return;
      const page = document.getElementById(pageId);
      if (!page) return;
      const MAX = 320;
      let w = probe.naturalWidth  || 200;
      let h = probe.naturalHeight || 200;
      if (w > MAX || h > MAX) {
        const k = MAX / Math.max(w, h);
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
      const pageRect = page.getBoundingClientRect();
      const vh = window.innerHeight;
      const vt = Math.max(0, pageRect.top);
      const vb = Math.min(vh, pageRect.bottom);
      const yMid = (vt + vb) / 2;
      const yOnPage = yMid - pageRect.top - h / 2;
      const xOnPage = page.clientWidth / 2 - w / 2;
      const id = 'ig-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const entry = {
        id, pageId,
        x: Math.max(8, Math.round(xOnPage)),
        y: Math.max(8, Math.round(yOnPage)),
        w, h,
      };
      /* Upload the binary to Storage and keep only a path reference. On ANY
         failure (offline, RLS, storage down) fall back to inlining the base64
         data URL so the user never loses the image — it just stays heavy. */
      try {
        const blob = await _imgMaybeCompress(file, probe);
        entry.storagePath = await _imgUploadToStorage(blob, _rs_active(), id);
      } catch (_) {
        entry.src = dataUrl;
      }
      _imgEntries.push(entry);
      try { imgSave(_imgEntries); }
      catch (_) { _imgEntries.pop(); return; }
      const el = imgMakeEl(entry);
      if (!document.body.classList.contains('edit-mode')) {
        document.body.classList.add('edit-mode');
        document.getElementById('btn-mode-edit')?.classList.add('on');
        document.getElementById('btn-mode-view')?.classList.remove('on');
      }
      ctDeselectAll();
      shDeselectAll();
      imgDeselectAll();
      if (el) { el.classList.add('selected'); _selUpdateMultiClass(); }
    };
    probe.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

function imgDelete(id) {
  _imgEntries = _imgEntries.filter(e => e.id !== id);
  imgSave(_imgEntries);
  const el = document.querySelector('.image-overlay[data-id="' + id + '"]');
  if (el) el.remove();
  _selUpdateMultiClass();
}

function setupImages() {
  const btn = document.getElementById('btn-add-image');
  const fileInput = document.getElementById('ig-file-input');
  if (btn && fileInput) {
    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) imgAddFromFile(f);
      fileInput.value = '';
    });
  }

  document.addEventListener('keydown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    const selected = Array.from(document.querySelectorAll('.image-overlay.selected'));
    if (!selected.length) return;
    ev.preventDefault();
    const ids = new Set(selected.map(el => el.dataset.id));
    _imgEntries = _imgEntries.filter(e => !ids.has(e.id));
    imgSave(_imgEntries);
    selected.forEach(el => el.remove());
    _selUpdateMultiClass();
  });

  /* Right-click on an image overlay → "Copy to all pages" menu. */
  document.addEventListener('contextmenu', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    const imgEl = ev.target.closest('.image-overlay');
    if (!imgEl) { orHideCtxMenu(); return; }
    const id = imgEl.dataset.id;
    const entry = imgEntryById(id);
    if (!entry) return;
    ev.preventDefault();
    ctDeselectAll();
    shDeselectAll();
    imgDeselectAll();
    imgEl.classList.add('selected');
    _selUpdateMultiClass();
    orShowCtxMenu(ev.clientX, ev.clientY, [
      { label: 'Copy to all pages', action: () => _imgCopyToAll(id) },
      { label: 'Copy to pages…',     action: () => { if (_ppCopyModalReady) ppCopyPagesOpenForKind('image', entry); else _imgCopyToPages(entry); } },
      { label: 'Delete',             action: () => imgDelete(id) },
    ]);
  });
  document.addEventListener('click', orHideCtxMenu);

  imgRenderAll();
}

function _imgCopyToAll(id) {
  const entry = imgEntryById(id);
  if (!entry) return;
  const others = pageMetaList().filter(m => m.id !== entry.pageId);
  if (!others.length) return;
  others.forEach(m => {
    /* Deep copy so each clone is fully independent — a shallow
       Object.assign would share any nested fields between siblings. */
    const clone = JSON.parse(JSON.stringify(entry));
    clone.id = 'ig-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    clone.pageId = m.id;
    _imgEntries.push(clone);
    imgMakeEl(clone);
  });
  imgSave(_imgEntries);
}

/* Prompt-based "copy to specific pages" for images — mirrors
   _shCopyPagesOpen; Slice 4's modal will replace both. */
function _imgCopyToPages(entry) {
  if (!entry) return;
  const others = pageMetaList().filter(m => m.id !== entry.pageId);
  if (!others.length) { alert('There are no other pages to copy this image to.'); return; }
  const list = others.map((m, i) => (i + 1) + '. ' + m.label).join('\n');
  const ans = window.prompt(
    'Copy this image to which pages?\n\nType "all" for every page, OR a comma-separated list of numbers:\n\n' + list,
    'all'
  );
  if (ans == null) return;
  const trimmed = ans.trim().toLowerCase();
  let targets = [];
  if (trimmed === 'all' || trimmed === '*' || trimmed === '') {
    targets = others.map(m => m.id);
  } else {
    const nums = trimmed.split(/[,\s]+/).map(n => parseInt(n, 10) - 1).filter(n => n >= 0 && n < others.length);
    targets = nums.map(n => others[n].id);
  }
  if (!targets.length) { alert('No valid pages picked.'); return; }
  targets.forEach(pid => {
    const clone = JSON.parse(JSON.stringify(entry));
    clone.id = 'ig-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    clone.pageId = pid;
    _imgEntries.push(clone);
    imgMakeEl(clone);
  });
  imgSave(_imgEntries);
}

/* ═════════════ Floating right-click context menu ═════════════ */
function orShowCtxMenu(x, y, items) {
  const menu = document.getElementById('or-ctx-menu');
  if (!menu) return;
  menu.innerHTML = '';
  items.forEach(it => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.addEventListener('click', () => {
      orHideCtxMenu();
      try { it.action(); } catch (e) { console.error(e); }
    });
    menu.appendChild(b);
  });
  /* Clamp to viewport so the menu never spawns off-screen. */
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  menu.style.left = '0px'; menu.style.top = '0px';
  menu.classList.add('open');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(Math.max(8, x), vw - r.width - 8) + 'px';
  menu.style.top  = Math.min(Math.max(8, y), vh - r.height - 8) + 'px';
}
function orHideCtxMenu() {
  const menu = document.getElementById('or-ctx-menu');
  if (menu) menu.classList.remove('open');
}

/* ═════════════════════════════════════════════════════════════════
   Page-background editor — popover + apply-to-pages modal
   ─────────────────────────────────────────────────────────────────
   Right-click any bare .page background (in edit mode) → popover
   opens with Solid / Gradient tabs. Live preview as the user picks
   colours / drags the angle slider. Apply commits; Cancel reverts;
   Reset clears the override entirely; "Apply to other pages…"
   opens the modal for bulk-applying to multiple pages.
   ═════════════════════════════════════════════════════════════════ */
let _bgEditorTarget = null;
let _bgEditorOriginal = '';

function _bgToHex(s) {
  if (!s) return '#142230';
  const t = String(s).trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) {
    return ('#' + t.slice(1).split('').map(c => c + c).join('')).toLowerCase();
  }
  if (/^rgba?\(/i.test(t)) {
    const m = t.match(/-?\d+(?:\.\d+)?/g);
    if (m && m.length >= 3) {
      return '#' + m.slice(0, 3).map(n =>
        Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')
      ).join('');
    }
  }
  return '#142230';
}

function _bgParse(value) {
  const def = { mode: 'solid', solid: '#142230', c1: '#0f2b38', c2: '#1f546d', angle: 135 };
  if (!value || typeof value !== 'string') return def;
  const v = value.trim();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v) || /^rgba?\(/i.test(v)) {
    const hex = _bgToHex(v);
    return { mode: 'solid', solid: hex, c1: hex, c2: def.c2, angle: 135 };
  }
  const g = v.match(/^linear-gradient\(\s*(-?\d+(?:\.\d+)?)deg\s*,\s*([^,]+?)\s+0%\s*,\s*([^)]+?)\s+100%\s*\)$/i);
  if (g) {
    return {
      mode: 'gradient',
      solid: def.solid,
      c1: _bgToHex(g[2]),
      c2: _bgToHex(g[3]),
      angle: ((parseInt(g[1], 10) % 360) + 360) % 360,
    };
  }
  return def;
}

function _bgPopover() { return document.getElementById('bg-popover'); }

function _bgReadState() {
  const pop = _bgPopover();
  const tab = pop.querySelector('.bg-tab.on');
  const mode = tab ? tab.dataset.mode : 'solid';
  const ang = parseInt(document.getElementById('bg-grad-angle').value, 10);
  return {
    mode,
    solid: document.getElementById('bg-solid-color').value,
    c1:    document.getElementById('bg-grad-c1').value,
    c2:    document.getElementById('bg-grad-c2').value,
    angle: Number.isFinite(ang) ? Math.max(0, Math.min(360, ang)) : 135,
  };
}

function _bgComposeCss(s) {
  if (s.mode === 'gradient') {
    return 'linear-gradient(' + s.angle + 'deg, ' + s.c1 + ' 0%, ' + s.c2 + ' 100%)';
  }
  return s.solid;
}

function _bgWriteState(p) {
  const pop = _bgPopover();
  pop.querySelectorAll('.bg-tab').forEach(b => {
    const on = (b.dataset.mode === p.mode);
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  pop.querySelectorAll('.bg-pane').forEach(pane => {
    pane.classList.toggle('on', pane.dataset.mode === p.mode);
  });
  document.getElementById('bg-solid-color').value    = p.solid;
  document.getElementById('bg-solid-hex').value      = p.solid;
  document.getElementById('bg-grad-c1').value        = p.c1;
  document.getElementById('bg-grad-c1-hex').value    = p.c1;
  document.getElementById('bg-grad-c2').value        = p.c2;
  document.getElementById('bg-grad-c2-hex').value    = p.c2;
  document.getElementById('bg-grad-angle').value     = String(p.angle);
  document.getElementById('bg-grad-angle-num').value = String(p.angle);
}

function _bgUpdatePreview() {
  const css = _bgComposeCss(_bgReadState());
  const pv = document.getElementById('bg-preview');
  if (pv) pv.style.background = css;
  if (_bgEditorTarget) _bgEditorTarget.style.background = css;
}

function _bgPositionPopover(clientX, clientY) {
  const pop = _bgPopover();
  pop.style.visibility = 'hidden';
  pop.classList.add('open');
  const rect = pop.getBoundingClientRect();
  const w = rect.width  || 280;
  const h = rect.height || 260;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const x = Math.min(Math.max(8, clientX), vw - w - 8) + window.scrollX;
  const y = (clientY + h + 12 < vh ? clientY + 8 : Math.max(8, clientY - h - 8)) + window.scrollY;
  pop.style.left = x + 'px';
  pop.style.top  = y + 'px';
  pop.style.visibility = '';
}

function openPageBgEditor(pageEl, clientX, clientY) {
  if (!pageEl) return;
  if (_bgEditorTarget && _bgEditorTarget !== pageEl) {
    _bgEditorTarget.style.background = _bgEditorOriginal;
  }
  _bgEditorTarget = pageEl;
  _bgEditorOriginal = pageEl.style.background || '';
  const stored = loadPageBgs()[pageEl.id];
  const seed = stored || _bgEditorOriginal || getComputedStyle(pageEl).backgroundColor || '';
  _bgWriteState(_bgParse(seed));
  _bgUpdatePreview();
  _bgPositionPopover(clientX, clientY);
  const titleEl = document.getElementById('bg-popover-title');
  if (titleEl) titleEl.textContent = 'Page Background — ' + (pageEl.dataset.label || pageEl.id);
}
function closePageBgEditor() {
  const pop = _bgPopover();
  if (pop) pop.classList.remove('open');
  _bgEditorTarget = null;
  _bgEditorOriginal = '';
}
function cancelPageBgEditor() {
  if (_bgEditorTarget) _bgEditorTarget.style.background = _bgEditorOriginal;
  closePageBgEditor();
}

function setupPageBgEditor() {
  const pop = _bgPopover();
  if (!pop) return;
  /* Double-click a bare .page in edit mode opens the editor. Single
     clicks are reserved for selection / drag in the overlay systems
     (and the +Page custom-pages workflow), so a double-click is the
     explicit, low-collision gesture for the page background. */
  const wrap = document.querySelector('.page-outer-wrap');
  if (wrap) {
    wrap.addEventListener('dblclick', ev => {
      if (!document.body.classList.contains('edit-mode')) return;
      const t = ev.target;
      if (!t || !t.classList || !t.classList.contains('page')) return;
      ev.preventDefault();
      openPageBgEditor(t, ev.clientX, ev.clientY);
    });
  }
  document.addEventListener('mousedown', ev => {
    if (!pop.classList.contains('open')) return;
    if (pop.contains(ev.target)) return;
    if (ev.target && ev.target.classList && ev.target.classList.contains('page')) return;
    cancelPageBgEditor();
  }, true);
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (!pop.classList.contains('open')) return;
    cancelPageBgEditor();
  });

  pop.querySelectorAll('.bg-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      pop.querySelectorAll('.bg-tab').forEach(b => {
        const on = (b === btn);
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      pop.querySelectorAll('.bg-pane').forEach(p => {
        p.classList.toggle('on', p.dataset.mode === btn.dataset.mode);
      });
      _bgUpdatePreview();
    });
  });

  const pairColor = (colId, hexId) => {
    const col = document.getElementById(colId);
    const hex = document.getElementById(hexId);
    if (!col || !hex) return;
    col.addEventListener('input', () => {
      hex.value = col.value;
      _bgUpdatePreview();
    });
    hex.addEventListener('input', () => {
      const v = hex.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) {
        col.value = v.toLowerCase();
        _bgUpdatePreview();
      }
    });
    hex.addEventListener('blur', () => { hex.value = col.value; });
  };
  pairColor('bg-solid-color', 'bg-solid-hex');
  pairColor('bg-grad-c1',     'bg-grad-c1-hex');
  pairColor('bg-grad-c2',     'bg-grad-c2-hex');

  const ang  = document.getElementById('bg-grad-angle');
  const angN = document.getElementById('bg-grad-angle-num');
  if (ang && angN) {
    ang.addEventListener('input', () => { angN.value = ang.value; _bgUpdatePreview(); });
    angN.addEventListener('input', () => {
      let v = parseInt(angN.value, 10);
      if (Number.isFinite(v)) {
        v = Math.max(0, Math.min(360, v));
        ang.value = String(v);
        _bgUpdatePreview();
      }
    });
  }

  const applyBtn  = document.getElementById('bg-apply');
  const cancelBtn = document.getElementById('bg-cancel');
  const resetBtn  = document.getElementById('bg-reset');
  const applyPgs  = document.getElementById('bg-apply-pages');
  if (applyBtn) applyBtn.addEventListener('click', () => {
    if (!_bgEditorTarget) return;
    setPageBg(_bgEditorTarget.id, _bgComposeCss(_bgReadState()));
    closePageBgEditor();
  });
  if (cancelBtn) cancelBtn.addEventListener('click', cancelPageBgEditor);
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (!_bgEditorTarget) return;
    setPageBg(_bgEditorTarget.id, '');
    closePageBgEditor();
  });
  if (applyPgs) applyPgs.addEventListener('click', () => {
    if (!_bgEditorTarget) return;
    pageBgApplyOpen();
  });
}

/* ═════════════ Apply background to other pages modal ═════════════ */
let _bgApplySnapshot = null;

function pageBgApplyOpen() {
  if (!_bgEditorTarget) return;
  const bg   = document.getElementById('bg-apply-modal-bg');
  const list = document.getElementById('bg-apply-list');
  const sub  = document.getElementById('bg-apply-sub');
  const allCb = document.getElementById('bg-apply-all');
  if (!bg || !list || !sub || !allCb) return;
  _bgApplySnapshot = {
    sourceId: _bgEditorTarget.id,
    css:      _bgComposeCss(_bgReadState()),
  };
  const allPages   = Array.from(document.querySelectorAll('section.page[id]'));
  const otherPages = allPages.filter(p => p.id !== _bgApplySnapshot.sourceId);
  if (!otherPages.length) {
    alert('There are no other pages to apply to.');
    _bgApplySnapshot = null;
    return;
  }
  const srcPage  = document.getElementById(_bgApplySnapshot.sourceId);
  const srcLabel = srcPage ? (srcPage.dataset.label || srcPage.id) : _bgApplySnapshot.sourceId;
  const srcIdx   = allPages.indexOf(srcPage) + 1;
  sub.innerHTML =
    'Applying the background from page ' + srcIdx + ' (<strong>' + srcLabel + '</strong>) ' +
    '<span style="display:inline-block; width:18px; height:12px; border-radius:2px; ' +
    'border:1px solid rgba(255,255,255,0.2); vertical-align:middle; ' +
    'background:' + _bgApplySnapshot.css.replace(/"/g, '&quot;') + ';"></span> ' +
    'to the pages you tick below. The source page is updated too.';
  list.innerHTML = '';
  otherPages.forEach((page) => {
    const idx = allPages.indexOf(page) + 1;
    const label = page.dataset.label || page.id;
    const row = document.createElement('label');
    row.className = 'pp-pages-row';
    row.innerHTML =
      '<input type="checkbox" data-page-id="' + page.id + '" />' +
      '<span class="num">' + idx + '</span>' +
      '<span class="lbl">' + label + '</span>';
    list.appendChild(row);
  });
  allCb.checked = false;
  pageBgApplyUpdateConfirmCount();
  const pop = _bgPopover();
  if (pop) pop.classList.remove('open');
  bg.classList.add('open');
  bg.setAttribute('aria-hidden', 'false');
}

function pageBgApplyClose() {
  const bg = document.getElementById('bg-apply-modal-bg');
  if (!bg) return;
  bg.classList.remove('open');
  bg.setAttribute('aria-hidden', 'true');
  _bgApplySnapshot = null;
  const pop = _bgPopover();
  if (pop && _bgEditorTarget) pop.classList.add('open');
}

function pageBgApplyUpdateConfirmCount() {
  const list = document.getElementById('bg-apply-list');
  const btn  = document.getElementById('bg-apply-confirm');
  if (!list || !btn) return;
  const checked = list.querySelectorAll('input[type="checkbox"]:checked').length;
  btn.disabled = checked === 0;
  btn.textContent = checked === 0 ? 'Apply' : 'Apply to ' + (checked + 1) + ' pages';
}

function setupPageBgApplyModal() {
  const bg = document.getElementById('bg-apply-modal-bg');
  if (!bg) return;
  const list  = document.getElementById('bg-apply-list');
  const allCb = document.getElementById('bg-apply-all');
  const closeBtn  = document.getElementById('bg-apply-close');
  const cancelBtn = document.getElementById('bg-apply-cancel');
  const confirmBtn = document.getElementById('bg-apply-confirm');
  if (closeBtn)  closeBtn.addEventListener('click', pageBgApplyClose);
  if (cancelBtn) cancelBtn.addEventListener('click', pageBgApplyClose);
  bg.addEventListener('click', ev => { if (ev.target === bg) pageBgApplyClose(); });
  if (allCb && list) {
    allCb.addEventListener('change', () => {
      list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = allCb.checked; });
      pageBgApplyUpdateConfirmCount();
    });
    list.addEventListener('change', () => {
      const cbs = list.querySelectorAll('input[type="checkbox"]');
      const checked = list.querySelectorAll('input[type="checkbox"]:checked');
      allCb.checked = (cbs.length > 0 && checked.length === cbs.length);
      pageBgApplyUpdateConfirmCount();
    });
  }
  if (confirmBtn) confirmBtn.addEventListener('click', () => {
    const snap = _bgApplySnapshot;
    if (!snap) { pageBgApplyClose(); return; }
    const targetIds = Array.from(list.querySelectorAll('input[type="checkbox"]:checked'))
      .map(cb => cb.dataset.pageId);
    if (!targetIds.length) return;
    setPageBgs([snap.sourceId, ...targetIds], snap.css);
    closePageBgEditor();
    pageBgApplyClose();
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (!bg.classList.contains('open')) return;
    pageBgApplyClose();
  });
}

/* ═════════════ Side TOC (rebuild with .num + .lbl + actions) ═════════════
   The wrap element is `side-toc-inner` (regional convention) for the
   National + Commercial reports. Older tools that used `sideToc` as
   the dump target are no longer in this family, but the fallback
   selector keeps the function defensive — if neither id exists we
   no-op. */
function buildSideToc() {
  const wrap = document.getElementById('side-toc-inner') || document.getElementById('sideToc');
  if (!wrap) return;
  const meta = pageMetaList();
  wrap.innerHTML = '';
  meta.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'side-toc-item';
    row.dataset.target = m.id;
    row.draggable = true;
    row.innerHTML =
      '<span class="num">' + (i + 1) + '</span>' +
      '<span class="lbl">' + (m.label || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>' +
      '<span class="side-toc-actions">' +
        '<button class="dup" title="Duplicate this page">⧉</button>' +
        '<button class="ren" title="Rename this page">✎</button>' +
        '<button class="del danger" title="Delete this page">×</button>' +
      '</span>';
    row.addEventListener('click', ev => {
      if (ev.target.closest('.side-toc-actions')) return;
      if (row.classList.contains('renaming')) return;
      const tgt = document.getElementById(m.id);
      if (tgt) tgt.scrollIntoView({ behavior: 'auto', block: 'start' });
      document.querySelectorAll('.side-toc-item').forEach(it => {
        it.classList.toggle('active', it === row);
      });
    });
    row.querySelector('.dup').addEventListener('click', ev => { ev.stopPropagation(); duplicatePage(m.id); });
    row.querySelector('.ren').addEventListener('click', ev => { ev.stopPropagation(); renamePage(row, m.id); });
    row.querySelector('.del').addEventListener('click', ev => { ev.stopPropagation(); deletePage(m.id); });
    row.addEventListener('dragstart', tocDragStart);
    row.addEventListener('dragend',   tocDragEnd);
    row.addEventListener('dragenter', tocDragEnter);
    row.addEventListener('dragover',  tocDragOver);
    row.addEventListener('dragleave', tocDragLeave);
    row.addEventListener('drop',      tocDragDrop);
    wrap.appendChild(row);
  });
}

function refreshChrome() {
  injectPageNumbers();
  buildSideToc();
}

/* ═════════════ Side-TOC collapse / expand toggle ═════════════
   Two-phase cascading animation matching the regional Online Reports
   behaviour: on hide the rows fade out bottom-to-top, then the
   column shrinks; on show the column expands first, then rows fade
   in top-to-bottom. The TOC starts COLLAPSED on entry so the chart
   pages aren't immediately squashed — users opt in via the chevron. */
function setupTocToggle() {
  const btn = document.getElementById('side-toc-toggle');
  const toc = document.getElementById('side-toc');
  if (!btn || !toc) return;
  /* Default to collapsed without playing the cascade. Force a reflow
     so the no-transition state commits before transitions resume. */
  const prevTransition = toc.style.transition;
  toc.style.transition = 'none';
  toc.classList.add('items-hidden', 'collapsed', 'chevron-down');
  void toc.offsetHeight;
  toc.style.transition = prevTransition;

  const STAGGER_MS   = 40;
  const ITEM_FADE_MS = 380;
  const CONTAINER_MS = 480;
  const SAFETY_MS    = 40;
  let busy = false;

  btn.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    const willCollapse = !toc.classList.contains('collapsed');
    const items = toc.querySelectorAll('.side-toc-item');
    const total = items.length;
    items.forEach((item, idx) => {
      const delay = willCollapse
        ? (total - 1 - idx) * STAGGER_MS
        : idx * STAGGER_MS;
      item.style.transitionDelay = delay + 'ms';
    });
    const itemPhaseMs = (total > 0 ? (total - 1) * STAGGER_MS : 0) + ITEM_FADE_MS;
    toc.classList.toggle('chevron-down', willCollapse);
    if (willCollapse) {
      toc.classList.add('items-hidden');
      setTimeout(() => {
        toc.classList.add('collapsed');
        setTimeout(() => { busy = false; }, CONTAINER_MS + SAFETY_MS);
      }, itemPhaseMs + SAFETY_MS);
    } else {
      toc.classList.remove('collapsed');
      setTimeout(() => {
        toc.classList.remove('items-hidden');
        setTimeout(() => { busy = false; }, itemPhaseMs + SAFETY_MS);
      }, CONTAINER_MS + SAFETY_MS);
    }
  });
}

/* ─── Scroll spy — highlights the TOC row matching the most-visible
   page AND updates the pager's "N / M" indicator. The pager indicator
   uses ctVisiblePageId() (which already picks the page with the most
   on-screen height) so the number lines up with what the user is
   actually looking at, not just whichever section is intersecting. */
function setupScrollSpy() {
  const sections = Array.from(document.querySelectorAll('section.page'));
  if (!sections.length) return;
  const indicator = document.getElementById('page-indicator');
  const updateIndicator = () => {
    if (!indicator) return;
    const meta = pageMetaList();
    if (!meta.length) return;
    const visible = ctVisiblePageId();
    const idx = Math.max(0, meta.findIndex(m => m.id === visible));
    indicator.textContent = (idx + 1) + ' / ' + meta.length;
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const items = document.querySelectorAll('.side-toc-item');
        items.forEach(it => it.classList.toggle('active', it.dataset.target === e.target.id));
      }
    });
    updateIndicator();
  }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
  sections.forEach(s => io.observe(s));
  /* Initial paint so the indicator reads "1 / N" on first load
     instead of staying blank until the first scroll event. */
  updateIndicator();
  window.addEventListener('scroll', updateIndicator, { passive: true });
  window.addEventListener('resize', updateIndicator, { passive: true });
}

/* ─── Region picker. Lists every report tool the hub exposes —
   the two research reports first, then the 35 regional reports
   grouped by cluster. Selecting a different entry navigates to
   that tool's URL (fade-out then redirect). */
function setupRegionSelect() {
  const sel = document.getElementById('region-select');
  if (!sel) return;
  const slug = _rs_active();
  sel.innerHTML = '';
  /* Research group. */
  const researchGroup = document.createElement('optgroup');
  researchGroup.label = 'Research Reports';
  for (const [s, info] of Object.entries(RESEARCH_REGIONS)) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = info.name;
    if (s === slug) opt.selected = true;
    researchGroup.appendChild(opt);
  }
  sel.appendChild(researchGroup);
  /* Regional groups, cluster-by-cluster. */
  for (const cluster of REGIONAL_CLUSTER_ORDER) {
    const group = document.createElement('optgroup');
    group.label = REGIONAL_CLUSTER_LABELS[cluster];
    const entries = Object.entries(REGIONAL_REGIONS)
      .filter(([_, info]) => info.cluster === cluster)
      .sort((a, b) => a[1].name.localeCompare(b[1].name));
    for (const [s, info] of entries) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = info.name + ' · ' + info.state;
      if (s === slug) opt.selected = true;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  sel.addEventListener('change', () => {
    const value = sel.value;
    if (!value || value === slug) return;
    const target = (RESEARCH_REGIONS[value] && { url: '/tools/' + RESEARCH_REGIONS[value].url })
                || (REGIONAL_REGIONS[value]  && { url: '/tools/online-reports.html?region=' + value });
    if (!target) return;
    document.body.style.transition = 'opacity .2s ease';
    document.body.style.opacity = '0';
    setTimeout(() => { location.href = target.url; }, 200);
  });
}

/* ═════════════════════════════════════════════════════════════════
   Download Report modal — pages + regions picker
   ─────────────────────────────────────────────────────────────────
   Mirrors the regional Online Reports' Download Report modal so all
   three tools share the same UX. The current region is pre-checked
   in the regions column; the other research region can also be
   ticked to download both reports in one batch.

   Cancellation is wired through window.__pp_exportCancelled — the
   inline download functions poll this flag at each page-capture
   boundary and bail out cleanly when it's set. The Cancel button on
   the export overlay calls cancelCurrentExport() which both sets
   the flag and hides the overlay so the user knows the cancel
   registered (the running loop unwinds within ~1s).
   ═════════════════════════════════════════════════════════════════ */
window.__pp_exportCancelled = false;
window.__pp_exportInProgress = false;

/* Public cancel entry point — the Cancel button on the export
   overlay (in each HTML file) calls this. Sets the flag; the running
   capture loop checks it at each iteration and exits before the
   next render. */
function cancelCurrentExport() {
  if (!window.__pp_exportInProgress) return;
  window.__pp_exportCancelled = true;
  /* Visible feedback so the user sees the click registered — the
     overlay message updates immediately while the loop unwinds. */
  if (typeof _updateExportMsg === 'function') {
    _updateExportMsg('Cancelling…');
  }
}
window.cancelCurrentExport = cancelCurrentExport;

function openPdfPagesModal() {
  if (typeof isViewOnly === 'function' && isViewOnly()) {
    alert('PDF / JPEG download is not available for viewer accounts.');
    return;
  }
  const bg          = document.getElementById('pdf-pages-modal-bg');
  const pageList    = document.getElementById('pdf-pages-list');
  const regionList  = document.getElementById('pdf-regions-list');
  const allPagesCb  = document.getElementById('pdf-pages-all');
  const allRegionsCb= document.getElementById('pdf-regions-all');
  if (!bg || !pageList || !regionList) return;

  /* PAGES — built from the current report's meta (post-restore so
     user-renamed labels show up). Every row defaults checked. */
  const meta = pageMetaList();
  pageList.innerHTML = meta.map((m, i) => {
    const safe = String(m.label).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    return ''
      + '<label class="pp-pages-row">'
      +   '<input type="checkbox" data-page-id="' + m.id + '" checked />'
      +   '<span class="num">' + (i + 1) + '</span>'
      +   '<span class="lbl">' + safe + '</span>'
      + '</label>';
  }).join('');

  /* REGIONS — pre-check the active region; other research regions
     are listed but unchecked by default. */
  const slug = _rs_active();
  const _esc = (str) => String(str).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  const _regRow = (s, name) => ''
    + '<label class="pp-pages-row">'
    +   '<input type="checkbox" data-slug="' + s + '"' + (s === slug ? ' checked' : '') + ' />'
    +   '<span class="lbl">' + _esc(name) + '</span>'
    + '</label>';
  const _regHdr = (label) => '<div class="pp-region-group" style="font-size:11px;font-weight:700;'
    + 'letter-spacing:.08em;text-transform:uppercase;opacity:.55;margin:12px 2px 4px;">' + _esc(label) + '</div>';
  /* Unified report list: the 35 regional reports grouped by cluster, then a
     Research Reports group (National + Commercial). The active report is
     pre-checked; everything else starts unchecked. Cross-family picks (e.g. a
     regional report selected from the National report) download as the cached
     full PDF — see _dispatchReportDownload. */
  let _regHtml = '';
  REGIONAL_CLUSTER_ORDER.forEach(cl => {
    const rows = Object.entries(REGIONAL_REGIONS).filter(([, info]) => info.cluster === cl);
    if (!rows.length) return;
    _regHtml += _regHdr(REGIONAL_CLUSTER_LABELS[cl] || cl);
    rows.forEach(([s, info]) => { _regHtml += _regRow(s, info.name); });
  });
  _regHtml += _regHdr('Research Reports');
  Object.entries(RESEARCH_REGIONS).forEach(([s, info]) => { _regHtml += _regRow(s, info.name); });
  regionList.innerHTML = _regHtml;

  if (allPagesCb) allPagesCb.checked = true;
  if (allRegionsCb) {
    const allLbl = allRegionsCb.closest('label');
    const st = allLbl && allLbl.querySelector('strong');
    if (st) st.textContent = 'All reports';
    const allChecked = Array.from(regionList.querySelectorAll('input[type="checkbox"]')).every(c => c.checked);
    allRegionsCb.checked = allChecked;
  }

  /* Per-row change handlers — keep masters in sync + recompute summary. */
  pageList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const allRows = pageList.querySelectorAll('input[type="checkbox"]');
      const allChecked = Array.from(allRows).every(c => c.checked);
      if (allPagesCb) allPagesCb.checked = allChecked;
      updatePdfPagesConfirmState();
    });
  });
  regionList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const allRows = regionList.querySelectorAll('input[type="checkbox"]');
      const allChecked = Array.from(allRows).every(c => c.checked);
      if (allRegionsCb) allRegionsCb.checked = allChecked;
      updatePdfPagesConfirmState();
    });
  });

  updatePdfPagesConfirmState();
  bg.classList.add('open');
  bg.setAttribute('aria-hidden', 'false');
}
window.openPdfPagesModal = openPdfPagesModal;

function closePdfPagesModal() {
  const bg = document.getElementById('pdf-pages-modal-bg');
  if (!bg) return;
  bg.classList.remove('open');
  bg.setAttribute('aria-hidden', 'true');
}

function updatePdfPagesConfirmState() {
  const confirm = document.getElementById('pdf-pages-confirm');
  const jpeg    = document.getElementById('pdf-pages-jpeg');
  const summary = document.getElementById('pdf-pages-summary');
  const pageRows   = document.querySelectorAll('#pdf-pages-list input[type="checkbox"]');
  const regionRows = document.querySelectorAll('#pdf-regions-list input[type="checkbox"]');
  const pCount = document.querySelectorAll('#pdf-pages-list input[type="checkbox"]:checked').length;
  const rCount = document.querySelectorAll('#pdf-regions-list input[type="checkbox"]:checked').length;
  const allPages = pageRows.length && pCount === pageRows.length;
  const allRegions = regionRows.length && rCount === regionRows.length;
  const anyMissing = !pCount || !rCount;
  if (confirm) {
    confirm.disabled = anyMissing;
    confirm.textContent = anyMissing
      ? 'Pick pages + regions'
      : (rCount > 1 ? ('Download ' + rCount + ' PDFs') : 'Download PDF');
  }
  if (jpeg) jpeg.disabled = anyMissing;
  if (summary) {
    if (anyMissing) {
      summary.innerHTML = '<span class="pdf-pages-summary-warn">Pick at least one page and one region.</span>';
    } else {
      const pagesPart = allPages
        ? '<strong>All pages</strong>'
        : ('<strong>' + pCount + '</strong> page' + (pCount === 1 ? '' : 's'));
      const regionsPart = allRegions
        ? '<strong>All ' + rCount + ' regions</strong>'
        : ('<strong>' + rCount + '</strong> region' + (rCount === 1 ? '' : 's'));
      summary.innerHTML = pagesPart + ' &middot; ' + regionsPart;
    }
  }
  updatePdfPageSections();
}

/* Lean per-family page sections (Increment 2): the page checklist can only be
   the CURRENT report's pages (pageMetaList reads the live DOM — other tools
   aren't loaded). So label the checklist with the current report FAMILY, and
   when reports from the OTHER family are also selected, show a "downloads as
   the full PDF" section listing them — making the regional/research page split
   explicit. Pure UI: the export split in _dispatchReportDownload already routes
   the current family's page selection and the other family's full cached PDF.
   Auto-runs from updatePdfPagesConfirmState (fires on every page/region tick). */
function updatePdfPageSections() {
  const pageList = document.getElementById('pdf-pages-list');
  if (!pageList) return;
  const pagesCol = pageList.parentElement;
  const _esc = (str) => String(str).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  const activeSlug = (typeof _rs_active === 'function') ? _rs_active() : null;
  const activeIsResearch = !!(activeSlug && RESEARCH_REGIONS[activeSlug]);
  const curFamLabel   = activeIsResearch ? 'Research report' : 'Regional report';
  const otherFamLabel = activeIsResearch ? 'Research report' : 'Regional report';   // label of the OTHER family
  const otherFamName  = activeIsResearch ? 'Regional' : 'Research';

  const sel = Array.from(document.querySelectorAll('#pdf-regions-list input[type="checkbox"]:checked')).map(c => c.dataset.slug);
  const otherSel = sel.filter(s => (!!RESEARCH_REGIONS[s]) !== activeIsResearch);
  const regionalSel = sel.filter(s => !!REGIONAL_REGIONS[s]);

  /* Label the page checklist with the current family. */
  const title = pagesCol && pagesCol.querySelector('.pdf-pages-section-title');
  if (title) title.textContent = curFamLabel + ' pages';

  /* Availability note — only meaningful for the regional family with >1 region
     selected (page sets differ per region; missing pages are skipped). */
  let note = document.getElementById('pp-pages-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'pp-pages-note';
    note.style.cssText = 'margin:6px 2px 0;font-size:11px;opacity:.7;';
    pageList.after(note);
  }
  if (!activeIsResearch && regionalSel.length > 1) {
    note.style.display = '';
    note.textContent = 'Pages not present in a selected region are skipped for that region.';
  } else {
    note.style.display = 'none';
  }

  /* Other-family section — appears only when the other family has picks. */
  let other = document.getElementById('pp-other-family');
  if (!other) {
    other = document.createElement('div');
    other.id = 'pp-other-family';
    other.style.cssText = 'margin:12px 2px 0;padding:10px;border:1px dashed rgba(255,255,255,0.18);border-radius:8px;font-size:12px;line-height:1.5;';
    note.after(other);
  }
  if (otherSel.length) {
    const names = otherSel.map(s => _esc((RESEARCH_REGIONS[s] || REGIONAL_REGIONS[s] || {}).name || s));
    other.style.display = '';
    other.innerHTML =
        '<div style="font-weight:700;text-transform:uppercase;letter-spacing:.06em;font-size:11px;opacity:.6;margin-bottom:4px;">'
      +   otherFamName + ' reports'
      + '</div>'
      + '<div>Download as the <strong>full PDF</strong> (the page selection above applies to '
      +   curFamLabel.toLowerCase() + 's only):</div>'
      + '<div style="opacity:.85;margin-top:4px;">' + names.join(', ') + '</div>';
  } else {
    other.style.display = 'none';
  }
}

function setupPdfPagesModal() {
  const bg = document.getElementById('pdf-pages-modal-bg');
  if (!bg) return;
  if (bg.dataset.wired === '1') return;
  bg.dataset.wired = '1';

  const closeX = document.getElementById('pdf-pages-close');
  const cancel = document.getElementById('pdf-pages-cancel');
  if (closeX) closeX.addEventListener('click', closePdfPagesModal);
  if (cancel) cancel.addEventListener('click', closePdfPagesModal);
  bg.addEventListener('click', (e) => { if (e.target === bg) closePdfPagesModal(); });

  const allPagesCb  = document.getElementById('pdf-pages-all');
  const allRegionsCb= document.getElementById('pdf-regions-all');
  if (allPagesCb) allPagesCb.addEventListener('change', () => {
    document.querySelectorAll('#pdf-pages-list input[type="checkbox"]').forEach(cb => {
      cb.checked = allPagesCb.checked;
    });
    updatePdfPagesConfirmState();
  });
  if (allRegionsCb) allRegionsCb.addEventListener('change', () => {
    document.querySelectorAll('#pdf-regions-list input[type="checkbox"]').forEach(cb => {
      cb.checked = allRegionsCb.checked;
    });
    updatePdfPagesConfirmState();
  });

  /* Confirm buttons delegate to host-HTML functions that know how to
     capture the current report's pages. The host functions are
     responsible for honouring the cancel flag inside their capture
     loops. */
  const pdfBtn  = document.getElementById('pdf-pages-confirm');
  const jpegBtn = document.getElementById('pdf-pages-jpeg');
  if (pdfBtn)  pdfBtn.addEventListener('click',  () => { const sel = _readPdfPagesSelection(); if (sel) _dispatchReportDownload('pdf',  sel); });
  if (jpegBtn) jpegBtn.addEventListener('click', () => { const sel = _readPdfPagesSelection(); if (sel) _dispatchReportDownload('jpeg', sel); });

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && bg.classList.contains('open')) closePdfPagesModal();
  });
}

function _readPdfPagesSelection() {
  const pageRows = document.querySelectorAll('#pdf-pages-list input[type="checkbox"]');
  const pageChecked = document.querySelectorAll('#pdf-pages-list input[type="checkbox"]:checked');
  const wantAllPages = pageRows.length > 0 && pageChecked.length === pageRows.length;
  const pageIds = Array.from(pageChecked).map(cb => cb.dataset.pageId).filter(Boolean);
  const regions = Array.from(
    document.querySelectorAll('#pdf-regions-list input[type="checkbox"]:checked')
  ).map(cb => cb.dataset.slug);
  if (!pageIds.length || !regions.length) return null;
  return { pageIds, regions, allPages: wantAllPages };
}

/* Route a download. Selections in the CURRENT report's family go to the
   tool's own renderer (window.runReportDownload — honours page subsets + JPEG,
   live render / prebuilt cache). Selections from the OTHER family (e.g. a
   regional report picked from the National report) download as the cached full
   PDF via _downloadCachedReportPdfs (Increment 1: full PDF only — cross-family
   JPEG / page-subset is a later increment). */
function _dispatchReportDownload(kind, sel) {
  closePdfPagesModal();
  const activeSlug = (typeof _rs_active === 'function') ? _rs_active() : null;
  const activeIsResearch = !!(activeSlug && RESEARCH_REGIONS[activeSlug]);
  const cur = [], other = [];
  (sel.regions || []).forEach(s => {
    const isResearch = !!RESEARCH_REGIONS[s];
    (isResearch === activeIsResearch ? cur : other).push(s);
  });
  if (cur.length && typeof window.runReportDownload === 'function') {
    window.runReportDownload({ kind: kind, pageIds: sel.pageIds, regions: cur, allPages: sel.allPages });
  }
  if (other.length) {
    if (kind !== 'pdf' || !sel.allPages) {
      alert('The ' + (activeIsResearch ? 'regional' : 'National / Commercial') + ' report(s) you also picked '
        + 'export as the complete PDF for now (JPEG / specific-page export for the other report type is coming '
        + 'in the next step).');
    }
    _downloadCachedReportPdfs(other);
  }
}

/* Fetch the prebuilt monthly PDF for each slug straight from Storage and save
   it — the renderer publishes every report (35 regionals + national +
   commercial) to online-reports/<YYYY-MM>/<slug>.pdf. Tries this month, then
   last month (in case the 12th-of-month render hasn't run yet). Bucket is
   private → short-lived signed URLs. */
async function _downloadCachedReportPdfs(slugs) {
  if (!window.sb || !window.sb.storage) { alert('Cached downloads need a signed-in session.'); return; }
  const mk = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const now = new Date();
  const months = [mk(now), mk(new Date(now.getFullYear(), now.getMonth() - 1, 1))];
  const nameOf = (s) => ((RESEARCH_REGIONS[s] || REGIONAL_REGIONS[s] || {}).name || s);
  const miss = [];
  for (const slug of slugs) {
    let done = false;
    for (const m of months) {
      try {
        const { data, error } = await window.sb.storage.from('online-reports').createSignedUrl(m + '/' + slug + '.pdf', 60);
        if (error || !data || !data.signedUrl) continue;
        const resp = await fetch(data.signedUrl, { cache: 'no-store' });
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'PPA-' + nameOf(slug).replace(/[^\w]+/g, '-') + '.pdf';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        done = true;
        await new Promise(r => setTimeout(r, 350));   // space out so the browser asks once
        break;
      } catch (_) { /* try previous month */ }
    }
    if (!done) miss.push(slug);
  }
  if (miss.length) {
    alert('No cached PDF found yet for: ' + miss.map(nameOf).join(', ')
      + '.\n\nThe monthly PDFs build on the 12th. Open that report directly and use its own Download for a live export in the meantime.');
  }
}

/* ─── Bands button — chart reference-band UI is a future extension
   for the research reports (the regional Online Reports tool has
   per-region growth/correction period bands rendered behind several
   charts). For now this opens a placeholder alert so the visual
   parity with the regional pager is maintained without committing
   to the per-chart markArea integration. */
function setupBandsStub() {
  const btn = document.getElementById('btn-bands');
  if (!btn) return;
  btn.addEventListener('click', () => {
    alert(
      'Reference Bands are a regional-tool feature — they paint growth '
      + 'and correction periods behind specific time-series charts.\n\n'
      + 'They are not yet wired for the National + Commercial research '
      + 'reports; the storage bucket is in place so future support can '
      + 'land without a data migration.'
    );
  });
}

/* ─── Refresh button (↻) — re-fetches the Apps Script data feed +
   re-paints every chart. Spins while the fetch is in flight. The
   host HTML's inline `liveBoot()` is the work; we just call it. */
function setupRefreshButton() {
  const btn = document.getElementById('reportsRefreshBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('is-spinning');
    try {
      if (typeof liveBoot === 'function') {
        await liveBoot();
      }
    } catch (e) {
      console.warn('[report] refresh failed:', e && e.message || e);
    } finally {
      /* Brief delay so the spin animation is visible even on cache
         hits that return near-instantly. */
      setTimeout(() => {
        btn.classList.remove('is-spinning');
        btn.disabled = false;
      }, 300);
    }
  });
}

/* ─── Cached-PDF status pill. Lists the Supabase Storage bucket for
   the current month's pre-rendered PDF and shows either:
     - "Cached <D Mon YYYY>"  (file present — Download is instant)
     - "Live render"          (no cached file — Download renders live)
   Silent on failure (e.g. user signed out, network offline) so the
   pill just collapses via .prebuilt-status:empty. */
async function ppRefreshPrebuiltIndicator() {
  const el = document.getElementById('prebuilt-status');
  if (!el) return;
  const slug = _rs_active();
  const bucket = (typeof PREBUILT_BUCKET !== 'undefined' && PREBUILT_BUCKET) ? PREBUILT_BUCKET : 'online-reports';
  el.textContent = '';
  el.classList.remove('cached', 'live');
  if (!window.sb || !window.sb.storage) return;
  const monthKey = (() => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  })();
  const filename = slug + '.pdf';
  try {
    const { data, error } = await window.sb.storage
      .from(bucket)
      .list(monthKey, { limit: 100, search: filename });
    if (error || !Array.isArray(data)) { el.textContent = ''; return; }
    const hit = data.find(f => f.name === filename);
    if (hit) {
      const ts = hit.updated_at || hit.created_at;
      const d  = ts ? new Date(ts) : new Date();
      const label = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
      el.textContent = 'Cached ' + label;
      el.title = 'Pre-built PDF cached on ' + label + ' — Download will fetch this version instantly.';
      el.classList.add('cached');
    } else {
      el.textContent = 'Live render';
      el.title = 'No cached PDF for this report this month — Download will render live (~30s).';
      el.classList.add('live');
    }
  } catch (_) {
    el.textContent = '';
  }
}

/* ═════════════ TOC drag-and-drop reorder ═════════════ */
let _tocDragSrc = null;

function tocDragStart(ev) {
  if (!document.body.classList.contains('edit-mode')) { ev.preventDefault(); return; }
  _tocDragSrc = this;
  this.classList.add('dragging');
  ev.dataTransfer.effectAllowed = 'move';
  try { ev.dataTransfer.setData('text/plain', this.dataset.target); } catch (_) {}
}
function tocDragEnd() {
  this.classList.remove('dragging');
  document.querySelectorAll('.side-toc-item').forEach(it => {
    it.classList.remove('drag-over-top', 'drag-over-bot');
  });
  _tocDragSrc = null;
}
function tocDragEnter(ev) {
  if (!_tocDragSrc || _tocDragSrc === this) return;
  ev.preventDefault();
}
function tocDragOver(ev) {
  if (!_tocDragSrc || _tocDragSrc === this) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const rect = this.getBoundingClientRect();
  const before = (ev.clientY - rect.top) < rect.height / 2;
  this.classList.toggle('drag-over-top', before);
  this.classList.toggle('drag-over-bot', !before);
}
function tocDragLeave() {
  this.classList.remove('drag-over-top', 'drag-over-bot');
}
function tocDragDrop(ev) {
  ev.preventDefault();
  if (!_tocDragSrc || _tocDragSrc === this) return;
  const srcId = _tocDragSrc.dataset.target;
  const tgtId = this.dataset.target;
  const srcSec = document.getElementById(srcId);
  const tgtSec = document.getElementById(tgtId);
  if (!srcSec || !tgtSec) return;
  const rect = this.getBoundingClientRect();
  const before = (ev.clientY - rect.top) < rect.height / 2;
  if (before) tgtSec.parentNode.insertBefore(srcSec, tgtSec);
  else        tgtSec.parentNode.insertBefore(srcSec, tgtSec.nextSibling);
  refreshChrome();
  persistAll();
}

/* ═════════════ Inline rename ═════════════ */
function renamePage(row, pageId) {
  if (!document.body.classList.contains('edit-mode')) return;
  const lbl = row.querySelector('.lbl');
  if (!lbl) return;
  const original = lbl.textContent;
  let cancelled = false;
  row.classList.add('renaming');
  lbl.classList.add('editing');
  lbl.contentEditable = 'true';
  lbl.focus();
  const range = document.createRange();
  range.selectNodeContents(lbl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const onKeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); lbl.blur(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelled = true; lbl.blur(); }
  };
  const onBlur = () => {
    lbl.removeEventListener('keydown', onKeydown);
    lbl.removeEventListener('blur', onBlur);
    lbl.contentEditable = 'false';
    lbl.classList.remove('editing');
    row.classList.remove('renaming');
    if (cancelled) { lbl.textContent = original; return; }
    const next = (lbl.textContent || '').trim();
    if (!next || next === original) { lbl.textContent = original; return; }
    setPageLabel(pageId, next);
  };
  lbl.addEventListener('keydown', onKeydown);
  lbl.addEventListener('blur', onBlur);
}

/* ═════════════ Page CRUD ═════════════ */
function persistOrderFromDOM() {
  const ids = Array.from(document.querySelectorAll('section.page[id]')).map(s => s.id);
  savePageOrder(ids);
}
function persistCustomPages() {
  const customs = Array.from(document.querySelectorAll('section.page[data-custom="true"]'));
  saveCustomPages(customs.map(s => ({
    id: s.id,
    label: s.dataset.label || s.id,
    html: s.outerHTML,
  })));
}
function persistAll() {
  persistCustomPages();
  persistOrderFromDOM();
  if (!_ctRestoring) ctPushHistory();
}

function newPageId() {
  let i = 1;
  while (document.getElementById('pc-' + i)) i++;
  return 'pc-' + i;
}
function _wrap() { return document.querySelector('.page-outer-wrap'); }

function addBlankPage() {
  const id = newPageId();
  const visibleId = ctVisiblePageId();
  const after = visibleId ? document.getElementById(visibleId) : null;
  const sec = document.createElement('section');
  sec.className = 'page';
  sec.id = id;
  sec.dataset.label = 'New Page';
  sec.dataset.custom = 'true';
  sec.innerHTML =
    '<header class="rh-head"><div class="rh-brand">' +
      '<img src="../assets/Reports/logo-color.png" alt="Performance Property" />' +
    '</div></header>';
  if (after && after.parentNode) after.parentNode.insertBefore(sec, after.nextSibling);
  else _wrap().appendChild(sec);
  refreshChrome();
  persistAll();
  sec.scrollIntoView({ behavior: 'auto', block: 'start' });
}

function duplicatePage(srcId) {
  const src = document.getElementById(srcId);
  if (!src) return;
  const clone = src.cloneNode(true);
  clone.id = newPageId();
  clone.dataset.label = (src.dataset.label || 'Page') + ' (copy)';
  clone.dataset.custom = 'true';
  clone.querySelectorAll('.custom-text').forEach(el => el.remove());
  clone.querySelectorAll('.page-num').forEach(el => el.remove());
  src.parentNode.insertBefore(clone, src.nextSibling);
  refreshChrome();
  persistAll();
}

function deletePage(id) {
  const sec = document.getElementById(id);
  if (!sec) return;
  const total = document.querySelectorAll('section.page[id]').length;
  if (total <= 1) { alert('Cannot delete the only remaining page.'); return; }
  const label = sec.dataset.label || id;
  if (!confirm('Delete page "' + label + '"? Tip: Ctrl+Z will bring it back if you change your mind.')) return;
  sec.remove();
  refreshChrome();
  persistAll();
}

function restorePagesFromStorage() {
  const customs = loadCustomPages();
  const wrap = _wrap();
  if (!wrap) return;
  customs.forEach(c => {
    if (document.getElementById(c.id)) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = c.html;
    const sec = tmp.firstElementChild;
    if (sec && sec.classList.contains('page')) wrap.appendChild(sec);
  });

  const storedOrder = loadPageOrder();
  if (!storedOrder || !storedOrder.length) return;
  const sourceOrder = Array.from(document.querySelectorAll('section.page[id]')).map(s => s.id);
  const merged = storedOrder.slice();
  const known  = new Set(storedOrder);
  for (let i = 0; i < sourceOrder.length; i++) {
    const id = sourceOrder[i];
    if (known.has(id)) continue;
    let insertAt = 0;
    for (let j = i - 1; j >= 0; j--) {
      const prev = sourceOrder[j];
      if (known.has(prev)) { insertAt = merged.indexOf(prev) + 1; break; }
    }
    merged.splice(insertAt, 0, id);
    known.add(id);
  }
  const byId = {};
  document.querySelectorAll('section.page[id]').forEach(s => { byId[s.id] = s; });
  merged.forEach(id => { if (byId[id]) wrap.appendChild(byId[id]); });
}

/* ═════════════ View / Edit toggle + Grid + button wiring ═════════════ */
function setupModeToggle() {
  const btnView = document.getElementById('btn-mode-view');
  const btnEdit = document.getElementById('btn-mode-edit');
  if (!btnView || !btnEdit) return;
  const apply = (edit) => {
    document.body.classList.toggle('edit-mode', edit);
    btnView.classList.toggle('on', !edit);
    btnEdit.classList.toggle('on',  edit);
    btnView.setAttribute('aria-selected', !edit);
    btnEdit.setAttribute('aria-selected',  edit);
    if (!edit) {
      ctDeselectAll();
      shDeselectAll();
      imgDeselectAll();
      document.body.classList.remove('show-grid');
      document.getElementById('btn-grid')?.classList.remove('on');
    }
  };
  btnView.addEventListener('click', () => apply(false));
  btnEdit.addEventListener('click', () => apply(true));
  apply(false);
}

function setupGridToggle() {
  const btn = document.getElementById('btn-grid');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const on = !document.body.classList.contains('show-grid');
    document.body.classList.toggle('show-grid', on);
    btn.classList.toggle('on', on);
  });
}

/* ═════════════════════════════════════════════════════════════════
   Auto-zoom — shrink body.zoom to fit narrow viewports
   ─────────────────────────────────────────────────────────────────
   The regional Online Reports tool runs this so the 1200-wide pages
   never overflow a sub-1600 viewport. Without it, a 14"/15" laptop
   shows the page at 100% and the user has to side-scroll. With it,
   body.zoom scales the whole report (chrome + pages) so 1200px of
   content fits in viewport_width / 1600 of the screen.

   Skipped entirely in export mode (Puppeteer iframe runs at 1200px
   and we want the capture at native size, not a zoom-shrunk version).
   ═════════════════════════════════════════════════════════════════ */
const PP_AUTOZOOM_REQUIRED = 1600;
let _pp_autoZoomRaf = 0;

function applyAutoZoom() {
  if (typeof PP_EXPORT_MODE !== 'undefined' && PP_EXPORT_MODE) {
    document.body.style.zoom = '1';
    return;
  }
  if (document.body.classList.contains('export-mode')) {
    document.body.style.zoom = '1';
    return;
  }
  const vw = window.innerWidth;
  const zoom = vw < PP_AUTOZOOM_REQUIRED ? Math.max(0.55, vw / PP_AUTOZOOM_REQUIRED) : 1;
  document.body.style.zoom = String(zoom);
}

function setupAutoZoom() {
  applyAutoZoom();
  window.addEventListener('resize', () => {
    if (_pp_autoZoomRaf) return;
    _pp_autoZoomRaf = requestAnimationFrame(() => {
      _pp_autoZoomRaf = 0;
      applyAutoZoom();
    });
  });
}

/* ─── Pager-tools collapse/expand. Hides every tool button (View/Edit,
   edit-only tools, Download, Sync, Backup, Audit, status) behind the
   chevron at the far right of the pager. Same pattern as the regional
   pager-tools-toggle. Toggle preference NOT persisted — re-entering
   the tool always lands on the expanded state so the user sees what's
   available. */
function setupPagerToolsToggle() {
  /* Research reports use #pp-pager(-toggle); the regional tool uses
     #pager-tools(-toggle). Fall back so the chevron wires up in both. */
  const btn = document.getElementById('pp-pager-toggle') || document.getElementById('pager-tools-toggle');
  const pager = document.getElementById('pp-pager') || document.getElementById('pager-tools');
  if (!btn || !pager) return;
  btn.addEventListener('click', () => {
    pager.classList.toggle('tools-collapsed');
  });
}

function setupAddPageButton() {
  const btn = document.getElementById('btn-add-page');
  if (!btn) return;
  btn.addEventListener('click', addBlankPage);
}

/* ═════════════════════════════════════════════════════════════════
   Slice 4 — Research-region registry
   ─────────────────────────────────────────────────────────────────
   For sync + backup operations we need to enumerate every research
   region (so the user can pick "send my edits to Commercial too" or
   "back up both regions"). The regional file's REGION_MANIFEST lists
   all 35 regional reports; here we mirror just the two research ones.

   When more research regions are added, append them here. The slugs
   MUST match the ACTIVE_REGION values set by each tool's inline JS
   (Slice 1).
   ═════════════════════════════════════════════════════════════════ */
const RESEARCH_REGIONS = {
  national:   { name: 'National Market Overview',   url: 'national-report.html' },
  commercial: { name: 'Commercial Market Overview', url: 'commercial-report.html' },
};

/* All regional Online Reports regions. Mirror of REGION_MANIFEST in
   tools/online-reports.html — kept here so the research-report Sync
   and Backup modals can target every regional report and so the
   pager region-select can jump straight into any tool. The URL is
   relative to /tools/ (sibling of national-report.html). */
const REGIONAL_REGIONS = {
  sydney:           { name: 'Sydney',          state: 'NSW', cluster: 'capital' },
  melbourne:        { name: 'Melbourne',       state: 'VIC', cluster: 'capital' },
  brisbane:         { name: 'Brisbane',        state: 'QLD', cluster: 'capital' },
  adelaide:         { name: 'Adelaide',        state: 'SA',  cluster: 'capital' },
  perth:            { name: 'Perth',           state: 'WA',  cluster: 'capital' },
  hobart:           { name: 'Hobart',          state: 'TAS', cluster: 'capital' },
  canberra:         { name: 'Canberra',        state: 'ACT', cluster: 'capital' },
  darwin:           { name: 'Darwin',          state: 'NT',  cluster: 'capital' },
  bundaberg:        { name: 'Bundaberg',       state: 'QLD', cluster: 'qld' },
  cairns:           { name: 'Cairns',          state: 'QLD', cluster: 'qld' },
  gladstone:        { name: 'Gladstone',       state: 'QLD', cluster: 'qld' },
  'gold-coast':     { name: 'Gold Coast',      state: 'QLD', cluster: 'qld' },
  ipswich:          { name: 'Ipswich',         state: 'QLD', cluster: 'qld' },
  mackay:           { name: 'Mackay',          state: 'QLD', cluster: 'qld' },
  rockhampton:      { name: 'Rockhampton',     state: 'QLD', cluster: 'qld' },
  'sunshine-coast': { name: 'Sunshine Coast',  state: 'QLD', cluster: 'qld' },
  toowoomba:        { name: 'Toowoomba',       state: 'QLD', cluster: 'qld' },
  townsville:       { name: 'Townsville',      state: 'QLD', cluster: 'qld' },
  albury:           { name: 'Albury',          state: 'NSW', cluster: 'nsw' },
  'central-coast':  { name: 'Central Coast',   state: 'NSW', cluster: 'nsw' },
  'coffs-harbour':  { name: 'Coffs Harbour',   state: 'NSW', cluster: 'nsw' },
  dubbo:            { name: 'Dubbo',           state: 'NSW', cluster: 'nsw' },
  newcastle:        { name: 'Newcastle',       state: 'NSW', cluster: 'nsw' },
  orange:           { name: 'Orange',          state: 'NSW', cluster: 'nsw' },
  'port-macquarie': { name: 'Port Macquarie',  state: 'NSW', cluster: 'nsw' },
  tamworth:         { name: 'Tamworth',        state: 'NSW', cluster: 'nsw' },
  'wagga-wagga':    { name: 'Wagga Wagga',     state: 'NSW', cluster: 'nsw' },
  wollongong:       { name: 'Wollongong',      state: 'NSW', cluster: 'nsw' },
  ballarat:         { name: 'Ballarat',        state: 'VIC', cluster: 'vicwatas' },
  bendigo:          { name: 'Bendigo',         state: 'VIC', cluster: 'vicwatas' },
  geelong:          { name: 'Geelong',         state: 'VIC', cluster: 'vicwatas' },
  mildura:          { name: 'Mildura',         state: 'VIC', cluster: 'vicwatas' },
  wodonga:          { name: 'Wodonga',         state: 'VIC', cluster: 'vicwatas' },
  bunbury:          { name: 'Bunbury',         state: 'WA',  cluster: 'vicwatas' },
  rockingham:       { name: 'Rockingham',      state: 'WA',  cluster: 'vicwatas' },
  launceston:       { name: 'Launceston',      state: 'TAS', cluster: 'vicwatas' },
};
const REGIONAL_CLUSTER_ORDER  = ['capital', 'qld', 'nsw', 'vicwatas'];
const REGIONAL_CLUSTER_LABELS = {
  capital:  'Capital Cities',
  qld:      'QLD Regions',
  nsw:      'NSW Regions',
  vicwatas: 'VIC / WA / TAS Regions',
};

/* ---------------------------------------------------------------------------
 * Per-region page drops — the DOM page IDs each regional report does NOT
 * render. The regional template (online-reports.html) drops these pages per
 * region, so an overlay / label / page-bg keyed to a dropped page is
 * meaningless there. Cross-tool sync must filter those out before writing to
 * a target, or the target silently accumulates orphan entries on pages it
 * never shows (and they leak into its monthly PDF strip logic).
 *
 * CANONICAL-PENDING (#5 cutover): this MIRRORS REGION_MANIFEST's pageDrops in
 * tools/online-reports.html. Until that file is consolidated onto this
 * module, the two copies MUST be kept in step — change both together. The
 * cutover's job is to make online-reports.html read these from here so the
 * duplication goes away.
 * ------------------------------------------------------------------------- */
const _PP_PERTH_ONLY = ['p32', 'p33'];
const _PP_DROPS_31P  = [..._PP_PERTH_ONLY];
const _PP_DROPS_30P  = ['p27', ..._PP_PERTH_ONLY];
const _PP_DROPS_29P  = ['p26', 'p27', ..._PP_PERTH_ONLY];
const _PP_DROPS_26P  = ['p14', 'p22', 'p24', 'p26', 'p27', ..._PP_PERTH_ONLY];
const REGIONAL_PAGEDROPS = {
  /* capitals */
  sydney: _PP_DROPS_31P, melbourne: _PP_DROPS_31P, brisbane: _PP_DROPS_31P,
  adelaide: _PP_DROPS_31P, perth: [], hobart: _PP_DROPS_30P,
  canberra: _PP_DROPS_29P, darwin: _PP_DROPS_29P,
  /* QLD regions */
  bundaberg: _PP_DROPS_26P, cairns: _PP_DROPS_26P, gladstone: _PP_DROPS_26P,
  'gold-coast': _PP_DROPS_26P, ipswich: _PP_DROPS_26P, mackay: _PP_DROPS_26P,
  rockhampton: _PP_DROPS_26P, 'sunshine-coast': _PP_DROPS_26P,
  toowoomba: _PP_DROPS_26P, townsville: _PP_DROPS_26P,
  /* NSW regions */
  albury: _PP_DROPS_26P, 'central-coast': _PP_DROPS_26P, 'coffs-harbour': _PP_DROPS_26P,
  dubbo: _PP_DROPS_26P, newcastle: _PP_DROPS_26P, orange: ['p7', ..._PP_DROPS_26P],
  'port-macquarie': _PP_DROPS_26P, tamworth: _PP_DROPS_26P,
  'wagga-wagga': _PP_DROPS_26P, wollongong: _PP_DROPS_26P,
  /* VIC / WA / TAS regions */
  ballarat: _PP_DROPS_26P, bendigo: _PP_DROPS_26P, geelong: _PP_DROPS_26P,
  mildura: ['p11', ..._PP_DROPS_26P], wodonga: _PP_DROPS_26P,
  bunbury: _PP_DROPS_26P, rockingham: _PP_DROPS_26P, launceston: _PP_DROPS_26P,
};

/* Drop-set lookup for a target slug. Returns null when the target has no
   drops to apply: research targets (national/commercial render every page)
   and Perth (the 33-page superset) — both mean "don't filter anything". */
function _regionDropSet(targetSlug) {
  const drops = REGIONAL_PAGEDROPS[targetSlug];
  if (!drops || !drops.length) return null;
  return new Set(drops);
}

/* Leading 4-digit year of a band's `from` field ("2008" or "2008-03-01"),
   or null if it isn't a parseable year. Private name to avoid colliding
   with the regional tool's own bandToYear once this module is loaded
   there at cutover. */
function _ppBandToYear(d) {
  if (typeof d === 'number') return d;
  const m = String(d).match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/* First chart year for a sync target. Regional charts start later than
   Sydney, so bands predating a target's first year render off-axis there.
   Prefer live data (PPA_REGION_DATA), then a region stub (REGIONS), then
   a kind-based floor: regional reports start ~2000, research ~1985.
   Mirrors regional's syncBandStartYearForTarget. */
function _syncBandStartYearForTarget(targetSlug) {
  try {
    const live = (typeof window !== 'undefined' && window.PPA_REGION_DATA) ? window.PPA_REGION_DATA[targetSlug] : null;
    const yrs = live && live.medianPrice && live.medianPrice.years;
    if (yrs && yrs.length) { const y = Number(yrs[0]); if (Number.isFinite(y)) return y; }
  } catch (_) {}
  try {
    const stub = (typeof window !== 'undefined' && window.REGIONS) ? window.REGIONS[targetSlug] : null;
    if (stub && stub.priceYears && stub.priceYears.length) { const y = Number(stub.priceYears[0]); if (Number.isFinite(y)) return y; }
  } catch (_) {}
  return REGIONAL_REGIONS[targetSlug] ? 2000 : 1985;
}

/* Filter one sync bucket's value so nothing keyed to a page the target
   region doesn't render gets written there. Shapes handled:
     • array of entries each carrying .pageId  (texts / shapes / images)
     • object map keyed by pageId              (pageBgs / pageLabels)
     • pageOrder array of bare page IDs
   Anything else (or no drops) is returned unchanged. Non-destructive: the
   source region keeps its full data; only the copy written to the target
   is trimmed. Returns { value, dropped } so the caller can report counts. */
function _syncFilterForTarget(value, targetSlug, bucket) {
  /* Bands clip by the target's chart start year, independent of page
     drops (bands aren't keyed to a pageId). Handled before the page-drop
     short-circuit so it applies to EVERY target — including Perth and the
     research reports, which _regionDropSet() exempts from page filtering. */
  if (bucket === 'bands' && Array.isArray(value)) {
    const startYear = _syncBandStartYearForTarget(targetSlug);
    let dropped = 0;
    const kept = value.filter((b) => {
      const fromYear = _ppBandToYear(b && b.from);
      if (fromYear != null && fromYear < startYear) { dropped++; return false; }
      return true;
    });
    return { value: kept, dropped };
  }
  const dropSet = _regionDropSet(targetSlug);
  if (!dropSet) return { value, dropped: 0 };
  if (bucket === 'customPages') return { value, dropped: 0 }; // user-added IDs never collide with template drops
  if (Array.isArray(value)) {
    let dropped = 0;
    const kept = value.filter((e) => {
      const pid = (bucket === 'pageOrder') ? e : (e && e.pageId);
      if (pid && dropSet.has(pid)) { dropped++; return false; }
      return true;
    });
    return { value: kept, dropped };
  }
  if (value && typeof value === 'object') {
    let dropped = 0;
    const out = {};
    for (const [pid, v] of Object.entries(value)) {
      if (dropSet.has(pid)) { dropped++; continue; }
      out[pid] = v;
    }
    return { value: out, dropped };
  }
  return { value, dropped: 0 };
}

/* Combined registry — every report tool, used by sync / backup /
   region-select / audit modals to enumerate cross-tool targets.
   Slugs are unique across both research and regional reports so the
   reports_state table's region column stays a clean primary key. */
function allReportRegions() {
  const out = {};
  for (const [s, info] of Object.entries(RESEARCH_REGIONS)) {
    out[s] = Object.assign({}, info, { kind: 'research', url: '/tools/' + info.url });
  }
  for (const [s, info] of Object.entries(REGIONAL_REGIONS)) {
    out[s] = Object.assign({}, info, { kind: 'regional', url: '/tools/online-reports.html?region=' + s });
  }
  return out;
}

/* Bucket → key generator. Matches RS_BUCKET_KEYS from Slice 1 but
   exposed under a separate name here so the sync/backup code reads
   directly without leaking into the rs-namespace. */
const BACKUP_BUCKET_KEYS = {
  texts:       (slug) => 'ppa-online-reports-custom-texts-v2-' + slug,
  shapes:      (slug) => 'ppa-online-reports-shapes-v1-'       + slug,
  images:      (slug) => 'ppa-online-reports-images-v1-'       + slug,
  pageBgs:     (slug) => 'ppa-online-reports-page-bgs-v1-'     + slug,
  pageOrder:   (slug) => 'ppa-online-reports-page-order-v1-'   + slug,
  customPages: (slug) => 'ppa-online-reports-custom-pages-v1-' + slug,
  pageLabels:  (slug) => 'ppa-online-reports-page-labels-v1-'  + slug,
  bands:       (slug) => 'ppa-online-reports-bands-v1-'        + slug,
  auditLog:    (slug) => 'ppa-online-reports-audit-log-v1-'    + slug,
};
const BACKUP_BUCKET_DEFAULTS = {
  texts: [], shapes: [], images: [],
  pageBgs: {}, pageOrder: [], customPages: [], pageLabels: {}, bands: [],
  auditLog: [],
};
const BACKUP_OBJECT_BUCKETS = new Set(['pageBgs', 'pageLabels']);
const BACKUP_KEY_PREFIX = 'ppa-online-reports-';

/* ═════════════════════════════════════════════════════════════════
   Backup / Restore modal
   ─────────────────────────────────────────────────────────────────
   - Download: bundles the chosen buckets × chosen regions into a
     single JSON file. Non-active regions are pulled from Supabase
     (rsLoadFromServer) since their localStorage cache may be cold.
   - Import: parse JSON → preview → confirm restores per-region per-
     bucket onto the server, sets the import-pending flag for the
     active region, and reloads. Other regions repaint lazily on
     next visit (their server state already has the imported data).
   ═════════════════════════════════════════════════════════════════ */
function backupCollectKeys() {
  const slug = _rs_active();
  const matches = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(BACKUP_KEY_PREFIX)) continue;
    if (!k.endsWith('-' + slug)) continue;
    matches.push(k);
  }
  return matches;
}

function backupRenderStats() {
  const host = document.getElementById('backup-stats');
  if (!host) return;
  const slug = _rs_active();
  const rows = [];
  let total = 0;
  for (const k of backupCollectKeys()) {
    const v = localStorage.getItem(k) || '';
    const bytes = new Blob([k, v]).size;
    total += bytes;
    const label = k.slice(BACKUP_KEY_PREFIX.length, k.length - ('-' + slug).length);
    rows.push({ label, bytes });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  host.innerHTML = '';
  if (!rows.length) {
    host.innerHTML = '<div class="row"><span class="label">No saved customisations for this region yet.</span></div>';
    return;
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span class="label">' + r.label + '</span><span>' + (r.bytes / 1024).toFixed(1) + ' KB</span>';
    host.appendChild(row);
  }
  /* Image overlays + heavy shape gradients can fill localStorage fast.
     Surface a warning band at >50% and danger at >80% of the typical
     5 MB per-origin quota. */
  const QUOTA_LIKELY = 5 * 1024 * 1024;
  const pct = (total / QUOTA_LIKELY) * 100;
  const cls = pct > 80 ? 'danger' : pct > 50 ? 'warn' : '';
  const totalRow = document.createElement('div');
  totalRow.className = 'row total ' + cls;
  totalRow.innerHTML =
    '<span>Total</span><span>' + (total / 1024 / 1024).toFixed(2) +
    ' MB (~' + pct.toFixed(0) + '% of typical 5 MB quota)</span>';
  host.appendChild(totalRow);
}

function backupGetSelectedBuckets() {
  return Array.from(document.querySelectorAll('#backup-buckets input[type="checkbox"]:checked'))
    .map(cb => cb.dataset.bucket);
}
function backupGetSelectedRegions() {
  const slug = _rs_active();
  const mode = (document.querySelector('input[name="backup-region-mode"]:checked') || {}).value || 'current';
  if (mode === 'current') return [slug];
  if (mode === 'all')     return Object.keys(RESEARCH_REGIONS);
  return Array.from(document.querySelectorAll('#backup-pick-list input[type="checkbox"]:checked'))
    .map(cb => cb.dataset.slug);
}

async function backupFetchRegionState(slug) {
  if (slug === _rs_active()) {
    /* Active region: localStorage cache is the freshest source — the
       server may be a few hundred ms behind because of the debounced
       save. */
    const out = {};
    for (const b of Object.keys(BACKUP_BUCKET_KEYS)) {
      try {
        const raw = localStorage.getItem(BACKUP_BUCKET_KEYS[b](slug));
        out[b] = raw == null ? BACKUP_BUCKET_DEFAULTS[b] : JSON.parse(raw);
      } catch { out[b] = BACKUP_BUCKET_DEFAULTS[b]; }
    }
    return out;
  }
  if (typeof rsLoadFromServer !== 'function') return {};
  const remote = await rsLoadFromServer(slug);
  return remote && typeof remote === 'object' ? remote : {};
}

function backupFilterByBuckets(state, buckets) {
  const out = {};
  for (const b of buckets) {
    out[b] = (state[b] !== undefined)
      ? state[b]
      : (BACKUP_BUCKET_DEFAULTS[b] !== undefined ? BACKUP_BUCKET_DEFAULTS[b] : null);
  }
  return out;
}

async function backupDownload() {
  const buckets = backupGetSelectedBuckets();
  const regions = backupGetSelectedRegions();
  if (!buckets.length) { alert('Pick at least one bucket to back up.'); return; }
  if (!regions.length) { alert('Pick at least one region to back up.'); return; }
  const btn = document.getElementById('backup-download-btn');
  const origLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  const regionStates = {};
  try {
    await Promise.all(regions.map(async (slug) => {
      const state = await backupFetchRegionState(slug);
      regionStates[slug] = backupFilterByBuckets(state, buckets);
    }));
  } catch (e) {
    alert('Backup failed while fetching one or more regions: ' + (e && e.message || e));
    if (btn) { btn.disabled = false; btn.textContent = origLabel; }
    return;
  }
  const payload = {
    version: '3',
    tool: 'ppa-research-reports',
    exportedAt: new Date().toISOString(),
    scope: { buckets, regions },
    regions: regionStates,
  };
  const allRegionsCount = Object.keys(RESEARCH_REGIONS).length;
  const filenameRegion = (regions.length === 1)
    ? regions[0]
    : (regions.length === allRegionsCount ? 'all-research' : (regions.length + 'regions'));
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ppa-research-reports-backup-' + filenameRegion + '-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  rsAppendAuditFn('Downloaded backup', 'Buckets [' + buckets.join(', ') + '] from ' + regions.length + ' region' + (regions.length === 1 ? '' : 's'), true);
  if (btn) { btn.disabled = false; btn.textContent = origLabel; }
}

/* Tiny adapter so the shared module can call rsAppendAudit safely
   even if it's not yet defined (e.g. during isolated tests). */
function rsAppendAuditFn(action, details, force) {
  if (typeof rsAppendAudit === 'function') rsAppendAudit(action, details, force);
}

function backupParseFile(file, onValid, onError) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const json = JSON.parse(e.target.result);
      /* Accept both 'ppa-research-reports' (this tool's native format)
         AND 'ppa-online-reports' (the regional tool's format — same
         schema, different tool string). A regional backup with the
         research-region slugs in it round-trips here too. */
      if (!json || (json.tool !== 'ppa-research-reports' && json.tool !== 'ppa-online-reports')) {
        return onError('That file does not look like a valid Performance Property reports backup.');
      }
      /* Accept v3 (multi-region: json.regions) AND legacy v1/v2
         (single-region flat localStorage dump: json.data). Reject
         anything else so we never half-restore an unknown format. */
      const isV3 = json.regions && typeof json.regions === 'object';
      const isLegacy = json.data && typeof json.data === 'object';
      if (!isV3 && !isLegacy) {
        return onError('Backup file is in an unrecognised format (missing regions/data).');
      }
      onValid(json);
    } catch (err) {
      onError('Could not parse backup file: ' + (err.message || err));
    }
  };
  reader.onerror = () => onError('Could not read file.');
  reader.readAsText(file);
}

function backupRenderPreview(json) {
  const host = document.getElementById('backup-preview');
  if (!host) return;
  const exportedAt = json.exportedAt ? new Date(json.exportedAt).toLocaleString() : 'unknown';
  const isV3 = json.regions && typeof json.regions === 'object';
  const isKnown = (s) => !!(RESEARCH_REGIONS[s] || REGIONAL_REGIONS[s]);

  let html = '<div><strong>Backup contents</strong></div>';
  html += '<div style="margin-top:6px">Exported: ' + exportedAt + '</div>';
  let onConfirm;

  if (isV3) {
    const regionSlugs = Object.keys(json.regions || {});
    const buckets = (json.scope && Array.isArray(json.scope.buckets))
      ? json.scope.buckets
      : Object.keys(json.regions[regionSlugs[0]] || {});
    const unknownSlugs = regionSlugs.filter(s => !isKnown(s));
    html += '<div><strong>' + regionSlugs.length + '</strong> region' + (regionSlugs.length === 1 ? '' : 's') + ': ' + regionSlugs.join(', ') + '</div>';
    html += '<div><strong>' + buckets.length + '</strong> bucket type' + (buckets.length === 1 ? '' : 's') + ': ' + buckets.join(', ') + '</div>';
    if (unknownSlugs.length) {
      html += '<div class="warn" style="margin-top:6px">' + unknownSlugs.length + ' unrecognised region slug(s) (' + unknownSlugs.join(', ') + ') will be skipped.</div>';
    }
    html += '<div style="margin-top:8px;color:rgba(255,255,255,0.55);font-size:10.5px">Restore overwrites the selected buckets on each known region. Other buckets stay untouched. The page reloads after restore.</div>';
    onConfirm = () => backupApplyImport(json);
  } else {
    /* Legacy v1/v2 single-region flat dump (json.data keyed by full
       localStorage key, json.region = source slug). Restores into the
       active region, remapping key suffixes if they differ. */
    const slug = _rs_active();
    const exportedSlug = json.region || '?';
    const sameRegion = exportedSlug === slug;
    const keyCount = Object.keys(json.data || {}).length;
    html += '<div>From region: <strong>' + exportedSlug + '</strong>';
    if (!sameRegion) html += ' <span class="warn">(active region is ' + slug + ' — keys will be remapped)</span>';
    html += '</div>';
    html += '<div>' + keyCount + ' storage entr' + (keyCount === 1 ? 'y' : 'ies') + '.</div>';
    html += '<div style="margin-top:8px;color:rgba(255,255,255,0.55);font-size:10.5px">Importing overwrites the current ' + slug + ' customisations. The page reloads after import.</div>';
    onConfirm = () => _backupApplyLegacy(json, sameRegion);
  }

  html += '<div class="preview-actions">';
  html += '<button class="pp-modal-btn ghost"   id="backup-cancel-import">Cancel</button>';
  html += '<button class="pp-modal-btn primary" id="backup-confirm-import">Restore this backup</button>';
  html += '</div>';
  host.innerHTML = html;
  host.classList.add('show');
  document.getElementById('backup-cancel-import').addEventListener('click', () => {
    host.classList.remove('show');
    host.innerHTML = '';
    const fileInput = document.getElementById('backup-file-input');
    if (fileInput) fileInput.value = '';
  });
  document.getElementById('backup-confirm-import').addEventListener('click', onConfirm);
}

async function backupApplyImport(json) {
  const slug = _rs_active();
  /* Accept any known report slug — research OR regional — so this v3
     path works both for the research reports and for the regional tool
     once it loads this shared module (post-#5 cutover). This mirrors the
     sync modal, which already writes across both namespaces. */
  const knownTargets = Object.keys(json.regions || {}).filter(s => RESEARCH_REGIONS[s] || REGIONAL_REGIONS[s]);
  if (!knownTargets.length) {
    alert('Backup contained no recognised report regions.');
    return;
  }
  const host = document.getElementById('backup-preview');
  const setStatus = (msg) => { if (host) host.innerHTML = '<div>' + msg + '</div>'; };
  setStatus('Fetching current state for ' + knownTargets.length + ' region' + (knownTargets.length === 1 ? '' : 's') + '…');
  const currentStates = {};
  await Promise.all(knownTargets.map(async (target) => {
    currentStates[target] = (await rsLoadFromServer(target)) || {};
  }));
  /* Build per-region merged state — start from existing server state
     so unrelated buckets stay intact, overlay imported buckets. */
  const mergedStates = {};
  for (const target of knownTargets) {
    const merged = Object.assign({}, currentStates[target]);
    for (const [bucket, value] of Object.entries(json.regions[target] || {})) {
      merged[bucket] = value;
      if (target === slug && BACKUP_BUCKET_KEYS[bucket]) {
        try { localStorage.setItem(BACKUP_BUCKET_KEYS[bucket](target), JSON.stringify(value)); }
        catch (_) {}
      }
    }
    mergedStates[target] = merged;
  }
  setStatus('Saving ' + knownTargets.length + ' region' + (knownTargets.length === 1 ? '' : 's') + ' to the server…');
  let okCount = 0;
  const errors = [];
  for (const target of knownTargets) {
    try {
      if (!window.sb) throw new Error('Supabase client not loaded');
      const { error } = await window.sb
        .from('reports_state')
        .upsert({ region: target, payload: mergedStates[target] }, { onConflict: 'region' });
      if (error) throw error;
      okCount++;
    } catch (e) {
      errors.push(target + ': ' + (e && e.message || e));
    }
  }
  rsAppendAuditFn('Restored backup', knownTargets.length + ' region' + (knownTargets.length === 1 ? '' : 's') + ': ' + knownTargets.join(', '), true);
  /* Mark the active region so rsBoot on next load uses local-wins
     across every bucket — otherwise the per-bucket merge could let
     the now-stale server state overwrite the just-imported buckets. */
  if (knownTargets.indexOf(slug) >= 0) {
    try { localStorage.setItem('ppa-online-reports-import-pending-' + slug, '1'); } catch (_) {}
  }
  if (errors.length) {
    alert('Restored ' + okCount + ' of ' + knownTargets.length + ' regions on the server. ' + errors.length + ' failed — check the console for details.');
  }
  setTimeout(() => location.reload(), 60);
}

/* Legacy v1/v2 restore — a single-region flat localStorage dump
   (json.data keyed by full localStorage key; json.region = source slug).
   Clears the active region's buckets, then writes the file's entries
   back, remapping the source slug suffix to the active region so e.g. a
   Sydney backup can seed Melbourne. Sets the import-pending flag so
   rsBoot uses local-wins on reload. Faithful port of the regional tool's
   pre-v3 path; v3 backups go through backupApplyImport instead. */
function _backupApplyLegacy(json, sameRegion) {
  const slug = _rs_active();
  const exportedSlug = json.region || slug;
  const remap = (key) =>
    (sameRegion || !key.endsWith('-' + exportedSlug))
      ? key
      : key.slice(0, key.length - ('-' + exportedSlug).length) + '-' + slug;
  /* Clear existing entries for the active region first so stale keys
     not present in the backup don't survive the restore. */
  for (const k of backupCollectKeys()) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(json.data || {})) {
    if (typeof v !== 'string') continue;
    try { localStorage.setItem(remap(k), v); }
    catch (e) {
      alert('Backup restore stopped: localStorage is full. Some entries may not have been restored. Free up space and try again.');
      break;
    }
  }
  try { localStorage.setItem('ppa-online-reports-import-pending-' + slug, '1'); } catch (_) {}
  location.reload();
}

function backupRefreshRegionPicker() {
  const slug = _rs_active();
  const all = allReportRegions();
  const allSlugs = Object.keys(all);
  const currentNameEl = document.getElementById('backup-current-region-name');
  if (currentNameEl) currentNameEl.textContent = all[slug] ? '(' + all[slug].name + ')' : '';
  const allCountEl = document.getElementById('backup-all-count');
  if (allCountEl) allCountEl.textContent = '(' + allSlugs.length + ')';
  const pickList = document.getElementById('backup-pick-list');
  if (pickList) {
    pickList.innerHTML = '';
    /* Research first, regional groups after — same ordering as the
       sync picker so users see one consistent tool registry. */
    const researchSlugs = Object.keys(RESEARCH_REGIONS);
    if (researchSlugs.length) {
      const h = document.createElement('div');
      h.className = 'sync-cluster-header';
      h.textContent = 'Research Reports';
      pickList.appendChild(h);
      for (const s of researchSlugs) {
        const m = RESEARCH_REGIONS[s];
        const lbl = document.createElement('label');
        lbl.innerHTML = '<input type="checkbox" data-slug="' + s + '"' + (s === slug ? ' checked' : '') + '> ' + m.name;
        pickList.appendChild(lbl);
      }
    }
    for (const cluster of REGIONAL_CLUSTER_ORDER) {
      const slugs = Object.keys(REGIONAL_REGIONS)
        .filter(s => REGIONAL_REGIONS[s].cluster === cluster)
        .sort((a, b) => REGIONAL_REGIONS[a].name.localeCompare(REGIONAL_REGIONS[b].name));
      if (!slugs.length) continue;
      const h = document.createElement('div');
      h.className = 'sync-cluster-header';
      h.textContent = REGIONAL_CLUSTER_LABELS[cluster];
      pickList.appendChild(h);
      for (const s of slugs) {
        const m = REGIONAL_REGIONS[s];
        const lbl = document.createElement('label');
        lbl.innerHTML = '<input type="checkbox" data-slug="' + s + '"' + (s === slug ? ' checked' : '') + '> ' + m.name + ' <span class="sync-count">' + m.state + '</span>';
        pickList.appendChild(lbl);
      }
    }
  }
  const currentRadio = document.querySelector('input[name="backup-region-mode"][value="current"]');
  if (currentRadio) currentRadio.checked = true;
  if (pickList) pickList.hidden = true;
}

function setupBackupModal() {
  const bg = document.getElementById('backup-modal-bg');
  if (!bg) return;
  const trigger = document.getElementById('btn-backup');
  if (trigger) trigger.addEventListener('click', () => {
    backupRenderStats();
    backupRefreshRegionPicker();
    const preview = document.getElementById('backup-preview');
    if (preview) { preview.classList.remove('show'); preview.innerHTML = ''; }
    const fileInput = document.getElementById('backup-file-input');
    if (fileInput) fileInput.value = '';
    bg.classList.add('open');
  });
  const closeBtn = document.getElementById('backup-close');
  if (closeBtn) closeBtn.addEventListener('click', () => bg.classList.remove('open'));
  bg.addEventListener('click', ev => { if (ev.target === bg) bg.classList.remove('open'); });
  const dlBtn = document.getElementById('backup-download-btn');
  if (dlBtn) dlBtn.addEventListener('click', backupDownload);
  const importBtn = document.getElementById('backup-import-btn');
  if (importBtn) importBtn.addEventListener('click', () => {
    const fileInput = document.getElementById('backup-file-input');
    if (fileInput) fileInput.click();
  });
  const fileInput = document.getElementById('backup-file-input');
  if (fileInput) fileInput.addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    backupParseFile(f, backupRenderPreview, (msg) => alert(msg));
  });
  document.querySelectorAll('input[name="backup-region-mode"]').forEach(r => {
    r.addEventListener('change', () => {
      const pickList = document.getElementById('backup-pick-list');
      if (pickList) pickList.hidden = (document.querySelector('input[name="backup-region-mode"]:checked').value !== 'pick');
    });
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && bg.classList.contains('open')) bg.classList.remove('open');
  });
}

/* ═════════════════════════════════════════════════════════════════
   Sync — apply this region's customisations to the other research
   region. Smaller than the regional sync (only 2 regions to choose
   between) but uses the same bucket-by-bucket merge so untouched
   buckets on the target stay intact.
   ═════════════════════════════════════════════════════════════════ */
function syncReadEntries(slug, bucket) {
  try {
    const raw = localStorage.getItem(BACKUP_BUCKET_KEYS[bucket](slug));
    if (raw == null) return BACKUP_OBJECT_BUCKETS.has(bucket) ? {} : [];
    return JSON.parse(raw);
  } catch { return BACKUP_OBJECT_BUCKETS.has(bucket) ? {} : []; }
}
function syncCountEntries(slug, bucket) {
  const v = syncReadEntries(slug, bucket);
  if (!v) return 0;
  return Array.isArray(v) ? v.length : Object.keys(v).length;
}

function syncOpenModal() {
  const bg = document.getElementById('sync-modal-bg');
  if (!bg) return;
  const slug = _rs_active();
  const m = RESEARCH_REGIONS[slug] || REGIONAL_REGIONS[slug];

  /* From-Source card — "Region <name>" "Kind <Research / Regional>". */
  const src = document.getElementById('sync-source');
  if (src) {
    const kind = RESEARCH_REGIONS[slug] ? 'Research' : 'Regional';
    src.innerHTML = '<span class="label">Region</span><strong>' + (m ? m.name : slug) + '</strong>'
      + '  <span class="label" style="margin-left:14px">Kind</span><strong>' + kind + '</strong>';
  }

  /* Radio-mode counts. */
  const otherResearch = Object.keys(RESEARCH_REGIONS).filter(s => s !== slug);
  const otherResearchEl = document.getElementById('sync-other-research-name');
  if (otherResearchEl) {
    if (otherResearch.length === 1) {
      const tm = RESEARCH_REGIONS[otherResearch[0]];
      otherResearchEl.textContent = tm.name;
    } else if (otherResearch.length > 1) {
      otherResearchEl.textContent = '(' + otherResearch.length + ')';
    } else {
      otherResearchEl.textContent = '(none)';
    }
  }
  const regionalCountEl = document.getElementById('sync-regional-count');
  if (regionalCountEl) regionalCountEl.textContent = '(' + Object.keys(REGIONAL_REGIONS).length + ')';
  const allCountEl = document.getElementById('sync-all-count');
  if (allCountEl) {
    const allOthers = otherResearch.length + Object.keys(REGIONAL_REGIONS).length;
    allCountEl.textContent = '(' + allOthers + ')';
  }

  /* Pick-grid — 2-column, with cluster headers. Populated once; hidden
     by default and revealed when the "Pick specific regions…" radio
     fires. Every entry is rendered (unchecked by default). */
  const pickList = document.getElementById('sync-pick-list');
  if (pickList) {
    pickList.innerHTML = '';
    if (otherResearch.length) {
      const h = document.createElement('div');
      h.className = 'sync-cluster-header';
      h.textContent = 'Research Reports';
      pickList.appendChild(h);
      for (const targetSlug of otherResearch) {
        const tm = RESEARCH_REGIONS[targetSlug];
        const lbl = document.createElement('label');
        lbl.innerHTML = '<input type="checkbox" data-slug="' + targetSlug + '"> ' + tm.name;
        pickList.appendChild(lbl);
      }
    }
    for (const cluster of REGIONAL_CLUSTER_ORDER) {
      const slugs = Object.keys(REGIONAL_REGIONS)
        .filter(s => REGIONAL_REGIONS[s].cluster === cluster && s !== slug)
        .sort((a, b) => REGIONAL_REGIONS[a].name.localeCompare(REGIONAL_REGIONS[b].name));
      if (!slugs.length) continue;
      const h = document.createElement('div');
      h.className = 'sync-cluster-header';
      h.textContent = REGIONAL_CLUSTER_LABELS[cluster];
      pickList.appendChild(h);
      for (const targetSlug of slugs) {
        const tm = REGIONAL_REGIONS[targetSlug];
        const lbl = document.createElement('label');
        lbl.innerHTML = '<input type="checkbox" data-slug="' + targetSlug + '"> ' + tm.name + ' <span class="sync-count">' + tm.state + '</span>';
        pickList.appendChild(lbl);
      }
    }
    pickList.hidden = true;
  }
  /* Reset radio + pick-list visibility every open. */
  document.querySelectorAll('input[name="sync-target"]').forEach(r => {
    r.checked = (r.value === 'research');
  });

  /* Live bucket counts from the active region's localStorage. */
  ['texts','shapes','images','pageBgs','pageLabels','pageOrder','customPages'].forEach(b => {
    const el = document.getElementById('sync-count-' + b);
    if (el) el.textContent = '(' + syncCountEntries(slug, b) + ')';
  });

  const result = document.getElementById('sync-result');
  if (result) { result.hidden = true; result.textContent = ''; }
  bg.classList.add('open');
}

function syncCollectTargets() {
  const slug = _rs_active();
  const mode = (document.querySelector('input[name="sync-target"]:checked') || {}).value || 'research';
  if (mode === 'research') {
    return Object.keys(RESEARCH_REGIONS).filter(s => s !== slug);
  }
  if (mode === 'regional') {
    return Object.keys(REGIONAL_REGIONS).filter(s => s !== slug);
  }
  if (mode === 'all') {
    return Object.keys(RESEARCH_REGIONS).concat(Object.keys(REGIONAL_REGIONS)).filter(s => s !== slug);
  }
  /* pick mode */
  return Array.from(document.querySelectorAll('#sync-pick-list input[type="checkbox"]:checked'))
    .map(cb => cb.dataset.slug);
}
function syncCollectBuckets() {
  return Array.from(document.querySelectorAll('#sync-buckets input[type="checkbox"]:checked'))
    .map(cb => cb.dataset.bucket);
}

async function syncApply() {
  const sourceSlug = _rs_active();
  const targets = syncCollectTargets();
  const buckets = syncCollectBuckets();
  const result = document.getElementById('sync-result');
  const applyBtn = document.getElementById('sync-apply');
  if (result) result.classList.remove('error');
  if (!targets.length) {
    if (result) {
      result.classList.add('error');
      result.innerHTML = 'No target regions selected.';
      result.hidden = false;
    }
    return;
  }
  if (!buckets.length) {
    if (result) {
      result.classList.add('error');
      result.innerHTML = 'No buckets selected — pick at least one of the "What to copy" options.';
      result.hidden = false;
    }
    return;
  }
  rsAppendAuditFn(
    'Synced',
    'Buckets [' + buckets.join(', ') + '] → ' + targets.length + ' region' + (targets.length === 1 ? '' : 's') + ': ' + targets.join(', '),
    true
  );
  const sourceData = {};
  for (const b of buckets) sourceData[b] = syncReadEntries(sourceSlug, b);

  if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = 'Applying…'; }
  if (result) {
    result.classList.remove('error');
    result.innerHTML = 'Fetching current state for ' + targets.length + ' region' + (targets.length === 1 ? '' : 's') + '…';
    result.hidden = false;
  }

  /* Pre-fetch each target's current state in parallel so we don't
     clobber buckets the user didn't pick. */
  const targetStates = {};
  await Promise.all(targets.map(async (target) => {
    try {
      targetStates[target] = (await rsLoadFromServer(target)) || {};
    } catch (e) {
      targetStates[target] = {};
    }
  }));

  if (result) result.innerHTML = 'Saving to ' + targets.length + ' region' + (targets.length === 1 ? '' : 's') + '…';
  let okCount = 0;
  let totalDropped = 0;
  const errors = [];
  for (const target of targets) {
    try {
      const merged = Object.assign({}, targetStates[target] || {});
      for (const b of buckets) {
        /* Trim anything keyed to a page this target region doesn't render,
           so we never seed orphan overlays on dropped pages. Source-side
           data is untouched — only the copy written here is filtered. */
        const filtered = _syncFilterForTarget(sourceData[b], target, b);
        const value = filtered.value;
        totalDropped += filtered.dropped;
        merged[b] = value;
        try { localStorage.setItem(BACKUP_BUCKET_KEYS[b](target), JSON.stringify(value)); }
        catch (_) {}
      }
      if (!window.sb) throw new Error('Supabase client not loaded');
      const { error } = await window.sb
        .from('reports_state')
        .upsert({ region: target, payload: merged }, { onConflict: 'region' });
      if (error) throw error;
      okCount++;
    } catch (e) {
      errors.push(target + ': ' + (e && e.message || e));
    }
  }

  if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply'; }
  let html = 'Synced to <strong>' + okCount + '</strong> of <strong>' + targets.length + '</strong> region' + (targets.length === 1 ? '' : 's') + ' on the server.';
  if (totalDropped) {
    html += '<br><span style="color:rgba(255,255,255,0.7);font-size:11px">Skipped <strong>' + totalDropped + '</strong> ' + (totalDropped === 1 ? 'entry' : 'entries') + ' tied to pages a target region doesn\'t include.</span>';
  }
  html += '<br><br><span style="color:rgba(255,255,255,0.7);font-size:11px">Note: page IDs (p1, p2, …) overlap between the National and Commercial reports, but those pages display different content. Overlays positioned for a specific chart on one report may land on an unrelated page on the other. Review the target report after syncing.</span>';
  if (errors.length) {
    if (result) result.classList.add('error');
    html += '<br><br><strong>Errors:</strong><br>' + errors.map(e => '• ' + e).join('<br>');
  }
  if (result) result.innerHTML = html;
}

function setupSyncModal() {
  const bg = document.getElementById('sync-modal-bg');
  if (!bg) return;
  const trigger = document.getElementById('btn-sync');
  if (trigger) trigger.addEventListener('click', syncOpenModal);
  const closeBtn  = document.getElementById('sync-close');
  const cancelBtn = document.getElementById('sync-cancel');
  if (closeBtn)  closeBtn.addEventListener('click', () => bg.classList.remove('open'));
  if (cancelBtn) cancelBtn.addEventListener('click', () => bg.classList.remove('open'));
  bg.addEventListener('click', ev => { if (ev.target === bg) bg.classList.remove('open'); });
  const applyBtn = document.getElementById('sync-apply');
  if (applyBtn) applyBtn.addEventListener('click', syncApply);
  /* Radio mode → toggle the pick-grid visibility. */
  document.querySelectorAll('input[name="sync-target"]').forEach(r => {
    r.addEventListener('change', () => {
      const pickList = document.getElementById('sync-pick-list');
      if (!pickList) return;
      const mode = (document.querySelector('input[name="sync-target"]:checked') || {}).value;
      pickList.hidden = (mode !== 'pick');
    });
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && bg.classList.contains('open')) bg.classList.remove('open');
  });
}

/* ═════════════════════════════════════════════════════════════════
   Audit log modal — read-only view of the per-region edit history.
   - This region: reads from localStorage (Slice 1 _rsReadAuditLog).
   - All research regions: fetches each region's auditLog from
     Supabase, merges by timestamp, annotates with region label.
   ═════════════════════════════════════════════════════════════════ */
let _auditScope = 'region';
let _auditAllCache = null;

function _rsEsc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function _rsRenderAuditList(entries, opts) {
  const list = document.getElementById('audit-list');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<div class="audit-empty">' + (opts && opts.emptyText || 'No entries.') + '</div>';
    return;
  }
  list.innerHTML = entries.map(e => {
    const d = new Date(e.ts);
    const dateStr = d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const userLabel = _rsEsc(e.user || 'Unknown');
    const emailSub = (e.email && e.email !== e.user)
      ? '<span class="audit-email">' + _rsEsc(e.email) + '</span>' : '';
    const detailsStr = e.details
      ? '<div class="audit-details">' + _rsEsc(String(e.details)) + '</div>' : '';
    const regionTag = e.regionLabel
      ? '<span class="audit-region">' + _rsEsc(e.regionLabel) + '</span>' : '';
    return '<div class="audit-entry">'
      + '<div class="audit-entry-top">'
      +   '<div class="audit-action-group">'
      +     '<span class="audit-action">' + _rsEsc(e.action || '') + '</span>'
      +     regionTag
      +   '</div>'
      +   '<span class="audit-time">' + _rsEsc(dateStr) + '</span>'
      + '</div>'
      + '<div class="audit-user">' + userLabel + emailSub + '</div>'
      + detailsStr
      + '</div>';
  }).join('');
}

async function _rsFetchAllAuditLogs() {
  /* Fetch every research + regional tool's audit log so the
     "All reports" view spans 37 regions. Per-region errors are
     swallowed silently so one failing fetch doesn't break the
     merged view. */
  const all = allReportRegions();
  const slugs = Object.keys(all);
  const results = await Promise.all(slugs.map(async (slug) => {
    try {
      const remote = await rsLoadFromServer(slug);
      const log = (remote && Array.isArray(remote.auditLog)) ? remote.auditLog : [];
      const label = all[slug].name;
      return log.map(e => Object.assign({}, e, { regionSlug: slug, regionLabel: label }));
    } catch (_) {
      return [];
    }
  }));
  const merged = [].concat.apply([], results);
  merged.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return merged;
}

async function _rsRenderAuditView() {
  const modal = document.getElementById('audit-modal-bg');
  const list  = document.getElementById('audit-list');
  if (!modal || !list) return;
  if (_auditScope === 'region') {
    /* Use the Slice 1 reader if it's defined; otherwise inline the
       bucket-read so the modal still works in isolation. */
    const slug = _rs_active();
    let log = [];
    try {
      const raw = localStorage.getItem(BACKUP_BUCKET_KEYS.auditLog(slug));
      log = raw == null ? [] : (JSON.parse(raw) || []);
    } catch { log = []; }
    const label = (RESEARCH_REGIONS[slug] || {}).name || slug;
    const items = log.slice().reverse().map(e =>
      Object.assign({}, e, { regionSlug: slug, regionLabel: label })
    );
    _rsRenderAuditList(items, {
      emptyText: 'No edits recorded yet for this region. Saves and syncs by admins will appear here.'
    });
    return;
  }
  if (_auditAllCache) {
    _rsRenderAuditList(_auditAllCache, {
      emptyText: 'No edits recorded yet across any research region.'
    });
    return;
  }
  list.innerHTML = '<div class="audit-loading">Loading edits across all research regions…</div>';
  try {
    _auditAllCache = await _rsFetchAllAuditLogs();
    if (_auditScope !== 'all') return;
    _rsRenderAuditList(_auditAllCache, {
      emptyText: 'No edits recorded yet across any research region.'
    });
  } catch (_) {
    list.innerHTML = '<div class="audit-empty">Failed to load all-regions log. Check your connection and try again.</div>';
  }
}

function _setAuditScope(scope) {
  if (scope !== 'region' && scope !== 'all') return;
  _auditScope = scope;
  document.querySelectorAll('.audit-scope-toggle button').forEach(b => {
    b.classList.toggle('on', b.dataset.scope === scope);
  });
  _rsRenderAuditView();
}

function openAuditLog() {
  const modal = document.getElementById('audit-modal-bg');
  if (!modal) return;
  _auditScope = 'region';
  _auditAllCache = null;
  document.querySelectorAll('.audit-scope-toggle button').forEach(b => {
    b.classList.toggle('on', b.dataset.scope === 'region');
  });
  modal.classList.add('open');
  _rsRenderAuditView();
}
function closeAuditLog() {
  const modal = document.getElementById('audit-modal-bg');
  if (modal) modal.classList.remove('open');
  _auditAllCache = null;
}

function setupAuditModal() {
  const bg = document.getElementById('audit-modal-bg');
  if (!bg) return;
  const trigger = document.getElementById('btn-audit');
  if (trigger) trigger.addEventListener('click', openAuditLog);
  const closeBtn = document.getElementById('audit-close');
  if (closeBtn) closeBtn.addEventListener('click', closeAuditLog);
  bg.addEventListener('click', ev => { if (ev.target === bg) closeAuditLog(); });
  document.querySelectorAll('.audit-scope-toggle button').forEach(b => {
    b.addEventListener('click', () => _setAuditScope(b.dataset.scope));
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && bg.classList.contains('open')) closeAuditLog();
  });
}

/* ═════════════════════════════════════════════════════════════════
   Version history + restore (migration 030: reports_state_history)
   ─────────────────────────────────────────────────────────────────
   A server-side safety net distinct from the audit log: the audit log
   records who/when, this restores actual prior CONTENT. The list shows
   archived versions for the active region (metadata only — payloads
   are large, so we fetch a version's full payload only on restore via
   the restore_reports_state RPC, which also force-archives the current
   state so a restore is itself undoable).

   Read access is writer-only (RLS on reports_state_history). All
   queries go through window.sb against production, independent of any
   MCP / tooling connection.
   ═════════════════════════════════════════════════════════════════ */
function _historyRelTime(ts) {
  const then = new Date(ts).getTime();
  if (!Number.isFinite(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60)     return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60)     return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24)     return h + 'h ago';
  const d = Math.round(h / 24);
  if (d < 30)     return d + 'd ago';
  const mo = Math.round(d / 30);
  return mo + 'mo ago';
}

async function _historyLoadVersions() {
  if (!window.sb) return [];
  const slug = _rs_active();
  /* Metadata only — never pull the (large) payloads into the list. */
  const { data, error } = await window.sb
    .from('reports_state_history')
    .select('id, saved_at, saved_by')
    .eq('region', slug)
    .order('saved_at', { ascending: false });
  if (error || !Array.isArray(data)) {
    console.warn('[history] load failed:', error && error.message || error);
    return null;
  }
  /* Resolve author names in one query (writers can read all profiles). */
  const ids = Array.from(new Set(data.map(r => r.saved_by).filter(Boolean)));
  let names = {};
  if (ids.length) {
    try {
      const { data: profs } = await window.sb
        .from('profiles').select('id, full_name, email').in('id', ids);
      (profs || []).forEach(p => { names[p.id] = p.full_name || p.email || ''; });
    } catch (_) {}
  }
  return data.map(r => Object.assign({}, r, { authorName: names[r.saved_by] || '' }));
}

function _historyRenderList(versions) {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (versions === null) {
    list.innerHTML = '<div class="audit-empty">Couldn\'t load version history. If this report has never been saved since version history was enabled, there\'s nothing here yet.</div>';
    return;
  }
  if (!versions.length) {
    list.innerHTML = '<div class="audit-empty">No earlier versions archived yet. Versions are captured automatically as this report is edited.</div>';
    return;
  }
  list.innerHTML = versions.map((v, i) => {
    const d = new Date(v.saved_at);
    const abs = d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const rel = _historyRelTime(v.saved_at);
    const who = v.authorName ? _rsEsc(v.authorName) : 'Unknown';
    const latestTag = i === 0 ? '<span class="pp-history-tag">most recent</span>' : '';
    return '<div class="pp-history-entry">'
      + '<div class="pp-history-meta">'
      +   '<div class="pp-history-when">' + _rsEsc(abs) + ' <span class="pp-history-rel">· ' + _rsEsc(rel) + '</span>' + latestTag + '</div>'
      +   '<div class="pp-history-who">' + who + '</div>'
      + '</div>'
      + '<button class="pp-modal-btn pp-history-restore" data-version-id="' + v.id + '">Restore</button>'
      + '</div>';
  }).join('');
  list.querySelectorAll('.pp-history-restore').forEach(btn => {
    btn.addEventListener('click', () => historyRestore(parseInt(btn.dataset.versionId, 10)));
  });
}

async function openHistoryModal() {
  const modal = document.getElementById('history-modal-bg');
  if (!modal) return;
  const sub = document.getElementById('history-sub');
  const slug = _rs_active();
  const name = (RESEARCH_REGIONS[slug] || REGIONAL_REGIONS[slug] || {}).name || slug;
  if (sub) sub.innerHTML = 'Earlier saved versions of <strong>' + _rsEsc(name) + '</strong>. Restoring overwrites the current report — but the current state is archived first, so you can undo a restore.';
  const list = document.getElementById('history-list');
  if (list) list.innerHTML = '<div class="audit-loading">Loading version history…</div>';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  const versions = await _historyLoadVersions();
  /* Bail if the user closed the modal mid-fetch. */
  if (!modal.classList.contains('open')) return;
  _historyRenderList(versions);
}
function closeHistoryModal() {
  const modal = document.getElementById('history-modal-bg');
  if (modal) { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }
}

async function historyRestore(versionId) {
  if (!Number.isFinite(versionId)) return;
  const slug = _rs_active();
  if (!confirm('Restore this report to the selected version?\n\nThis overwrites the current report for everyone. Your current version is archived first, so you can undo this from version history.')) {
    return;
  }
  const list = document.getElementById('history-list');
  if (list) list.innerHTML = '<div class="audit-loading">Restoring…</div>';
  try {
    if (!window.sb) throw new Error('Supabase client not loaded');
    const { error } = await window.sb.rpc('restore_reports_state', {
      p_region: slug, p_version_id: versionId,
    });
    if (error) throw error;
    rsAppendAuditFn('Restored version', 'Rolled back to an earlier saved version', true);
    /* Re-fetch the now-restored payload and rewrite the local cache so
       rsBoot repaints from it; import-pending forces local-wins on the
       per-bucket merge. Same mechanism as a backup restore. */
    const restored = await rsLoadFromServer(slug);
    if (restored && typeof restored === 'object') {
      for (const [bucket, value] of Object.entries(restored)) {
        if (BACKUP_BUCKET_KEYS[bucket]) {
          try { localStorage.setItem(BACKUP_BUCKET_KEYS[bucket](slug), JSON.stringify(value)); }
          catch (_) {}
        }
      }
    }
    try { localStorage.setItem('ppa-online-reports-import-pending-' + slug, '1'); } catch (_) {}
    setTimeout(() => location.reload(), 60);
  } catch (e) {
    console.error('[history] restore failed', e);
    alert('Restore failed: ' + (e && e.message ? e.message : 'unknown error')
      + '\n\n(If this says "not authorized", you need dev/admin rights. If it mentions a missing function, migration 030 hasn\'t been applied to this project yet.)');
    /* Re-render the list so the user can retry. */
    _historyRenderList(await _historyLoadVersions());
  }
}

function setupHistoryModal() {
  const bg = document.getElementById('history-modal-bg');
  if (!bg) return;
  const trigger = document.getElementById('btn-history');
  if (trigger) trigger.addEventListener('click', openHistoryModal);
  const closeBtn = document.getElementById('history-close');
  if (closeBtn) closeBtn.addEventListener('click', closeHistoryModal);
  bg.addEventListener('click', ev => { if (ev.target === bg) closeHistoryModal(); });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && bg.classList.contains('open')) closeHistoryModal();
  });
}

/* ═════════════════════════════════════════════════════════════════
   AI commentary drafting (#8)
   ─────────────────────────────────────────────────────────────────
   A "✨ Draft" button in the edit toolbar opens a modal: the user
   describes the commentary they want, Groq (via the existing
   ai-concierge proxy — no new backend, stays on the free tier) drafts
   it with the active region as context, the user reviews/edits, then
   inserts it as a custom-text overlay. The button + modal are injected
   by this module so no per-tool HTML changes are needed. Writer-gated
   in practice: the button is .edit-only (hidden outside edit mode,
   which only writers can enter) and the insert writes via ctSave →
   reports_state, which RLS gates on is_writer().
   ═════════════════════════════════════════════════════════════════ */
const AI_DRAFT_PROXY_URL = 'https://cannojsxduvlewimwoxa.supabase.co/functions/v1/ai-concierge';

async function _aiDraftToken() {
  try {
    const { data } = await window.sb.auth.getSession();
    return (data && data.session && data.session.access_token) || null;
  } catch (_) { return null; }
}

/* Calls the Groq proxy for a commentary draft. Region context comes from
   the shared registries (name/state only — no PII, no client data). The
   system prompt forbids invented statistics so the model stays qualitative
   unless the user supplies figures. Returns trimmed prose; throws on error. */
async function _aiDraftCommentary(brief) {
  if (typeof window === 'undefined' || !window.sb) throw new Error('Not signed in.');
  const token = await _aiDraftToken();
  if (!token) throw new Error('Not signed in.');
  const slug = _rs_active();
  const info = (RESEARCH_REGIONS && RESEARCH_REGIONS[slug]) || (REGIONAL_REGIONS && REGIONAL_REGIONS[slug]) || {};
  const regionName = info.name || slug || 'this region';
  const stateBit = info.state ? (', ' + info.state) : '';
  const system =
    'You are a property-market analyst writing concise commentary for a Performance Property research report. '
    + 'Region: ' + regionName + stateBit + ' (Australia). '
    + 'Write in professional, factual Australian English. Output ONLY the commentary prose — no preamble, '
    + 'no markdown, no headings, no bullet symbols — ready to drop straight into a report text box. Be concise '
    + 'unless the request asks for more. Do NOT invent specific statistics or figures; stay qualitative unless '
    + 'the user supplies numbers in their request.';
  const resp = await fetch(AI_DRAFT_PROXY_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: system }, { role: 'user', content: String(brief || '') }],
      temperature: 0.4,
      stream: false,
    }),
  });
  if (!resp.ok) {
    if (resp.status === 429) throw new Error('Rate-limited by Groq — wait ~60s and try again.');
    let detail = '';
    try { const j = await resp.json(); detail = (j && j.error && (j.error.message || j.error)) || ''; } catch (_) {}
    throw new Error('AI request failed (' + resp.status + ')' + (detail ? ': ' + detail : ''));
  }
  const data = await resp.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text || !String(text).trim()) throw new Error('The AI returned an empty response.');
  return String(text).trim();
}

/* Plain prose → HTML for a custom-text overlay (entry.text is rendered as
   HTML). Escape the specials, turn newlines into <br>. */
function _aiDraftToHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r\n?|\n/g, '<br>');
}

function setupAiDraft() {
  const tools = document.getElementById('pp-pager-tools') || document.getElementById('pager-tools');
  if (!tools) return;                              // no edit toolbar on this page
  if (document.getElementById('btn-ai-draft')) return;  // idempotent

  /* Toolbar button. `pp-edit-btn` styles it on the research reports; on the
     regional tool the #pager-tools button selector styles it (extra class is
     harmless). `.edit-only` hides it outside edit mode in both. */
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'btn-ai-draft';
  btn.className = 'pp-edit-btn edit-only';
  btn.title = 'Draft report commentary with AI';
  btn.textContent = '✨ Draft';
  tools.appendChild(btn);

  /* Self-contained modal (styled in report-edit.css, loaded by all report
     tools). Injected once into <body>. */
  if (!document.getElementById('pp-ai-modal-bg')) {
    const bg = document.createElement('div');
    bg.className = 'pp-ai-modal-bg';
    bg.id = 'pp-ai-modal-bg';
    bg.setAttribute('aria-hidden', 'true');
    bg.innerHTML =
      '<div class="pp-ai-modal" role="dialog" aria-label="Draft commentary with AI">'
      + '<button class="pp-ai-close" id="pp-ai-close" type="button" aria-label="Close">×</button>'
      + '<h3 class="pp-ai-title">✨ Draft commentary</h3>'
      + '<p class="pp-ai-sub">Describe the commentary you want. The active region (<strong id="pp-ai-region"></strong>) is sent as context. Review and edit before inserting — the model can be wrong, so check any claims.</p>'
      + '<textarea id="pp-ai-brief" class="pp-ai-input" rows="3" placeholder="e.g. Two sentences on the rental market outlook and what’s driving it"></textarea>'
      + '<div class="pp-ai-actions"><button class="pp-ai-btn primary" id="pp-ai-go" type="button">Draft</button></div>'
      + '<div class="pp-ai-result" id="pp-ai-result" hidden>'
      +   '<label class="pp-ai-label">Draft (editable)</label>'
      +   '<textarea id="pp-ai-output" class="pp-ai-input" rows="7"></textarea>'
      +   '<div class="pp-ai-actions">'
      +     '<button class="pp-ai-btn ghost" id="pp-ai-regen" type="button">Re-draft</button>'
      +     '<button class="pp-ai-btn primary" id="pp-ai-insert" type="button">Insert as text box</button>'
      +   '</div>'
      + '</div>'
      + '<div class="pp-ai-status" id="pp-ai-status" hidden></div>'
      + '</div>';
    document.body.appendChild(bg);
  }

  const bg      = document.getElementById('pp-ai-modal-bg');
  const briefEl = document.getElementById('pp-ai-brief');
  const goBtn   = document.getElementById('pp-ai-go');
  const resultEl= document.getElementById('pp-ai-result');
  const outEl   = document.getElementById('pp-ai-output');
  const statusEl= document.getElementById('pp-ai-status');

  const setStatus = (msg, isErr) => {
    if (!statusEl) return;
    if (!msg) { statusEl.hidden = true; statusEl.textContent = ''; return; }
    statusEl.hidden = false;
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', !!isErr);
  };
  const open = () => {
    const slug = _rs_active();
    const info = (RESEARCH_REGIONS && RESEARCH_REGIONS[slug]) || (REGIONAL_REGIONS && REGIONAL_REGIONS[slug]) || {};
    const regionEl = document.getElementById('pp-ai-region');
    if (regionEl) regionEl.textContent = info.name || slug || 'current';
    if (resultEl) resultEl.hidden = true;
    if (outEl) outEl.value = '';
    setStatus('');
    bg.classList.add('open');
    if (briefEl) briefEl.focus();
  };
  const close = () => { bg.classList.remove('open'); };

  const run = async () => {
    const brief = (briefEl && briefEl.value || '').trim();
    if (!brief) { setStatus('Type what you’d like the commentary to cover.', true); return; }
    goBtn.disabled = true;
    if (document.getElementById('pp-ai-regen')) document.getElementById('pp-ai-regen').disabled = true;
    setStatus('Drafting…');
    try {
      const text = await _aiDraftCommentary(brief);
      if (outEl) outEl.value = text;
      if (resultEl) resultEl.hidden = false;
      setStatus('');
    } catch (e) {
      setStatus((e && e.message) || 'Could not draft commentary.', true);
    } finally {
      goBtn.disabled = false;
      if (document.getElementById('pp-ai-regen')) document.getElementById('pp-ai-regen').disabled = false;
    }
  };

  btn.addEventListener('click', open);
  if (goBtn) goBtn.addEventListener('click', run);
  const regenBtn = document.getElementById('pp-ai-regen');
  if (regenBtn) regenBtn.addEventListener('click', run);
  const closeBtn = document.getElementById('pp-ai-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  bg.addEventListener('click', ev => { if (ev.target === bg) close(); });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && bg.classList.contains('open')) close();
  });
  const insertBtn = document.getElementById('pp-ai-insert');
  if (insertBtn) insertBtn.addEventListener('click', () => {
    const text = (outEl && outEl.value || '').trim();
    if (!text) { setStatus('Nothing to insert yet.', true); return; }
    close();
    ctAddNew(_aiDraftToHtml(text));   // drops a custom-text overlay on the visible page
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   NATIONAL / COMMERCIAL add-ons — arrow-key nudge + copy-to-pages modal.
   ─────────────────────────────────────────────────────────────────────
   Everything here is uniquely named (pp*) so it can NEVER collide with the
   regional tool's own inline setupKeyboardNudge / copyPagesOpenForKind /
   _copyPagesContext (which would be a parse-time SyntaxError that kills this
   whole module). They're also gated in initReportEdit and opted OUT by the
   regional via PPA_REPORT_EDIT_OPTS, so they only ever activate on the
   National / Commercial reports — the regional keeps its own versions.
   ═══════════════════════════════════════════════════════════════════════ */

/* Arrow-key nudge for the selected overlay(s) — text / shape / image.
   1px per press, 10px with Shift. Skipped while typing in a field. */
function ppSetupArrowKeyNudge() {
  document.addEventListener('keydown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(ev.key)) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    const step = ev.shiftKey ? 10 : 1;
    const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
    const dy = ev.key === 'ArrowUp'   ? -step : ev.key === 'ArrowDown'  ? step : 0;

    const ctSel  = Array.from(document.querySelectorAll('.custom-text.selected'));
    const shSel  = Array.from(document.querySelectorAll('.shape.selected'));
    const imgSel = Array.from(document.querySelectorAll('.image-overlay.selected'));
    if (!ctSel.length && !shSel.length && !imgSel.length) return;
    ev.preventDefault();

    let textChanged = false, shapeChanged = false, imageChanged = false;
    ctSel.forEach(el => {
      const entry = _ctEntries.find(e => e.id === el.dataset.id);
      if (!entry) return;
      entry.y = (entry.y || 0) + dy;
      if (entry.anchorRight) {
        entry.rightX = (entry.rightX != null ? entry.rightX : (entry.x || 0)) + dx;
        el.style.left = 'auto'; el.style.right = (CT_PAGE_W - entry.rightX) + 'px';
      } else {
        entry.x = (entry.x || 0) + dx;
        el.style.left = entry.x + 'px';
      }
      el.style.top = entry.y + 'px';
      textChanged = true;
    });
    shSel.forEach(el => {
      const entry = _shEntries.find(e => e.id === el.dataset.id);
      if (!entry) return;
      if (entry.type === 'line' || entry.type === 'arrow') {
        entry.x1 += dx; entry.y1 += dy; entry.x2 += dx; entry.y2 += dy;
        _shRecalcBbox(entry);
      } else {
        entry.x = (entry.x || 0) + dx; entry.y = (entry.y || 0) + dy;
      }
      shRedraw(el, entry);
      shapeChanged = true;
    });
    imgSel.forEach(el => {
      const entry = _imgEntries.find(e => e.id === el.dataset.id);
      if (!entry) return;
      entry.x = (entry.x || 0) + dx; entry.y = (entry.y || 0) + dy;
      imgRedraw(el, entry);
      imageChanged = true;
    });

    const n = (textChanged ? 1 : 0) + (shapeChanged ? 1 : 0) + (imageChanged ? 1 : 0);
    if (n >= 2) {
      if (textChanged)  localStorage.setItem(ctStorageKey(),  JSON.stringify(_ctEntries));
      if (shapeChanged) localStorage.setItem(shStorageKey(),  JSON.stringify(_shEntries));
      if (imageChanged) localStorage.setItem(imgStorageKey(), JSON.stringify(_imgEntries));
      if (!_ctRestoring) ctPushHistory();
      _rs_scheduleSave();
    } else if (textChanged) {
      ctSave(_ctEntries);
    } else if (shapeChanged) {
      shSave(_shEntries);
    } else if (imageChanged) {
      imgSave(_imgEntries);
    }
  });
}

/* Arrow-key PAGE navigation — Down/Up jump instantly to the next/previous
   page. Mouse-wheel scrolling is untouched (it still scrolls smoothly), since
   this only intercepts the Down/Up keys. Mirrors the regional tool. Skipped
   while typing into an input/textarea/contentEditable, and — in edit mode —
   while a text/shape/image overlay is selected, so the nudge handler keeps the
   arrows for moving that overlay. The regional opts out (OPTS.arrowKeyNav
   false) and uses its own inline setupArrowKeyNav. */
function ppSetupArrowKeyNav() {
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
    if (document.body.classList.contains('edit-mode') &&
        (document.querySelector('.custom-text.selected') ||
         document.querySelector('.shape.selected') ||
         document.querySelector('.image-overlay.selected'))) return;

    const meta = pageMetaList();
    if (!meta.length) return;
    const visible = ctVisiblePageId();
    const idx = Math.max(0, meta.findIndex(m => m.id === visible));
    const nextIdx = ev.key === 'ArrowDown'
      ? Math.min(meta.length - 1, idx + 1)
      : Math.max(0, idx - 1);
    if (nextIdx === idx) return;
    ev.preventDefault();
    const targetId = meta[nextIdx].id;
    const target = document.getElementById(targetId);
    if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });

    /* Instant active-highlight swap (don't wait for the scroll spy's
       measurement, which feels laggy under fast Up/Down taps). */
    document.querySelectorAll('.side-toc-item').forEach(it => {
      it.classList.toggle('active', it.dataset.target === targetId);
    });
    /* Keep the active TOC item in view without disturbing the document scroll
       the line above just set. */
    const tocItem = document.querySelector('.side-toc-item[data-target="' + targetId + '"]');
    if (tocItem) {
      const tocScroll = tocItem.closest('.side-toc-scroll');
      if (tocScroll) {
        const itemRect = tocItem.getBoundingClientRect();
        const scrollRect = tocScroll.getBoundingClientRect();
        const buffer = 12;
        if (itemRect.top < scrollRect.top + buffer) {
          tocScroll.scrollTop -= (scrollRect.top + buffer) - itemRect.top;
        } else if (itemRect.bottom > scrollRect.bottom - buffer) {
          tocScroll.scrollTop += itemRect.bottom - (scrollRect.bottom - buffer);
        }
      }
    }
  });
}

/* Copy-to-pages page-picker modal (pp-modal). _ppCopyModalReady gates the
   shared copy triggers: true only after this wires up (i.e. the host has the
   pp-modal markup AND didn't opt out), so the regional falls back to its own
   path. */
let _ppCopyPagesCtx   = null;   /* { kind, entryId } stashed at open-time */
let _ppCopyModalReady = false;

function ppCopyPagesOpenForKind(kind, entryOverride) {
  let entry = entryOverride;
  if (!entry) {
    if      (kind === 'shape') entry = shGetSelectedEntry();
    else if (kind === 'image') entry = imgGetSelectedEntry();
    else                       entry = ctGetSelectedEntry();
  }
  if (!entry) return;
  const bg      = document.getElementById('copy-pages-modal-bg');
  const list    = document.getElementById('copy-pages-list');
  const sub     = document.getElementById('copy-pages-sub');
  const titleEl = document.getElementById('copy-pages-modal-title');
  const allCb   = document.getElementById('copy-pages-all');
  if (!bg || !list || !sub || !allCb) return;
  const allPages   = Array.from(document.querySelectorAll('section.page[id]'));
  const otherPages = allPages.filter(p => p.id !== entry.pageId);
  if (!otherPages.length) { alert('There are no other pages to copy to.'); return; }
  _ppCopyPagesCtx = { kind, entryId: entry.id };
  if (titleEl) titleEl.textContent = (kind === 'shape') ? 'Copy shape to pages'
                                   : (kind === 'image') ? 'Copy image to pages'
                                                        : 'Copy text to pages';
  const srcPage  = document.getElementById(entry.pageId);
  const srcLabel = srcPage ? (srcPage.dataset.label || srcPage.id) : entry.pageId;
  const srcIdx   = allPages.indexOf(srcPage) + 1;
  if (kind === 'shape') {
    sub.innerHTML = 'Copying <strong>' + _shEscapeAttr(entry.type || 'shape') + '</strong> shape from page ' + srcIdx + ' (' + srcLabel + ').';
  } else if (kind === 'image') {
    sub.innerHTML = 'Copying <strong>image</strong> from page ' + srcIdx + ' (' + srcLabel + ').';
  } else {
    const preview = String(entry.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    sub.innerHTML = 'Copying <strong>"' + (preview || '(blank)') + '"</strong> from page ' + srcIdx + ' (' + srcLabel + ').';
  }
  list.innerHTML = '';
  otherPages.forEach((page) => {
    const idx = allPages.indexOf(page) + 1;
    const label = page.dataset.label || page.id;
    const row = document.createElement('label');
    row.className = 'pp-pages-row';
    row.innerHTML = '<input type="checkbox" data-page-id="' + page.id + '" />' +
      '<span class="num">' + idx + '</span><span class="lbl">' + label + '</span>';
    list.appendChild(row);
  });
  allCb.checked = false;
  ppCopyPagesUpdateCount();
  bg.classList.add('open');
  bg.setAttribute('aria-hidden', 'false');
}

function ppCopyPagesClose() {
  const bg = document.getElementById('copy-pages-modal-bg');
  if (!bg) return;
  bg.classList.remove('open');
  bg.setAttribute('aria-hidden', 'true');
  _ppCopyPagesCtx = null;
}

function ppCopyPagesUpdateCount() {
  const list = document.getElementById('copy-pages-list');
  const btn  = document.getElementById('copy-pages-confirm');
  if (!list || !btn) return;
  const checked = list.querySelectorAll('input[type="checkbox"]:checked').length;
  btn.disabled = checked === 0;
  btn.textContent = checked === 0 ? 'Copy' : 'Copy to ' + checked + ' page' + (checked === 1 ? '' : 's');
}

function ppSetupCopyPagesModal() {
  const bg = document.getElementById('copy-pages-modal-bg');
  if (!bg) return;
  _ppCopyModalReady = true;
  const list       = document.getElementById('copy-pages-list');
  const allCb      = document.getElementById('copy-pages-all');
  const closeBtn   = document.getElementById('copy-pages-close');
  const cancelBtn  = document.getElementById('copy-pages-cancel');
  const confirmBtn = document.getElementById('copy-pages-confirm');
  if (closeBtn)  closeBtn.addEventListener('click', ppCopyPagesClose);
  if (cancelBtn) cancelBtn.addEventListener('click', ppCopyPagesClose);
  bg.addEventListener('click', ev => { if (ev.target === bg) ppCopyPagesClose(); });
  if (allCb && list) {
    allCb.addEventListener('change', () => {
      list.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = allCb.checked; });
      ppCopyPagesUpdateCount();
    });
    list.addEventListener('change', () => {
      const cbs = list.querySelectorAll('input[type="checkbox"]');
      const checked = list.querySelectorAll('input[type="checkbox"]:checked');
      allCb.checked = (cbs.length > 0 && checked.length === cbs.length);
      ppCopyPagesUpdateCount();
    });
  }
  if (confirmBtn) confirmBtn.addEventListener('click', () => {
    const ctx = _ppCopyPagesCtx;
    let entry = null;
    if (ctx) {
      if      (ctx.kind === 'shape') entry = shEntryById(ctx.entryId);
      else if (ctx.kind === 'image') entry = imgEntryById(ctx.entryId);
      else                           entry = ctEntryById(ctx.entryId);
    }
    if (!entry) { ppCopyPagesClose(); return; }
    const targetIds = Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.dataset.pageId);
    if (!targetIds.length) return;
    if (ctx.kind === 'shape') {
      targetIds.forEach(pageId => {
        const clone = JSON.parse(JSON.stringify(entry));
        clone.id = 'sh-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        clone.pageId = pageId; _shEntries.push(clone); shMakeEl(clone);
      });
      shSave(_shEntries);
    } else if (ctx.kind === 'image') {
      targetIds.forEach(pageId => {
        const clone = JSON.parse(JSON.stringify(entry));
        clone.id = 'ig-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        clone.pageId = pageId; _imgEntries.push(clone); imgMakeEl(clone);
      });
      imgSave(_imgEntries);
    } else {
      targetIds.forEach(pageId => {
        const clone = Object.assign({}, entry, { id: 'ct-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), pageId: pageId });
        _ctEntries.push(clone); ctMakeEl(clone);
      });
      ctSave(_ctEntries);
    }
    ppCopyPagesClose();
  });
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape') return;
    if (!bg.classList.contains('open')) return;
    ppCopyPagesClose();
  });
}

/* Copy / cut / paste / duplicate for overlays — Ctrl+C / X / V / D, covering
   text, shape AND image. Ported from the regional tool with pp* names (the
   regional has its own inline _ctClipboard / setupCopyPaste; unique names
   avoid the parse-time collision that breaks the shared module). Uses an
   internal JS clipboard, not the OS clipboard, so it doesn't fight a
   contenteditable's own text copy/paste. Gated + opted out by the regional. */
let _ppClipboard = null;
let _ppPasteStep = 0;
const _PP_PASTE_OFFSET = 15;

/* ── Cross-report clipboard ───────────────────────────────────────
   Copy/paste between different reports (other regions, or national /
   commercial) is a fresh page load, so the in-memory clipboard is gone.
   We mirror every copy/cut into localStorage under one shared key + the
   same {kind,data} item format both the shared and the regional inline
   copy/paste already use. On paste, if the in-memory clipboard is empty we
   fall back to this; and when the clipboard came from a DIFFERENT report we
   paste onto the page being viewed at each item's original x/y (no cascade
   offset) so it lands at the same position you'd expect. */
const _PP_CLIP_KEY = 'ppa-report-clipboard-v1';
function ppReportId() {
  try {
    const tool = (location.pathname || '').split('/').pop() || '';
    const region = new URLSearchParams(location.search).get('region') || '';
    return tool + (region ? ('?region=' + region) : '');
  } catch (e) { return String(location.href); }
}
function ppClipboardStore(items) {
  try { localStorage.setItem(_PP_CLIP_KEY, JSON.stringify({ source: ppReportId(), items: items })); } catch (e) {}
}
function ppClipboardLoadShared() {
  try {
    const o = JSON.parse(localStorage.getItem(_PP_CLIP_KEY) || 'null');
    return (o && Array.isArray(o.items) && o.items.length) ? o : null;
  } catch (e) { return null; }
}

function ppPersistOverlayChanges(textChanged, shapeChanged, imageChanged) {
  const n = (textChanged ? 1 : 0) + (shapeChanged ? 1 : 0) + (imageChanged ? 1 : 0);
  if (n >= 2) {
    if (textChanged)  localStorage.setItem(ctStorageKey(),  JSON.stringify(_ctEntries));
    if (shapeChanged) localStorage.setItem(shStorageKey(),  JSON.stringify(_shEntries));
    if (imageChanged) localStorage.setItem(imgStorageKey(), JSON.stringify(_imgEntries));
    if (!_ctRestoring) ctPushHistory();
    _rs_scheduleSave();
  } else if (textChanged) {
    ctSave(_ctEntries);
  } else if (shapeChanged) {
    shSave(_shEntries);
  } else if (imageChanged) {
    imgSave(_imgEntries);
  }
}

function ppClipboardCopy(skipStore) {
  const items = [];
  document.querySelectorAll('.custom-text.selected').forEach(el => {
    const entry = _ctEntries.find(e => e.id === el.dataset.id);
    if (entry) items.push({ kind: 'text', data: JSON.parse(JSON.stringify(entry)) });
  });
  document.querySelectorAll('.shape.selected').forEach(el => {
    const entry = _shEntries.find(e => e.id === el.dataset.id);
    if (entry) items.push({ kind: 'shape', data: JSON.parse(JSON.stringify(entry)) });
  });
  document.querySelectorAll('.image-overlay.selected').forEach(el => {
    const entry = _imgEntries.find(e => e.id === el.dataset.id);
    if (entry) items.push({ kind: 'image', data: JSON.parse(JSON.stringify(entry)) });
  });
  if (!items.length) return false;
  _ppClipboard = items;
  _ppPasteStep = 0;
  if (!skipStore) ppClipboardStore(items);   /* mirror to the cross-report clipboard (skipped by duplicate) */
  return true;
}

function ppClipboardCut() {
  if (!ppClipboardCopy()) return false;
  const ctSelected  = Array.from(document.querySelectorAll('.custom-text.selected'));
  const shSelected  = Array.from(document.querySelectorAll('.shape.selected'));
  const imgSelected = Array.from(document.querySelectorAll('.image-overlay.selected'));
  let textChanged = false, shapeChanged = false, imageChanged = false;
  if (ctSelected.length) {
    const ids = new Set(ctSelected.map(el => el.dataset.id));
    _ctEntries = _ctEntries.filter(e => !ids.has(e.id));
    ctSelected.forEach(el => el.remove());
    textChanged = true;
  }
  if (shSelected.length) {
    const ids = new Set(shSelected.map(el => el.dataset.id));
    _shEntries = _shEntries.filter(e => !ids.has(e.id));
    shSelected.forEach(el => el.remove());
    shapeChanged = true;
  }
  if (imgSelected.length) {
    const ids = new Set(imgSelected.map(el => el.dataset.id));
    _imgEntries = _imgEntries.filter(e => !ids.has(e.id));
    imgSelected.forEach(el => el.remove());
    imageChanged = true;
  }
  ppPersistOverlayChanges(textChanged, shapeChanged, imageChanged);
  ctUpdateSidebar();
  if (typeof shUpdatePanel === 'function') shUpdatePanel();
  _selUpdateMultiClass();
  return true;
}

function ppClipboardPaste(opts) {
  /* Resolve the clipboard: in-memory (copied this session = same report) first,
     else the cross-report localStorage clipboard. `exact` = the items came from
     a DIFFERENT report → keep each item's original page + position, no offset. */
  let items = _ppClipboard;
  let exact = false;
  if (!items || !items.length) {
    const shared = ppClipboardLoadShared();
    if (shared) { items = shared.items; exact = (shared.source !== ppReportId()); }
  }
  if (!items || !items.length) return false;
  /* Only duplicate keeps the original pageId. A cross-report (exact) paste
     lands on the page you're VIEWING, at each item's original x/y (no offset)
     — so it goes where you paste it, not back onto the source page. */
  const inPlace = !!(opts && opts.inPlace);
  const visiblePageId = ctVisiblePageId();
  if (!inPlace && !visiblePageId) return false;
  if (!exact) _ppPasteStep += 1;
  const dx = exact ? 0 : _PP_PASTE_OFFSET * _ppPasteStep;
  const dy = exact ? 0 : _PP_PASTE_OFFSET * _ppPasteStep;
  ctDeselectAll();
  if (typeof shDeselectAll  === 'function') shDeselectAll();
  if (typeof imgDeselectAll === 'function') imgDeselectAll();
  let textChanged = false, shapeChanged = false, imageChanged = false;
  items.forEach(item => {
    if (item.kind === 'text') {
      const orig = item.data;
      const clone = Object.assign({}, JSON.parse(JSON.stringify(orig)), {
        id: 'ct-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        pageId: inPlace ? orig.pageId : visiblePageId,
        x: (+orig.x || 0) + dx,
        y: (+orig.y || 0) + dy,
      });
      _ctEntries.push(clone);
      const el = ctMakeEl(clone);
      if (el) el.classList.add('selected');
      textChanged = true;
    } else if (item.kind === 'shape') {
      const clone = JSON.parse(JSON.stringify(item.data));
      clone.id = 'sh-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      clone.pageId = inPlace ? clone.pageId : visiblePageId;
      clone.x = (+clone.x || 0) + dx;
      clone.y = (+clone.y || 0) + dy;
      if (clone.type === 'line' || clone.type === 'arrow') {
        clone.x1 = (+clone.x1 || 0) + dx; clone.y1 = (+clone.y1 || 0) + dy;
        clone.x2 = (+clone.x2 || 0) + dx; clone.y2 = (+clone.y2 || 0) + dy;
      }
      _shEntries.push(clone);
      const el = shMakeEl(clone);
      if (el) el.classList.add('selected');
      shapeChanged = true;
    } else if (item.kind === 'image') {
      const clone = JSON.parse(JSON.stringify(item.data));
      clone.id = 'ig-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      clone.pageId = inPlace ? clone.pageId : visiblePageId;
      clone.x = (+clone.x || 0) + dx;
      clone.y = (+clone.y || 0) + dy;
      _imgEntries.push(clone);
      const el = imgMakeEl(clone);
      if (el) el.classList.add('selected');
      imageChanged = true;
    }
  });
  ppPersistOverlayChanges(textChanged, shapeChanged, imageChanged);
  ctUpdateSidebar();
  if (typeof shUpdatePanel === 'function') shUpdatePanel();
  _selUpdateMultiClass();
  return true;
}

function ppDuplicateSelected() {
  const savedClip = _ppClipboard;
  const savedStep = _ppPasteStep;
  if (!ppClipboardCopy(true)) { _ppClipboard = savedClip; _ppPasteStep = savedStep; return false; }
  ppClipboardPaste({ inPlace: true });
  _ppClipboard = savedClip; _ppPasteStep = savedStep;
  return true;
}

function ppSetupCopyPaste() {
  document.addEventListener('keydown', ev => {
    if (!document.body.classList.contains('edit-mode')) return;
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
    const k = (ev.key || '').toLowerCase();
    if (k === 'c') { if (ppClipboardCopy()) ev.preventDefault(); }
    else if (k === 'x') { if (ppClipboardCut()) ev.preventDefault(); }
    else if (k === 'v') { if (ppClipboardPaste()) ev.preventDefault(); }
    else if (k === 'd') { if (ppDuplicateSelected()) ev.preventDefault(); }
  });
}

/* ─── Reference Bands (growth / correction periods behind price charts) ───
   Ported from the regional tool with pp* names so it can't collide with the
   regional's inline BANDS / bandsLoad / setupBandsModal (the regional opts
   out via PPA_REPORT_EDIT_OPTS.bands=false and keeps its own). The host's
   _mountChart paints the bands behind the pages listed in its _PP_BAND_PAGES
   via ppBandsMarkArea(). Data lives in the shared 'bands' storage bucket so
   the sync layer bundles it. */
const _PP_BAND_DEFAULTS = [
  { from: 1982, to: 1985, type: 'correct' },
  { from: 1985, to: 1991, type: 'growth'  },
  { from: 1991, to: 1996, type: 'correct' },
  { from: 1996, to: 2004, type: 'growth'  },
  { from: 2004, to: 2009, type: 'correct' },
  { from: 2009, to: 2020, type: 'growth'  },
  { from: 2020, to: 2022, type: 'correct' },
  { from: 2022, to: 2026, type: 'growth'  },
];
const _PP_BAND_GROWTH_COLOR     = 'rgba(155, 215, 225, 0.55)';
const _PP_BAND_CORRECTION_COLOR = 'rgba(180, 185, 192, 0.50)';

function ppBandsStorageKey() { return 'ppa-online-reports-bands-v1-' + _rs_active(); }
function ppBandsDefaults() {
  return _PP_BAND_DEFAULTS.map(b => ({
    id: 'band-default-' + b.from + '-' + b.to, type: b.type,
    from: b.from + '-01-01', to: b.to + '-01-01',
  }));
}
function ppBandsLoad() {
  try { const raw = localStorage.getItem(ppBandsStorageKey()); if (!raw) return null;
        const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : null; }
  catch (e) { return null; }
}
function ppBandsSave(bands) {
  if (bands == null) localStorage.removeItem(ppBandsStorageKey());
  else               localStorage.setItem(ppBandsStorageKey(), JSON.stringify(bands));
  _rs_scheduleSave();
}
function ppBandsActive() { return ppBandsLoad() || ppBandsDefaults(); }
function ppBandToYear(d) {
  if (typeof d === 'number') return d;
  const m = String(d).match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}
/* markArea data (pairs of points) for the charts that paint bands. */
function ppBandsMarkArea() {
  return ppBandsActive().map(b => ([
    { xAxis: String(ppBandToYear(b.from)), itemStyle: { color: b.type === 'growth' ? _PP_BAND_GROWTH_COLOR : _PP_BAND_CORRECTION_COLOR } },
    { xAxis: String(ppBandToYear(b.to)) },
  ]));
}
function ppBandsFormatDate(d) {
  if (!d) return '';
  if (/^\d{4}$/.test(String(d))) d = d + '-01-01';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
function ppBandsNormalizeForInput(d) {
  if (!d) return '';
  if (/^\d{4}$/.test(String(d))) return d + '-01-01';
  return String(d).slice(0, 10);
}
function ppBandsRefreshCharts() {
  if (typeof renderAllCharts === 'function' && typeof REPORT_DATA !== 'undefined' && REPORT_DATA) {
    try { renderAllCharts(REPORT_DATA); } catch (_) {}
  }
}

function ppBandsRefresh() {
  const list = document.getElementById('bands-list');
  if (!list) return;
  const sub = document.getElementById('bands-sub');
  const bands = ppBandsActive();
  if (sub) sub.textContent = (ppBandsLoad() ? 'Custom set — saved for this report.' : 'Default set shown. Add or edit any row to start a custom set.')
    + ' Drawn behind the price charts.';
  if (!bands.length) {
    list.innerHTML = '<table class="bands-table"><tbody><tr class="empty-row"><td>No bands. Click "+ Add band" to create one.</td></tr></tbody></table>';
    return;
  }
  let html = '<table class="bands-table"><thead><tr><th style="width:24px"></th><th>Type</th><th>From</th><th>To</th><th style="text-align:right;">Actions</th></tr></thead><tbody>';
  for (const b of bands) {
    const typeLabel = b.type === 'growth' ? 'Growth' : 'Correction';
    const cls       = b.type === 'growth' ? 'growth' : 'correct';
    html += '<tr class="band-row" draggable="true" data-id="' + b.id + '">' +
      '<td class="band-drag-cell" title="Drag to reorder"><span class="band-drag-handle" aria-hidden="true">⋮⋮</span></td>' +
      '<td><span class="band-type-pill ' + cls + '" role="button" tabindex="0" data-action="toggle-type" data-id="' + b.id + '" title="Click to flip type" style="cursor:pointer">' + typeLabel + '</span></td>' +
      '<td>' + ppBandsFormatDate(b.from) + '</td>' +
      '<td>' + ppBandsFormatDate(b.to)   + '</td>' +
      '<td style="text-align:right;">' +
        '<button class="bands-row-action" data-action="edit" data-id="' + b.id + '">Edit</button>' +
        '<button class="bands-row-action delete" data-action="delete" data-id="' + b.id + '">Delete</button>' +
      '</td></tr>';
  }
  html += '</tbody></table>';
  list.innerHTML = html;
  list.querySelectorAll('button[data-action], span[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'edit')        ppBandsOpenForm(btn.dataset.id);
      if (btn.dataset.action === 'delete')      ppBandsDelete(btn.dataset.id);
      if (btn.dataset.action === 'toggle-type') ppBandsToggleType(btn.dataset.id);
    });
    if (btn.tagName === 'SPAN' && btn.dataset.action === 'toggle-type') {
      btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ppBandsToggleType(btn.dataset.id); } });
    }
  });
  /* Drag-reorder. */
  let _dragId = null;
  list.querySelectorAll('tr.band-row').forEach(row => {
    row.addEventListener('dragstart', (e) => { _dragId = row.dataset.id; row.classList.add('band-row-dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', _dragId); } catch (_) {} });
    row.addEventListener('dragend', () => { row.classList.remove('band-row-dragging'); list.querySelectorAll('tr.band-row.drop-above, tr.band-row.drop-below').forEach(r => r.classList.remove('drop-above', 'drop-below')); _dragId = null; });
    row.addEventListener('dragover', (e) => { if (!_dragId || _dragId === row.dataset.id) return; e.preventDefault(); const rect = row.getBoundingClientRect(); const before = (e.clientY - rect.top) < (rect.height / 2); row.classList.toggle('drop-above', before); row.classList.toggle('drop-below', !before); });
    row.addEventListener('dragleave', () => { row.classList.remove('drop-above', 'drop-below'); });
    row.addEventListener('drop', (e) => { if (!_dragId || _dragId === row.dataset.id) return; e.preventDefault(); const rect = row.getBoundingClientRect(); const before = (e.clientY - rect.top) < (rect.height / 2); ppBandsReorder(_dragId, row.dataset.id, before); });
    row.querySelectorAll('button, .band-type-pill').forEach(el => { el.addEventListener('mousedown', (e) => e.stopPropagation()); el.setAttribute('draggable', 'false'); });
  });
}
function ppBandsReorder(srcId, targetId, placeBefore) {
  const list = (ppBandsLoad() || ppBandsDefaults()).slice();
  const srcIdx = list.findIndex(b => String(b.id) === String(srcId));
  if (srcIdx < 0) return;
  const [src] = list.splice(srcIdx, 1);
  const tgtIdx = list.findIndex(b => String(b.id) === String(targetId));
  if (tgtIdx < 0) list.push(src);
  else list.splice(placeBefore ? tgtIdx : tgtIdx + 1, 0, src);
  ppBandsSave(list); ppBandsRefresh(); ppBandsRefreshCharts();
}
function ppBandsToggleType(id) {
  const list = ppBandsLoad() || ppBandsDefaults();
  const b = list.find(x => x.id === id);
  if (!b) return;
  b.type = (b.type === 'growth') ? 'correction' : 'growth';
  ppBandsSave(list); ppBandsRefresh(); ppBandsRefreshCharts();
}
function ppBandsOpenForm(id) {
  const form = document.getElementById('bands-edit-form');
  if (!form) return;
  const all = ppBandsActive();
  if (id) {
    const b = all.find(x => x.id === id);
    if (!b) return;
    document.getElementById('band-id').value   = id;
    document.getElementById('band-type').value = b.type === 'growth' ? 'growth' : 'correct';
    document.getElementById('band-from').value = ppBandsNormalizeForInput(b.from);
    document.getElementById('band-to').value   = ppBandsNormalizeForInput(b.to);
  } else {
    document.getElementById('band-id').value   = '';
    document.getElementById('band-type').value = 'growth';
    document.getElementById('band-from').value = '';
    document.getElementById('band-to').value   = '';
  }
  form.classList.add('open');
  document.getElementById('band-from').focus();
}
function ppBandsCloseForm() {
  const form = document.getElementById('bands-edit-form');
  if (form) form.classList.remove('open');
}
function ppBandsSaveForm() {
  const id   = document.getElementById('band-id').value;
  const type = document.getElementById('band-type').value;
  const from = document.getElementById('band-from').value;
  const to   = document.getElementById('band-to').value;
  if (!from || !to) { alert('Both From and To dates are required.'); return; }
  if (from >= to)   { alert('"From" date must be before "To" date.'); return; }
  const list = ppBandsLoad() || ppBandsDefaults();
  if (id) { const b = list.find(x => x.id === id); if (b) Object.assign(b, { type, from, to }); }
  else    { list.push({ id: 'band-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type, from, to }); }
  ppBandsSave(list); ppBandsCloseForm(); ppBandsRefresh(); ppBandsRefreshCharts();
}
function ppBandsDelete(id) {
  const list = (ppBandsLoad() || ppBandsDefaults()).filter(x => x.id !== id);
  ppBandsSave(list); ppBandsRefresh(); ppBandsRefreshCharts();
}
function ppBandsResetDefaults() {
  if (!confirm('Discard your custom bands and restore the defaults?')) return;
  ppBandsSave(null); ppBandsCloseForm(); ppBandsRefresh(); ppBandsRefreshCharts();
}
function ppSetupBandsModal() {
  const bg = document.getElementById('bands-modal-bg');
  const btn = document.getElementById('btn-bands');
  if (!bg || !btn) return;
  const close = () => { bg.classList.remove('open'); bg.setAttribute('aria-hidden', 'true'); ppBandsCloseForm(); };
  btn.addEventListener('click', () => { ppBandsRefresh(); bg.classList.add('open'); bg.setAttribute('aria-hidden', 'false'); });
  const closeBtn  = document.getElementById('bands-close');
  if (closeBtn) closeBtn.addEventListener('click', close);
  bg.addEventListener('click', ev => { if (ev.target === bg) close(); });
  const addBtn = document.getElementById('band-add');
  if (addBtn) addBtn.addEventListener('click', () => ppBandsOpenForm(null));
  const cancelBtn = document.getElementById('band-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', ppBandsCloseForm);
  const saveBtn = document.getElementById('band-save');
  if (saveBtn) saveBtn.addEventListener('click', ppBandsSaveForm);
  const resetBtn = document.getElementById('band-reset');
  if (resetBtn) resetBtn.addEventListener('click', ppBandsResetDefaults);
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || !bg.classList.contains('open')) return;
    const form = document.getElementById('bands-edit-form');
    if (form && form.classList.contains('open')) ppBandsCloseForm();
    else close();
  });
}

/* ═════════════ Entry point — host HTML calls this after DOMContentLoaded ═════════════ */
function initReportEdit() {
  /* Opt-out config (the #5 consolidation seam). A host tool can set
     window.PPA_REPORT_EDIT_OPTS = { regionSelect:false, bands:false,
     refresh:false, prebuiltIndicator:false, downloadModal:false,
     audit:false } to suppress the shared module's version of a
     subsystem it implements itself. The regional Online Reports tool
     will use this to keep its richer region nav / reference bands /
     multi-region PDF export / live-data refresh while reusing the
     shared overlay engine. Unset (national/commercial) → every flag is
     undefined → every subsystem runs exactly as before. */
  var OPTS = (typeof window !== 'undefined' && window.PPA_REPORT_EDIT_OPTS) || {};
  /* Order matters:
       1. Restore page DOM (custom pages + saved order)
       2. Apply stored labels onto data-label (so chrome reads them)
       3. Apply stored page backgrounds
       4. Build chrome (TOC + page-num)
       5. Load entries from storage (text, shape, image)
       6. Wire scroll spy + mode toggle + grid + +Text/+Page/+Shape/+Image
       7. Init CT system (renderAll + history seed + format panel)
       8. Init shape + image + page-bg systems
     Charts render via the host HTML's existing liveBoot() flow — they
     don't depend on this init order. */
  restorePagesFromStorage();
  applyStoredLabels();
  applyStoredPageBgs();
  injectPageNumbers();
  buildSideToc();
  setupTocToggle();
  setupScrollSpy();
  setupModeToggle();
  setupGridToggle();
  setupAddPageButton();
  setupPagerToolsToggle();
  if (OPTS.regionSelect !== false) setupRegionSelect();
  if (OPTS.bands       !== false) ppSetupBandsModal();
  if (OPTS.refresh     !== false) setupRefreshButton();
  setupAutoZoom();
  /* Cached-PDF indicator runs asynchronously — the pill is empty
     until the storage.list() round-trip completes, which keeps the
     boot path snappy and the pill silent-on-failure. */
  if (OPTS.prebuiltIndicator !== false) ppRefreshPrebuiltIndicator();
  _ctEntries  = ctLoad();
  _shEntries  = shLoad();
  _imgEntries = imgLoad();
  ctInit();
  if (typeof loadReportSourceLib === 'function') loadReportSourceLib();   // shared Source Library (chunk 1)
  if (typeof setupSourcesUI === 'function') setupSourcesUI();             // shared Source Library UI (chunk 3)
  setupShapes();
  setupImages();
  setupPageBgEditor();
  setupPageBgApplyModal();
  /* National/Commercial add-ons (uniquely named, opted out by the regional
     which has its own). Copy-pages sets _ppCopyModalReady, which switches the
     shared copy triggers from prompt → modal. */
  if (OPTS.copyPages    !== false) ppSetupCopyPagesModal();
  if (OPTS.keyboardNudge !== false) ppSetupArrowKeyNudge();
  if (OPTS.arrowKeyNav  !== false) ppSetupArrowKeyNav();
  if (OPTS.copyPaste    !== false) ppSetupCopyPaste();
  /* Slice 4 — backup/sync/audit modals. Triggers live on the pager
     with tier1-only gating; their no-op early-out when the HTML
     scaffolds aren't present keeps things safe if a future tool
     leaves them out. */
  if (OPTS.backup !== false) setupBackupModal();
  if (OPTS.sync   !== false) setupSyncModal();
  if (OPTS.audit  !== false) setupAuditModal();
  setupHistoryModal();
  if (OPTS.downloadModal !== false) setupPdfPagesModal();
  if (OPTS.aiDraft !== false) setupAiDraft();
}

/* Expose entry point + commonly-called functions on window so the
   inline pager-button onclick attributes can call them. */
window.initReportEdit = initReportEdit;
window.ctAddNew       = ctAddNew;
window.addBlankPage   = addBlankPage;
