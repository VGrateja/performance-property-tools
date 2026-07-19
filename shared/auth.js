/* ============================================================================
 * Performance Property — shared auth module (Supabase edition)
 *
 * Replaces the EmailJS + JSONBin + bcrypt-on-Netlify stack with Supabase Auth.
 *
 * Auth model:
 *   • Tier 0 (dev)       — Vandolf only. Email + password (signInWithPassword).
 *                          Skips OTP for fast admin access.
 *   • Tier 1 (admin)     — saskia / shaene / paul / (vandolf if password blank).
 *                          Email OTP only.
 *   • Tier 2 (company)   — any other @performanceproperty.com.au. Email OTP only.
 *   • Tier 3 (client)    — registers with first name + tickbox. Email OTP.
 *                          status='pending' until an admin approves.
 *   • Tier 4 (guest)     — registers without tickbox. Email OTP, status='active'.
 *
 * Tier + status come from public.profiles (created by the on_auth_user_created
 * trigger — see supabase/migrations/002_trigger_metadata.sql).
 *
 * Loading order on every page that uses this:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="../shared/supabase-client.js"></script>   (or shared/ on hub)
 *   <script src="../shared/auth.js"></script>              (or shared/)
 *
 * Public surface (window.*):
 *   getAuthLevel, getViewAsLevel, getAccessLevel
 *   isDev, isAdmin, isCompany, isClient, isGuest, isLimitedUser, isViewOnly
 *   applyAccessRestrictions, initTierSwitcher
 *   logout, getCurrentUserDisplay, getCurrentUserEmail, showMain
 *   ppListUsers, ppRefreshUsers, ppApproveUser, ppRejectUser
 *   showLoginNotice, clearLoginNotice
 * ============================================================================ */

/* ═══ STATIC CONFIG ═══ */
const ADMIN_EMAILS = [
  'saskia@performanceproperty.com.au',
  'shaene@performanceproperty.com.au',
  'vandolf@performanceproperty.com.au',
  'paul@performanceproperty.com.au'
];
/* DEV_EMAILS auto-reveal the (otherwise hidden) password field on the
   login screen. Email + password sign-in skips OTP entirely.
   Tier is derived from the SQL trigger (admin emails → admin, other
   @performanceproperty.com.au → company), so adding a non-dev address
   here gives that account password-only sign-in at whatever tier the
   trigger assigns. Anyone whose email isn't in this list never sees
   the password field — they go straight to the email-only OTP flow. */
const DEV_EMAILS = [
  'vandolf@performanceproperty.com.au',
  /* Shared internal test account — Tier 2 (company) via the trigger.
     Password is set in Supabase Auth; auth.users.password_hash. */
  'test@performanceproperty.com.au',
  /* Second internal test account — same deal as above. */
  'test2@performanceproperty.com.au'
];

/* Registration master switch. Off per Paul (CEO): this tool is
   internal-only; clients use the separate client-facing product.
   When false:
     • The "New here? Register for viewer access" button on step 1
       is hidden (inline display:none in index.html).
     • The "Account not found → Register here" inline link in
       tryLogin's error path swaps for a plain "contact admin"
       message.
     • Step 3 (the registration form) is still in the DOM but
       unreachable through normal UI.
   To re-enable: flip this to true AND remove the inline display:none
   on the showRegisterBtn wrapper in index.html. */
const REGISTRATION_ENABLED = false;
const ADMIN_NAMES = {
  'saskia@performanceproperty.com.au':    'Saskia',
  'shaene@performanceproperty.com.au':    'Shaene',
  'vandolf@performanceproperty.com.au':   'Vandolf',
  'paul@performanceproperty.com.au':      'Paul',
  'd.robbins@performanceproperty.com.au': 'David',
  'marilou@performanceproperty.com.au':   'Marilou'
};
const ALLOWED_DOMAIN = 'performanceproperty.com.au';

/* ═══ SESSION-STORAGE MIRRORS ═══
   The rest of the codebase reads sessionStorage synchronously to decide
   what to render (tier switcher, hub blur wall, tool toolbars, etc.). We
   mirror the Supabase profile into sessionStorage on auth state changes
   so existing call sites keep working unchanged. */
function _setSessionMirror(profile) {
  if (!profile) {
    sessionStorage.removeItem('pp_auth');
    sessionStorage.removeItem('pp_auth_level');
    sessionStorage.removeItem('pp_view_as');
    sessionStorage.removeItem('pp_user_email');
    sessionStorage.removeItem('pp_user_name');
    sessionStorage.removeItem('pp_user_team');
    sessionStorage.removeItem('pp_user_team_name');
    sessionStorage.removeItem('pp_view_team');
    sessionStorage.removeItem('pp_allowed_tools_v1');
    return;
  }
  sessionStorage.setItem('pp_auth', '1');
  sessionStorage.setItem('pp_auth_level', profile.tier);
  if (!sessionStorage.getItem('pp_view_as')) {
    sessionStorage.setItem('pp_view_as', profile.tier);
  }
  sessionStorage.setItem('pp_user_email', profile.email || '');
  sessionStorage.setItem('pp_user_name',  profile.full_name || '');
  sessionStorage.setItem('pp_user_team',  profile.team || '');   /* GROUPS visibility axis (081); '' = unassigned → baseline */
}

/* ═══ ACCESS LEVEL HELPERS (sync) ═══ */
function getAuthLevel()   { return sessionStorage.getItem('pp_auth_level') || ''; }
function getViewAsLevel() { return sessionStorage.getItem('pp_view_as')    || getAuthLevel(); }
function getAccessLevel() { return getViewAsLevel(); }
function isDev()          { return getAuthLevel() === 'dev'; }
function isAdmin()        { const l = getAccessLevel(); return l === 'admin' || l === 'dev'; }
function isCompany()      { return getAccessLevel() === 'company'; }
function isLeads()        { return getAccessLevel() === 'leads'; }
function isClient()       { return getAccessLevel() === 'client'; }
function isGuest()        { return getAccessLevel() === 'guest'; }
function isLimitedUser()  { return isLeads() || isCompany() || isClient() || isGuest(); }
function isViewOnly()     { return isClient() || isGuest(); }

/* Expose every helper on window so the rest of the codebase keeps working. */
window.getAuthLevel   = getAuthLevel;
window.getViewAsLevel = getViewAsLevel;
window.getAccessLevel = getAccessLevel;
window.isDev          = isDev;
window.isAdmin        = isAdmin;
window.isCompany      = isCompany;
window.isLeads        = isLeads;
window.isClient       = isClient;
window.isGuest        = isGuest;
window.isLimitedUser  = isLimitedUser;
window.isViewOnly     = isViewOnly;

/* ═══ GROUP (team) TOOL VISIBILITY — resolver for migration 081 ═══
   Visibility-only axis on top of tiers: `hub_groups` rows hold tool-key
   arrays (shared/tool-registry.js); a staff member sees
   union(company_baseline, their group). Rights are untouched.
   State shape: { mode:'all'|'external'|'set', keys:Set, team, fallback }.
   'all' = dev/admin · 'external' = client/guest (legacy gating) ·
   'set' = leads/company. Missing state = not resolved yet → helpers in
   tool-registry.js fail open to the legacy tier gates.
   Resolution is NON-BLOCKING (fired after profile hydrate); results are
   cached in sessionStorage 'pp_allowed_tools_v1' so revisits + tool pages
   read it synchronously. */
