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
   login screen. Tier 0 dev signs in with email + password to skip OTP.
   Anyone whose email isn't in this list never sees the field — they go
   straight to the email-only OTP flow. */
const DEV_EMAILS = [
  'vandolf@performanceproperty.com.au'
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
  'd.robbins@performanceproperty.com.au': 'David'
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
    return;
  }
  sessionStorage.setItem('pp_auth', '1');
  sessionStorage.setItem('pp_auth_level', profile.tier);
  if (!sessionStorage.getItem('pp_view_as')) {
    sessionStorage.setItem('pp_view_as', profile.tier);
  }
  sessionStorage.setItem('pp_user_email', profile.email || '');
  sessionStorage.setItem('pp_user_name',  profile.full_name || '');
}

/* ═══ ACCESS LEVEL HELPERS (sync) ═══ */
function getAuthLevel()   { return sessionStorage.getItem('pp_auth_level') || ''; }
function getViewAsLevel() { return sessionStorage.getItem('pp_view_as')    || getAuthLevel(); }
function getAccessLevel() { return getViewAsLevel(); }
function isDev()          { return getAuthLevel() === 'dev'; }
function isAdmin()        { const l = getAccessLevel(); return l === 'admin' || l === 'dev'; }
function isCompany()      { return getAccessLevel() === 'company'; }
function isClient()       { return getAccessLevel() === 'client'; }
function isGuest()        { return getAccessLevel() === 'guest'; }
function isLimitedUser()  { return isCompany() || isClient() || isGuest(); }
function isViewOnly()     { return isClient() || isGuest(); }

/* Expose every helper on window so the rest of the codebase keeps working. */
window.getAuthLevel   = getAuthLevel;
window.getViewAsLevel = getViewAsLevel;
window.getAccessLevel = getAccessLevel;
window.isDev          = isDev;
window.isAdmin        = isAdmin;
window.isCompany      = isCompany;
window.isClient       = isClient;
window.isGuest        = isGuest;
window.isLimitedUser  = isLimitedUser;
window.isViewOnly     = isViewOnly;

/* ═══ TIER SWITCHER (dev only) — unchanged from previous build ═══ */
window._pp_currentView = window._pp_currentView || '';

function _ppBuildTierSwitcher() {
  const existing   = document.getElementById('tier-switcher');     if (existing)   existing.remove();
  const existingJs = document.getElementById('tier-switcher-js');  if (existingJs) existingJs.remove();

  const host = document.createElement('div');
  host.id = 'tier-switcher-js';
  const hostStyles = {
    'position':'fixed','bottom':'18px','right':'18px','z-index':'2147483647',
    'display':'block','width':'auto','height':'auto','min-width':'180px','min-height':'40px',
    'font-family':"'Montserrat', system-ui, -apple-system, sans-serif",
    'pointer-events':'auto','margin':'0','padding':'0','border':'none',
    'background':'transparent','transform':'none','opacity':'1','visibility':'visible'
  };
  for (const [k,v] of Object.entries(hostStyles)) host.style.setProperty(k, v, 'important');

  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'ts-toggle-btn';
  btn.setAttribute('title', 'View as tier — dev tool');
  const btnStyles = {
    'display':'flex','align-items':'center','gap':'8px','background':'#1f283f','color':'#ffffff',
    'border':'1.5px solid #00b6cb','padding':'10px 18px','border-radius':'22px','font-size':'11px',
    'font-weight':'800','letter-spacing':'2px','text-transform':'uppercase','cursor':'pointer',
    'box-shadow':'0 6px 24px rgba(0,0,0,.45)','font-family':'inherit','line-height':'1',
    'white-space':'nowrap','min-height':'40px'
  };
  for (const [k,v] of Object.entries(btnStyles)) btn.style.setProperty(k, v, 'important');
  btn.innerHTML = '<span style="font-size:13px;line-height:1">&#128065;</span>'
                + '<span>View as:&nbsp;</span>'
                + '<span id="ts-current-label-js" style="color:#00b6cb">TIER 0</span>';
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    const m = document.getElementById('ts-menu-js');
    if (m) m.style.setProperty('display', m.style.display === 'block' ? 'none' : 'block', 'important');
  });
  host.appendChild(btn);

  const menu = document.createElement('div');
  menu.id = 'ts-menu-js';
  const menuStyles = {
    'position':'absolute','bottom':'calc(100% + 10px)','right':'0','background':'#ffffff',
    'border-radius':'10px','box-shadow':'0 14px 48px rgba(0,0,0,.35)','min-width':'240px',
    'overflow':'hidden','border':'1px solid #e0e3ec','display':'none'
  };
  for (const [k,v] of Object.entries(menuStyles)) menu.style.setProperty(k, v, 'important');

  const header = document.createElement('div');
  header.textContent = 'Switch Tier Perspective';
  const hdrStyles = {
    'padding':'10px 14px','background':'#f7f8fb','border-bottom':'1px solid #e6e8ef',
    'font-size':'9px','font-weight':'800','letter-spacing':'2px','text-transform':'uppercase',
    'color':'#666666','font-family':'inherit'
  };
  for (const [k,v] of Object.entries(hdrStyles)) header.style.setProperty(k, v, 'important');
  menu.appendChild(header);

  const tiers = [
    ['dev',    'TIER 0', 'Dev / Full access'],
    ['admin',  'TIER 1', 'Admin'],
    ['company','TIER 2', 'Company staff'],
    ['client', 'TIER 3', 'Client (no edits, no downloads)'],
    ['guest',  'TIER 4', 'Lite — Contact Us blur wall']
  ];
  tiers.forEach(([tier, label, sub]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('data-tier', tier);
    const bs = {
      'display':'block','width':'100%','text-align':'left','padding':'11px 14px','border':'none',
      'border-bottom':'1px solid #f0f2f6','background':'#ffffff','font-family':'inherit',
      'font-size':'11.5px','font-weight':'700','color':'#1f283f','cursor':'pointer','letter-spacing':'0.3px'
    };
    for (const [k,v] of Object.entries(bs)) b.style.setProperty(k, v, 'important');
    b.innerHTML = label + ' <span style="display:block;font-size:9.5px;font-weight:600;opacity:.7;margin-top:2px;letter-spacing:.5px">' + sub + '</span>';
    b.addEventListener('mouseenter', () => b.style.setProperty('background', '#eef7f9', 'important'));
    b.addEventListener('mouseleave', () => {
      const active = b.getAttribute('data-tier') === getViewAsLevel();
      b.style.setProperty('background', active ? '#00b6cb' : '#ffffff', 'important');
      b.style.setProperty('color',      active ? '#ffffff' : '#1f283f', 'important');
    });
    b.addEventListener('click', function (e) { e.stopPropagation(); setViewAs(tier); });
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
    const labels = { dev:'TIER 0', admin:'TIER 1', company:'TIER 2', client:'TIER 3', guest:'TIER 4' };
    const lbl = document.getElementById('ts-current-label-js');
    if (lbl) lbl.textContent = labels[va] || 'TIER 0';
    document.querySelectorAll('#ts-menu-js button[data-tier]').forEach(b => {
      const active = b.getAttribute('data-tier') === va;
      b.style.setProperty('background', active ? '#00b6cb' : '#ffffff', 'important');
      b.style.setProperty('color',      active ? '#ffffff' : '#1f283f', 'important');
    });
  } catch (e) {}
}
window.initTierSwitcher = initTierSwitcher;

