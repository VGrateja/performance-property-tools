/* Paste this whole file into the dev console while the Presentation
   tool (tools/presentation.html) is open in your browser. It uses
   the already-loaded window.sb client + your authenticated session
   to read the cloud row and print sizes; also prints localStorage
   sizes for the same keys. ASCII-only so copy-paste can't mangle. */

(async function () {
  function sz(s) { return new Blob([s == null ? "" : s]).size; }
  function fmt(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(3) + " MB";
  }
  function pad(s, n) { s = String(s); while (s.length < n) s = " " + s; return s; }

  // ===== localStorage =====
  console.log("=== localStorage ===");
  var lsKeys = [
    "ppa-presentation-custom-decks-v1",
    "ppa-presentation-overlays-v1",
    "ppa-presentation-slide-bgs-v1",
    "ppa-presentation-themes-v1",
    "ppa-presentation-active-theme-v1"
  ];
  var lsTotal = 0;
  for (var i = 0; i < lsKeys.length; i++) {
    var k = lsKeys[i];
    var b = sz(localStorage.getItem(k));
    lsTotal += b;
    console.log(" ", pad(fmt(b), 12), k);
  }
  console.log(" ", pad(fmt(lsTotal), 12), "TOTAL localStorage");

  // ===== cloud =====
  if (!window.sb) {
    console.warn("window.sb not found - are you on the Presentation tool page?");
    return;
  }
  var resp = await window.sb
    .from("presentation_state")
    .select("payload")
    .eq("id", 1)
    .single();
  if (resp.error) {
    console.warn("cloud read error:", resp.error);
    return;
  }
  var p = resp.data.payload;

  console.log("\n=== cloud presentation_state row ===");
  var totalCloud = sz(JSON.stringify(p));
  console.log(" ", pad(fmt(totalCloud), 12), "TOTAL payload");
  var topKeys = Object.keys(p);
  for (var j = 0; j < topKeys.length; j++) {
    var tk = topKeys[j];
    console.log(" ", pad(fmt(sz(JSON.stringify(p[tk]))), 12), tk);
  }

  // ===== per deck =====
  console.log("\n=== per-deck (cloud) ===");
  var decks = p.customDecks || [];
  for (var d = 0; d < decks.length; d++) {
    var deck = decks[d];
    var slides = (deck.slides || []).length;
    console.log(
      " ",
      pad(fmt(sz(JSON.stringify(deck))), 12),
      "slides=" + pad(slides, 3),
      deck.id,
      "-",
      deck.title || "(untitled)"
    );
  }

  // ===== heaviest overlay slide keys =====
  console.log("\n=== top 10 heaviest overlay slide keys ===");
  var ov = p.overlays || {};
  var rows = [];
  var ovKeys = Object.keys(ov);
  for (var m = 0; m < ovKeys.length; m++) {
    rows.push([ovKeys[m], sz(JSON.stringify(ov[ovKeys[m]]))]);
  }
  rows.sort(function (a, b) { return b[1] - a[1]; });
  for (var n = 0; n < Math.min(10, rows.length); n++) {
    console.log(" ", pad(fmt(rows[n][1]), 12), rows[n][0]);
  }

  // ===== heaviest single overlays inside those slide keys =====
  console.log("\n=== top 10 heaviest individual overlays ===");
  var items = [];
  for (var q = 0; q < ovKeys.length; q++) {
    var list = ov[ovKeys[q]] || [];
    for (var r = 0; r < list.length; r++) {
      items.push({
        slideKey: ovKeys[q],
        type: list[r] && list[r].type,
        bytes: sz(JSON.stringify(list[r]))
      });
    }
  }
  items.sort(function (a, b) { return b.bytes - a.bytes; });
  for (var t = 0; t < Math.min(10, items.length); t++) {
    console.log(
      " ",
      pad(fmt(items[t].bytes), 12),
      pad(items[t].type || "?", 8),
      items[t].slideKey
    );
  }
})();