let _ppAllowed = null;
let _ppAllowedPromise = null;
window._ppHubGroupsCache = window._ppHubGroupsCache || null;   /* rows for the switcher + Groups panel */

function getViewAsTeam() { return isDev() ? (sessionStorage.getItem('pp_view_team') || '') : ''; }
window.getViewAsTeam = getViewAsTeam;

window.ppAllowedState = function () {
  if (_ppAllowed) return _ppAllowed;
  try {
    const raw = sessionStorage.getItem('pp_allowed_tools_v1');
    if (!raw) return null;
    const p = JSON.parse(raw);
    _ppAllowed = { mode: p.mode, keys: new Set(p.keys || []), team: p.team || '', fallback: !!p.fallback };
    return _ppAllowed;
  } catch (e) { return null; }
};

function _ppSetAllowed(st) {
  _ppAllowed = st;
  try {
    sessionStorage.setItem('pp_allowed_tools_v1', JSON.stringify({
      mode: st.mode, keys: Array.from(st.keys || []), team: st.team || '', fallback: !!st.fallback, ts: Date.now()
    }));
  } catch (e) {}
  try { if (typeof populateHubWidgets === 'function') populateHubWidgets(); } catch (e) {}
  try { if (typeof initTierSwitcher === 'function') initTierSwitcher(); } catch (e) {}
  try { document.dispatchEvent(new CustomEvent('pp-allowed-tools-changed')); } catch (e) {}
}

window.ppResolveAllowedTools = function (force) {
  if (!force && _ppAllowed && !_ppAllowed.fallback) return Promise.resolve(_ppAllowed);
  if (_ppAllowedPromise) return _ppAllowedPromise;
  _ppAllowedPromise = (async () => {
    const lvl = getViewAsLevel();
    const REG = window.PP_TOOL_REGISTRY;
    let team = getViewAsTeam() || sessionStorage.getItem('pp_user_team') || '';
    /* dev = Van: always everything. Everyone else is ASSIGNABLE to any group
       (Van 2026-07-19), including the 'admins' and 'leads' group rows. Safe
       defaults while unassigned: admin → sees everything; tier='leads' →
       auto-applies the 'leads' row (today's reach). */
    if (lvl === 'leads' && !team) team = 'leads';
    if (lvl === 'dev' || (lvl === 'admin' && !team)) {
      /* the Group Switcher needs the group names even though dev/admin skip
         resolution — backfill the cache non-blocking, then re-render it */
      if (isDev() && !window._ppHubGroupsCache && window.sb) {
        window.sb.from('hub_groups').select('key,name,tools,sort').order('sort')
          .then(({ data }) => { if (data && data.length) { window._ppHubGroupsCache = data; try { initTierSwitcher(); } catch (e) {} } })
          .catch(() => {});
      }
      const st = { mode: 'all', keys: new Set() }; _ppSetAllowed(st); return st;
    }
    if (lvl === 'client' || lvl === 'guest' || !lvl) { const st = { mode: 'external', keys: new Set() }; _ppSetAllowed(st); return st; }
    if (!REG) { const st = { mode: 'external', keys: new Set() }; _ppSetAllowed(st); return st; }   /* no registry on this page → legacy gates */
    try {
      const { data, error } = await window.sb.from('hub_groups').select('key,name,tools,sort').order('sort');
      if (error || !data || !data.length) throw (error || new Error('empty'));
      window._ppHubGroupsCache = data;
      const by = {}; data.forEach(r => { by[r.key] = r; });
      const keys = new Set(((by.company_baseline || {}).tools) || []);
      if (team && by[team]) (by[team].tools || []).forEach(k => keys.add(k));
      /* real team's display name for the identity chip (identity, not view-as) */
      const realTeam = sessionStorage.getItem('pp_user_team') || '';
      sessionStorage.setItem('pp_user_team_name', (realTeam && by[realTeam]) ? by[realTeam].name : '');
      const st = { mode: 'set', keys, team };
      _ppSetAllowed(st);
      return st;
    } catch (e) {
      /* hub_groups missing (081 not applied) or offline → today's UI exactly.
         A grouped ADMIN fails open to see-all (their pre-081 behavior). */
      if (lvl === 'admin') { const st = { mode: 'all', keys: new Set(), fallback: true }; _ppSetAllowed(st); return st; }
      const keys = new Set(REG.DEFAULT_BASELINE);
      if (lvl === 'leads') REG.DEFAULT_LEADS_EXTRA.forEach(k => keys.add(k));
      const st = { mode: 'set', keys, team: '', fallback: true };
      _ppSetAllowed(st);
      return st;
    } finally {
      _ppAllowedPromise = null;
    }
  })();
  return _ppAllowedPromise;
};

/* ═══ TIER SWITCHER (dev only) — unchanged from previous build ═══ */
window._pp_currentView = window._pp_currentView || '';

