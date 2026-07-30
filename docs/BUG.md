# Bug log

**No open bugs recorded here.** Only add an entry for something actually
unresolved — this file gets read as the open-bug list, so a fixed issue left
sitting here resurfaces in status reports months later. That is exactly what
happened with the entry below: fixed in production, but the doc still described
it as blocking, and it kept reappearing.

---

## RESOLVED — New-user sign-in freeze (logged 2026-05-11, closed 2026-07-30)

Fresh-browser sign-in used to hang for every account except the Supabase org
owner's, which blocked new-staff onboarding. Three debug sessions concluded the
cause sat below the app layer — it reproduced identically through a full Clerk
migration, so it was neither supabase-js nor app code.

**Fixed in production; staff sign in normally on fresh browsers.** Confirmed
closed by Van 2026-07-30. Sign-in has moved on considerably since the log was
written: "Continue with Google" shipped 2026-06-29 (commit `7795396`, OAuth
consent locked Internal to @performanceproperty.com.au) alongside the existing
email/OTP and password paths (`ab5509e`).

The full ~16-hour investigation — symptoms, everything ruled out, the
Cloudflare-edge hypothesis and the Clerk attempt — is preserved in git rather
than here:

```
git show af24725:docs/BUG.md   # first log
git show 400fe29:docs/BUG.md   # final state, session 3
```

### Leftovers still worth deleting

External resources spun up during that investigation. All on free tiers, so
nothing is accruing cost, but none of them are needed:

- **Supabase sandbox project** `sjopptjqciyjtqqfnsun` (Tokyo) — created only to
  prove the bug wasn't project-state. Dashboard → that project → Settings →
  General → Delete Project.
- **Supabase Third-Party Auth → Clerk row** on the production project
  (`cannojsxduvlewimwoxa`), registered against
  `humble-kingfish-89.clerk.accounts.dev`. Authentication → Third-Party Auth →
  remove the Clerk row.
- **The whole Clerk application** ("Performance Property Tools"). Clerk Dashboard
  → Settings → Danger Zone → Delete Application removes its users, the Supabase
  JWT setup and the integration together.
- **`auth-migration` branch** — the Clerk experiment. Never merged, not in
  production, and should not be merged. Delete it or leave it as a curiosity.

The production project `cannojsxduvlewimwoxa` is of course the live one — keep.
