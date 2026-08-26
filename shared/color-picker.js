/* ─── Shared colour swatch picker ────────────────────────────────
   Auto-attaches to every <input type="color"> on the page and
   replaces it with a circular swatch button. Clicking the button
   opens a popover with two sections:
     1. Presets — fixed palette of 24 common colours
     2. Recently Used — last 16 colours the user has picked,
        persisted in localStorage under "ppa-recent-colors" so the
        list flows between tools.
   A "Custom…" footer button still opens the OS-native colour
   dialog for one-off precise picks.

   Existing tool code that listens to `input`/`change` events on the
   colour input keeps working unchanged — when the user picks a
   swatch we set input.value and dispatch both events. The native
   <input type="color"> stays in the DOM (off-screen) so the
   Custom… button can still call .click() on it. */

(function () {
  'use strict';

  /* 24 presets — neutrals, vibrant primaries, brand cyans/blues. */
  var PRESETS = [
    '#000000','#424242','#757575','#9E9E9E','#BDBDBD','#E0E0E0','#F5F5F5','#FFFFFF',
    '#E53935','#FB8C00','#FDD835','#43A047','#00ACC1','#1E88E5','#3949AB','#8E24AA',
    '#00B6CB','#5CC8E0','#0090A8','#0F2B38','#142036','#0A1520','#1F546D','#142230'
  ];
  var STORE_KEY  = 'ppa-recent-colors';
  var RECENT_CAP = 16;

  function getRecents() {
    try {
      var arr = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function pushRecent(hex) {
    if (typeof hex !== 'string') return;
    hex = hex.toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    var arr = getRecents().filter(function (h) { return h !== hex; });
    arr.unshift(hex);
    if (arr.length > RECENT_CAP) arr = arr.slice(0, RECENT_CAP);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  var _activePopover = null;
  function closePopover() {
    if (_activePopover) {
      _activePopover.remove();
      _activePopover = null;
    }
  }

  function makeCell(hex, input, currentLower) {
    var cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'pp-swatch-cell';
    var lower = hex.toLowerCase();
    cell.dataset.hex = lower;
    cell.style.background = hex;
    cell.title = hex;
    if (currentLower && currentLower === lower) {
      cell.classList.add('is-current');
    }
    cell.addEventListener('click', function (ev) {
      ev.stopPropagation();
      input.value = hex;
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      pushRecent(hex);
      closePopover();
    });
    return cell;
  }

  function openPopover(anchor, input) {
    closePopover();
    var pop = document.createElement('div');
    pop.className = 'pp-swatch-popover';
    pop.innerHTML =
      '<div class="pp-swatch-section">' +
        '<div class="pp-swatch-label">Presets</div>' +
        '<div class="pp-swatch-grid pp-swatch-grid-presets"></div>' +
      '</div>' +
      '<div class="pp-swatch-section pp-swatch-recents-section">' +
        '<div class="pp-swatch-label">Recently Used</div>' +
        '<div class="pp-swatch-grid pp-swatch-grid-recents"></div>' +
      '</div>' +
      '<div class="pp-swatch-hex-row">' +
        '<span class="pp-swatch-hex-label">Hex</span>' +
        '<input type="text" class="pp-swatch-hex-input" maxlength="7" spellcheck="false" autocomplete="off" placeholder="#000000">' +
      '</div>' +
      '<button type="button" class="pp-swatch-custom">Custom…</button>';
    document.body.appendChild(pop);
    _activePopover = pop;

    /* Stop clicks inside the swatch popover from reaching document-
       level outside-click handlers on parent popovers (e.g. the
       Presentation tool's cell-popover and bg-editor both close
       themselves on document clicks/mousedowns that fall outside
       their own DOM). Without this, picking a colour would also
       close the parent panel. mousedown stops bgEditor; click
       stops cellPopover. */
    pop.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    pop.addEventListener('click',     function (e) { e.stopPropagation(); });

    var current = (input.value || '').toLowerCase();
    var presetsGrid = pop.querySelector('.pp-swatch-grid-presets');
    PRESETS.forEach(function (hex) {
      presetsGrid.appendChild(makeCell(hex, input, current));
    });

    var recents = getRecents();
    var recentsGrid    = pop.querySelector('.pp-swatch-grid-recents');
    var recentsSection = pop.querySelector('.pp-swatch-recents-section');
    if (recents.length === 0) {
      recentsSection.style.display = 'none';
    } else {
      recents.forEach(function (hex) {
        recentsGrid.appendChild(makeCell(hex, input, current));
      });
    }

    /* Hex input — Enter (or blur with a valid hex) applies + closes.
       Accepts #abc / #aabbcc / abc / aabbcc, normalises to lowercase
       6-digit. Invalid input is silently ignored on blur; keeps the
       picker open so the user can correct it. */
    var hexInput = pop.querySelector('.pp-swatch-hex-input');
    hexInput.value = current || '';
    function _normalizeHex(raw) {
      if (typeof raw !== 'string') return null;
      var s = raw.trim().toLowerCase();
      if (s.charAt(0) !== '#') s = '#' + s;
      if (/^#[0-9a-f]{3}$/.test(s)) {
        s = '#' + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2) + s.charAt(3) + s.charAt(3);
      }
      return /^#[0-9a-f]{6}$/.test(s) ? s : null;
    }
    /* One commit per popover. Enter commits and closes the popover, and
       removing it blurs this very field, whose blur handler commits AGAIN —
       so every hex typed here used to fire input/change twice. Harmless
       when both landed on the same whole box; wrong once a consumer acts
       on the first event only (presentation.html replays a stashed text
       selection on the first and would paint the whole box on the second),
       and the re-entrant close threw a removeChild error in the tool. */
    var committed = false;
    function _commitHex() {
      if (committed) return false;
      var hex = _normalizeHex(hexInput.value);
      if (!hex) return false;
      committed = true;
      input.value = hex;
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      pushRecent(hex);
      closePopover();
      return true;
    }
    hexInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); _commitHex(); }
    });
    hexInput.addEventListener('blur', function () { _commitHex(); });

    pop.querySelector('.pp-swatch-custom').addEventListener('click', function (ev) {
      ev.stopPropagation();
      /* Native colour-picker fallback. The hidden source input has
         CSS that some browsers consider too "uninteractable" to fire
         the OS dialog from a programmatic .click(). The reliable
         pattern is to spawn a fresh, lightly-styled <input type="color">
         and click that — its events forward back to the source input
         so all existing handlers fire as if the source were used. */
      var tmp = document.createElement('input');
      tmp.type = 'color';
      /* Mark BEFORE inserting into DOM so the MutationObserver-driven
         auto-attach skips this throwaway. Without this, the observer
         hides it (display:none) and inserts a swatch button next to
         it — leaving a stray circle at top-left and stopping the OS
         picker from ever opening. */
      tmp.setAttribute('data-pp-swatch-skip', 'true');
      var cur = input.value;
      tmp.value = (cur && /^#[0-9a-f]{6}$/i.test(cur)) ? cur : '#000000';
      tmp.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;' +
                          'border:0;padding:0;margin:0;opacity:0;';
      document.body.appendChild(tmp);

      tmp.addEventListener('input', function () {
        input.value = tmp.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      tmp.addEventListener('change', function () {
        input.value = tmp.value;
        input.dispatchEvent(new Event('input',  { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        pushRecent(tmp.value);
        tmp.remove();
        closePopover();
      });
      /* Clean up if the dialog closes without committing — some
         browsers fire blur, others don't fire anything. Belt-and-
         braces: a delayed remove if no change has happened. */
      tmp.addEventListener('blur', function () {
        setTimeout(function () { if (tmp.parentNode) tmp.remove(); }, 250);
      });

      try { tmp.click(); } catch (e) {}
    });

    /* Position: anchored below the trigger, clamped to viewport so
       it never falls off-screen. */
    var rect = anchor.getBoundingClientRect();
    pop.style.top  = (rect.bottom + 6) + 'px';
    pop.style.left = rect.left + 'px';
    requestAnimationFrame(function () {
      var popRect = pop.getBoundingClientRect();
      if (popRect.right > window.innerWidth - 8) {
        pop.style.left = Math.max(8, window.innerWidth - popRect.width - 8) + 'px';
      }
      if (popRect.bottom > window.innerHeight - 8) {
        var above = rect.top - popRect.height - 6;
        pop.style.top = (above >= 8 ? above : 8) + 'px';
      }
    });
  }

  function attach(input) {
    if (input._ppaSwatchAttached) return;
    /* Inputs flagged data-pp-swatch-skip are throwaway helpers
       (e.g. the Custom… fallback's native picker host) — leave them
       alone so the browser doesn't refuse to open the OS dialog
       because the input is display:none. */
    if (input.hasAttribute('data-pp-swatch-skip')) return;
    input._ppaSwatchAttached = true;
    input.classList.add('pp-swatch-hidden-input');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-swatch-btn';
    btn.style.background = input.value || '#000000';
    btn.title = 'Choose colour';
    btn.setAttribute('aria-label', 'Choose colour');
    /* Insert the trigger right before the input so it slots into
       the existing flex layout (where the native colour box was). */
    if (input.parentNode) input.parentNode.insertBefore(btn, input);

    /* Keep the swatch in sync with programmatic value changes —
       existing tool code that does `colorEl.value = '#xxx'` then
       fires events still updates the visible swatch. */
    var sync = function () { btn.style.background = input.value; };
    input.addEventListener('input',  sync);
    input.addEventListener('change', sync);

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openPopover(btn, input);
    });
  }

  function attachAll(root) {
    (root || document).querySelectorAll('input[type="color"]').forEach(attach);
  }

  /* Outside-click + Escape close the popover. Capture-phase so we
     run before any tool's own click handlers; the .pp-swatch-btn
     check exempts the button itself so re-clicking the same swatch
     doesn't immediately close + reopen, and clicking a *different*
     swatch button hands off cleanly. */
  document.addEventListener('click', function (ev) {
    if (!_activePopover) return;
    var t = ev.target;
    if (_activePopover.contains(t)) return;
    if (t && t.classList && t.classList.contains('pp-swatch-btn')) return;
    closePopover();
  }, true);
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && _activePopover) closePopover();
  });

  /* Catch <input type="color"> elements inserted dynamically (e.g.
     editor panels rendered after first paint). */
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (!node || node.nodeType !== 1) continue;
          if (node.matches && node.matches('input[type="color"]')) attach(node);
          if (node.querySelectorAll) attachAll(node);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { attachAll(); });
  } else {
    attachAll();
  }

  window.PP_ColorPicker = {
    attachAll: attachAll,
    attach: attach,
    getRecents: getRecents,
    pushRecent: pushRecent
  };
})();