function _ppBuildTierSwitcher() {
  const existing   = document.getElementById('tier-switcher');     if (existing)   existing.remove();
  const existingJs = document.getElementById('tier-switcher-js');  if (existingJs) existingJs.remove();

  const host = document.createElement('div');
  host.id = 'tier-switcher-js';
  /* Sits at bottom-right but shifted LEFT past the AI-concierge
     floating chat button (.concierge-btn — 56px wide, anchored at
     right:20). 96px clearance = button width + its 20px right
     margin + a 20px gap so the two sit comfortably side-by-side
     instead of overlapping. */
  const hostStyles = {
    'position':'fixed','bottom':'18px','right':'96px','z-index':'2147483647',
    'display':'block','width':'auto','height':'auto','min-width':'180px','min-height':'40px',
    'font-family':"'Figtree', 'Montserrat', system-ui, -apple-system, sans-serif",
    'pointer-events':'auto','margin':'0','padding':'0','border':'none',
    'background':'transparent','transform':'none','opacity':'1','visibility':'visible'
  };
  for (const [k,v] of Object.entries(hostStyles)) host.style.setProperty(k, v, 'important');

  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'ts-toggle-btn';
  btn.setAttribute('title', 'View as — dev tool (groups + roles)');
  const btnStyles = {
    'display':'flex','align-items':'center','gap':'8px','background':'rgba(21,25,38,0.72)','color':'#ffffff',
    'backdrop-filter':'blur(20px) saturate(1.5)','-webkit-backdrop-filter':'blur(20px) saturate(1.5)',
    'border':'1px solid rgba(255,255,255,0.16)','padding':'10px 16px','border-radius':'12px','font-size':'11px',
    'font-weight':'800','letter-spacing':'2px','text-transform':'uppercase','cursor':'pointer',
    'box-shadow':'0 6px 24px rgba(0,0,0,.45)','font-family':'inherit','line-height':'1',
    'white-space':'nowrap','min-height':'40px'
  };
  for (const [k,v] of Object.entries(btnStyles)) btn.style.setProperty(k, v, 'important');
  btn.innerHTML = '<span style="font-size:13px;line-height:1">&#128065;</span>'
                + '<span style="opacity:.6">View as:&nbsp;</span>'
                + '<span id="ts-current-label-js" style="color:#ffffff">DEV</span>';
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    const m = document.getElementById('ts-menu-js');
    if (m) m.style.setProperty('display', m.style.display === 'block' ? 'none' : 'block', 'important');
  });
  host.appendChild(btn);

  const menu = document.createElement('div');
  menu.id = 'ts-menu-js';
  const menuStyles = {
    'position':'absolute','bottom':'calc(100% + 10px)','right':'0','background':'rgba(18,22,34,0.92)',
    'backdrop-filter':'blur(24px) saturate(1.5)','-webkit-backdrop-filter':'blur(24px) saturate(1.5)',
    'border-radius':'12px','box-shadow':'0 14px 48px rgba(0,0,0,.45)','min-width':'240px',
    'overflow':'hidden','border':'1px solid rgba(255,255,255,0.12)','display':'none'
  };
  for (const [k,v] of Object.entries(menuStyles)) menu.style.setProperty(k, v, 'important');

  const header = document.createElement('div');
  header.textContent = 'Switch Tier Perspective';
  const hdrStyles = {
    'padding':'10px 14px','background':'rgba(255,255,255,0.05)','border-bottom':'1px solid rgba(255,255,255,0.10)',
    'font-size':'9px','font-weight':'800','letter-spacing':'2px','text-transform':'uppercase',
    'color':'rgba(235,240,250,0.55)','font-family':'inherit'
  };
  for (const [k,v] of Object.entries(hdrStyles)) header.style.setProperty(k, v, 'important');
  menu.appendChild(header);

  /* GROUP SWITCHER (Van 2026-07-19): one flat list, no "TIER n" wording —
     Dev · Admin · Leads · each staff group · Client · Guest. Group rows come
     from the hub_groups cache (backfilled for dev by the resolver); the
     'admins'/'leads' GROUP rows are skipped because the Admin/Leads entries
     already preview those perspectives. */
  const entries = [
    { tier: 'dev',   label: 'Dev',   sub: 'Full access' },
    { tier: 'admin', label: 'Admin', sub: 'Full edit + download' },
    { tier: 'leads', label: 'Leads', sub: 'Baseline + Leads tools' }
  ];
  (window._ppHubGroupsCache || [])
    .filter(r => r.key !== 'company_baseline' && r.key !== 'admins' && r.key !== 'leads')
    .forEach(r => entries.push({ team: r.key, label: r.name, sub: 'Staff group' }));
  entries.push(
    { tier: 'client', label: 'Client', sub: 'No edits, no downloads' },
    { tier: 'guest',  label: 'Guest',  sub: 'Lite — Contact Us blur wall' }
  );

  entries.forEach(en => {
    const b = document.createElement('button');
    b.type = 'button';
    if (en.team) b.setAttribute('data-team', en.team); else b.setAttribute('data-tier', en.tier);
    const bs = {
      'display':'block','width':'100%','text-align':'left','padding':'10px 14px','border':'none',
      'border-bottom':'1px solid rgba(255,255,255,0.07)','background':'transparent','font-family':'inherit',
      'font-size':'11.5px','font-weight':'700','color':'#e8edf7','cursor':'pointer','letter-spacing':'0.3px'
    };
    for (const [k,v] of Object.entries(bs)) b.style.setProperty(k, v, 'important');
    b.innerHTML = en.label + ' <span style="display:block;font-size:9.5px;font-weight:600;opacity:.7;margin-top:2px;letter-spacing:.5px">' + en.sub + '</span>';
    const isActive = () => en.team
      ? (getViewAsLevel() === 'company' && getViewAsTeam() === en.team)
      : (getViewAsLevel() === en.tier && !(en.tier === 'company' && getViewAsTeam()));
    b.addEventListener('mouseenter', () => b.style.setProperty('background', 'rgba(255,255,255,0.08)', 'important'));
    b.addEventListener('mouseleave', () => {
      const active = isActive();
      b.style.setProperty('background', active ? '#e8edf7' : 'transparent', 'important');
      b.style.setProperty('color',      active ? '#10131c' : '#e8edf7', 'important');
    });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (en.team) setViewAs('company', en.team); else setViewAs(en.tier);
    });
    menu.appendChild(b);
  });
  host.appendChild(menu);

  document.addEventListener('click', function (e) {
    if (!host.contains(e.target)) menu.style.setProperty('display', 'none', 'important');
  });

  document.body.appendChild(host);
  return host;
}

function initTierSwitcher() {
  const dev   = isDev();
  const onHub = window._pp_currentView === 'hub';
  if (!(dev && onHub)) {
    const ex = document.getElementById('tier-switcher-js');     if (ex) ex.remove();
    const legacy = document.getElementById('tier-switcher');    if (legacy) legacy.style.setProperty('display', 'none', 'important');
    return;
  }
  _ppBuildTierSwitcher();
  try {
    const va = getViewAsLevel();
    const vTeam = getViewAsTeam();
    const labels = { dev:'DEV', admin:'ADMIN', leads:'LEADS', company:'STAFF', client:'CLIENT', guest:'GUEST' };
    const lbl = document.getElementById('ts-current-label-js');
    if (lbl) {
      let text = labels[va] || 'DEV';
      if (va === 'company' && vTeam) {
        const row = (window._ppHubGroupsCache || []).find(r => r.key === vTeam);
        text = ((row && row.name) || vTeam).toUpperCase();
      }
      lbl.textContent = text;
    }
    document.querySelectorAll('#ts-menu-js button[data-tier]').forEach(b => {
      const active = b.getAttribute('data-tier') === va && !(va === 'company' && vTeam);
      b.style.setProperty('background', active ? '#e8edf7' : 'transparent', 'important');
      b.style.setProperty('color',      active ? '#10131c' : '#e8edf7', 'important');
    });
    document.querySelectorAll('#ts-menu-js button[data-team]').forEach(b => {
      const active = va === 'company' && b.getAttribute('data-team') === vTeam;
      b.style.setProperty('background', active ? '#e8edf7' : 'transparent', 'important');
      b.style.setProperty('color',      active ? '#10131c' : '#e8edf7', 'important');
    });
  } catch (e) {}
}
window.initTierSwitcher = initTierSwitcher;

function setViewAs(tier, teamKey) {
  if (!isDev()) return;
  if (!['dev','admin','leads','company','client','guest'].includes(tier)) return;
  sessionStorage.setItem('pp_view_as', tier);
  /* pp_view_as stays a PLAIN TIER string (arena gates, report gates and
     applyAccessRestrictions all parse it) — a group preview rides a second
     dev-only key that only the visibility resolver reads. */
  if (tier === 'company' && teamKey) sessionStorage.setItem('pp_view_team', teamKey);
  else sessionStorage.removeItem('pp_view_team');
  sessionStorage.removeItem('pp_allowed_tools_v1');   /* re-resolve for the new perspective */
  location.reload();
}
window.setViewAs = setViewAs;

