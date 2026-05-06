/* ============================================================================
 * Clock state proxy — keeps the JSONBin master key off the client.
 *
 *   GET  /.netlify/functions/clock-state   → latest clock state (public read)
 *   PUT  /.netlify/functions/clock-state   → overwrite clock state
 *                                            (requires Authorization header)
 *
 * Env vars (set in Netlify → Site settings → Environment variables):
 *   JSONBIN_BIN_ID       The bin ID (e.g. 69cb4c28aaba882197acf312)
 *   JSONBIN_MASTER_KEY   The JSONBin master key (never exposed to the browser)
 *   CLOCK_WRITE_SECRET   Random string; must match the token the clock page
 *                        sends in the "Authorization: Bearer <token>" header.
 *
 * Node 18+ provides a built-in fetch, so no dependencies are required.
 * ========================================================================== */

const BIN_ID       = process.env.JSONBIN_BIN_ID;
const MASTER_KEY   = process.env.JSONBIN_MASTER_KEY;
const WRITE_SECRET = process.env.CLOCK_WRITE_SECRET;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store",
};

function reply(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: JSON_HEADERS, body: "" };
  }

  if (!BIN_ID || !MASTER_KEY) {
    return reply(500, { error: "Server misconfigured: JSONBIN_BIN_ID or JSONBIN_MASTER_KEY env var is missing." });
  }

  const binUrl = "https://api.jsonbin.io/v3/b/" + BIN_ID;

  if (event.httpMethod === "GET") {
    try {
      const res = await fetch(binUrl + "/latest", {
        headers: { "X-Master-Key": MASTER_KEY },
      });
      const body = await res.text();
      return {
        statusCode: res.status,
        headers: JSON_HEADERS,
        body,
      };
    } catch (e) {
      return reply(502, { error: "Upstream GET failed", detail: String(e && e.message || e) });
    }
  }

  if (event.httpMethod === "PUT") {
    if (!WRITE_SECRET) {
      return reply(503, { error: "Writes disabled: CLOCK_WRITE_SECRET env var is not set." });
    }
    const auth = event.headers.authorization || event.headers.Authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (token !== WRITE_SECRET) {
      return reply(401, { error: "Unauthorized" });
    }
    if (!event.body) {
      return reply(400, { error: "Missing request body" });
    }
    // Sanity-check: body must be valid JSON so we don't blindly push junk.
    try { JSON.parse(event.body); }
    catch (_) { return reply(400, { error: "Body is not valid JSON" }); }

    try {
      const res = await fetch(binUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Master-Key": MASTER_KEY,
          "X-Bin-Versioning": "false",
        },
        body: event.body,
      });
      const body = await res.text();
      return {
        statusCode: res.status,
        headers: JSON_HEADERS,
        body,
      };
    } catch (e) {
      return reply(502, { error: "Upstream PUT failed", detail: String(e && e.message || e) });
    }
  }

  return reply(405, { error: "Method not allowed" });
};