function setViewAs(tier) {
  if (!isDev()) return;
  if (!['dev','admin','company','client','guest'].includes(tier)) return;
  sessionStorage.setItem('pp_view_as', tier);
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
    msg.style.opacity = '1'; bar.style.opacity = '1'; sub.style.opacity = '1';
  }));
  setTimeout(() => {
    overlay.style.transition = 'opacity 0.9s ease';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.opacity = '1';
      overlay.style.transition = '';
      msg.style.opacity = '0'; bar.style.opacity = '0'; sub.style.opacity = '0';
      showMain();
    }, 900);
  }, 2800);
}

/* ═══ APPLY ACCESS RESTRICTIONS — same as before, just reads sessionStorage ═══ */
function applyAccessRestrictions() {
  const level = getAccessLevel();
  try { initTierSwitcher(); } catch (e) {}

  try {
    document.body.classList.remove('tier-dev','tier-admin','tier-company','tier-client','tier-guest');
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

  if (level === 'company') {
    document.querySelectorAll('.tbtn:not(.pdf-btn)').forEach(b => b.style.display = 'none');
    const saveInd = document.getElementById('save-indicator');
    if (saveInd) saveInd.style.display = 'none';
    return;
  }
  if (level === 'client') {
    document.querySelectorAll('.tbtn').forEach(b => b.style.display = 'none');
    const saveInd = document.getElementById('save-indicator');
    if (saveInd) saveInd.style.display = 'none';
    const rwPdfBtn  = document.getElementById('runwayPdfBtn');  if (rwPdfBtn)  rwPdfBtn.style.display  = 'none';
    const rwJpegBtn = document.getElementById('runwayJpegBtn'); if (rwJpegBtn) rwJpegBtn.style.display = 'none';
    const rwSrcSel = document.getElementById('runwayDataSelect');
    if (rwSrcSel) {
      const grp = rwSrcSel.closest('.ctrl-group');
      if (grp) grp.style.display = 'none';
    }
    return;
  }
  if (level === 'guest') {
    const toolbar = document.querySelector('.toolbar');
    if (toolbar) toolbar.style.display = 'none';
    document.querySelectorAll('.tbtn').forEach(b => b.style.display = 'none');
    const rwPdfBtn  = document.getElementById('runwayPdfBtn');  if (rwPdfBtn)  rwPdfBtn.style.display  = 'none';
    const rwJpegBtn = document.getElementById('runwayJpegBtn'); if (rwJpegBtn) rwJpegBtn.style.display = 'none';
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
    .select('id, email, full_name, tier, status')
    .eq('id', sess.session.user.id)
    .single();
  if (error || !profile) {
    console.warn('Profile lookup failed', error);
    _setSessionMirror(null);
    return null;
  }
  _setSessionMirror(profile);
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
  /* Sign out via Clerk (primary auth source). Falls back to clearing
     sessionStorage + reload in case Clerk isn't loaded yet. After
     Clerk.signOut() resolves, Clerk removes its own localStorage keys
     and the next reload lands on the Clerk sign-in screen instead of
     auto-rehydrating. */
  try {
    if (window.Clerk && typeof window.Clerk.signOut === 'function') {
      await window.Clerk.signOut();
    }
  } catch (e) { console.warn('Clerk signOut failed', e); }
  /* Defensive Supabase signOut for any stale supabase-js session. */
  try { if (window.sb && window.sb.auth && typeof window.sb.auth.signOut === 'function') await window.sb.auth.signOut(); } catch (e) {}
  _setSessionMirror(null);
  /* Hard reload to wipe in-memory state + Clerk's mounted component. */
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
   Four "At a glance" stats on the hub. Resolution rules:
     - hs-history (Months of History): pure calendar math from
       Jan 2025 to current month, inclusive. Counts up automatically
       on the 1st of every month.
     - hs-edition (Current Edition): "Q{1-4} · YYYY" derived from
       the current calendar quarter. Flips Jan / Apr / Jul / Oct.
     - hs-latest (Latest Data): latest month displayed by the
       Runway tool. Cached to localStorage as ppa-runway-latest
       whenever Runway loads. Falls back to "previous month name"
       calendar formula if no cache yet (close enough on first visit).
     - hs-regions (Regions Tracked): live count from Demand Score's
       markets array. Cached to localStorage as ppa-demand-markets
       whenever Demand Score loads. Falls back to PP_HUB_STATS.regions
       (still hand-maintained as the safety net).
   */
const _MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _hubMonthsOfHistory() {
  /* Inclusive count from Jan 2025 (the start of our published data
     coverage) to the current month. Apr 2026 → 16, May 2026 → 17. */
  const start = new Date(2025, 0, 1);
  const now = new Date();
  return (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + 1;
}
function _hubCurrentEdition() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) + 1;   // 0-2→Q1, 3-5→Q2, 6-8→Q3, 9-11→Q4
  return 'Q' + q + ' · ' + now.getFullYear();
}
function _hubLatestMonthFromCacheOrFormula() {
  /* Prefer the cached Runway latest month; fall back to "previous
     month" since Runway data typically lags the calendar by ~1
     month (May data lands in June, etc.). */
  try {
    const cached = localStorage.getItem('ppa-runway-latest');
    if (cached) return cached;
  } catch (e) {}
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return _MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
}
function _hubRegionsFromCacheOrFallback(fallback) {
  try {
    const cached = parseInt(localStorage.getItem('ppa-demand-markets'), 10);
    if (cached > 0) return cached;
  } catch (e) {}
  return (fallback != null) ? fallback : '—';
}

function populateHubWidgets() {
  try {
    const fallback = (typeof window !== 'undefined' && window.PP_HUB_STATS) || {};

    /* Regions Tracked — live count from Demand Score, with the
       PP_HUB_STATS hand-maintained number as the safety net. */
    const regEl = document.getElementById('hs-regions');
    if (regEl) regEl.textContent = _hubRegionsFromCacheOrFallback(fallback.regions);

    /* Latest Data — cached from Runway (or calendar previous-month
       fallback). */
    const latestEl = document.getElementById('hs-latest');
    if (latestEl) latestEl.textContent = _hubLatestMonthFromCacheOrFormula();

    /* Months of History — calendar math, no cache needed. */
    const histEl = document.getElementById('hs-history');
    if (histEl) histEl.textContent = _hubMonthsOfHistory();

    /* Current Edition — current calendar quarter, no cache needed. */
    const editionEl = document.getElementById('hs-edition');
    if (editionEl) editionEl.textContent = _hubCurrentEdition();

    const tierEl = document.getElementById('hubIdentityTier');
    if (tierEl) {
      const labels = {
        dev:    'Tier 0 · Dev',
        admin:  'Tier 1 · Admin',
        company:'Tier 2 · Company',
        client: 'Tier 3 · Client',
        guest:  'Tier 4 · Lite'
      };
      const lvl = getAuthLevel();
      tierEl.textContent = labels[lvl] || '—';
    }
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

  /* Clerk migration: skip the Supabase auth state subscription + hydration
     entirely. Clerk handles auth now (see docs/BUG.md). The Clerk handler
     in index.html mirrors the Clerk user to sessionStorage which is what
     the tier helpers read from. */
  if (false && window.sb) {
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