/* ═══ LOGIN NOTICE ═══ */
function showLoginNotice(text, variant) {
  const el  = document.getElementById('loginNotice');
  const txt = document.getElementById('loginNoticeText');
  if (!el || !txt) return;
  txt.textContent = text;
  el.classList.toggle('is-warn', variant === 'warn');
  el.hidden = false;
}
function clearLoginNotice() {
  const el = document.getElementById('loginNotice');
  if (!el) return;
  el.hidden = true;
  el.classList.remove('is-warn');
}
window.showLoginNotice  = showLoginNotice;
window.clearLoginNotice = clearLoginNotice;

/* ═══ WELCOME OVERLAY (admin only) ═══ */
function showWelcomeAndProceed(name) {
  const overlay = document.getElementById('welcomeOverlay');
  const msg = document.getElementById('welcomeMsg');
  const bar = document.getElementById('welcomeBar');
  const sub = document.getElementById('welcomeSub');
  if (!overlay || !msg) { showMain(); return; }
  msg.textContent = 'Welcome back, ' + name + '!';
  overlay.style.display = 'flex';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    msg.style.opacity = '1'; bar.style.opacity = '1';
    if (sub) sub.style.opacity = '1';   /* subtitle removed from the hub (Van 2026-07-12) */
  }));
  setTimeout(() => {
    overlay.style.transition = 'opacity 0.9s ease';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.opacity = '1';
      overlay.style.transition = '';
      msg.style.opacity = '0'; bar.style.opacity = '0';
      if (sub) sub.style.opacity = '0';
      showMain();
    }, 900);
  }, 2800);
}

/* ═══ APPLY ACCESS RESTRICTIONS — same as before, just reads sessionStorage ═══ */
function applyAccessRestrictions() {
  const level = getAccessLevel();
  try { initTierSwitcher(); } catch (e) {}

  try {
    document.body.classList.remove('tier-dev','tier-admin','tier-leads','tier-company','tier-client','tier-guest');
    document.body.classList.add('tier-' + level);
  } catch (e) {}

  /* Per-user accessibility hook — David Robbins struggles to read
     the cyan accent in a few specific spots, so we tag the body
     with .user-d-robbins and let each tool override those colors
     to navy (#000080) via scoped CSS. Invisible to every other
     user. */
  try {
    const email = (typeof getCurrentUserEmail === 'function' ? (getCurrentUserEmail() || '') : '').toLowerCase();
    document.body.classList.toggle('user-d-robbins', email === 'd.robbins@performanceproperty.com.au');
  } catch (e) {}

  if (level === 'admin' || level === 'dev') {
    try {
      const tabs = document.querySelector('.toolbar .tabs');
      const slot = document.getElementById('center-tabs-bar');
      if (tabs && slot && !slot.contains(tabs)) {
        slot.appendChild(tabs);
        slot.style.display = 'flex';
      }
    } catch (e) {}
    return;
  }

  document.querySelectorAll('.tier1-only').forEach(el => { el.style.display = 'none'; });
  const hubPill = document.getElementById('hubIdentityPill');
  if (hubPill) hubPill.style.display = 'none';

  /* Leads / Company / Client / Guest all get the same VIEW surface — this
     is an internal-only tool now (no external clients use it), so every
     tier below admin sees everything Staff (company) sees. The only
     differences:
       • All lose edit toolbar buttons (.tbtn:not(.pdf-btn)) and the save
         indicator — they're view-only as far as content editing goes.
         (Leads' extra reach is the Vault + PM hub pages, gated in
         index.html, not edit rights.)
       • Client / Guest ADDITIONALLY lose the download buttons (.pdf-btn,
         #runwayPdfBtn, #runwayJpegBtn) — that's the single differentiator
         between them and Leads / Staff, who keep downloads.
     The old guest branch hid the whole toolbar (no tab switcher etc.)
     and the old client branch hid the Runway data-source dropdown;
     both are gone so 3/4 see the same controls 2 sees, minus
     download. */
  if (level === 'leads' || level === 'company' || level === 'client' || level === 'guest') {
    document.querySelectorAll('.tbtn:not(.pdf-btn)').forEach(b => b.style.display = 'none');
    const saveInd = document.getElementById('save-indicator');
    if (saveInd) saveInd.style.display = 'none';
    if (level === 'client' || level === 'guest') {
      document.querySelectorAll('.tbtn.pdf-btn').forEach(b => b.style.display = 'none');
      const rwPdfBtn  = document.getElementById('runwayPdfBtn');  if (rwPdfBtn)  rwPdfBtn.style.display  = 'none';
      const rwJpegBtn = document.getElementById('runwayJpegBtn'); if (rwJpegBtn) rwJpegBtn.style.display = 'none';
    }
    return;
  }
}
window.applyAccessRestrictions = applyAccessRestrictions;

/* ═══ STEP NAVIGATION ═══ */
function showStep(n) {
  ['step1','step2','step3'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', n !== (i + 1));
  });
}
window.showStep = showStep;

/* ═══ RESEND TIMER ═══ */
let resendInterval = null;
function startResendTimer() {
  let secs = 60;
  const btn = document.getElementById('resendBtn');
  const timerEl = document.getElementById('resendTimer');
  if (!btn || !timerEl) return;
  btn.disabled = true;
  timerEl.textContent = secs;
  btn.innerHTML = 'Resend code (<span id="resendTimer">' + secs + '</span>s)';
  clearInterval(resendInterval);
  resendInterval = setInterval(() => {
    secs--;
    const t = document.getElementById('resendTimer');
    if (t) t.textContent = secs;
    if (secs <= 0) {
      clearInterval(resendInterval);
      btn.disabled = false;
      btn.textContent = 'Resend code';
    }
  }, 1000);
}

/* ═══ OTP WRONG-ATTEMPTS LOCKOUT (UX cue — Supabase rate-limits server-side) ═══ */
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCKOUT_SECS = 60;
let otpWrongAttempts = 0;
let otpLockoutInterval = null;

function resetOtpAttempts() {
  otpWrongAttempts = 0;
  if (otpLockoutInterval) { clearInterval(otpLockoutInterval); otpLockoutInterval = null; }
  const btn = document.getElementById('verifyBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Verify Code'; }
}
function startOtpLockout() {
  let secs = OTP_LOCKOUT_SECS;
  const btn = document.getElementById('verifyBtn');
  const errEl = document.getElementById('otpError');
  if (btn) { btn.disabled = true; btn.textContent = 'Locked (' + secs + 's)'; }
  if (errEl) errEl.textContent = 'Too many incorrect codes. Please wait ' + secs + ' seconds, or request a new code.';
  if (otpLockoutInterval) clearInterval(otpLockoutInterval);
  otpLockoutInterval = setInterval(() => {
    secs--;
    if (btn) btn.textContent = 'Locked (' + secs + 's)';
    if (errEl) errEl.textContent = 'Too many incorrect codes. Please wait ' + secs + ' seconds, or request a new code.';
    if (secs <= 0) {
      clearInterval(otpLockoutInterval);
      otpLockoutInterval = null;
      otpWrongAttempts = 0;
      if (btn) { btn.disabled = false; btn.textContent = 'Verify Code'; }
      if (errEl) errEl.textContent = '';
    }
  }, 1000);
}

