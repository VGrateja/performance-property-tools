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

   A link may target ONE Google page (url carried #slide=id.<objectId>) or the
   whole deck. A page-targeted link only lights up when THAT page changes, which
   is what makes a per-hub-slide mark meaningful.

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

  /* The stamp this link is watching: one page's fingerprint, or the whole deck's.
     A page that has vanished from the Google deck gets its own stamp so the loss
     is reported once and can then be acknowledged. */
  function stampFor(link, file) {
    if (!file) return null;
    if (link.page_id) {
      var h = (file.page_hashes || {})[link.page_id];
      return h ? h : 'gone:' + link.page_id;
    }
    return file.content_stamp || null;
  }

  function isFlagged(link, state) {
    if (!link || !state) return false;
    var file = state.files[link.file_id];
    if (!file) return false;                       // never polled yet — say nothing
    var stamp = stampFor(link, file);
    if (!stamp) return false;
    var seen = state.seen[link.id];
    /* the page this link points at is gone from the Google deck — report once */
    if (stamp.indexOf('gone:') === 0) return seen !== stamp;
    if (!file.last_changed_at) return false;       // seeded, never changed since
    if (!link.page_id) return seen !== stamp;      // whole-deck link: any change counts

    /* PAGE-SCOPED link. "Never acknowledged" is not evidence that THIS page
       moved — without this guard every page-scoped link on a deck lights up
       the moment any single page changes. So on a first sighting we trust the
       monitor's own changed_pages list; once the user HAS acknowledged a
       version of this page, a differing hash is proof enough on its own. */
    if (seen === undefined) {
      return (file.changed_pages || []).some(function (c) { return c.objectId === link.page_id; });
    }
    return seen !== stamp;
  }

  function changesFor(link, state) {
    var file = state && state.files[link.file_id];
    if (!file) return [];
    var all = (file.changed_pages || []).slice();
    if (link.page_id) {
      var mine = all.filter(function (c) { return c.objectId === link.page_id; });
      if (!mine.length && !(file.page_hashes || {})[link.page_id]) {
        mine = [{ objectId: link.page_id, index: 0, title: '', kind: 'removed' }];
      }
      all = mine;
    }
    return all.map(function (c) {
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

  /* cfg.ignorePage — treat the url's #slide= fragment as INCIDENTAL and watch the
     whole deck. A library card's url often carries whatever slide the author had
     open when they copied it; honouring that would scope the card to page 1 and
     it would then stay silent while pages 3 and 7 changed. A hand-attached
     per-slide link is the opposite: there the fragment is the whole point. */
  async function attach(cfg) {
    var p = parse(cfg.url);
    if (!p) throw new Error('That does not look like a Google Slides link.');
    var u = await sb().auth.getUser();
    var row = {
      scope: cfg.scope, deck_key: String(cfg.deckKey), slide_key: String(cfg.slideKey || ''),
      file_id: p.fileId, page_id: cfg.ignorePage ? null : p.pageId, source_url: String(cfg.url).trim(),
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
