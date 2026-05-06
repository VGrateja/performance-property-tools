/* ============================================================================
 * Users state proxy — registration, password verification, admin approval.
 *
 * Single JSONBin holds the full users array. The function is the ONLY path
 * to user data; the JSONBin master key never leaves Netlify env vars. By
 * keeping all auth checks server-side, the client never sees password
 * hashes — `password` is stripped from every GET response.
 *
 *   GET  /.netlify/functions/users
 *        → { users: [...] }   public read, used by the admin pending list
 *                              and the cache-refresh on login. Password
 *                              field is REDACTED.
 *
 *   POST /.netlify/functions/users
 *        body: { action: 'register', user: { email, firstName, password,
 *                                            role: 'client'|'guest' } }
 *        → { ok: true }       public, appends a new user record. Server:
 *                              - bcrypts the password (cost 10)
 *                              - assigns a UUID
 *                              - sets status='pending' for client,
 *                                'active' for guest
 *                              - stamps createdAt + updatedAt
 *
 *   POST /.netlify/functions/users
 *        body: { action: 'verify-password', email, password }
 *        → 200 { ok: true,  user: {id, email, firstName, role, status, ...} }
 *          403 { ok: false, error: 'pending', user: { ... } }   credentials
 *                                                                match but
 *                                                                pending
 *          401 { ok: false, error: 'Invalid credentials' }      no user OR
 *                                                                wrong pw
 *
 *   POST /.netlify/functions/users
 *        body: { action: 'approve'|'reject', email }
 *        Authorization: Bearer <USERS_ADMIN_SECRET>
 *        → { ok: true, user? }
 *
 * Env vars (Netlify → Site settings → Environment variables):
 *   JSONBIN_MASTER_KEY     Same master key the other functions use.
 *   JSONBIN_USERS_BIN_ID   The single bin holding { users: [...] }.
 *   USERS_ADMIN_SECRET     Random string. Required for approve/reject.
 *                           Must match USERS_ADMIN_TOKEN in shared/auth.js.
 *
 * Schema migration note:
 *   Pre-2026-04-29 records were base64-only and had no id/updatedAt.
 *   verifyPassword() detects legacy base64 hashes (no $2 prefix) and
 *   accepts them ONCE — re-writing the record with bcrypt + UUID +
 *   updatedAt on a successful legacy login. After every legacy account
 *   has signed in once, the data set is fully bcrypt and UUID'd.
 *
 * Node 18+ provides built-in fetch and crypto.randomUUID.
 * ========================================================================== */

const bcrypt = require("bcryptjs");
const { randomUUID } = require("crypto");

const MASTER_KEY   = process.env.JSONBIN_MASTER_KEY;
const BIN_ID       = process.env.JSONBIN_USERS_BIN_ID;
const ADMIN_SECRET = process.env.USERS_ADMIN_SECRET;

const BCRYPT_COST  = 10;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store",
};