/* ═══ AUTH FLOWS ═══ */
/* The email currently mid-OTP. Set in step 1, consumed in step 2. */
let _otpPendingEmail = '';

/* Fetch the current user's profile, populate sessionStorage, and route to
   the right post-login UI. Returns the profile or null if no session. */
async function _hydrateFromSession() {
  if (!window.sb) return null;
  const { data: sess } = await window.sb.auth.getSession();
  if (!sess || !sess.session) {
    _setSessionMirror(null);
    return null;
  }
  const { data: profile, error } = await window.sb
    .from('profiles')
    .select('*')   /* schema-tolerant: `team` (migration 081) appears when applied; an explicit column list 400s pre-migration and breaks login */
    .eq('id', sess.session.user.id)
    .single();
  if (error || !profile) {
    console.warn('Profile lookup failed', error);
    _setSessionMirror(null);
    return null;
  }
  _setSessionMirror(profile);
  /* resolve group tool visibility in the background — never blocks login */
  try { if (typeof window.ppResolveAllowedTools === 'function') window.ppResolveAllowedTools().catch(() => {}); } catch (e) {}
  /* Pre-warm the pending-approvals cache for admin/dev so the hub pill
     reflects pending-count on first paint without an extra event. */
  if (profile.tier === 'admin' || profile.tier === 'dev') {
    if (typeof window.fetchUsersFromServer === 'function') {
      window.fetchUsersFromServer().then(() => {
        document.dispatchEvent(new CustomEvent('pp-users-changed'));
      }).catch(() => {});
    }
  }
  return profile;
}

/* After a successful sign-in or OTP verify: gate by status, then either
   show welcome (admin/dev) or jump straight to the hub. */
async function _completeLogin() {
  const profile = await _hydrateFromSession();
  if (!profile) {
    const errEl = document.getElementById('loginError');
    if (errEl) errEl.textContent = 'Profile lookup failed. Please try again.';
    return;
  }
  if (profile.status === 'pending') {
    await window.sb.auth.signOut();
    _setSessionMirror(null);
    showStep(1);
    showLoginNotice('Your account is still being verified. You’ll receive an email at ' + profile.email + ' once it’s active.', 'warn');
    return;
  }
  if (profile.status === 'rejected') {
    await window.sb.auth.signOut();
    _setSessionMirror(null);
    showStep(1);
    showLoginNotice('This account is not active. Please contact Performance Property.', 'warn');
    return;
  }
  /* Active — log them in. */
  const loginScreen = document.getElementById('loginScreen');
  if (loginScreen) loginScreen.style.display = 'none';
  applyAccessRestrictions();
  /* Welcome overlay for every tier — admins get the named greeting via
     ADMIN_NAMES, non-admins get their full_name (set during registration)
     or the email's local-part as a fallback. */
  const name = ADMIN_NAMES[profile.email]
            || profile.full_name
            || (profile.email || '').split('@')[0]
            || 'there';
  showWelcomeAndProceed(name);
}

/* ── Google OAuth sign-in (added ALONGSIDE the email/OTP flow) ──
   Supabase runs the handshake. After Google → Supabase callback →
   redirect back to this page, supabase-client.js's detectSessionInUrl
   parses the session and _hydrateFromSession (on load) reads the profile
   and routes by tier — identical to any other sign-in. Tier is assigned
   by the handle_new_user trigger from the verified email, so PP staff
   land as company/admin automatically; the Google "Internal" consent
   screen already restricts this to @performanceproperty.com.au accounts,
   and any non-active profile is signed out by the existing status gate. */
async function signInWithGoogle() {
  const errEl = document.getElementById('loginError');
  if (errEl) errEl.textContent = '';
  const btn = document.getElementById('googleLoginBtn');
  if (!window.sb) { if (errEl) errEl.textContent = 'Still connecting — try again in a moment.'; return; }
  if (btn) btn.disabled = true;
  /* Come back to whatever page launched the flow (hub in prod, or the
     localhost preview) — must be in Supabase's redirect allow-list. */
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await window.sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      /* hd hints the Workspace domain in Google's account chooser;
         prompt:select_account avoids silently reusing a personal login. */
      queryParams: { hd: 'performanceproperty.com.au', prompt: 'select_account' }
    }
  });
  if (error) {
    if (btn) btn.disabled = false;
    if (errEl) errEl.textContent = 'Google sign-in could not start: ' + error.message;
  }
  /* On success the browser redirects to Google immediately — nothing else
     to do here; the redirect back is handled on next page load. */
}
window.signInWithGoogle = signInWithGoogle;

/* ── Step 1: email + (optional) password ── */
async function tryLogin() {
  const emailEl = document.getElementById('emailInput');
  const pwEl    = document.getElementById('pwInput');
  const errEl   = document.getElementById('loginError');
  const btn     = document.getElementById('loginBtn');
  if (!emailEl || !errEl || !btn) return;
  errEl.textContent = '';

  if (btn.classList.contains('is-pending')) return;

  const origLabel = btn.textContent;
  function enterPending(label) {
    btn.classList.add('is-pending');
    btn.disabled = true;
    btn.textContent = label || 'Signing in…';
  }
  function leavePending(label) {
    btn.classList.remove('is-pending');
    btn.disabled = false;
    btn.textContent = label != null ? label : origLabel;
  }

  const email = emailEl.value.trim().toLowerCase();
  const pass  = pwEl ? pwEl.value : '';

  if (!email) { errEl.textContent = 'Please enter your email.'; return; }
  if (!email.includes('@')) { errEl.textContent = 'Please enter a valid email.'; return; }

  enterPending('Signing in…');

  /* Password path — Tier 0 (Vandolf) only. Anyone else with a password is
     also fine; signInWithPassword fails for users who never set one. */
  if (pass) {
    const { error } = await window.sb.auth.signInWithPassword({ email, password: pass });
    if (error) {
      leavePending();
      errEl.textContent = 'Incorrect email or password.';
      if (pwEl) { pwEl.value = ''; pwEl.focus(); }
      return;
    }
    /* Don't restore label — _completeLogin navigates away. */
    await _completeLogin();
    return;
  }

  /* OTP path — everyone else. For @performanceproperty.com.au staff
     we set shouldCreateUser:true so first-time admins/company users
     can self-onboard with no manual provisioning — the SQL trigger
     in migration 002 automatically assigns tier='admin' (for the
     hardcoded admin emails) or tier='company' (for other PP staff)
     on first sign-in. For everyone else we keep shouldCreateUser
     false so unknown emails get a "register here" prompt rather
     than silently creating ghost accounts. */
  const isStaffEmail = email.endsWith('@' + ALLOWED_DOMAIN);
  btn.textContent = 'Sending verification code…';
  const { error } = await window.sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: isStaffEmail }
  });
  if (error) {
    leavePending('Send Verification Code');
    /* Supabase returns "Signups not allowed for otp" when shouldCreateUser
       is false and the email isn't in auth.users. Map that to the standard
       "register here" prompt. */
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('signups not allowed') || msg.includes('user not found')) {
      if (REGISTRATION_ENABLED) {
        errEl.innerHTML = 'Account not found. <button onclick="showStep(3)" style="background:none;border:none;color:var(--accent);cursor:pointer;font-weight:700;text-decoration:underline;font-size:inherit;padding:0">Register here</button> for viewer access.';
      } else {
        /* Internal-only tool — no self-registration path. Users have
           to be onboarded by an admin. Pointing at the existing
           researchsupport@ alias keeps the message actionable. */
        errEl.textContent = 'Account not found. Please contact researchsupport@performanceproperty.com.au to request access.';
      }
    } else {
      errEl.textContent = error.message || 'Failed to send code. Please try again.';
    }
    return;
  }

  _otpPendingEmail = email;
  const disp = document.getElementById('otpEmailDisplay');
  if (disp) disp.textContent = email;
  showStep(2);
  leavePending('Send Verification Code');
  startResendTimer();
  setTimeout(() => {
    const first = document.querySelectorAll('.otp-digit')[0];
    if (first) first.focus();
  }, 100);
}
window.tryLogin = tryLogin;

