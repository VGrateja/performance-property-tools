/* =============================================================================
   shared/copy-link.js  —  PP_COPY_LINK: one "Copy link" click, two clipboard
   flavours.
   -----------------------------------------------------------------------------
   WHY: staff asked (Tommy via Saskia, 2026-09-09) that "Copy link" put a
   clickable document NAME on the clipboard the way Google Sheets does, so an
   email reads "here is the Adelaide report" with Adelaide as the link, instead
   of a naked 200-character Cloud URL. The obvious risk with a rich-text copy is
   that pasting into the browser address bar would then paste the word
   "Adelaide" and go nowhere.

   It does not have to be a choice. The clipboard holds SEVERAL representations
   of one copy at the same time, and each paste target picks the flavour it
   understands:

       text/html   ->  <a href="URL">Adelaide</a>   Gmail, Google Docs/Sheets,
                                                     Slack, Word, Outlook
       text/plain  ->  URL                           address bar, plain inputs,
                                                     terminals, code editors

   So one button is correct in both places and there is nothing for a user to
   pick wrongly.

   USAGE
       PP_COPY_LINK.copy(url, label).then(onCopied, onFailed);

     - Call it SYNCHRONOUSLY from the click handler. Safari only accepts a
       clipboard write while the user gesture is still live and requires the
       ClipboardItem to be constructed inside it, so this module never awaits
       anything before calling navigator.clipboard.write(). Do not `await`
       something else in your handler before calling copy().
     - The returned promise RESOLVES with the mode that succeeded
       ('rich' | 'plain' | 'exec') and REJECTS only when nothing at all could be
       copied. Always pass a rejection handler (an unhandled rejection would
       show up as a console error).
     - label is optional; it defaults to the URL, which degrades to today's
       behaviour rather than to something broken.

   FALLBACK CHAIN (a browser must never end up with nothing, and must never end
   up with the label alone -- a label with no URL is worse than a bare URL):
       1. navigator.clipboard.write() with both flavours     -> 'rich'
       2. navigator.clipboard.writeText(url)                 -> 'plain'
       3. hidden <textarea> + document.execCommand('copy')   -> 'exec'
   Each step also catches a synchronous throw from the step above (Firefox and
   older WebKit have shipped a ClipboardItem constructor that throws for
   text/html), so an unsupported browser still lands a working URL.

   ESCAPING: a document title legitimately contains & < > " ' (e.g. "Buyer's
   Guide: Risk & Return"), and every captured PDF URL contains & in its query
   string. Both are HTML-escaped before they go into the markup, so the href
   survives intact and the label cannot inject tags.

   Only a single http(s)/mailto URL gets an anchor. Anything else -- another
   scheme (javascript:, data:), or a payload carrying whitespace, which means
   it is a block of text and not one link -- is copied as plain text only. A
   "copy every link" button handing its whole list to copy() must not come back
   as one giant broken anchor.
   ============================================================================= */
(function (global) {
  'use strict';

  var ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ENTITIES[c]; });
  }

  function linkable(url) {
    var u = String(url || '').trim();
    return /^(?:https?:|mailto:)/i.test(u) && !/\s/.test(u);   /* one URL, not a list */
  }

  /* The exact text/html payload. Exported so a test can assert it. */
  function buildHtml(url, label) {
    var u = String(url == null ? '' : url).trim();
    var text = String(label == null ? '' : label).trim() || u;
    return '<a href="' + esc(u) + '">' + esc(text) + '</a>';
  }

  function canRich() {
    return !!(global.navigator && global.navigator.clipboard &&
              typeof global.navigator.clipboard.write === 'function' &&
              typeof global.ClipboardItem === 'function');
  }

  /* Step 3 — the pre-async-clipboard trick these tools already used. */
  function execCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, ta.value.length); } catch (_) {}   /* iOS */
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) { return false; }
  }

  function stepExec(url) {
    return execCopy(url) ? Promise.resolve('exec')
                         : Promise.reject(new Error('PP_COPY_LINK: clipboard unavailable'));
  }

  function stepPlain(url) {
    var clip = global.navigator && global.navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      try {
        return clip.writeText(url).then(
          function () { return 'plain'; },
          function () { return stepExec(url); }
        );
      } catch (_) { /* threw synchronously -- fall through */ }
    }
    return stepExec(url);
  }

  /* Rich write. Built and handed over synchronously: Safari drops the write if
     the ClipboardItem is created after an await. Values are Promise-wrapped
     Blobs, which every implementation of the constructor accepts. */
  function stepRich(url, html) {
    var item = new global.ClipboardItem({
      'text/html': Promise.resolve(new Blob([html], { type: 'text/html' })),
      'text/plain': Promise.resolve(new Blob([url], { type: 'text/plain' }))
    });
    return global.navigator.clipboard.write([item]);
  }

  /**
   * Copy a link as BOTH a named hyperlink and the bare URL.
   * @param {string} url    the URL to copy (this is exactly what text/plain gets)
   * @param {string} [label] the name to hyperlink; defaults to the URL
   * @returns {Promise<string>} 'rich' | 'plain' | 'exec'; rejects if nothing copied
   */
  function copy(url, label) {
    var plain = String(url == null ? '' : url).trim();
    if (!plain) return Promise.reject(new Error('PP_COPY_LINK: no url'));
    if (canRich() && linkable(plain)) {
      try {
        return stepRich(plain, buildHtml(plain, label)).then(
          function () { return 'rich'; },
          function () { return stepPlain(plain); }
        );
      } catch (_) { /* constructor rejected the payload -- degrade to plain */ }
    }
    return stepPlain(plain);
  }

  global.PP_COPY_LINK = { copy: copy, html: buildHtml, escape: esc, canRich: canRich, linkable: linkable };
})(typeof window !== 'undefined' ? window : this);
