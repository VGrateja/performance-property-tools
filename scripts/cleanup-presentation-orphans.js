/* Paste this whole file into the dev console while the Presentation
   tool (tools/presentation.html) is open in your browser, with you
   signed in. Uses window.sb (already loaded by the page) so RLS sees
   your session.

   What it does:
     1. Reads the current cloud presentation_state payload.
     2. Builds the set of VALID slide-keys from each customDeck
        (deckId/0 .. deckId/(slides.length-1)).
     3. Finds overlay entries keyed on slide-indices that no longer
        exist on the deck (orphans left behind by past delete-slide
        operations that didn't clean up storage).
     4. Prints what it would delete + the byte savings.
     5. Writes the cleaned payload back: localStorage AND cloud.

   Safe to re-run; idempotent (a second run finds zero orphans). */

(async function () {
  function sz(s) { return new Blob([s == null ? "" : s]).size; }
  function fmt(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(3) + " MB";
  }

  if (!window.sb) {
    console.warn("window.sb missing - are you on the Presentation tool page?");
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
  var payload = resp.data.payload || {};
  var beforeBytes = sz(JSON.stringify(payload));

  var validDecks = {};
  (payload.customDecks || []).forEach(function (d) {
    if (!d || !d.id) return;
    validDecks[d.id] = (d.slides || []).length;
  });
  console.log("Known decks (id : slide-count):");
  Object.keys(validDecks).forEach(function (id) {
    console.log(" ", id, ":", validDecks[id]);
  });

  var overlays = payload.overlays || {};
  var orphans = [];
  Object.keys(overlays).forEach(function (k) {
    var slash = k.lastIndexOf("/");
    if (slash < 0) { orphans.push({ key: k, reason: "malformed-key" }); return; }
    var deckId = k.substring(0, slash);
    var idxStr = k.substring(slash + 1);
    var idx = parseInt(idxStr, 10);
    if (!(deckId in validDecks)) {
      orphans.push({ key: k, reason: "deck-not-found" });
    } else if (!Number.isFinite(idx) || idx < 0 || idx >= validDecks[deckId]) {
      orphans.push({ key: k, reason: "slide-idx-out-of-range (deck has " + validDecks[deckId] + " slides)" });
    }
  });

  if (orphans.length === 0) {
    console.log("No orphan overlay keys found. Nothing to do.");
    return;
  }

  console.log("\nOrphan overlay keys (will be deleted):");
  var freedBytes = 0;
  orphans.forEach(function (o) {
    var b = sz(JSON.stringify(overlays[o.key]));
    freedBytes += b;
    console.log(" ", o.key.padEnd(48), "  ", o.reason, "  ", fmt(b));
  });
  console.log("\nTotal orphan bytes to reclaim:", fmt(freedBytes));
  console.log("Payload size before:", fmt(beforeBytes));
  console.log("Estimated after:   ", fmt(beforeBytes - freedBytes));

  // Build cleaned overlays.
  var cleanedOverlays = {};
  Object.keys(overlays).forEach(function (k) {
    if (!orphans.find(function (o) { return o.key === k; })) {
      cleanedOverlays[k] = overlays[k];
    }
  });
  var cleanedPayload = Object.assign({}, payload, { overlays: cleanedOverlays });
  var afterBytes = sz(JSON.stringify(cleanedPayload));

  // Push to cloud.
  console.log("\nWriting cleaned payload to cloud...");
  var up = await window.sb
    .from("presentation_state")
    .update({ payload: cleanedPayload })
    .eq("id", 1);
  if (up.error) {
    console.error("Cloud update failed:", up.error);
    return;
  }
  console.log("Cloud update OK. New payload size:", fmt(afterBytes));

  // Mirror to localStorage so a refresh doesn't pull the old in-memory
  // state through any cache. We also rewrite the in-memory mirror that
  // the tool reads on boot.
  try {
    localStorage.setItem(
      "ppa-presentation-overlays-v1",
      JSON.stringify(cleanedOverlays)
    );
    console.log("localStorage overlays key updated.");
  } catch (e) {
    console.warn("localStorage write failed:", e);
  }

  console.log(
    "\nDone. Reload the Presentation tool to confirm slides 11-13 now save."
  );
})();