/* ── Step 2: OTP verify ── */
function getOTPValue() {
  return [...document.querySelectorAll('.otp-digit')].map(i => i.value).join('');
}

async function verifyOTP() {
  const errEl = document.getElementById('otpError');
  if (!errEl) return;
  errEl.textContent = '';
  if (otpLockoutInterval) return;
  const entered = getOTPValue();
  if (entered.length < 6) { errEl.textContent = 'Please enter all 6 digits.'; return; }
  if (!_otpPendingEmail) { errEl.textContent = 'Session expired. Please request a new code.'; return; }

  const { error } = await window.sb.auth.verifyOtp({
    email: _otpPendingEmail,
    token: entered,
    type:  'email'
  });
  if (error) {
    otpWrongAttempts++;
    const remaining = OTP_MAX_ATTEMPTS - otpWrongAttempts;
    if (remaining <= 0) {
      document.querySelectorAll('.otp-digit').forEach(i => i.value = '');
      startOtpLockout();
      return;
    }
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('expired')) {
      errEl.textContent = 'Code expired. Please request a new one.';
    } else {
      errEl.textContent = 'Incorrect code. ' + remaining + ' attempt' + (remaining === 1 ? '' : 's') + ' remaining.';
    }
    document.querySelectorAll('.otp-digit').forEach(i => i.value = '');
    const first = document.querySelectorAll('.otp-digit')[0];
    if (first) first.focus();
    return;
  }
  /* Success */
  resetOtpAttempts();
  clearInterval(resendInterval);
  _otpPendingEmail = '';
  await _completeLogin();
}
window.verifyOTP = verifyOTP;

/* ── Step 3: registration ──
   Submits an OTP request with shouldCreateUser:true and metadata that
   the on_auth_user_created trigger reads to set tier + status. The OTP
   itself doubles as email verification. After verifyOtp, _completeLogin
   gates by status (client→pending banner; guest→active hub). */
async function registerSubmit() {
  const errEl  = document.getElementById('regError');
  const btn    = document.getElementById('registerBtn');
  if (!errEl || !btn) return;
  errEl.textContent = '';

  const firstName = document.getElementById('regFirstName').value.trim();
  const email     = document.getElementById('regEmail').value.trim().toLowerCase();
  const isClient  = !!document.getElementById('regIsClient')?.checked;

  if (!firstName) { errEl.textContent = 'Please enter your first name.'; return; }
  if (!email || !email.includes('@')) { errEl.textContent = 'Please enter a valid email.'; return; }
  if (email.endsWith('@' + ALLOWED_DOMAIN)) {
    errEl.textContent = 'Staff members use the Sign In flow, not registration.';
    return;
  }

  const origLabel = btn.textContent;
  btn.textContent = 'Creating account…';
  btn.disabled = true;
  btn.classList.add('is-pending');

  const { error } = await window.sb.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      data: {
        first_name: firstName,
        role: isClient ? 'client' : 'guest'
      }
    }
  });

  btn.textContent = origLabel || 'Create Account';
  btn.disabled = false;
  btn.classList.remove('is-pending');

  if (error) {
    errEl.textContent = error.message || 'Registration failed. Please try again.';
    return;
  }

  if (isClient) {
    /* Client path: the OTP arrives but verifying it lands the user as
       status='pending' which _completeLogin signs out + banners. We still
       send the OTP because Supabase needs verifyOtp to commit the
       auth.users row (and fire the trigger). */
    showLoginNotice('Your account has been submitted. We’ve sent a verification code to ' + email + ' — enter it to confirm your email, then wait for our approval email.', 'warn');
  } else {
    clearLoginNotice();
  }

  /* Pre-fill the OTP step with the registration email and walk forward. */
  _otpPendingEmail = email;
  const disp = document.getElementById('otpEmailDisplay');
  if (disp) disp.textContent = email;
  showStep(2);
  startResendTimer();
  setTimeout(() => {
    const first = document.querySelectorAll('.otp-digit')[0];
    if (first) first.focus();
  }, 100);
}

