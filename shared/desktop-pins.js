/* ============================================================================
 * Desktop pins store — the user's personal pinned-shortcut layout on the
 * Performance OS hub. Shared by the hub (which renders + arranges the pins)
 * and, from Phase 2, the tools (a "Pin to desktop" button writes a deep-link
 * pin here — e.g. a specific region report or deck).
 *
 * Source of truth is Supabase (public.desktop_pins — one row per user, RLS
 * scoped to the owner) so pins FOLLOW THE USER across devices. A localStorage
 * mirror (key pp-desktop-pins) gives instant paint and keeps working before
 * the migration is applied / when offline. Every Supabase call is best-effort
 * and never throws into the caller.
 *
 * Pin object:
 *   { id, kind:'tool'|'link', sec, n, label, url, a1, a2, icon, col, row }
 *
 * API (window.PP_PINS):
 *   .get()             -> current pins array (cached copy, synchronous)
 *   .has(pred)         -> bool
 *   .load()            -> paint from cache now + refresh from Supabase async
 *   .add(pin)          -> add (auto id), persist, notify
 *   .remove(id)        -> remove, persist, notify
 *   .update(id, patch) -> patch a pin (e.g. {col,row}), persist (debounced), notify
 *   .onChange(cb)      -> subscribe; returns an unsubscribe fn
 * ========================================================================== */
(function () {
  'use strict';

  var LS_KEY = 'pp-desktop-pins';
  var pins = [];
  var listeners = [];
  var saveTimer = null;

  function readLocal() {
    try { var s = localStorage.getItem(LS_KEY); var a = s ? JSON.parse(s) : []; return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function writeLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(pins)); } catch (e) {} }
  function notify() { listeners.forEach(function (cb) { try { cb(pins.slice()); } catch (e) {} }); }

  async function userId() {
    try {
      if (!window.sb || !window.sb.auth) return null;
      var r = await window.sb.auth.getSession();
      return (r && r.data && r.data.session && r.data.session.user && r.data.session.user.id) || null;
    } catch (e) { return null; }
  }

  async function pushRemote() {
    try {
      var uid = await userId();
      if (!uid || !window.sb) return;
      await window.sb.from('desktop_pins')
        .upsert({ user_id: uid, pins: pins, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    } catch (e) { /* table not applied yet / offline — the localStorage mirror still holds */ }
  }

  async function refreshRemote() {
    try {
      var uid = await userId();
      if (!uid || !window.sb) return;
      var r = await window.sb.from('desktop_pins').select('pins').eq('user_id', uid).maybeSingle();
      if (r && !r.error && r.data && Array.isArray(r.data.pins)) {
        pins = r.data.pins; writeLocal(); notify();
      }
    } catch (e) { /* keep local */ }
  }

  function persist() {
    writeLocal();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushRemote, 400);   // debounce (covers a drag)
  }

  /* re-pull from Supabase when a session appears (e.g. logging in on a new
     machine) so cross-device pins land without a manual reload */
  try {
    if (window.sb && window.sb.auth && window.sb.auth.onAuthStateChange) {
      window.sb.auth.onAuthStateChange(function (evt) {
        if (evt === 'SIGNED_IN' || evt === 'INITIAL_SESSION' || evt === 'TOKEN_REFRESHED') refreshRemote();
      });
    }
  } catch (e) {}

  window.PP_PINS = {
    get: function () { return pins.slice(); },
    has: function (pred) { return pins.some(pred); },
    onChange: function (cb) {
      listeners.push(cb);
      return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    add: function (pin) {
      if (!pin) return null;
      if (!pin.id) pin.id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      pins.push(pin); persist(); notify();
      return pin;
    },
    remove: function (id) {
      var before = pins.length;
      pins = pins.filter(function (p) { return p.id !== id; });
      if (pins.length !== before) { persist(); notify(); }
    },
    update: function (id, patch) {
      var hit = false;
      pins = pins.map(function (p) { if (p.id === id) { hit = true; return Object.assign({}, p, patch); } return p; });
      if (hit) { persist(); notify(); }
    },
    load: function () { pins = readLocal(); notify(); refreshRemote(); }
  };
})();