function reply(statusCode, payload) {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

async function loadUsers() {
  const res = await fetch("https://api.jsonbin.io/v3/b/" + BIN_ID + "/latest", {
    headers: { "X-Master-Key": MASTER_KEY },
  });
  if (!res.ok) {
    throw new Error("JSONBin GET failed (" + res.status + ")");
  }
  const data = await res.json();
  return data && data.record && Array.isArray(data.record.users)
    ? data.record.users
    : [];
}

async function saveUsers(users) {
  const res = await fetch("https://api.jsonbin.io/v3/b/" + BIN_ID, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": MASTER_KEY,
      "X-Bin-Versioning": "false",
    },
    body: JSON.stringify({ users }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("JSONBin PUT failed (" + res.status + "): " + text);
  }
}

function bearerToken(event) {
  const auth = event.headers.authorization || event.headers.Authorization || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

/* Strip password from every record before sending to the client. */
function publicUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
}

/* Detect bcrypt vs legacy base64 hashes. Bcrypt outputs always start with
   $2a$, $2b$, $2x$, or $2y$. Anything else is the legacy btoa() format. */
function isBcrypt(hash) {
  return typeof hash === "string" && /^\$2[abxy]\$/.test(hash);
}

/* Legacy base64 verify — mirrors the old client-side hashPW(): the
   stored value is btoa(encodeURIComponent(password)). */
function legacyMatch(plain, stored) {
  try {
    const expected = Buffer.from(encodeURIComponent(plain)).toString("base64");
    return expected === stored;
  } catch { return false; }
}

async function verifyPassword(plain, stored) {
  if (!plain || !stored) return false;
  if (isBcrypt(stored)) return bcrypt.compare(plain, stored);
  /* Legacy account — falls through to base64. Caller is expected to
     re-hash with bcrypt after a successful legacy verify. */
  return legacyMatch(plain, stored);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: JSON_HEADERS, body: "" };
  }
  if (!MASTER_KEY || !BIN_ID) {
    return reply(500, { error: "Server misconfigured: JSONBIN_MASTER_KEY or JSONBIN_USERS_BIN_ID env var is missing." });
  }

  /* ── Public read — passwords REDACTED ─────────────────────────── */
  if (event.httpMethod === "GET") {
    try {
      const users = await loadUsers();
      return reply(200, { users: users.map(publicUser) });
    } catch (e) {
      return reply(502, { error: "Upstream GET failed", detail: String(e && e.message || e) });
    }
  }

  /* ── POST — action-routed ─────────────────────────────────────── */
  if (event.httpMethod === "POST") {
    if (!event.body) return reply(400, { error: "Missing body" });
    let body;
    try { body = JSON.parse(event.body); }
    catch { return reply(400, { error: "Invalid JSON" }); }

    const action = body.action;

    /* register — public. Hashes the password server-side. */
    if (action === "register") {
      const u = body.user || {};
      const email = String(u.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) return reply(400, { error: "Invalid email" });
      if (!u.password || String(u.password).length < 6) return reply(400, { error: "Password must be at least 6 characters" });
      if (!u.firstName) return reply(400, { error: "Missing firstName" });
      const role = u.role === "client" ? "client" : "guest";

      try {
        const users = await loadUsers();
        if (users.find(x => x.email === email)) {
          return reply(409, { error: "An account with this email already exists." });
        }
        const now = new Date().toISOString();
        const hashed = await bcrypt.hash(String(u.password), BCRYPT_COST);
        users.push({
          id: randomUUID(),
          email,
          firstName: String(u.firstName).trim(),
          password: hashed,
          role,
          status: role === "client" ? "pending" : "active",
          createdAt: now,
          updatedAt: now,
        });
        await saveUsers(users);
        return reply(200, { ok: true });
      } catch (e) {
        return reply(502, { error: "Registration failed", detail: String(e && e.message || e) });
      }
    }

    /* verify-password — public. Single source of truth for credential
       checks. Uses constant-ish work via bcrypt.compare regardless of
       whether the email exists, to dampen email-enumeration timing. */
    if (action === "verify-password") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!email || !password) return reply(400, { error: "Missing email or password" });
      try {
        const users = await loadUsers();
        const i = users.findIndex(x => x.email === email);
        if (i < 0) {
          /* Burn a bcrypt cycle so timing matches the "real user" path. */
          await bcrypt.compare(password, "$2b$10$0000000000000000000000000000000000000000000000000000aaa");
          return reply(401, { error: "Invalid email or password" });
        }
        const user = users[i];
        const ok = await verifyPassword(password, user.password);
        if (!ok) return reply(401, { error: "Invalid email or password" });

        /* Legacy → bcrypt upgrade on successful verify. Also backfills
           id and updatedAt for pre-2026-04-29 records. */
        let mutated = false;
        if (!isBcrypt(user.password)) {
          user.password = await bcrypt.hash(password, BCRYPT_COST);
          mutated = true;
        }
        if (!user.id) { user.id = randomUUID(); mutated = true; }
        if (mutated) {
          user.updatedAt = new Date().toISOString();
          users[i] = user;
          /* Best-effort save — failure here doesn't fail the login. */
          saveUsers(users).catch(err => console.warn("Legacy upgrade save failed:", err));
        }

        if ((user.status || "active") === "pending") {
          return reply(403, { error: "pending", user: publicUser(user) });
        }
        return reply(200, { ok: true, user: publicUser(user) });
      } catch (e) {
        return reply(502, { error: "Verify failed", detail: String(e && e.message || e) });
      }
    }

    /* Privileged actions — admin secret required. */
    if (action === "approve" || action === "reject") {
      if (!ADMIN_SECRET) {
        return reply(503, { error: "Admin actions disabled: USERS_ADMIN_SECRET env var is not set." });
      }
      if (bearerToken(event) !== ADMIN_SECRET) {
        return reply(401, { error: "Unauthorized" });
      }
      const email = String(body.email || "").trim().toLowerCase();
      if (!email) return reply(400, { error: "Missing email" });

      try {
        const users = await loadUsers();
        if (action === "approve") {
          const i = users.findIndex(x => x.email === email);
          if (i < 0) return reply(404, { error: "User not found" });
          users[i] = Object.assign({}, users[i], {
            status: "active",
            updatedAt: new Date().toISOString(),
          });
          /* Backfill id if it's a legacy record being approved. */
          if (!users[i].id) users[i].id = randomUUID();
          await saveUsers(users);
          return reply(200, { ok: true, user: publicUser(users[i]) });
        }
        /* reject = remove the record entirely */
        const filtered = users.filter(x => x.email !== email);
        if (filtered.length === users.length) return reply(404, { error: "User not found" });
        await saveUsers(filtered);
        return reply(200, { ok: true });
      } catch (e) {
        return reply(502, { error: "Mutation failed", detail: String(e && e.message || e) });
      }
    }

    return reply(400, { error: "Unknown action: " + String(action) });
  }

  return reply(405, { error: "Method not allowed" });
};