/* ═══ ADMIN HELPERS ═══ */
window.ppListUsers = async function () {
  const { data, error } = await window.sb
    .from('profiles')
    .select('email, full_name, tier, status, created_at')
    .order('created_at', { ascending: false });
  if (error) { console.warn('ppListUsers failed', error); return []; }
  console.table(data);
  return data;
};
window.ppRefreshUsers = async function () {
  /* Kept for backwards-compat with hub admin UI. With Supabase there's no
     local cache to refresh — just dispatch the change event so the UI
     re-fetches. */
  document.dispatchEvent(new CustomEvent('pp-users-changed'));
  return true;
};
window.ppApproveUser = async function (email) {
  const { data, error } = await window.sb
    .from('profiles')
    .update({ status: 'active' })
    .eq('email', String(email || '').toLowerCase())
    .select()
    .single();
  if (error) { console.warn('Approve failed', error); return null; }
  console.log('%c✓ Approved', 'color:#00b6cb;font-weight:700', email, '→ status: active');
  document.dispatchEvent(new CustomEvent('pp-users-changed'));
  return data;
};
window.ppRejectUser = async function (email) {
  /* "Reject" deletes the profile row (cascade-deletes the auth.users row
     too via the FK on_delete:cascade — but we can't actually delete
     auth.users from the client. So we mark status='rejected' instead;
     the user can no longer log in because _completeLogin signs them out
     immediately). If you want a hard delete, run it from the SQL editor. */
  const { error } = await window.sb
    .from('profiles')
    .update({ status: 'rejected' })
    .eq('email', String(email || '').toLowerCase());
  if (error) { console.warn('Reject failed', error); return false; }
  console.log('%c✗ Rejected', 'color:#e57373;font-weight:700', email);
  document.dispatchEvent(new CustomEvent('pp-users-changed'));
  return true;
};
/* Legacy alias used by some hub UI bits — list pending only. */
window.ppListPendingUsers = async function () {
  const { data, error } = await window.sb
    .from('profiles')
    .select('email, full_name, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) return [];
  return data || [];
};

/* ═══ BACKWARDS-COMPAT SHIMS for the inline hub admin UI ═══
   The pending-approvals modal in index.html was written against the
   pre-Supabase API (sync getPendingUsers + async fetchUsersFromServer +
   approveUserOnServer / rejectUserOnServer). Rather than rewrite the
   modal, we keep a small in-memory cache of pending profiles here and
   shim the legacy function names to use ppApproveUser / ppRejectUser.

   Field names are also remapped: the modal reads u.firstName +
   u.createdAt, which we mirror from profiles.full_name + .created_at. */
let _pendingUsersCache = [];

function _shapePendingForLegacyUI(row) {
  return {
    email:     row.email,
    firstName: row.full_name || (row.email ? row.email.split('@')[0] : ''),
    createdAt: row.created_at,
    role:      'client',
    status:    'pending'
  };
}

window.fetchUsersFromServer = async function () {
  const { data, error } = await window.sb
    .from('profiles')
    .select('email, full_name, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) {
    console.warn('fetchUsersFromServer failed', error);
    return null;
  }
  _pendingUsersCache = (data || []).map(_shapePendingForLegacyUI);
  return _pendingUsersCache;
};

window.getPendingUsers = function () {
  return _pendingUsersCache.slice();
};

window.approveUserOnServer = async function (email) {
  const profile = await window.ppApproveUser(email);
  if (!profile) return { ok: false, error: 'Approve failed' };
  await window.fetchUsersFromServer();
  return { ok: true, user: _shapePendingForLegacyUI(profile) };
};

window.rejectUserOnServer = async function (email) {
  const ok = await window.ppRejectUser(email);
  if (!ok) return { ok: false, error: 'Reject failed' };
  await window.fetchUsersFromServer();
  return { ok: true };
};

/* ═══ LOGOUT ═══ */
async function logout() {
  try { await window.sb.auth.signOut(); } catch (e) {}
  _setSessionMirror(null);
  location.reload();
}
window.logout = logout;

/* ═══ getCurrentUserDisplay / getCurrentUserEmail ═══ */
function getCurrentUserDisplay() {
  const email = sessionStorage.getItem('pp_user_email') || '';
  const name  = sessionStorage.getItem('pp_user_name')  || '';
  if (ADMIN_NAMES[email]) return ADMIN_NAMES[email];
  if (name) return name;
  if (email) return email.split('@')[0] || email;
  return 'Unknown';
}
function getCurrentUserEmail() {
  return sessionStorage.getItem('pp_user_email') || '';
}
window.getCurrentUserDisplay = getCurrentUserDisplay;
window.getCurrentUserEmail   = getCurrentUserEmail;

/* ═══ SHOW MAIN (hub) ═══ */
function showMain() {
  const loginScreen = document.getElementById('loginScreen');
  if (loginScreen) loginScreen.style.display = 'none';
  const mainPage = document.getElementById('mainPage');
  if (mainPage) mainPage.style.display = 'flex';
  window._pp_currentView = 'hub';
  document.body.classList.add('on-hub');
  try { initTierSwitcher(); } catch (e) {}
  try { if (typeof populateHubWidgets === 'function') populateHubWidgets(); } catch (e) {}
}
window.showMain = showMain;

/* ═══ HUB WIDGETS ═══
   The "At a glance" stat card (hs-* ids) was removed in the 2026-07 hub
   redesign; its stats logic + the hand-maintained PP_HUB_STATS fallback
   were deleted 2026-07-18. What remains is the identity pill's tier label. */
function populateHubWidgets() {
  try {
    const tierEl = document.getElementById('hubIdentityTier');
    if (tierEl) {
      const labels = {
        dev:    'Tier 0 · Dev',
        admin:  'Tier 1 · Admin',
        leads:  'Tier 2 · Leads',
        company:'Tier 3 · Staff',
        client: 'Tier 4 · Client',
        guest:  'Tier 5 · Lite'
      };
      const lvl = getAuthLevel();
      /* staff in a GROUP (081) show the group name instead of the tier label
         — identity, not view-as; applies to company/leads/admin (all
         assignable), never dev/externals */
      const teamName = (lvl === 'company' || lvl === 'leads' || lvl === 'admin')
        ? (sessionStorage.getItem('pp_user_team_name') || '') : '';
      tierEl.textContent = teamName || labels[lvl] || '—';
    }
    /* dev-only Groups panel button (symmetric: a boolean set for every tier) */
    const gbtn = document.getElementById('hubGroupsBtn');
    if (gbtn) gbtn.hidden = !isDev();
  } catch (e) {}
}
window.populateHubWidgets = populateHubWidgets;

/* ═══ OTP DIGIT KEYBOARD UX ═══ */
function _wireOtpDigits() {
  document.querySelectorAll('.otp-digit').forEach((input, i, arr) => {
    input.addEventListener('input', e => {
      const v = e.target.value.replace(/[^0-9]/g, '');
      e.target.value = v.slice(-1);
      if (v && i < arr.length - 1) arr[i + 1].focus();
      if (getOTPValue().length === 6) verifyOTP();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i > 0) arr[i - 1].focus();
      if (e.key === 'Enter') verifyOTP();
    });
    input.addEventListener('paste', e => {
      e.preventDefault();
      const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '').slice(0, 6);
      arr.forEach((inp, j) => inp.value = paste[j] || '');
      const next = Math.min(paste.length, 5);
      arr[next].focus();
      if (paste.length === 6) verifyOTP();
    });
  });
}

