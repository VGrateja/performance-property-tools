/* ===========================================================================
   shared/gslides-watch.js — client side of the Google Slides change watch
   (migration 098 · monitor: scripts/gslides-watch.mjs)

   An editor ATTACHES a Google Slides link to a hub slide. A scheduled monitor
   fingerprints that Google deck. This module tells the UI whether the hub slide
   should wear a red mark, and what to say when it is opened.

   WHY THE MARK CLEARS ITSELF CORRECTLY: "seen" is stored as the CONTENT STAMP
   the user looked at, not a flag or a counter. So an edit-then-revert in Google
   returns the stamp to a value the user already acknowledged and the mark
   disappears on its own — no stuck dots.

   A link watches the WHOLE Google deck. The hub slide it hangs off is just
   where the red dot lands — there is no content connection between the two, by
   design: Van does the comparing. The report answers only "did it change, when,
   and which pages".

     PP_GSW.parse(url)                     -> { fileId, pageId } | null
     await PP_GSW.load(scope, deckKey)     -> { links, files, seen }
     PP_GSW.isFlagged(link, state)         -> bool
     PP_GSW.changesFor(link, state)        -> [{ index, title, kind, url }]
     PP_GSW.changedAt(link, state)         -> Date | null
     await PP_GSW.markSeen(link, state)
     await PP_GSW.flaggedCount()           -> number   (dock rollup, all scopes)
     await PP_GSW.attach({scope,deckKey,slideKey,url,label})   // writer only
     await PP_GSW.detach(linkId)                               // writer only

   Requires window.sb (shared/supabase-client.js).
   =========================================================================== */
(function () {
  'use strict';
  var sb = function () { return window.sb; };

  /* Accepts a bare id, an /edit url, or an /edit#slide=id.gXXX url. The page
     fragment is what lets one deck feed several hub slides independently. */
  function parse(url) {
    var s = String(url || '').trim();
    if (!s) return null;
    var fileId = '';
    var m = s.match(/\/presentation\/d\/(?:e\/)?([A-Za-z0-9_-]{20,})/);
    if (m) fileId = m[1];
    else if (/^[A-Za-z0-9_-]{20,}$/.test(s)) fileId = s;
    if (!fileId) return null;
    var pageId = '';
    var p = s.match(/[#&?]slide=id\.([A-Za-z0-9_-]+)/);
    if (p) pageId = p[1];
    return { fileId: fileId, pageId: pageId || null };
  }

  function pageUrl(fileId, pageId) {
    return 'https://docs.google.com/presentation/d/' + fileId + '/edit'
      + (pageId ? '#slide=id.' + pageId : '');
  }

  /* A link watches the WHOLE Google deck — its fingerprint is the deck's.
     Deliberately not per-page: the hub slide and the Google deck are not wired
     together, so there is nothing to scope a watch to. Van does the comparing;
     this only answers "did it move, when, and which pages". */
  function stampFor(link, file) {
    return (file && file.content_stamp) || null;
  }

  function isFlagged(link, state) {
    if (!link || !state) return false;
    var file = state.files[link.file_id];
    if (!file) return false;                  // never polled yet — say nothing
    if (!file.last_changed_at) return false;  // seeded, nothing has moved since
    var stamp = stampFor(link, file);
    if (!stamp) return false;
    return state.seen[link.id] !== stamp;
  }

  /* Every page the monitor saw move in the latest change, newest list wins. */
  function changesFor(link, state) {
    var file = state && state.files[link.file_id];
    if (!file) return [];
    return (file.changed_pages || []).map(function (c) {
      return { index: c.index, title: c.title || '', kind: c.kind,
               objectId: c.objectId, url: pageUrl(link.file_id, c.objectId) };
    });
  }

  function changedAt(link, state) {
    var file = state && state.files[link.file_id];
    return (file && file.last_changed_at) ? new Date(file.last_changed_at) : null;
  }

  function emptyState() { return { links: [], files: {}, seen: {} }; }

  /* scope/deckKey omitted => every link (the dock rollup path). */
  async function load(scope, deckKey) {
    var out = emptyState();
    try {
      var q = sb().from('gslides_links').select('*');
      if (scope) q = q.eq('scope', scope);
      if (deckKey) q = q.eq('deck_key', deckKey);
      var lr = await q;
      out.links = lr.data || [];
      if (!out.links.length) return out;
      var ids = [];
      out.links.forEach(function (l) { if (ids.indexOf(l.file_id) < 0) ids.push(l.file_id); });
      var fr = await sb().from('gslides_files').select('*').in('file_id', ids);
      (fr.data || []).forEach(function (f) { out.files[f.file_id] = f; });
      /* own rows only — RLS makes this safe without a user filter */
      var sr = await sb().from('gslides_seen').select('link_id,seen_stamp');
      (sr.data || []).forEach(function (s) { out.seen[s.link_id] = s.seen_stamp; });
    } catch (e) { /* watch must never break a deck from opening */ }
    return out;
  }

  async function markSeen(link, state) {
    try {
      var file = state.files[link.file_id];
      var stamp = stampFor(link, file);
      if (!stamp) return;
      var u = await sb().auth.getUser();
      var uid = u && u.data && u.data.user && u.data.user.id;
      if (!uid) return;
      await sb().from('gslides_seen').upsert(
        { user_id: uid, link_id: link.id, seen_stamp: stamp, seen_at: new Date().toISOString() },
        { onConflict: 'user_id,link_id' });
      state.seen[link.id] = stamp;
    } catch (e) {}
  }

  async function flaggedCount() {
    var st = await load();
    var n = 0;
    st.links.forEach(function (l) { if (isFlagged(l, st)) n++; });
    return n;
  }

  /* page_id is always null: a link watches the whole Google deck. Pasted urls
     routinely carry a leftover #slide=id.… fragment from wherever they were
     copied, and honouring that would silently narrow the watch to one page and
     stay quiet while every other page changed. */
  async function attach(cfg) {
    var p = parse(cfg.url);
    if (!p) throw new Error('That does not look like a Google Slides link.');
    var u = await sb().auth.getUser();
    var row = {
      scope: cfg.scope, deck_key: String(cfg.deckKey), slide_key: String(cfg.slideKey || ''),
      file_id: p.fileId, page_id: null, source_url: String(cfg.url).trim(),
      label: cfg.label || null,
      created_by: (u && u.data && u.data.user && u.data.user.id) || null,
    };
    var res = await sb().from('gslides_links')
      .upsert(row, { onConflict: 'scope,deck_key,slide_key' }).select().maybeSingle();
    if (res.error) throw new Error(res.error.message);
    return res.data;
  }

  async function detach(linkId) {
    var res = await sb().from('gslides_links').delete().eq('id', linkId);
    if (res.error) throw new Error(res.error.message);
  }

  /* "3 Aug, 2:04 PM" */
  function whenText(d) {
    if (!d) return '';
    try {
      return d.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  window.PP_GSW = {
    parse: parse, pageUrl: pageUrl, load: load, emptyState: emptyState,
    stampFor: stampFor, isFlagged: isFlagged, changesFor: changesFor, changedAt: changedAt,
    markSeen: markSeen, flaggedCount: flaggedCount, attach: attach, detach: detach,
    whenText: whenText,
  };
})();
