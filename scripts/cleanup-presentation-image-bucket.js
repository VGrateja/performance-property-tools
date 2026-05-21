/* Paste this into the dev console while the Presentation tool is open
   and you're signed in as dev/admin tier. Finds files in the
   `presentation-images` bucket that no overlay references anymore
   (left behind because we intentionally don't auto-delete on
   overlay-remove — preserving undo) and deletes them.

   Safe to run periodically. Idempotent: a second run finds zero
   orphans. Output lists every deleted path + the total bytes
   reclaimed in the bucket. */

(async function () {
  function fmt(b) {
    if (b == null) return "?";
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(3) + " MB";
  }

  if (!window.sb || !window.sb.storage) {
    console.warn("window.sb missing - are you on the Presentation tool page?");
    return;
  }

  /* Build the set of paths actively referenced by any overlay's
     o.storage field — anything else in the bucket is an orphan. */
  var resp = await window.sb
    .from("presentation_state")
    .select("payload")
    .eq("id", 1)
    .single();
  if (resp.error) { console.warn("cloud read error:", resp.error); return; }
  var overlays = (resp.data && resp.data.payload && resp.data.payload.overlays) || {};
  var referenced = new Set();
  Object.keys(overlays).forEach(function (k) {
    (overlays[k] || []).forEach(function (o) {
      if (o && o.type === "image" && o.storage) referenced.add(o.storage);
    });
  });
  console.log("=== Presentation image bucket cleanup ===");
  console.log("Referenced paths in payload:", referenced.size);

  /* List the bucket. Storage doesn't have a recursive list, so we
     walk: list "" (top level — should be deck-id folders), then
     list each folder. Limit 1000 per page is the default; bump if
     you ever exceed it (1000 deck-images is already plenty). */
  var bucketRoot = await window.sb.storage
    .from("presentation-images")
    .list("", { limit: 1000 });
  if (bucketRoot.error) { console.warn("bucket list error:", bucketRoot.error); return; }
  var topEntries = bucketRoot.data || [];
  /* Storage represents folders as entries with id == null. Files
     have id and metadata.size populated. */
  var deckFolders = topEntries.filter(function (e) { return e && e.id == null; });
  console.log("Deck folders found:", deckFolders.length);

  var allFiles = [];
  for (var i = 0; i < deckFolders.length; i++) {
    var folderName = deckFolders[i].name;
    var inFolder = await window.sb.storage
      .from("presentation-images")
      .list(folderName, { limit: 1000 });
    if (inFolder.error) {
      console.warn("list error for folder", folderName, inFolder.error);
      continue;
    }
    (inFolder.data || []).forEach(function (e) {
      if (e && e.id != null) {
        allFiles.push({
          path: folderName + "/" + e.name,
          size: (e.metadata && e.metadata.size) || 0,
        });
      }
    });
  }
  console.log("Total files in bucket:", allFiles.length);

  var orphans = allFiles.filter(function (f) { return !referenced.has(f.path); });
  if (orphans.length === 0) {
    console.log("No orphan files. Bucket is clean.");
    return;
  }

  var totalBytes = 0;
  console.log("\nOrphan files to delete:");
  orphans.forEach(function (f) {
    console.log(" ", f.path.padEnd(60), fmt(f.size));
    totalBytes += f.size;
  });
  console.log("\nTotal bytes to reclaim:", fmt(totalBytes));

  /* Batch delete — storage client takes an array of paths. */
  var paths = orphans.map(function (f) { return f.path; });
  var del = await window.sb.storage
    .from("presentation-images")
    .remove(paths);
  if (del.error) {
    console.error("Bucket delete failed:", del.error);
    return;
  }
  console.log("\nDeleted", orphans.length, "file(s). Bucket reclaimed", fmt(totalBytes), ".");
})();