/* ═══ INIT ═══ */
async function _initAuth() {
  /* Wire login form (only present on index.html). */
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', tryLogin);

    /* Google sign-in button (added alongside email/OTP). */
    const googleBtn = document.getElementById('googleLoginBtn');
    if (googleBtn) googleBtn.addEventListener('click', signInWithGoogle);

    const emailIn = document.getElementById('emailInput');
    const pwIn    = document.getElementById('pwInput');
    if (pwIn)    pwIn.addEventListener('keydown',    e => { if (e.key === 'Enter') tryLogin(); });
    /* Enter on email: jump to password ONLY when the password field is
       actually visible — otherwise just submit. The pw field exists in
       the DOM even when hidden (we toggle display:none), so don't focus
       it blindly. */
    if (emailIn) emailIn.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const pwField = document.getElementById('pwField');
      const pwShown = pwField && pwField.style.display !== 'none';
      if (pwShown && pwIn) pwIn.focus(); else tryLogin();
    });

    /* ── Password-field visibility ──
       Hidden by default (display:none in HTML). Auto-reveal when the
       email matches DEV_EMAILS. Manual reveal via Ctrl+Shift+D for
       cases where dev wants to see the field before typing the email
       (or when typing a stage-1 username variant). The field stays
       revealed once it's been shown — clearing it keeps state simple. */
    const pwField = document.getElementById('pwField');
    let _pwManuallyRevealed = false;

    function _isDevEmail(email) {
      return DEV_EMAILS.indexOf(String(email || '').trim().toLowerCase()) >= 0;
    }
    function _refreshPwVisibility() {
      if (!pwField) return;
      const emailVal = emailIn ? emailIn.value : '';
      const shouldShow = _pwManuallyRevealed || _isDevEmail(emailVal);
      pwField.style.display = shouldShow ? '' : 'none';
      /* Clear the password whenever we hide the field so a stale value
         doesn't survive an email change and trigger a password sign-in
         attempt the user didn't intend. */
      if (!shouldShow && pwIn) pwIn.value = '';
    }

    function _refreshLoginButtonLabel() {
      const pwShown = pwField && pwField.style.display !== 'none';
      const hasPw = pwShown && pwIn && pwIn.value;
      loginBtn.textContent = hasPw ? 'Sign In' : 'Send Verification Code';
    }

    if (emailIn) {
      emailIn.addEventListener('input', () => {
        _refreshPwVisibility();
        _refreshLoginButtonLabel();
      });
    }
    if (pwIn) {
      pwIn.addEventListener('input', _refreshLoginButtonLabel);
    }
    _refreshPwVisibility();
    _refreshLoginButtonLabel();

    /* "Forgot password?" — sends a Supabase recovery email. The
       resulting link logs the user in and fires PASSWORD_RECOVERY,
       handled by the auth-state subscription further down. Only
       Vandolf has a password today, so this rarely fires. */
    const forgotBtn = document.getElementById('forgotPwBtn');
    if (forgotBtn) {
      forgotBtn.addEventListener('click', async () => {
        const email = (emailIn && emailIn.value || '').trim().toLowerCase();
        const errEl = document.getElementById('loginError');
        if (errEl) errEl.textContent = '';
        if (!email) {
          if (errEl) errEl.textContent = 'Enter your email above first, then click Forgot password.';
          if (emailIn) emailIn.focus();
          return;
        }
        if (!confirm('Send a password reset email to ' + email + '?')) return;
        forgotBtn.textContent = 'Sending…';
        forgotBtn.disabled = true;
        const { error } = await window.sb.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin + location.pathname
        });
        forgotBtn.disabled = false;
        forgotBtn.textContent = 'Forgot password?';
        if (error) {
          if (errEl) errEl.textContent = error.message || 'Could not send recovery email.';
          return;
        }
        showLoginNotice('Recovery email sent to ' + email + '. Click the link inside to set a new password.');
      });
    }

    /* Hidden trigger — Ctrl+Shift+D toggles the password field. Useful
       if you want to sign in with a password before typing the email,
       or if the email-based reveal hasn't fired (e.g. an old browser
       autofills the email AFTER the input listener already settled). */
    document.addEventListener('keydown', (e) => {
      const isCombo = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd');
      if (!isCombo) return;
      e.preventDefault();
      _pwManuallyRevealed = !_pwManuallyRevealed;
      _refreshPwVisibility();
      _refreshLoginButtonLabel();
      if (_pwManuallyRevealed && pwIn) pwIn.focus();
    });

    const showRegisterBtn = document.getElementById('showRegisterBtn');
    if (showRegisterBtn) showRegisterBtn.addEventListener('click', () => showStep(3));
    const backToLoginBtn = document.getElementById('backToLoginBtn');
    if (backToLoginBtn) backToLoginBtn.addEventListener('click', () => showStep(1));

    const verifyBtn = document.getElementById('verifyBtn');
    if (verifyBtn) verifyBtn.addEventListener('click', verifyOTP);

    const resendBtn = document.getElementById('resendBtn');
    if (resendBtn) {
      resendBtn.addEventListener('click', async () => {
        const errEl = document.getElementById('otpError');
        if (errEl) errEl.textContent = '';
        if (!_otpPendingEmail) {
          if (errEl) errEl.textContent = 'Session expired. Please return to sign-in.';
          return;
        }
        resendBtn.textContent = 'Sending…';
        const { error } = await window.sb.auth.signInWithOtp({
          email: _otpPendingEmail,
          options: { shouldCreateUser: false }
        });
        if (error) {
          if (errEl) errEl.textContent = 'Failed to resend. Please try again.';
          resendBtn.textContent = 'Resend code';
          return;
        }
        document.querySelectorAll('.otp-digit').forEach(i => i.value = '');
        const first = document.querySelectorAll('.otp-digit')[0];
        if (first) first.focus();
        resetOtpAttempts();
        startResendTimer();
      });
    }

    const backBtn = document.getElementById('backBtn');
    if (backBtn) backBtn.addEventListener('click', () => {
      showStep(1);
      document.querySelectorAll('.otp-digit').forEach(i => i.value = '');
      const errEl = document.getElementById('otpError');
      if (errEl) errEl.textContent = '';
      clearInterval(resendInterval);
      resetOtpAttempts();
      _otpPendingEmail = '';
    });

    const registerBtn = document.getElementById('registerBtn');
    if (registerBtn) registerBtn.addEventListener('click', registerSubmit);

    _wireOtpDigits();
  }

  /* Subscribe to auth state changes BEFORE we await anything async. The
     PASSWORD_RECOVERY event fires during Supabase's URL-token parsing
     (which happens automatically when the SDK loads with
     detectSessionInUrl:true). If we register the listener after an
     await we can miss the event entirely — the user clicks the
     recovery email link and just sees the login page with no prompt. */
  if (window.sb) {
    window.sb.auth.onAuthStateChange(async (event, _session) => {
      if (event === 'SIGNED_OUT') _setSessionMirror(null);
      if (event === 'PASSWORD_RECOVERY') {
        /* Supabase has parsed the recovery link's tokens out of the URL
           and authenticated the user. Now we need to capture a new
           password and call updateUser. Simple browser prompt is fine
           — only one user has a password (Vandolf) and recovery is
           rare. */
        const next = window.prompt(
          'Enter your new password (min 6 characters):',
          ''
        );
        if (!next) {
          alert('Password unchanged. You are still signed in.');
          return;
        }
        if (next.length < 6) {
          alert('Password must be at least 6 characters. Try again from the recovery email.');
          return;
        }
        const { error } = await window.sb.auth.updateUser({ password: next });
        if (error) {
          alert('Could not update password: ' + (error.message || 'unknown error'));
          return;
        }
        alert('Password updated. You are signed in.');
      }
    });

    /* Restore session if one exists from a previous visit. Runs AFTER
       the onAuthStateChange handler is wired so the recovery flow above
       is guaranteed to fire. */
    const profile = await _hydrateFromSession();
    if (profile && profile.status === 'active') {
      /* showMain() sets _pp_currentView='hub' and body.on-hub, which the
         dev tier switcher uses to decide visibility. Only call it when
         we're actually on the hub page — i.e. mainPage exists. On tool
         pages we just apply access restrictions; auth-gate.js handles
         the rest, and the tier switcher stays hidden because
         _pp_currentView keeps its empty default. */
      const onHubPage = !!document.getElementById('mainPage');
      const loginScreen = document.getElementById('loginScreen');
      if (loginScreen) loginScreen.style.display = 'none';
      applyAccessRestrictions();
      if (onHubPage) showMain();
    } else if (profile && profile.status !== 'active') {
      /* Stale session for a deactivated account — sign out silently. */
      await window.sb.auth.signOut();
      _setSessionMirror(null);
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initAuth);
} else {
  _initAuth();
}
