/* Paste this whole file into the dev console while the Presentation
   tool (tools/presentation.html) is open in your browser, with you
   signed in as dev/admin tier. Uses window.sb (already loaded by
   the page) so the upload + cloud update goes through RLS as you.

   What it does:
     1. Reads the current cloud presentation_state payload.
     2. For every image overlay with an inlined `src` (data: URL) and
        no `storage` field, decodes the data URL to a Blob and uploads
        it to the `presentation-images` bucket at
        `{deckId}/{overlayId}.{ext}`.
     3. Rewrites the overlay record so it carries `storage: <path>`
        and drops the `src` data URL.
     4. Pushes the cleaned payload back to cloud + mirrors to
        localStorage.

   Reports per-overlay progress + total bytes reclaimed at the end.
   Safe to re-run (already-migrated overlays are skipped). */

(async function () {
  function sz(s) { return new Blob([s == null ? "" : s]).size; }
  function fmt(b) {
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
    return (b / 1048576).toFixed(3) + " MB";
  }

  if (!window.sb || !window.sb.storage) {
    console.warn("window.sb missing - are you on the Presentation tool page?");
    return;
  }

  /* Decode a data URL into a Blob the storage client can upload. */
  function dataUrlToBlob(dataUrl) {
    var m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || "");
    if (!m) return null;
    var mime = m[1];
    var bin = atob(m[2]);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /* Pull the current cloud payload — anything we change is pushed
     back in one update at the end so a mid-script error doesn't
     leave the cloud in a half-migrated state. */
  var resp = await window.sb
    .from("presentation_state")
    .select("payload")
    .eq("id", 1)
    .single();
  if (resp.error) { console.warn("cloud read error:", resp.error); return; }
  var payload = resp.data.payload || {};
  var overlays = payload.overlays || {};
  var beforeBytes = sz(JSON.stringify(payload));

  /* Find candidates — every image overlay with a data: src and no
     storage field. Skip already-migrated entries and any overlays
     whose src is already an external URL (shouldn't exist in
     current schema but handled defensively). */
  var candidates = [];
  Object.keys(overlays).forEach(function (slideKey) {
    var slash = slideKey.lastIndexOf("/");
    if (slash < 0) return;
    var deckId = slideKey.substring(0, slash);
    var list = overlays[slideKey] || [];
    list.forEach(function (o) {
      if (!o || o.type !== "image") return;
      if (o.storage) return; /* already migrated */
      if (typeof o.src !== "string" || o.src.indexOf("data:") !== 0) return;
      candidates.push({ deckId: deckId, overlay: o, slideKey: slideKey });
    });
  });

  console.log("=== Presentation image migration ===");
  console.log("Found " + candidates.length + " inlined image(s) to migrate.");
  if (candidates.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  console.log("Payload size before:", fmt(beforeBytes));

  var migrated = 0;
  var failed = 0;
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var o = c.overlay;
    var blob = dataUrlToBlob(o.src);
    if (!blob) {
      console.warn(" ", "[" + (i + 1) + "/" + candidates.length + "]", o.id, "skip - unparseable data URL");
      failed++;
      continue;
    }
    var mime = blob.type || "image/png";
    var ext = (mime.split("/")[1] || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ext === "jpeg") ext = "jpg";
    var path = c.deckId + "/" + o.id + "." + ext;
    try {
      var up = await window.sb.storage
        .from("presentation-images")
        .upload(path, blob, { upsert: true, contentType: mime });
      if (up.error) {
        console.warn(" ", "[" + (i + 1) + "/" + candidates.length + "]", o.id, "upload failed:", up.error.message || up.error);
        failed++;
        continue;
      }
      /* Rewrite in place — drop src, add storage. */
      o.storage = path;
      delete o.src;
      console.log(
        " ",
        "[" + (i + 1) + "/" + candidates.length + "]",
        o.id,
        "->",
        path,
        "(" + fmt(blob.size) + ")"
      );
      migrated++;
    } catch (e) {
      console.warn(" ", "[" + (i + 1) + "/" + candidates.length + "]", o.id, "exception:", e);
      failed++;
    }
  }

  if (migrated === 0) {
    console.log("\nNo images migrated. " + failed + " failed.");
    return;
  }

  /* Push the migrated payload to cloud + mirror locally. */
  console.log("\nWriting migrated payload to cloud...");
  var up2 = await window.sb
    .from("presentation_state")
    .update({ payload: payload })
    .eq("id", 1);
  if (up2.error) {
    console.error("Cloud update failed:", up2.error);
    console.warn("Uploads to the bucket already happened; re-running will skip them.");
    return;
  }
  try {
    localStorage.setItem(
      "ppa-presentation-overlays-v1",
      JSON.stringify(overlays)
    );
  } catch (e) {
    console.warn("localStorage write failed:", e);
  }

  var afterBytes = sz(JSON.stringify(payload));
  console.log("Cloud + localStorage updated.");
  console.log("Migrated:", migrated, "  Failed:", failed);
  console.log("Payload before:", fmt(beforeBytes));
  console.log("Payload after: ", fmt(afterBytes));
  console.log("Reclaimed:     ", fmt(beforeBytes - afterBytes));
  console.log("\nReload the Presentation tool to confirm images still render.");
})();
