# GUI review — Companion Hub, 2026-09-17

> **Purpose:** Findings from a screen-by-screen review of the whole GUI. Every finding here survived an
> adversarial verification pass whose default was to refute.
> **Scope:** `packages/frontend`, `packages/desktop/bootstrap`, `packages/desktop/src-tauri/src/tray.rs`.
> **Method:** 16 reviewers, one per screen group, each across six dimensions (layout, design system,
> functionality and state, accessibility, copy, docs and tests), then one independent refuter per finding.
> **Owner persona:** code-quality + product
> **Last updated:** 2026-09-17
> **Related:** docs/system/ui-screens.md, docs/system/user-flows.md, docs/UI-STYLE-GUIDE.md

---

## How to read this

108 findings confirmed, 20 refuted and dropped, and 120 more found but not reported, because each reviewer was capped
at its eight most significant. The cap makes this list a floor rather than a ceiling — most visibly for accessibility
and copy, where several reviewers spent the cap on functional defects first.

Every screen group is tracked as a GitHub issue (right-hand column below, label `gui-review-2026-09`); the eight
`high` findings that are single-file, self-contained fixes are collected in #1527, and the installed-app e2e
fixture that would unlock four untestable screens is #1528. Tick a finding there when it lands; this file stays
as written.

Findings are derived from source, not from a live appliance. Any operator address, tailnet hostname or CGNAT address a
reviewer quoted has been redacted, per the tip-scrub policy in `docs/README.md`.

Severity is the reviewer's, kept as-is. Treat it as a sort key, not a commitment: `high` here means "a real user hits
this and is blocked or misled", not "ship-blocking".

| Dimension | Confirmed | | Severity | Confirmed |
|---|---|---|---|---|
| functionality | 49 | | high | 60 |
| accessibility | 19 | | medium | 48 |
| layout | 16 | |  |  |
| copy | 15 | |  |  |
| design-system | 8 | |  |  |
| docs-tests | 1 | |  |  |

| Screen group | Key | Findings | Issue |
|---|---|---|---|
| Sign-in, register, reset password | `auth` | 7 | #1511 |
| Device registration | `device-reg` | 4 | #1512 |
| Onboarding wizard | `onboarding-wizard` | 7 | #1513 |
| Onboarding install and interstitials | `onboarding-install` | 6 | #1514 |
| Dashboard and guest dashboard | `dashboard` | 7 | #1515 |
| App store browse | `app-store` | 8 | #1516 |
| App details and update | `app-details` | 6 | #1517 |
| Custom apps and port expose | `custom-apps` | 6 | #1518 |
| Settings: general and security | `settings-core` | 7 | #1519 |
| Settings: network and pool | `settings-network` | 7 | #1520 |
| Settings: AI and MCP | `settings-ai-mcp` | 8 | #1521 |
| Settings: system and logs | `settings-system` | 6 | #1522 |
| Resource monitor | `resource-monitor` | 8 | #1523 |
| App shell and shared states | `shell` | 7 | #1524 |
| Mobile surfaces | `mobile` | 6 | #1525 |
| Desktop bootstrap and tray | `desktop-shell` | 8 | #1526 |

---

## Verified first-hand, and what was changed

Everything in the per-screen sections below came from a reviewer and an independent refuter. The items in this
section were reproduced directly — in the running GUI of a live appliance, or by reading the cited code — and the
ones marked **fixed** were changed in this pass. They are listed separately because their provenance differs, not
because they are more or less severe.

| # | Finding | Location | Status |
|---|---|---|---|
| 1 | "Downloaded models" printed each model's name and id, which every backend sets to the same string for an uncatalogued model — so a stock Ollama host showed the same tag twice on all 11 cards, and the useful line truncated first | `ai-settings.tsx:760`, root cause `ollama.backend.ts:263` | **fixed** — the id renders only when it differs |
| 2 | The Installed-MCP-servers table linked to `/app-store/<appName>/<appStoreId>`: no such route exists, and the segments are reversed relative to `/store/:storeId/:appId`, so every row landed on the 404 page | `mcp-settings.tsx:292` | **fixed** — now `/apps/<storeId>/<appName>`, matching `horizontal-app-list.tsx:87` |
| 3 | The catch-all 404 route sits outside both layout guards, so it has no height-bearing ancestor: `h-full` resolved to the content height, `justify-center` did nothing, and the page rendered jammed against the top of an empty viewport | `routes/not-found.tsx:10` | **fixed** — `min-h-screen` |
| 4 | 404 copy read "404 - Page Not Found" and "Oops! The page you are looking for does not exist." — Title Case and a filler interjection, both against `docs/writing-style.md` | `en.json:1917-1918` | **fixed** — "Page not found" / "This page does not exist…" |
| 5 | The model size groups rendered "Large models - 70B+" and "Small models - <=14B", showing a literal `<=`. The i18n strings had degraded the punctuation that the now-unreachable hardcoded fallbacks at `model-selection-card.tsx:332-347` got right | `en.json:1207-1209` | **fixed** — `·`, `–`, `≤`, matching the fallbacks |
| 6 | The release-notes card used `text-yellow-500`, a raw Tailwind palette value that does not follow the theme — the drift `docs/UI-STYLE-GUIDE.md` exists to prevent | `general-actions.tsx:358` | **fixed** — `text-warning` |
| 7 | 149 raw Tailwind palette classes (`bg-red-500`, `bg-gray-800`, `text-amber-400`, …) across 23 frontend files, none of which follow the theme | `packages/frontend/src` | reported — count reproducible below |
| 8 | When a release body is empty or the literal `Release <version>` that automation produces, the release card collapses to a title-only card restating a version already shown in the sentence above it and in the button, leaving a clipped decorative star as its only other content | `general-actions.tsx:342,356` | reported, deliberately not changed — `general-actions.test.tsx:277` asserts the card renders in exactly this case, so suppressing it is a product decision rather than a cleanup |
| 9 | Clicking **Settings** from the app store carries the store's browse params onto the settings URL: the address becomes `/settings?category=featured&store=ci-marketplace`, with no `?tab=`. `applyStoreBrowseParams` builds on `new URLSearchParams(searchParams)`, so it adds to whatever is already there | `store-browse-params.ts:35`, observed live | reported |
| 10 | The page-transition depth calculation still branches on an `/app-store` path prefix, which is not a route — dead since the store moved to `/store` | `layouts/dashboard/layout.tsx:82` | reported |
| 11 | The Logs tab has no service filter and no search. Its only controls are Follow logs, Wrap lines, Max lines and Download full logs | `containers/logs.tsx:59-77`, observed live | reported — CI-Docs documents both controls; the docs side is the defect |
| 12 | The settings footer reads "…See release notes for details." with no link on "release notes" | observed live | reported |

To reproduce #7:

```bash
grep -rnoE "(text|bg|border)-(red|yellow|green|blue|amber|orange|purple|pink|indigo|teal|cyan|emerald|lime|sky|violet|fuchsia|rose|slate|gray|zinc|neutral|stone)-[0-9]{2,3}" packages/frontend/src | wc -l
```

### Two claims that did not survive checking

Recorded because both looked real in the GUI and both were wrong:

- **"Settings tabs are not deep-linkable."** A first click appeared to focus a tab without selecting it, and the
  URL did not change. Both were automation artifacts. A single real click selects the tab *and* writes `?tab=`, and
  `/settings?tab=network` selects Network on load. The tabs are correctly deep-linkable and shareable.
- **"The Logs pane overflows its container."** A 17px `scrollWidth` excess with `overflow-x: visible` looked like
  clipped, unreachable log text. `documentElement.scrollWidth === clientWidth`, so nothing overflows the page and
  the inner terminal owns its own scroller. Not a defect.

---

## Sign-in, register, reset password

### Auth layout ignores the mobile safe area it defines everywhere else

`high` · layout · `packages/frontend/src/components/layouts/auth/layout.tsx:21`

The layout sizes itself with `height: calc(100vh - var(--titlebar-height))` and `paddingTop:
calc(var(--titlebar-height) + 2rem)`, and pins the language selector at `top: calc(var(--titlebar-height) + 0.25rem)`
(line 23). `--titlebar-height` is the desktop Tauri titlebar and is 0px on a phone. It never touches `--safe-area-top`
/ `--safe-area-bottom`, which `globals.css:51-54` sets to `max(env(...), 59px)` and `max(env(...), 34px)` under
`html.ci-mobile` precisely because the edge-to-edge WKWebView reports `env()` as 0, nor the `.safe-area-inset` utility
(globals.css:145-150) that every `/connect` page uses. It also uses `100vh` rather than the `min-h-dvh` used by
connect-page.tsx:191 and mobile-load-error.tsx:14. /login is a first-class mobile route — docs/system/frontend.md:110
says the app continues to /login after a Hub is chosen, and login-page.tsx:236 renders a mobile-only "Switch Hub"
button.

**What the user sees.** Open the iOS app, pick a Hub, and land on /login. The language selector sits 4px from the top
of the screen, entirely under the Dynamic Island — invisible and untappable — and the logo's top edge is clipped by
it. At the bottom, `pb-8` (32px) is less than the 34px home indicator, so the "Switch Hub" link is overlapped by the
indicator; with the software keyboard up, `100vh` also exceeds the visual viewport, so the submit button ends up below
the fold of a container that has already consumed the scroll.

**Fix.** Replace the inline `height` with `min-h-dvh` plus `paddingTop: calc(var(--titlebar-height) +
var(--safe-area-top) + 2rem)` and `paddingBottom: calc(var(--safe-area-bottom) + 2rem)`, and offset the language
selector by `--safe-area-top` too — or simply add the existing `safe-area-inset` class, as connect-page.tsx does.

### Reset-password failures always blame the link, never the real reason

`high` · functionality · `packages/frontend/src/lib/auth-password-reset-api.ts:33`

`completeResetPassword` reads the error body from `result.data`, but the generated client never populates `data` on a
non-2xx — `packages/frontend/src/api-client/client/client.gen.ts:186-218` throws the parsed body and returns it as
`error`, with no `data` key. So `message` is always `undefined`, and `reset-password-page.tsx:98` falls through to
`t('AUTH_RESET_PASSWORD_COMPLETE_FAILED')` = "Unable to reset password. The reset link may be invalid or expired." for
every failure. Two bugs stack here: the body is read from the wrong field, and `reset-password-page.tsx:103-104`
toasts `message` with no `t()` — the backend's `message` is a translation KEY (`exception.filter.ts:98-102` serialises
`TranslatableError`'s key verbatim), so even after fixing the field the user would see
`AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY` as literal text. `requestResetPassword` at line 22-23 has the identical dead
read.

**What the user sees.** Click a valid emailed reset link and enter `newpassword1` twice (12 chars, so the form's own
min(8) rule passes). The backend rejects it on complexity (auth.service.ts:1157), but the toast says "Unable to reset
password. The reset link may be invalid or expired." The user requests a fresh email and retries the same password,
and the flow fails identically forever — the link was fine all along.

**Fix.** Read the failure body from `result.error` (and keep `intlParams`), then render it through `t()` like
login-page.tsx:160 does: `toast.error(t(key, intlParams))`. Keep `AUTH_RESET_PASSWORD_COMPLETE_FAILED` only as the
fallback when no key comes back.

### Register success toast prints a raw translation key

`high` · copy · `packages/frontend/src/modules/auth/pages/register-page.tsx:36`

`toast.success(t('AUTH_REGISTER_EMAIL_VERIFICATION_REQUIRED'))` uses a key that exists nowhere in
`packages/common/i18n/translations/*.json` — grep finds it in exactly one file, this one. `i18n-provider.tsx` sets no
`parseMissingKeyHandler` and no `fallbackValue`, so i18next returns the key itself. The branch is live, not dead:
`packages/backend/src/modules/auth/auth.service.ts:822-824` returns `requiresEmailVerification: true` whenever
`signUpWithPortal` comes back not-signed-in, and `auth.controller.ts:313` forwards it. On top of the raw key, the page
does nothing else — no navigation, no state change — so the register form stays on screen with the email and both
passwords still filled, as if the submit had failed.

**What the user sees.** On a fresh Hub, enter a brand-new email and `Passw0rd!` on /register and submit. Portal
accepts the signup but requires email verification, so the toast that appears reads literally
"AUTH_REGISTER_EMAIL_VERIFICATION_REQUIRED" and the filled-in form stays put. The user has in fact been registered and
must go check their inbox, but nothing on screen says so.

**Fix.** Add `AUTH_REGISTER_EMAIL_VERIFICATION_REQUIRED` to `packages/common/i18n/translations/en.json` ("Check your
email to verify this address, then sign in.") and replace the toast with a rendered post-submit state on the page, the
way /reset-password does at reset-password-page.tsx:146-156, so the instruction survives a refresh. Consider a CI
check that fails when a `t('KEY')` literal in packages/frontend has no entry in en.json.

### Form validation errors are not announced to screen readers

`medium` · accessibility · `packages/frontend/src/components/ui/Input/InputGroup.tsx:102`

`{error && <p className="text-[0.8rem] font-medium text-destructive">{error}</p>}` renders the message as a bare
sibling: the input gets no `aria-invalid`, the `<p>` gets no `id`, and there is no `aria-describedby` or live region
tying them together. `Input.tsx:36` is identical. Every error on these screens flows through those two props —
`errors.email?.message` and `errors.passwordConfirm?.message` in login-form.tsx:145/155, register-form.tsx:53/62/70,
reset-password-form.tsx:49/58 — and react-hook-form does not move focus to the first invalid field either, so nothing
about the failure is exposed programmatically. The invalid state is otherwise signalled only by `border-destructive`,
i.e. by colour.

**What the user sees.** A screen-reader user fills /register, mistypes the confirmation, and presses Enter. The page
does not navigate and the reader announces nothing: focus stays on the submit button, the field is not marked invalid,
and "Passwords do not match" is painted below a field the user cannot associate it with. They have no way to learn why
the form refused to submit.

**Fix.** In both Input and InputGroup derive `const errorId = `${id || name}-error``, set `aria-invalid={Boolean(error
|| isInvalid)}` and `aria-describedby={error ? errorId : undefined}` on the input, and give the `<p>` `id={errorId}`
plus `role="alert"`. Then add a test asserting the input is described by its error text.

### Register and reset forms accept passwords the backend will reject

`medium` · functionality · `packages/frontend/src/modules/auth/components/register-form.tsx:22`

The client schema is `z.string().min(8)` on both fields, and reset-password-form.tsx:21-22 is the same. The backend
requires far more: `packages/backend/src/common/helpers/password-policy.ts:1` is
`/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/`, enforced at auth.service.ts:816 for register and
auth.service.ts:1157 for reset. The regex lives in `packages/backend` and is not exported through `packages/common`,
so the frontend cannot reuse it and has drifted. Neither form states the rule anywhere — no help text, no checklist —
and the only place the requirement appears is the error string `AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY` a user sees
after failing.

**What the user sees.** On /register type `mypassword1` twice. Both fields validate clean, the submit button enables,
the request goes out, and the answer is a red toast "Password must be at least 8 characters and include uppercase,
lowercase, a number, and a symbol" with no error on either field — the form's own label still promises "at least 8
characters". The user guesses and resubmits. On /reset-password the same input produces the wrong message entirely
(see the reset-password finding), so they never learn the rule at all.

**Fix.** Move `PASSWORD_COMPLEXITY_REGEX` into `packages/common` and validate against it in both zod schemas with
`t('AUTH_ERROR_INVALID_PASSWORD_COMPLEXITY')` as the message, and show the requirement as `helpText` on the password
field before the user types.

### "Cancel password change request" cancels nothing

`medium` · copy · `packages/frontend/src/modules/auth/components/reset-password-form/reset-password-form.tsx:69`

The secondary button is labelled `AUTH_RESET_PASSWORD_CANCEL`, which en.json defines as "Cancel password change
request". Its handler is supplied at reset-password-page.tsx:143 as `onCancel={() => navigate('/login')}` — it only
navigates. No request is revoked, the emailed token stays valid for its full TTL, and no endpoint for revoking it is
even called. The same screen's other escape hatch (reset-password-page.tsx:125/177) is labelled "Back to login" for
exactly this behaviour, so one action has two labels and only one of them is true. It also breaks the sentence-case,
action-named convention in docs/writing-style.md by describing an operation the button does not perform.

**What the user sees.** A user who requested a reset by mistake — or who suspects the email was triggered by someone
else — opens the link, sees "Cancel password change request", clicks it to void the outstanding reset, and lands on
/login believing the token is dead. It is not: the emailed link still works until it expires, and anyone holding that
email can still set the password.

**Fix.** Relabel the button "Back to login" (reuse `AUTH_RESET_PASSWORD_BACK_TO_LOGIN`, which the rest of the route
already uses), or wire `onCancel` to a real token-revocation endpoint before keeping the current wording.

### The two-factor step is a dead end that wipes the code on every failure

`medium` · functionality · `packages/frontend/src/modules/auth/pages/login-page.tsx:192`

Once `totpSessionId` is set the page returns `<TotpForm/>` and nothing else — no cancel, no "use a different account",
no back link. `totpSessionId` is component state, not a URL segment, so the browser Back button leaves /login entirely
rather than returning to the password step, and `verifyTotp.onError` (line 165-167) only toasts: it never clears
`totpSessionId`, so an expired TOTP session shows the same generic toast on every retry with no way to restart. The
form makes it worse: `totp-form.tsx:21` calls `setTotpCode('')` on submit, so a rejected code clears all six boxes,
and nothing refocuses box 1 (OtpInput has no `autoFocus` and `OtpInput.tsx:87` blurs after a full paste), so the user
must click back into the field before retyping.

**What the user sees.** Sign in on a Hub with TOTP enabled, then mistype one digit. The toast says the code is
invalid, all six boxes go blank, focus is nowhere — on a phone the keyboard closes — and the user must tap box 1
again. If their authenticator no longer has this account, or the totpSessionId has expired, there is no cancel button:
the only escape from the screen is a manual page reload.

**Fix.** Add a "Back to sign in" secondary button to TotpForm that clears `totpSessionId`, keep the entered code on
failure (clear only on success), give the first OTP box `autoFocus`, and clear `totpSessionId` when the error
identifies an expired or unknown session so the user is returned to the password form.

---

## Device registration

### The screen cannot be translated, but the language selector sits on it — and the one dialog that IS translated makes the screen bilingual

`high` · copy · `packages/common/i18n/translations/de-DE.json:1`

`AuthLayout` renders `LanguageSelector` with all 19 locales at layout.tsx:23-25, on this screen. Of the 79
`DEVICE_REGISTRATION_*` keys in `en.json`, every non-English locale except es-ES ships exactly 20 — and all 20 are
`DEVICE_REGISTRATION_STATE_DRIFT_*`. Nothing the pairing form renders (STEP_1_TITLE, STEP_2_TITLE, CURRENT_DEVICE_ID,
ENTER_PAIRING_CODE, REGISTER, the three hint strings, CHECKING_STATUS, LOADING_HUB) is translated anywhere. Verified
against the live appliance: `GET http://beta-max:5002/api/i18n/locales/translation/de-DE.json` returns 701 keys
(en.json has 2425) with `DEVICE_REGISTRATION_STEP_1_TITLE` absent, so the i18n-provider's en-merge
(i18n-provider.tsx:59) falls the whole screen back to English.

**What the user sees.** A German owner picks Deutsch from the selector in the corner of the setup screen and literally
nothing on the page changes. If the state-drift modal then opens, it appears fully in German ('Diesen Hub erneut
verbinden', 'Mein Gerät wiederherstellen') on top of an all-English page — one screen in two languages, at the moment
the user must make an irreversible restore-or-start-fresh choice.

**Fix.** Either backfill the rendered `DEVICE_REGISTRATION_*`/`REGISTRATION_*_HINT` keys for the shipped locales, or
gate `LanguageSelector` to locales that clear a coverage threshold so the selector never offers a language the screen
cannot render. A CI check comparing each locale's key set against `en.json` for the FTUE key prefixes would keep it
honest.

### Every provisioning progress message set after pairing is unreachable — the user gets a bare spinner for up to 5 minutes

`high` · functionality · `packages/frontend/src/modules/auth/pages/device-registration-page.tsx:345`

`finishRegistrationFlow` nulls `pendingPairTargetRef.current` on line 345, before it sets any status copy. But
`showProgressState` (lines 670-672) is the only branch that renders `redirectStatus`, and for an operational status it
is gated on `Boolean(pendingPairTargetRef.current)`. The effect that starts the flow (line 450) only runs once the
phase is NOT unregistered/paired/provisioning, so `isRegistrationPending` is false too. The first
`setRedirectStatusKey` inside the flow (line 365) therefore re-renders into the generic operational branch at lines
737-751 instead. Four written-and-translated messages — LOCAL_SETUP_COMPLETE_CHECKING_PUBLIC_URL,
WAITING_DNS_PROPAGATION (line 388), STILL_WAITING_PUBLIC_URL (line 391), PUBLIC_ROUTE_PROPAGATING (line 397) — plus
the degraded title on line 356 can never be displayed.

**What the user sees.** Owner pastes a valid pairing code on a fresh appliance. The progress screen flashes, then the
whole domain-probe window (60 attempts x 5s = up to 5 minutes) renders only a spinner, 'Registration complete', and
'Loading your Hub...'. The 'Check again' button disappears with it. Nothing tells them DNS is still propagating, so
the natural reaction is to reload or power-cycle the box mid-provision.

**Fix.** Keep the pair target for the duration of the flow: read it into a local but clear
`pendingPairTargetRef.current` only in the branches that navigate away, or replace the ref gate in `showProgressState`
with an explicit `isFinishing` state that `finishRegistrationFlow` sets on entry and never unsets. Add a test that
renders a registered non-pending phase after a successful pair and asserts the probe copy is on screen.

### `continue` skips the probe interval, so the two-consecutive-probes guard collapses into two back-to-back requests

`high` · functionality · `packages/frontend/src/modules/auth/pages/device-registration-page.tsx:378`

`REQUIRED_CONSECUTIVE_PROBES = 2` with `DOMAIN_PROBE_INTERVAL_MS = 5000` (lines 44-46) is clearly meant to confirm the
public URL is stable over ~5 seconds before handing the browser over. The `await sleep(DOMAIN_PROBE_INTERVAL_MS)` sits
at line 394, at the bottom of the loop, but the success path `continue`s at line 378 and skips it. So probe #2 fires
one network round-trip after probe #1, and `window.location.href` (line 375) is set the moment both return `ready`.

**What the user sees.** Cloudflare's tunnel flaps ready/not-ready during propagation (the exact condition this loop
exists for). Two probes land inside the same brief ready window, so the page immediately navigates the browser off the
Hub UI to `https://<sub>.<domain>/login`, which then serves a Cloudflare 1033/530 error page. The owner is now on a
dead public hostname with no back-link to the local Hub, at the end of first-run setup.

**Fix.** Move the interval so it runs after a success too — replace the `continue` with an `await
sleep(DOMAIN_PROBE_INTERVAL_MS); continue;`, or restructure the loop to sleep at the top on every attempt after the
first. The reset-on-failure on line 385 is already correct once the spacing is real.

### One transient status-fetch failure stops polling for good, and the pairing form offers no way to restart it

`medium` · functionality · `packages/frontend/src/modules/auth/pages/device-registration-page.tsx:420`

`shouldPoll` on line 420 requires `!statusError`, so the 5s headless poll (HEADLESS_POLL_INTERVAL_MS, line 43) stops
as soon as one status request throws. A 'Check again' / 'Retry status check' control exists in the progress branch
(line 718) and the no-status branch (line 733), but the pairing-form branch (lines 776-930) renders `statusError` as a
warning `Alert` on line 908 with no button beside it. `refreshRegistrationStatus` keeps the previous `unregistered`
status (lines 322-333), so that branch is exactly where a mid-provision backend restart lands the user.

**What the user sees.** Headless appliance is being registered from the Portal in another browser. The Hub backend
restarts for a second, one `/api` status call fails, and the screen shows 'We couldn't confirm your Hub status right
now. This is usually temporary. Please retry in a moment.' — with nothing to retry. Polling never resumes, so when the
external registration completes the screen never advances. The owner sits on a stale pairing form until they think to
reload the page.

**Fix.** Put the same 'Check again' button next to the `statusError` alert in the pairing-form branch, or resume
polling on a backoff instead of stopping dead (keep the existing 'does not keep polling registration status after a
failed lookup' test honest by asserting a slower interval rather than zero).

---

## Onboarding wizard

### Rescan silently reverts the chosen backend and discards every model the operator ticked

`high` · functionality · `packages/frontend/src/modules/onboarding/components/ai-setup-step.tsx:437`

`handleRescan` calls `fetchProfile(true)` with no `backendOverride`. `fetchProfile` then recomputes `requestedBackend
= recommendedInferenceBackend(data)` (line 209) and unconditionally writes `setSelectedBackend(resolvedBackend)`
(214), `setSelectedModelIds(getDefaultSelectedModelIds(...))` (216) and `setPreferredModelId(...)` (217).
`getDefaultSelectedModelIds` keeps only ids present in `installedCatalogIds`, so any model the operator selected for
download is dropped. The component already holds `selectedModelIdsRef` / `preferredModelIdRef` (152-155) precisely to
preserve edits across a refresh, but only `refreshInstalledModels` (327-366) consults them — `fetchProfile` never
does. The existing tests at lines 756-786 and 820-848 guard only the *raced* variant, and their own comments name this
reset as the harm they are preventing ("reset their models to Ollama's defaults"), so the uncontested click is
unguarded and untested. The same reset fires from the error screen's Retry button (line 659).

**What the user sees.** On an Apple Silicon Hub (recommended backend `dspark`) the operator deliberately switches to
Ollama, ticks 3 not-yet-downloaded models, then clicks Rescan at the top of System Overview (which the no-GPU notice
at system-overview.tsx:215 explicitly tells them to do). The rescan succeeds; the backend radio jumps back to
mlx-dspark and all 3 model tiles silently untick, with no message. They press Install & Finish believing their picks
are still in.

**Fix.** Give `fetchProfile` the same preservation `refreshInstalledModels` already has: pass the current
`selectedBackend` as `backendOverride` from `handleRescan`, and reconcile `selectedModelIdsRef.current` against the
new profile (keeping still-selectable ids) instead of overwriting with `getDefaultSelectedModelIds`. Add an
uncontested-rescan test asserting backend and selection survive.

### Keyboard focus is completely invisible on every model tile and both access-method options

`high` · accessibility · `packages/frontend/src/modules/onboarding/components/ai-setup/primitives.tsx:299`

`ModelCard` wraps an `<input type="checkbox" className="sr-only">` (line 306) in a `<label>` whose class list
(301-304) has no `focus-within:` state. `access-methods-card.tsx:39-51` and `71-83` do the same for the Web and
Private VPN options. There is no global focus-visible rule to fall back on: `globals.css` has none and
`@companionintelligence/tokens/globals.css` has no `focus`/`outline` declarations at all. The correct pattern already
exists two files away — `companion-apps-card.tsx:144` carries `focus-within:ring-2 focus-within:ring-primary
focus-within:ring-offset-2` — and `Button.tsx:8` has `focus-visible:ring-1`, so focus is visible on every button on
the page but on none of the selection cards. Compounding it, `HintText` (`components/ui/field-hint/field-hint.tsx:37`)
adds `tabIndex={0}` to a non-interactive `cursor-help` span, so each access-method option consumes two tab stops and
neither renders anything.

**What the user sees.** A keyboard-only operator tabs past Rescan into Step 1. Focus lands on the hidden Web checkbox:
nothing on screen changes. They press Space to "see what has focus" and toggle public web exposure off without knowing
it. Tabbing on through Step 4 they cross ~8 model tiles with no visual indication of position at any point.

**Fix.** Add `focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2` to the `ModelCard` label class
list and to both `access-methods-card` labels, matching `companion-apps-card.tsx:144`, and drop `tabIndex={0}` from
`HintText` (or make it a real button) so hint spans are not tab stops.

### Sticky "Install & Finish" button is off-screen on mobile browsers and under the iOS home indicator

`high` · layout · `packages/frontend/src/modules/onboarding/pages/onboarding-page.tsx:84`

`Shell` sets a fixed `height: calc(100vh - var(--titlebar-height, 0px))` with `overflow-y-auto`, making itself the
only scroller — `root.tsx:669` wraps it in a plain `<main id="root">` with no height, so the document has nothing to
scroll. On iOS Safari and Android Chrome `100vh` is the viewport with toolbars *collapsed*, so the container is taller
than what is visible, and the primary CTA at line 368 (`sticky bottom-4`) anchors to the container's bottom edge —
below the visible region — with no document scroll available to collapse the toolbar. The Shell also applies no
safe-area padding, unlike every other mobile entry point in this codebase (`root.tsx:58` and
`mobile-connect/pages/connect-page.tsx:191` both use `safe-area-inset min-h-dvh`), so in the Tauri mobile shell
(`html.ci-mobile` sets `--safe-area-bottom: 34px` in globals.css:53) the 16px-offset footer overlaps the home
indicator.

**What the user sees.** A user opens their Hub's URL in iOS Safari, logs in and lands on /onboarding. They scroll the
whole form, but the footer card holding "Install & Finish" never appears above Safari's bottom toolbar — the wizard
cannot be completed from a phone browser at all.

**Fix.** Use `100dvh` (or `min-h-dvh` and let the document scroll, as `restore-apps-page.tsx:169` does with
`minHeight`) instead of a fixed `100vh` height, and add `safe-area-inset`/`pb-[env(safe-area-inset-bottom)]` to the
Shell so the sticky footer clears the home indicator.

### On insufficient hardware the form's only numbered steps are 6 and 7, and the sole AI path is inside a collapsed drawer

`medium` · layout · `packages/frontend/src/modules/onboarding/components/ai-setup-step.tsx:707`

Steps 1 through 5 all sit inside `{!isInsufficient && (...)}` (707-846). When `profile.tier === 'insufficient'` the
operator therefore sees: the unnumbered System Overview, then a panel badged "6 · RECOMMENDED PRIVATE APPS ·
Optional", then "7 · ADVANCED · Optional" — a step ladder that starts at six. Worse, cloud API keys are the *only* way
that operator gets AI at all, and `advanced-drawers.tsx:21` renders step 7 with `collapsible defaultOpen={false}`, so
`ONBOARDING_CLOUD_PROVIDER_REQUIRED_HINT` ("Your hardware can't run local AI models. Configure a cloud provider to use
AI features.") is hidden until the drawer is expanded. The test at `__tests__/ai-setup-step.test.tsx:870`, named
"shows cloud provider inputs *prominently* when tier is insufficient", has to click `step-section-toggle-7` before it
can find them — the test itself demonstrates they are not prominent. Meanwhile the page footer
(onboarding-page.tsx:374) reads "You can change everything later in Settings." and Install & Finish is enabled.

**What the user sees.** An operator installs the Hub on a 4 GB CPU-only box. The form shows a red "Insufficient" tier
chip, then jumps straight to a step numbered 6. Nothing on screen says local models are impossible or that they must
open Advanced, so they press Install & Finish and finish onboarding with no inference path configured.

**Fix.** Renumber the surviving sections when `isInsufficient` (pass the number down rather than hard-coding it in
each card), and pass `defaultOpen={insufficientHardware}` to the Advanced `StepSection` so the cloud-key requirement
is visible by default on that tier.

### The production form has no backend-readiness gate; Install & Finish is enabled with the engine unreachable and says nothing

`medium` · functionality · `packages/frontend/src/modules/onboarding/components/ai-setup-step.tsx:684`

`needsOllamaForContinue` … `needsLemonadeForContinue` (684-690) are computed on every render but consumed only by the
`{!embedded && ...}` Continue button at 852-888. Onboarding always renders `<AiSetupStep embedded …>`
(onboarding-page.tsx:339), so the entire readiness gate is inert on the shipping path. The page's own gate is
`canFinish = aiSetupConfig !== undefined && !aiSetupConfig.installBlocked` (onboarding-page.tsx:186), and
`installBlocked` is set for exactly one condition — `budget.overDisk` (ai-setup-step.tsx:544). The footer's status
line (371-375) only ever shows the disk reason, "Loading recommended apps…", "Detecting your hardware..." or "You can
change everything later in Settings." Nothing downstream covers it either: `install-step.tsx` contains no readiness
check at all, and the page's model pull runs with `bestEffort: true` (onboarding-page.tsx:210).

**What the user sees.** A Linux Hub operator leaves Ollama (the default backend) not installed. Step 3 shows the amber
"Ollama isn't installed" card, but they scroll past it, tick a recommended model, and the footer says "You can change
everything later in Settings." with Install & Finish enabled. They click it, the apps install, the model pull silently
no-ops, and they arrive on /home with an agent that has no engine and no explanation.

**Fix.** Feed the already-computed `needs*ForContinue` flags into the emitted config (an `engineUnready` flag
alongside `installBlocked`) and have the footer state it — either disabling Install & Finish or showing an explicit
"Ollama is not reachable; models will not download" warning next to the button.

### Three different backend choices are all labelled "Speculative inference", and two engines ship with no description

`medium` · copy · `packages/frontend/src/modules/onboarding/components/ai-setup/backend-selection-card.tsx:32`

`BACKEND_INFO.lucebox.label` is "Speculative inference"; the group heading above it,
`ONBOARDING_BACKEND_SPECULATIVE_GROUP` (line 182), is also "Speculative inference"; and picking the *different* option
labelled "mlx-dspark" opens a panel headed `ONBOARDING_DSPARK_SECTION_TITLE` = "Set up Speculative inference"
(ai-setup-step.tsx:771), identical in wording to the `lucebox` panel's `ONBOARDING_SPECULATIVE_SECTION_TITLE` = "Set
up speculative inference" (739) apart from one capital letter. Separately, `mtplx` and `dspark` are the only two
entries in `BACKEND_INFO` with no `descriptionKey` (lines 30-31), so those rows render just "MTPLX" / "mlx-dspark"
plus a status dot while Ollama, vLLM, Lemonade and Speculative inference each get an explanatory line; "MTPLX" is
never expanded anywhere in the UI, and the only explanation is a hover-only `react-tooltip` (`field-hint.tsx:34`) that
a touch user cannot reach. The shared group description `ONBOARDING_BACKEND_DSPARK_DESC` ("Speculative decoding on
Apple Silicon, 2x - 4x Speed boost") also mid-sentence-capitalises "Speed" and uses a spaced hyphen as a range dash.

**What the user sees.** An Apple Silicon operator opens Step 3 and sees a group titled "Speculative inference"
containing rows "mlx-dspark", "MTPLX" and "Speculative inference". They tick "mlx-dspark"; the panel below is headed
"Set up Speculative inference", which is the exact heading the third row would have produced. On a tablet they cannot
hover the label, so "MTPLX" stays an unexplained acronym and they have no basis for choosing between the three.

**Fix.** Give the `lucebox` row a distinguishing label (e.g. "Lucebox (GPU)") or name the group differently from its
members, title the dspark panel "Set up mlx-dspark", and add `descriptionKey` entries for `mtplx` and `dspark` so
every row explains itself without a hover tooltip.

### Hardware tier badge uses emoji as its icon, unlabelled, over raw Tailwind palette colours

`medium` · design-system · `packages/frontend/src/modules/onboarding/components/ai-setup/system-overview.tsx:93`

The tier chip renders `{badge.emoji} {badge.label}`, and `helpers/hardware-display.ts:26-50` supplies 🚀 / ⚡ / 💡 / 🔧 /
☁️ / 🎮 / ✨ as those icons — the only emoji glyphs on this screen, which otherwise uses lucide throughout (`Monitor`,
`Cpu`, `MemoryStick`, `HardDrive`) plus the local `GpuIcon`/`VramIcon`. They carry no `aria-hidden`, so a screen
reader announces "rocket High" / "cloud Insufficient". The same records also hard-code raw palette classes
(`bg-green-100 text-green-800 dark:bg-green-900`, `bg-sky-950`, `bg-violet-100`, `bg-orange-100`, `bg-red-100`) for
what is a status signal, which docs/system/frontend.md:147-154 explicitly forbids: "Do not add component-local yellow,
amber, green, or emerald ramps or dark-mode shade overrides for these roles." The in-file comment at
hardware-display.ts:17-24 justifies not moving to the `--level-*` scale (a real polarity conflict) but says nothing
about `--success`/`--warning`/`--destructive`, and docs/UI-STYLE-GUIDE.md Part III never lists this drift at all.
Emoji also render at different sizes and colours per platform, so the chip's height shifts between macOS and Linux.

**What the user sees.** A VoiceOver user reaching the System Overview strip hears "rocket High" with no way to know
what the rocket means, and the sighted equivalent is a glyph that no other icon on the page matches. On the
'insufficient' tier the ☁️ emoji renders a blue cloud inside a red chip, so the colour and the icon disagree about
severity.

**Fix.** Replace `emoji` with a lucide icon per tier (e.g. `Rocket`, `Zap`, `Lightbulb`, `Wrench`, `Cloud`) rendered
with `aria-hidden`, and back the chip with `--success`/`--warning`/`--destructive` token classes as
docs/system/frontend.md requires; add the row to UI-STYLE-GUIDE Part III if the level-scale polarity blocks a full
migration.

---

## Onboarding install and interstitials

### A failed restore locks the user out of the whole app with no control to press

`high` · functionality · `packages/frontend/src/modules/auth/pages/restore-apps-page.tsx:227`

Retry and Continue-to-dashboard are rendered only inside the `result?.incomplete` branch (lines 227-248). When the
very first `executeRehydrate` POST fails, `runRehydrate` throws before `setResult`, so `result` and `plan` stay null
and only the red Alert (lines 178-182) renders. The page then has zero controls. Escape is impossible by navigation:
`authenticated-route.tsx:89-90` redirects every authenticated path back to /restore-apps for as long as sessionStorage
holds the drift choice `restore` and `getRehydrateStatus` reports `completed: false` — and only
`clearStoredDriftChoice()` (reachable solely from the two buttons that are not rendered) clears it. The `retry` and
`continueToDashboard` callbacks already exist at lines 131-148, unused on this path.

**What the user sees.** Operator picks "restore" after re-pairing; Portal is unreachable so executeRehydrate returns
502. The page shows "Restoring your apps" plus a red "App restore failed. You can retry from the app store or
Settings." — and nothing else. Typing /home in the address bar bounces straight back to /restore-apps. The user cannot
reach the app store or Settings the message points at; the only way out is clearing sessionStorage in devtools or
closing the tab.

**Fix.** Render the Retry + "Continue to dashboard" pair whenever `error` is set, not only when `result?.incomplete`
is true: change the guard at line 227 to `!isExecuting && (error || result?.incomplete)` and reuse the existing
`retry()` / `continueToDashboard()` handlers.

### A model pull that outlasts the 60 s onboarding budget silently loses the user's default model

`high` · functionality · `packages/frontend/src/modules/onboarding/components/install-step.tsx:186`

`pullWaitMs = 60_000` bounds the entire model-pull wait. After it lapses, a model still in `pulling` state produces no
entry in `modelErrors` (tracked-models.ts:38-52 only errors on state `error`), so no warning is shown; it is excluded
from `pinableIds` (line 225-227) so it is never pinned; and it is missing from `availablePreferenceModelIds`, so line
248 passes `model: null`, which `inference-api.ts:129` turns into `undefined` and omits from the PATCH. The preferred
model the user chose in the wizard is therefore never written anywhere. Nothing else writes it — it lives only in
wizard component state — and no dashboard surface reports in-flight pulls (`ModelDownloadStatus` is rendered only in
the form phase, onboarding-page.tsx:353). The row also visually regresses: at lines 561-585 the percentage and the `●`
glyph are both conditioned on `aiPhase.status === 'pulling-models'`, so once the phase advances the row falls back to
a bare `○` with no percentage and no label.

**What the user sees.** User selects a 20 GB model as their agent default. At the 60 s mark the pull is at 43%. The
card flips to "Installation Complete", the "Pin models" row shows a green check, and the model's own row reverts to a
hollow circle with no percentage — indistinguishable from "never started". The user continues to the dashboard
believing setup succeeded; the Hub has no preferred model set and no screen anywhere says the download is still
running.

**Fix.** Treat "still pulling at the deadline" as its own state: keep the last known percentage and an explicit "still
downloading" label on the row after the phase advances (drop the `status === 'pulling-models'` condition at lines
579-584), and either persist the preferred model id regardless of pull completion or add a footer line saying the
default model will be applied when the download finishes.

### Reloading during the install phase throws the whole wizard away and re-queues installs

`high` · functionality · `packages/frontend/src/modules/onboarding/pages/onboarding-page.tsx:132`

`phase`, `selectedApps`, `companionApps`, and `aiSetupConfig` are plain `useState` with no persistence (grep for
sessionStorage/localStorage across modules/onboarding returns nothing) and the install phase does not change the URL —
it stays /onboarding. `completeOnboarding` fires only from InstallStep's Continue handler, so a reload before that
leaves the server flag false and `authenticated-route.tsx` keeps the user in the wizard. InstallStep's own `started`
ref (install-step.tsx:87) is likewise per-mount, so a second Install & Finish re-POSTs `installApp` for apps the
backend is already installing.

**What the user sees.** Install is 90 s in, three apps queued, a model downloading. The user reloads (or the Tauri
window relaunches, or a slow Hub restart drops the page). They land back on step 1 of the wizard with every AI choice,
agent framework, and app selection blank, Install & Finish disabled until hardware is re-detected. Pressing it again
re-issues installApp for apps already mid-install, whose failures then render as red "Install failed - retry from My
Apps" rows for apps that are in fact coming up fine.

**Fix.** Persist the wizard's phase and config to sessionStorage (or move the install phase behind its own route such
as /onboarding/install) and, on remount in the install phase, seed each row's status from `getInstalledApps` instead
of `queued` so an already-running install is recognised rather than re-issued.

### The finishing interstitial's live region can never announce anything, and failure never takes focus

`medium` · accessibility · `packages/frontend/src/modules/app/pages/memory-connect-finishing-page.tsx:400`

`role="status"` with `aria-busy` is on `.mcf-status`, whose only children are the `aria-hidden` spinner and the
`aria-hidden` check icon (lines 400-406), so the live region's accessible content is permanently empty and fires no
announcement. The text that actually changes across all five phases — the `<h1>` and `.mcf-desc` at lines 408-445 —
sits outside any live region. Nothing moves focus when the card grows its "Open anyway" / "Back to dashboard" buttons,
and the `AppLogo` pair at 380-397 contributes no accessible name either (app-logo.tsx puts `alt` on
`aria-description`, a draft attribute with no AT support, and the inner `<svg>`/`<image>` have no title or role).

**What the user sees.** A screen-reader user approves the memory connection and lands here. The page announces
"Applying your memory connection" once. Three minutes later the heading silently becomes "The app didn't come back up"
and two buttons appear; nothing is announced, focus is still on `<body>`, and the user has no signal that the wait
ended or that there is now something to press.

**Fix.** Move `role="status" aria-live="polite"` onto the wrapper containing the `<h1>` and `.mcf-desc` (so phase copy
is announced), keep the spinner purely decorative, and focus the heading (`tabIndex={-1}` plus a ref focus) when
`phase` becomes `error`, `timeout`, or `ready`-without-target.

### The finishing page's failure heading contradicts its own body copy, and is false on the propagation path

`medium` · copy · `packages/frontend/src/modules/app/pages/memory-connect-finishing-page.tsx:423`

`MEMORY_CONNECT_FINISHING_ERROR_TITLE` ("The app didn't come back up") is the heading for all three failure phases,
while only the description varies (lines 423-430). For `phase === 'timeout'` with `restartPhase !== 'ready'` the body
says the app "is taking longer than expected to restart" — a heading asserting definitive failure over a body
asserting slowness. Worse, for `timedOutWhilePropagating` (line 316) `restartPhase === 'ready'`: the app demonstrably
did come back up and only its public address has not propagated, which the body says correctly ("...but X's web
address is still not responding") while the heading states the opposite. Adjacent copy issues found in the same review
and not filed separately: install-step's headings are Title Case against docs/writing-style.md's sentence-case rule
("Installation Complete", "Review Apps", "No Apps Selected", "Install & Finish"), several strings use a literal "(s)"
instead of i18next plurals so count=1 reads "1 app(s) ready to install.", and install-step.tsx:167/258 interpolate a
hardcoded `status: 0` into "...: HTTP {{status}}", showing the user "HTTP 0".

**What the user sees.** A newly exposed app restarts fine but its Cloudflare tunnel route takes over 60 s to
propagate. The card reads "The app didn't come back up" above "Your CI Memory connection was saved, but Hermes's web
address is still not responding." The user believes the container failed and goes to the dashboard to restart an app
that is already running.

**Fix.** Add two more title keys — one for the indeterminate timeout ("This is taking longer than expected") and one
for the propagation timeout ("The app's web address isn't responding yet") — and select the heading with the same
`phase` / `timedOutWhilePropagating` logic that already selects the description.

### AI-setup rows signal state with uncoloured, unlabelled text glyphs

`medium` · accessibility · `packages/frontend/src/modules/onboarding/components/install-step.tsx:538`

Every AI-phase row renders its state as a bare glyph in `<span className="w-4 text-center">` with no colour class, no
`aria-label`, no `role`, and no adjacent text status: runners (538-546), cloud providers (555), each model (561-569),
pin models (595). `✓` (success) and `✕` (failure) therefore render in identical `text-foreground`, so state is
conveyed by glyph shape alone at 14px, and `●` (in progress) versus `○` (pending) differ only by fill. A screen reader
gets "white circle" / "heavy black circle" and nothing about success or failure. The app rows directly below do this
correctly — lucide `Loader2`, `text-success` / `text-destructive` / `text-warning`, plus a text `statusLabel` (lines
413-457, 611-615) — so the same column uses three icon systems, including the literal emoji `⏳` at line 431 for the
`incomplete` state, which renders as a colour emoji rather than an icon.

**What the user sees.** On a Mac, mlx-dspark fails to install. The "Automatic local runners" row shows a plain `✕` in
body-text colour, visually near-identical to the `✓` on the row beneath it; the only other signal is a 12px
`text-warning` line. A screen-reader user hears "Automatic local runners" with no state at all, and a low-vision user
cannot tell the failed row from the succeeded ones.

**Fix.** Reuse `statusIcon`/`statusLabel` from the app rows: lucide `Loader2`/`CheckCircle2`/`XCircle` with
`text-success`/`text-destructive`, an `aria-label` or visible status text per row, and drop the `⏳` emoji from the
`incomplete` case at line 431.

---

## Dashboard and guest dashboard

### The first-run call to action is rendered at 30% opacity (~1.6:1 contrast) and is the page's only heading

`high` · accessibility · `packages/frontend/src/modules/dashboard/components/horizontal-app-list.tsx:75`

The empty state uses `text-muted-foreground/30`. `--muted-foreground` is `#3a524b` in light mode (tokens 1.1.0
globals.css:178); composited at 30% over `--card` that is roughly `#c4cbc9`, i.e. about 1.6:1 against the card — far
below WCAG AA's 4.5:1, and below even the 3:1 large-text floor. It is simultaneously an `<h1>`: /home has no other
heading (grep finds no `<h1>`/`<h2>` in the header or anywhere else in modules/dashboard), so the page's entire
heading structure is one `h1` that exists only while zero apps are installed and whose text is an instruction, not a
title.

**What the user sees.** A brand-new operator finishes onboarding with no apps installed, lands on /home, and the only
instruction on the screen — "Click here to install your first app" — is a barely visible ghost on the card; in bright
light or with any low-vision impairment it reads as an empty grey panel with nothing clickable. A screen-reader user
pulling up the heading list on /home after installing apps gets zero headings.

**Fix.** Use a legible token (`text-muted-foreground`, and put the de-emphasis in size/weight instead of opacity),
render the CTA as a real `Button`/link with descriptive text rather than an `h1`, and give the page a persistent
visually-hidden or visible `<h1>` (e.g. "Home") plus a section heading over the installed-app list.

### Both dashboard queries treat "no data" as "still loading", so a failed API call spins forever

`high` · functionality · `packages/frontend/src/modules/dashboard/pages/dashboard.tsx:63`

`const isLoading = !systemData` (line 63) and `isLoading={!appsData}` (line 108) are the only state either query has.
Neither destructures `isError`/`error`, and the global query client sets `retry: false`
(packages/frontend/src/components/providers/providers.tsx:18), so one failed response leaves `data` undefined
permanently. `systemLoad` keeps `refetchInterval: 3000` firing, so the failure repeats silently every 3 s;
`getInstalledApps` has no interval at all, so its skeletons never resolve until an SSE event or remount invalidates
the key. The page renders no error text, no stale-data notice, and no retry control anywhere.

**What the user sees.** `/api/system/load` returns 500 (systeminformation throws on the host, or the appliance is
mid-restart) and `/api/store/installed` also fails: the operator opens /home and sees a bare centred spinner where the
three stat cards belong and 16 pulsing grey rectangles where their apps belong — indefinitely, with no message
explaining that the Hub API is unreachable and no way to retry short of a full reload.

**Fix.** Destructure `isError` from both `useQuery` calls and render an inline error card (icon + one-sentence cause +
Retry wired to `refetch()`) in place of the spinner/skeletons; drive the skeletons off `isPending` rather than `!data`
so an error can never be mistaken for a pending fetch.

### Disk card prints "0%" and "0 / 0 GB" on a wedged Docker VM and drops the guidance the API already sends

`high` · functionality · `packages/frontend/src/modules/dashboard/pages/dashboard.tsx:77`

`host-metrics.service.ts:52-54` deliberately zeroes `diskSize`/`diskUsed` (and therefore `percentUsed`) when it
detects a VM wedge, and compensates by sending `hasVmWedge`, `runtimeKind`, `platformGuidance`, `containerDiskTotal`
and `containerDiskUsed` in the same payload (`packages/backend/src/modules/system/dto/system.dto.ts:15-22`). The
dashboard reads only the eight numeric fields and formats them blindly. `CompactSystemStat` even carries unused
`secondarySubtitle` and `hint` props (compact-system-stat.tsx:8-9) built for exactly this, and Settings → System
inspector does show the badge and container fallbacks (system-inspector.tsx:169-203) — so the same appliance
contradicts itself between two screens.

**What the user sees.** An operator on Docker Desktop for macOS with a wedged VM opens /home: the Disk space card
reads "0%", subtitle "0 / 0 GB", and an empty progress bar, implying the appliance has no storage at all. Settings →
System inspector on the same Hub shows a "VM wedge detected" badge plus the real container disk figures, so the
operator either panics about a phantom full/empty disk or concludes the dashboard is broken.

**Fix.** When `hasVmWedge` is true (or `diskSize === 0`), render the disk card with an em-dash metric plus
`hint={systemData.platformGuidance}` and `secondarySubtitle` carrying `containerDiskUsed / containerDiskTotal`,
instead of formatting zeros as a real measurement.

### Every guest app tile is keyboard-unreachable: the dropdown trigger is a plain div

`high` · accessibility · `packages/frontend/src/modules/dashboard/pages/guest-dashboard.tsx:42`

`DropdownMenuTrigger` is the raw Radix primitive (components/ui/DropdownMenu/DropdownMenu.tsx:13) and it is used with
`asChild` around a `<div>`. Radix forwards `aria-haspopup`, `aria-expanded`, `data-state` and its key handlers but
never a `tabIndex` (verified in @radix-ui/react-dropdown-menu 2.1.16 dist — no `tabIndex` anywhere), because it
assumes the native `<button>` it renders by default. A div with no `tabIndex` or `role` is not focusable, so the
`focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2` classes on that same line are dead code and the
`onKeyDown` Radix attached can never fire.

**What the user sees.** A guest on a kiosk or keyboard-only machine loads the guest dashboard, presses Tab repeatedly:
focus goes from the header straight to the external-link tiles (real `<button>`s in guest-link-tile.tsx:18), skipping
every app tile. There is no keyboard or screen-reader path to open any published app — the menu with the app's domain
and local URL can only be reached with a mouse or touch.

**Fix.** Make the trigger a real control: `<DropdownMenuTrigger asChild><button type="button" className="…">` (or add
`role="button" tabIndex={0}` at minimum) and give it an accessible name such as `aria-label={t('…OPEN_APP', { name:
info.name })}` so the menu announces what it opens.

### Guest link tile boxes a 20 px title in a 12 px row, so the title collides with its description

`medium` · layout · `packages/frontend/src/modules/dashboard/components/guest-link-tile.tsx:31`

`<div className="flex h-3 items-center">` fixes the title row at 12 px while the title inside is `text-xl` (20 px line
box), so it bleeds ~4 px above and below its row; the description `<div>` is laid out immediately after that 12 px box
and is overlapped by the title's descenders. The title span also has no `truncate`/`min-w-0`, while the wrapper on
line 26 is `overflow-hidden`, so a long title is cut at the card edge with no ellipsis. `CardContent`'s `p-6 pt-0`
(components/ui/Card/Card.tsx:26) removes the top padding the tile is relying on, since the tile has no `CardHeader`.

**What the user sees.** An operator publishes a guest link titled "Grafana — Appliance metrics dashboard" with a
description: the guest sees the bold title's baseline sitting on top of the first line of the description text, and
the title itself sliced off mid-word at the right edge of the card with no ellipsis to signal truncation.

**Fix.** Remove `h-3` and let the row size to its content (use `mb-1` for spacing), and add `min-w-0` + `truncate` on
the title span (with `title={link.title}`) so long titles end in an ellipsis instead of a hard cut.

### Units and the stopped-app label are hardcoded English, bypassing i18n on an otherwise translated screen

`medium` · copy · `packages/frontend/src/modules/dashboard/pages/dashboard.tsx:81`

The stat subtitles interpolate untranslated literals: `"… GB"` (lines 81 and 97) and `` `${systemData.cpuCores} cores`
`` (line 89) — the word "cores" is English prose inside a `t()`-driven card. `simple-app-tile.tsx:37,40` does the same
with `title="Stopped"` and `<span className="sr-only">Stopped</span>`, the only status text on a dashboard tile. The
repo ships 30 locale files (packages/common/i18n/translations/), so these are the only strings on /home that never
localise. Two related copy defects on the same screen: `DASHBOARD_NO_APPS_MESSAGE` is "Click here to install your
first app", which docs/writing-style.md explicitly forbids ("Descriptive link text (not 'click here')") and which is
wrong on touch; and `INSTALL_QUEUE_WAITING_ONLY` (en.json:68) has no `_one`/`_other` forms although the codebase uses
that pattern elsewhere (en.json:1151-1152).

**What the user sees.** A German operator with `de-DE` selected sees "Speicherplatz 96% / 474 / 494 GB" and "CPU-Last
8 cores" — English mixed into translated labels — and hovering a stopped app shows an English "Stopped" tooltip. With
exactly one app queued and none active, the banner reads "1 installs waiting in queue".

**Fix.** Move the units into keys with placeholders (`DASHBOARD_DISK_SUBTITLE: "{{used}} / {{total}} GB"`,
`DASHBOARD_CPU_CORES: "{{count}} cores"` with plural forms) and add `APP_STATUS_STOPPED` for the badge; reword
`DASHBOARD_NO_APPS_MESSAGE` to "Install your first app" and add `INSTALL_QUEUE_WAITING_ONLY_one`/`_other`.

### Guest dashboard reports an API failure as "No apps to display"

`medium` · functionality · `packages/frontend/src/modules/dashboard/pages/guest-dashboard.tsx:107`

`hasContent` is derived purely from array lengths, and the guard is `!hasContent && !appsLoading && !linksLoading`.
With `retry: false` globally, a 500 or a network drop resolves both queries to `isLoading: false, data: undefined`,
which collapses to `installed = []` and zero links — indistinguishable from a correctly-served empty appliance.
Neither query's `isError` is read anywhere on the screen, and the links query has no skeleton either (only
`appsLoading` paints placeholders, line 109-110), so a slow/failed links fetch shows nothing at all.

**What the user sees.** The Hub backend is restarting and `/api/guest/apps` returns 502. A guest loads the page and
reads "No apps to display — Ask your administrator to add apps to the guest dashboard or login to see your apps." They
go and ask the operator to publish apps that are in fact already published, instead of being told the Hub is
temporarily unavailable and to reload.

**Fix.** Read `isError` from both queries and render a distinct "can't reach this Hub right now" state with a Retry
button; keep the EmptyPage copy for the genuine `data !== undefined && length === 0` case only.

---

## App store browse

### 8.36 MB of catalog JSON is fetched on every authenticated page load, even for users who never open the store

`high` · functionality · `packages/frontend/src/context/app-context.tsx:43`

`prefetchStoreShell` calls `ensureQueryData` for all four `FEATURED_STORE_SECTIONS`, and the effect at lines 90-96
fires it from `AppContextProvider` for every authenticated route as soon as onboarding is complete — the dashboard,
settings, resource monitor, everything. Measured against http://beta-max:5002: `tags=companion-intelligence` 99 KB,
`tags=featured` 293 KB, `sort=trending` 3,984,772 B, `sort=newest` 3,984,772 B = 8.36 MB total, 1.2-1.4 s each. The
two big ones are the entire published catalog (576 records, ~7 KB each) because Portal's `listPublished` applies no
limit, and every record carries its full docker-compose YAML (up to 19 KB), `description`, `form_fields`,
`privacyLabels` and 35 other fields that a 4-card preview never reads. Trending and newest are the same 576 apps in
different order, so roughly 8 MB is transferred to paint 16 preview cards. `getFeaturedStoreBundleOptions`
(lib/featured-store-bundle-query.ts:46-64), the single-round-trip endpoint the backend comment at
packages/backend/src/app.controller.ts:229 and docs/system/frontend.md:74 both say the store uses, is imported by
nothing — it is dead code, and would not have reduced the bytes anyway (the bundle endpoint returns the same 8.36 MB
in one response).

**What the user sees.** A user opens the Hub dashboard over a Tailscale link or a phone connection and never touches
the store. The browser still downloads 8.36 MB of app-store JSON in the background, competing with the dashboard's own
requests; on a 5 Mbps link that is ~13 s of saturated downlink, and the whole payload is re-fetched after the 5-minute
`staleTime` on the next navigation. On a metered connection this is pure waste.

**Fix.** Add a `limit` to the Portal listing query (a preview needs 8, not 576) and a projection that drops `compose`,
`form_fields`, `description` and `privacyLabels` from listing responses; move `prefetchStoreShell` behind a
store-route hint (hover/focus on the store nav link, or the route loader) instead of running it on every authenticated
page; then either wire up `getFeaturedStoreBundleOptions` or delete it and correct docs/system/frontend.md:74.

### "Trending / Most popular apps right now" has no popularity signal — it is the catalog re-ingest timestamp order

`high` · functionality · `packages/frontend/src/lib/featured-store-bundle-query.ts:15`

The section requests `sort: 'trending'`, which Portal implements as `apps.sort((a,b) => b.updatedAt - a.updatedAt)`
(CI-Portal apps/hono-app/src/domains/applications/services/AppService.ts:153-154). `updatedAt` is the row's last-write
time, not a usage counter. Verified live against http://beta-max:5002/api/store/featured-bundle: all 576 `updatedAt`
values fall inside a 66-second window (2026-09-17T23:27:42Z - 23:28:32Z), i.e. the last catalog re-ingest, which wrote
rows in roughly reverse-alphabetical order — exactly the ZimaOS / ZITADEL / ZeroNote / yt-dlp-manager row observed. No
install, download, view, or popularity field exists anywhere in the 41-key listing record (author, available,
billing*, categories, compose, createdAt, description, icon, id, metadata, price*, tags, title, updatedAt, version,
website...), so no popularity signal is available to sort by even in principle. To answer the second half of the
question: "Recently Added" IS honestly date-sorted — `sort: 'newest'` orders by `createdAt` desc and the live payload
confirms it (torollo 2026-09-09T11:13, then strictly descending). Only "Trending" is mislabelled. The user-facing
claim lives at packages/common/i18n/translations/en.json:1276.

**What the user sees.** A user opens /store, scrolls to "Trending — Most popular apps right now", and sees ZimaOS,
ZITADEL, ZeroNote and yt-dlp-manager. They reasonably conclude those are the four most-installed apps on the platform
and install one on that basis. In fact the row will re-order arbitrarily after the next catalog sync and reflects
nothing but which rows the ingest job happened to touch last; nothing in the row is a popularity measurement.

**Fix.** Either give Portal a real signal (an install/download counter incremented by Hub install events, exposed as a
sort key) and keep the label, or drop the section and its subtitle. As an interim, relabel to something the data
supports — `APP_STORE_TRENDING_SECTION_TITLE: "Recently updated"` / subtitle "Apps whose listing changed most
recently" — so the copy stops asserting popularity.

### Trending and Recently Added are the same 576 apps, and "View all 576" mounts 576 cards into the scroll pane at once

`high` · layout · `packages/frontend/src/modules/app/components/featured-store-view/featured-store-view.tsx:33`

`AppSection` previews `apps.slice(0, PREVIEW_COUNT)` (4) and, when `apps.length > 4`, offers
`APP_STORE_FEATURED_VIEW_ALL` with `count: apps.length` (57). Neither the query
(lib/featured-store-bundle-query.ts:15-16) nor Portal's `listPublished` applies a limit, so `apps.length` is the whole
published catalog for both date-sorted sections. Verified live: `sort=trending` and `sort=newest` each return 576
records and `set(trending ids) == set(newest ids)` is True — the two sections are the identical catalog in two
different orders, which is why both render "View all 576". Expanding sets `expanded` and renders `visible = apps` into
the single `grid-cols-1 sm:2 md:3 lg:4` (83-87), mounting 576 `AppCard`s — each a `GlassContainer` with backdrop blur,
an `<img>`, and a `useAppStoreState` subscription — in one synchronous commit, with no virtualization.

**What the user sees.** A user clicks "View all 576" under Trending. The tab freezes for seconds while 576
blur-filtered cards mount, then the store pane becomes a ~40,000px scroll of the entire catalog sitting under a
heading that says "Most popular apps right now". Scrolling to the bottom of it and clicking "View all 576" under
Recently Added produces the exact same 576 apps again. The user has no way to tell the two sections apart by content.

**Fix.** Cap each date-sorted section server-side (a `limit` param, 8-12 rows) and turn "View all" into a link into
the paged catalog view (`/store?category=…` or a `?sort=` browse mode) that already has cursor pagination and infinite
scroll, rather than an in-place expander over an unbounded array.

### A cold-loaded `?store=` deep link is silently wiped before it is read, so links to secondary stores always land on CI Marketplace

`high` · functionality · `packages/frontend/src/modules/app/pages/app-store-page.tsx:85`

Three effects race on mount. The URL-to-state effect (lines 63-83) copies `q` and `category` into Zustand but NOT
`store`. The state-to-URL effect (85-103) then runs in the same commit with the first render's closure, where Zustand
`storeId` is still `undefined` (stores/app-store.ts:33), and `applyStoreBrowseParams` deletes any param it is given as
undefined (lib/store-browse-params.ts:52-56) — so `store=` is removed from the URL by a `replace` navigation. The
effect that would actually honour the param (174-199) does run in that same commit, but `getEnabledAppStores` has not
resolved yet, so `appStores?.appStores` is undefined and both branches are skipped. By the time the stores query
resolves, `searchParams` no longer contains `store`, so line 180-189 falls through to the `ci-marketplace` fallback.
`q` and `category` survive only because effect 63 had already pushed them into Zustand, so effect 85 re-adds them on
the next render; `store` has no such rescue. The test that claims to cover this (pages/app-store-page.test.tsx:275,
"syncs URL ?store= param to Zustand on mount") cannot catch it: `useSearchParams` is mocked to return a frozen
`capturedSearchParams` with a no-op `mockSetSearchParams` (test lines 19-27), so the deletion never takes effect, and
`useQuery` returns the store list synchronously on the first render.

**What the user sees.** A user on a Hub with two stores (CI Marketplace + Community) bookmarks /store?store=community,
or pastes that link to a colleague. Opening it cold shows the CI Marketplace catalog with CI Marketplace highlighted
in the store switcher, and the address bar quietly rewrites to /store?category=featured. The same happens on any
browser reload of a Community-store view, and on desktop-app cold start. There is no way to link to a non-default
store.

**Fix.** Have the URL-to-state effect at lines 63-83 also apply `parsed.store` (`if (parsed.store)
setStoreId(parsed.store)`), so `storeId` is populated before the state-to-URL effect runs; or gate the state-to-URL
effect on `appStores` having resolved. Then fix the test to use a real `MemoryRouter` route with
`initialEntries={['/store?store=community']}` and an enabled-stores query that resolves on a later tick.

### The catalog grid has no error branch — a failed search renders 16 skeleton cards forever, and a cold catalog is reported as "No app found"

`high` · functionality · `packages/frontend/src/modules/app/pages/app-store-page.tsx:223`

The `useInfiniteQuery` destructure at 223-229 never takes `isError` or `error`, and `isLoading` is defined as
`catalogSearchEnabled && !data` (231). The query fn sets `throwOnError: true` (lib/marketplace-search-query.ts:32), so
any failure — session cookie expiry giving 401, a 500, or the browser going offline — leaves `data` undefined after
the three default retries, `isLoading` stuck true, and line 388 rendering `SKELETONS` (16 placeholder cards)
permanently, with no message, no retry affordance and no toast. The sibling views in this very file handle this
properly: the Alternatives branch has an error box with a retry button (359-367) and so does each featured section
(components/featured-store-view/featured-store-view.tsx:75-81). Separately, the backend deliberately returns `{data:
[], total: 0, nextCursor: null}` when the Portal catalog is cold or a background warm is still running
(packages/backend/src/modules/marketplace/marketplace.service.ts:404, 417), and the page renders that as `EmptyPage
title="APP_STORE_NO_RESULTS" subtitle="APP_STORE_NO_RESULTS_SUBTITLE"` (375) — "No app found / Try to refine your
search".

**What the user sees.** Two concrete cases. (1) A user leaves /store open past session expiry, clicks the
"Development" category, the search request 401s, and the grid shows 16 grey skeleton cards indefinitely — the page
looks permanently stuck loading with nothing to click. (2) On a freshly paired appliance whose Portal catalog has not
warmed yet, a user clicks "Network" and sees "No app found — Try to refine your search", concluding the store has no
networking apps, when the real state is "catalog not loaded yet, retry in a moment".

**Fix.** Destructure `isError`, `error` and `refetch`, and render the same destructive-border error box +
`COMMON_RETRY` button already used at lines 359-367. Distinguish the degraded case by returning a flag (e.g.
`catalogWarming: true`) from `searchApps` when the service short-circuits to an empty page, and render a "catalog
still syncing, retry" state instead of `APP_STORE_NO_RESULTS`.

### Alternatives category icons never receive their colour (interpolated Tailwind class) and the section heading prints an untranslated raw key

`medium` · design-system · `packages/frontend/src/modules/app/components/alternatives-catalog/alternatives-catalog.tsx:37`

Line 31 reads `colorSchemeForCategory[altCategory] || 'blue'` and line 37 builds `clsx('h-5 w-5', `text-${color}`)`.
Two independent reasons this can never apply a colour: Tailwind's scanner cannot see a class assembled at runtime, so
the utility is never emitted into the stylesheet; and the values in that map (helpers/table-helpers.ts:22-40) are
`azure`, `lime`, `dark`, `muted`, `violet`, `teal`, `cyan`, `indigo`, `pink` — bare names with no shade, which are not
Tailwind text-colour utilities at all (`text-azure`, `text-dark`, `text-lime` do not exist even if written literally).
Every category icon therefore renders in the inherited foreground colour, in both themes, and the entire per-category
colour system this code implements is dead. Line 38 is a separate defect: `<CardTitle
className="capitalize">{altCategory}</CardTitle>` renders the raw Portal category key instead of `getCategoryLabel(t,
altCategory)`, the helper used for exactly this purpose everywhere else in the module (app-store-page.tsx:338,
app-store-sidebar.tsx:117).

**What the user sees.** A user opens the Alternatives view and sees a column of visually identical cards whose icons
are all the same default grey-foreground colour, so the category colour-coding the design intends gives them no help
scanning. A user on a non-English locale sees English category names there while every other category label on the
page is translated, and any multi-word Portal key renders as a single sentence-cased run (e.g.
"Media-and-entertainment" rather than the translated label).

**Fix.** Replace the interpolated class with a static lookup of real token/utility classes (e.g. `const
CATEGORY_ICON_CLASS: Record<string, string> = { network: 'text-blue-500', … }`) so Tailwind emits them, or drop the
colour and use `text-muted-foreground` uniformly; and change line 38 to `{getCategoryLabel(t, altCategory)}`.

### AppCard puts an unnamed, inert <button> inside the card's <a>, and every selected state in the store is colour-only with no ARIA

`medium` · accessibility · `packages/frontend/src/modules/app/components/app-card/app-card.tsx:112`

The whole card is a `<Link>` (line 71). Inside it, line 112-114 renders `<Button variant="ghost" size="sm"
className="h-8 w-8 rounded-full p-0"><Download/></Button>` — the Button primitive renders a real `<button>`
(components/ui/Button/Button.tsx:45-46), so this is a `<button>` nested in an `<a>`, which is invalid HTML; it has no
`onClick` and no `aria-label`. The installed variant (108-110) is a bare `<div>` with a Check icon, no text and no
`aria-label`, so "installed" is conveyed by a green tick alone. Selected state is colour-only throughout: the sidebar
category buttons use `bg-primary/10 text-primary` with no `aria-pressed` / `aria-current` / `role="tab"`
(components/app-store-sidebar/app-store-sidebar.tsx:65-120), the mobile pills do the same
(pages/app-store-page.tsx:299-341), and the store switcher only swaps `variant` between `default` and `outline`
(pages/app-store-page.tsx:271-279).

**What the user sees.** A keyboard user tabbing the catalog grid gets two stops per card — the card link, then an
unnamed "button" announced with no accessible name that does nothing when activated (1,152 stops on an expanded
576-card section). A screen-reader user tabbing the sidebar hears twenty identical "button, Gaming" / "button,
Network" announcements with no indication of which filter is currently applied, and cannot tell from the card whether
an app is already installed. A user with a colour-vision deficiency cannot tell which store the switcher has selected.

**Fix.** Replace the nested Button with a decorative `<Download aria-hidden="true" />` span (the card link is already
the click target), give the installed indicator an `aria-label` or visually-hidden "Installed" text, and add
`aria-pressed={isSelected}` to the category and mobile pill buttons plus `aria-current="true"` (or
`role="radiogroup"`/`radio`) to the store switcher.

### "Expose a port" is the store sidebar's only entry point in the whole frontend, and the sidebar does not exist below 768px

`medium` · layout · `packages/frontend/src/modules/app/components/app-store-sidebar/app-store-sidebar.tsx:78`

`navigate('/apps/expose')` at line 81 is the single occurrence of that path anywhere in packages/frontend/src (grep:
one hit, this line). The `<aside>` that contains it is `hidden … md:flex` (line 58), and the mobile fallback block in
the page (pages/app-store-page.tsx:296-343) renders only All, Alternatives and the 17 category pills — it has no
equivalent of this row. The route itself exists and is reachable (routes.ts:39, `/apps/expose` →
port-expose-create-page). Secondary defect on the same row: it is the only button in the sidebar list with no icon,
while every sibling renders a 16px lucide glyph under the same `gap-3 px-4` class, so its label starts ~28px to the
left of every other label in the column, and a navigation action is styled identically to the filter toggles around
it.

**What the user sees.** A user on a phone (or in a narrow Tauri desktop window under 768px) wants to expose a service
running on a host port. Nothing in the UI links there — not the store's mobile filter strip, not the dashboard, not
settings — so the feature is reachable only by typing /apps/expose into the address bar. On desktop the same row
visibly hangs left of the category labels above and below it.

**Fix.** Add the link to the mobile strip (or, better, move it out of the filter list into the page action row beside
"Check for Updates", where a navigation action belongs) and give it an icon (`Network`/`Plug` from lucide) so it
aligns with its siblings and reads as an action rather than a filter.

---

## App details and update

### Lightbox close button is painted under the fixed header on mobile, and nothing else closes it

`high` · layout · `packages/frontend/src/modules/app/components/app-media-gallery/app-media-gallery.tsx:72`

The lightbox offsets itself with `top: calc(var(--titlebar-height, 0px) + 3.5rem)`, but the fixed header is `height:
var(--header-offset)` = `3.5rem + var(--titlebar-height) + var(--safe-area-top)`
(packages/frontend/src/components/header/header.tsx:66-70, packages/frontend/src/styles/globals.css:40). The offset
omits `--safe-area-top`, which `html.ci-mobile` pins to at least 59px (globals.css:52). The header is z-50 and the
lightbox is z-40 — the file's own comment at line 68 says z-40 deliberately keeps the header on top — so the
lightbox's top ~59px is covered by the header. The Close button lives in exactly that band (`absolute right-4 top-4`,
line 81, so 16-40px from the lightbox's top edge). There is no backdrop click handler (the overlay div at lines 70-76
has no onClick) and the only other dismissal is the Escape key (line 26), which a phone has no keyboard for.

**What the user sees.** On the Tauri mobile app on an iPhone, tap a screenshot on an app detail page: the lightbox
opens, the X is drawn beneath the header so tapping it hits the nav instead, tapping the black backdrop does nothing,
and there is no Escape key — the only escape is to navigate away via the header, losing the page.

**Fix.** Offset with the existing token instead of a literal: `top: var(--header-offset)`. Add an overlay
click-to-close (guarded to the backdrop itself) so touch users always have a way out, and raise the z-index above the
header if the intent is to cover it.

### Screenshot lightbox is a hand-rolled dialog with no focus move, trap or restore

`high` · accessibility · `packages/frontend/src/modules/app/components/app-media-gallery/app-media-gallery.tsx:69`

The lightbox declares `role="dialog" aria-modal="true"` but implements none of the modal contract: nothing moves focus
into it on open, nothing traps Tab inside it, nothing returns focus to the trigger on close, and the page behind is
neither `inert` nor scroll-locked (no `overflow-hidden` on body — grep for focus/inert/autoFocus in this file returns
nothing). Every one of the eleven dialogs in modules/app/components/dialogs/* goes through the Radix `Dialog`
primitive (packages/frontend/src/components/ui/Dialog/Dialog.tsx), which provides all of this for free.

**What the user sees.** A keyboard user tabs to the screenshot button and presses Enter. The lightbox covers the
screen but focus stays on the now-hidden trigger, so the visible Close, Previous and Next buttons are only reachable
by blind tabbing; continuing to Tab walks invisibly through the AppActions buttons and access-point links behind the
black overlay, and pressing Enter there fires a real action (for example Stop) the user cannot see. Scrolling with the
lightbox open scrolls the page behind it, so closing lands the user somewhere else.

**Fix.** Render the lightbox through `Dialog`/`DialogContent` like the other dialogs in this module, which also
removes the hand-rolled Escape/arrow key listener and the manual createPortal.

### `.badge` class does not exist, so the current version renders white-on-near-white in light theme

`high` · design-system · `packages/frontend/src/modules/app/pages/app-update-page.tsx:85`

`<span className="badge bg-muted text-white">{info.version}</span>` relies on a `.badge` class that is defined nowhere
in the frontend — no `packages/frontend/src/**/*.css` file declares it and neither does
`@companionintelligence/tokens` (its `src/globals.css` and `src/tokens.css` have no `.badge` rule).
docs/UI-STYLE-GUIDE.md:79 (drift H-2) records that this repo has no Badge primitive at all. So only the two Tailwind
utilities apply, and `bg-muted` resolves to `--muted: #e8f2ec` in light theme
(node_modules/@companionintelligence/tokens/src/globals.css:177) against `text-white` — roughly a 1.07:1 contrast
ratio. The very next chip on line 87 does it correctly with `bg-success text-success-foreground`.

**What the user sees.** On /apps/immich/immich/update in the default light theme, the "from" version chip is blank:
the user sees an arrow pointing at the new version with nothing on the left, so they cannot tell what version they are
upgrading from. In dark theme (`--muted: #073038`) the same chip is legible, so the bug is invisible to anyone
developing in dark mode.

**Fix.** Use `bg-muted text-muted-foreground` (or port Portal's badge.tsx per H-2 and use it for both chips). The
identical bug is at packages/frontend/src/modules/app/pages/custom-app-details-page-content.tsx:91.

### Install dialog scrolls its whole content, so the Install button and the close X scroll out of reach

`medium` · layout · `packages/frontend/src/modules/app/components/dialogs/install-dialog/install-dialog.tsx:88`

`overflow-y-auto` is applied to the `DialogContent` itself (`sm:max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto`)
rather than to an inner body. DialogContent is the positioned containing block *and* the scroll container, so its
absolutely-positioned close button (Dialog.tsx:74, `absolute right-4 top-4`) scrolls away with the content, and the
DialogFooter with the submit button (lines 115-124) sits at the bottom of the scroll region. `InstallFormButtons`
renders only a submit button (install-form-buttons.tsx:16) — there is no Cancel. The sibling
`update-settings-dialog.tsx:61` already has the correct shape: `max-h-[85vh] flex flex-col` with `flex-1
overflow-y-auto` on the body only.

**What the user sees.** On a 375x667 phone, install an app whose manifest declares many `form_fields` (Immich,
Nextcloud). You must scroll the entire dialog to reach Install; by the time it is on screen the X close button has
scrolled off the top and there is no Cancel in the footer, so the only ways to back out are Escape (no phone keyboard)
or hitting the thin overlay strip. The "Fill every required field before installing" hint on line 117 is also pinned
above the button and scrolls with it, so it is off screen while the user is looking at the fields it refers to.

**Fix.** Mirror update-settings-dialog: keep `max-h` + `flex flex-col` on DialogContent and move `overflow-y-auto`
onto a wrapper around the Alert/McpSetupPanel/InstallForm so header, footer and X stay pinned.

### Install dialog's required-fields hint exists in zero of the 31 translation files

`medium` · copy · `packages/frontend/src/modules/app/components/dialogs/install-dialog/install-dialog.tsx:118`

`t('APP_INSTALL_FORM_COMPLETE_REQUIRED', { defaultValue: 'Fill every required field before installing. Fields with
defaults can stay as-is.' })` is the only string on these screens carried by an inline `defaultValue`. Grepping the
key across packages/common/i18n/translations/ returns no hits in any of the 31 locale files, including en.json — so
translators never see it and it can never be localised. Every other string in the module (all 34 keys I spot-checked,
including APP_DETAILS_ACCESS_QR_MALFORMED and APP_UPDATE_SUMMARY_CONFIG_CHECKING) is a real key present in en.json.

**What the user sees.** A user running the Hub in Spanish (es-ES.json) opens the install dialog for an app with a
required field and leaves it blank. Above the "Instalar" button appears the English sentence "Fill every required
field before installing. Fields with defaults can stay as-is." — the one untranslated line in an otherwise Spanish
dialog, and the line that explains why the button is disabled.

**Fix.** Add APP_INSTALL_FORM_COMPLETE_REQUIRED to packages/common/i18n/translations/en.json and remove the inline
defaultValue so the missing-key lint/pipeline catches regressions.

### Update page navigates away in onMutate without an optimistic status, so the click looks like a no-op and can be fired twice

`medium` · functionality · `packages/frontend/src/modules/app/pages/app-update-page.tsx:62`

`onMutate` calls `navigate(location.state?.from || '/apps')` before the request is sent, and unlike every lifecycle
dialog in this module (install-dialog.tsx:54, stop-dialog.tsx:35, restart-dialog.tsx:34, reset-dialog.tsx:41,
uninstall-dialog.tsx:45) it never calls `setOptimisticStatus`. Two consequences: `loading={update.isPending}` on the
confirm button (line 180) is dead code because the page unmounts first, and nothing marks the app as updating until
the backend's SSE `status_change` arrives.

**What the user sees.** Click Update on a large app. You are dropped on /apps, which apps-redirect.tsx bounces to the
store; the app's card still reads "Running" with its update affordance intact for the seconds until the first SSE
event. Reading that as "nothing happened", the user clicks Update again and re-enters the same page, and the confirm
button — which has no loading or disabled state — fires a second updateApp for the same URN. If the request fails, the
only feedback is an error toast on a completely different screen with no context about which app it refers to.

**Fix.** Call `setOptimisticStatus('updating', info.urn)` in `onMutate` alongside the navigate, exactly as the
lifecycle dialogs do, and drop the unreachable `loading` prop (or navigate in `onSuccess` and keep the loading state).

---

## Custom apps and port expose

### Add-service control is a bare SVG with onClick — keyboard and screen-reader users cannot add a second service

`high` · accessibility · `packages/frontend/src/components/multi-service-form/multi-service-form.tsx:175`

`<Plus className="text-primary cursor-pointer" size={20} onClick={() => saveBeforeAction(addService)()} />` — a lucide
SVG with a click handler and no `<button>` wrapper, no `tabIndex`, no `role`, no `aria-label`, and no keyboard
handler. An `<svg>` is not focusable and does not fire click on Enter/Space. It is the only add-service affordance on
the screen; the JSON editor is the sole workaround. The same file gets this right 30 lines later — the per-service
remove control at line 201 is a real `<button>` with `aria-label={t('MULTI_SERVICE_REMOVE_SERVICE')}` — so this is
inconsistency within one component, not a missing convention. (Related, dropped for the cap: that remove button is
nested inside the service-row `<button>` at line 180, which is invalid interactive nesting.)

**What the user sees.** A keyboard-only user on /apps/create tabs through the form: app name, the five tab buttons,
the essentials fields, then straight past the "Services" header into the service row — the "+" never receives focus,
so they cannot add service #2 at all. A screen-reader user is never told the control exists, since an unlabelled
decorative SVG is not announced.

**Fix.** Wrap it the way the remove control already is: `<button type="button"
aria-label={t('MULTI_SERVICE_ADD_SERVICE')} className="…focus-visible:ring-2 focus-visible:ring-ring"
onClick={…}><Plus size={20} aria-hidden="true" /></button>`, and add the `MULTI_SERVICE_ADD_SERVICE` key (no
add-service string exists in en.json today).

### Custom app version badge is white text on the pale light-theme --muted, and the .badge class does not exist

`high` · design-system · `packages/frontend/src/modules/app/pages/custom-app-details-page-content.tsx:91`

`<span className="badge bg-muted mt-2 text-white">{info?.version}</span>`. Two defects: (1) `text-white` is a
hardcoded literal instead of the paired token `text-muted-foreground`, and light-theme `--muted` is `#e8f2ec`
(node_modules/@companionintelligence/tokens/src/globals.css:177) — #ffffff on #e8f2ec is roughly 1.1:1 contrast, far
below the 4.5:1 floor. Dark theme happens to work because `--muted` is `#073038` there. (2) `.badge` is defined
nowhere in the frontend — grep across src/styles, app.css and tailwind.config.ts finds no rule and there is no
Tabler/tblr stylesheet import; it is a leftover class name, so the element also has no padding, radius or badge shape.
docs/UI-STYLE-GUIDE.md H-2 already records that this repo has no Badge primitive.

**What the user sees.** A user on /apps/mytool in light mode (the default on a fresh appliance, and what `system`
resolves to during the day) sees "Version:" followed by what looks like empty space — the version number is rendered
in white on a near-white mint chip. Switching to dark mode makes it readable, which is how this survived review.

**Fix.** Drop `text-white` and the dead `badge` class and use token pairs: `className="inline-flex items-center
rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"`. Better, land the Badge primitive that UI-STYLE-GUIDE
H-2 already calls for and use it here.

### Edit page hangs forever on a placeholder when the stored config fails schema parse

`high` · functionality · `packages/frontend/src/modules/app/pages/custom-app-edit-page.tsx:52`

`ready` gates all rendering (line 83). The effect sets it true only on the success branch; on `!parsed.success` it
console.errors, fires a toast, and `return`s (lines 52-56), leaving `ready === false` permanently. The query has
`staleTime: 30_000` and no refetch trigger, so the effect will not re-run with different data, and there is no retry
control, no error UI, and no redirect. The same page is the only in-app way to repair a broken custom app, so the one
screen that could fix a bad config is the screen the bad config disables.

**What the user sees.** A custom app was created before a schema change (or its compose was edited outside the UI) so
its stored config no longer satisfies `dynamicComposeFormSchema`. The user clicks Edit on /apps/myapp. A toast says
"Invalid configuration. Please check your services." and auto-dismisses after a few seconds; the page then sits
indefinitely on a bare placeholder with no heading, no services, no buttons and no explanation. Reloading reproduces
it exactly. The user's only remaining option is to uninstall the app.

**Fix.** Add a `parseFailed` state alongside `ready`; on the `!parsed.success` branch render a persistent error card
(reuse the APP_DETAILS_LOAD_FAILED pattern from custom-app-details-page.tsx:27-32) that names the offending field from
`parsed.error`, offers "Edit as JSON" so the raw config can still be repaired, and offers a link back to /apps/:appId.

### Edit page's loading state prints the raw i18n key "LOADING"

`high` · copy · `packages/frontend/src/modules/app/pages/custom-app-edit-page.tsx:84`

`<div>{t('LOADING')}</div>`. The key `LOADING` exists in none of the 32 files under packages/common/i18n/translations/
— verified by scanning every locale. i18next is configured with `fallbackLng: 'en'` and no `parseMissingKeyHandler`
(i18n-provider.tsx:84), so a missing key returns the key string itself. The existing key is `COMMON_LOADING`.
Separately, this is bare unstyled text where every other async screen in the module uses `<PageLoadingSpinner />`
(custom-app-details-page.tsx:23).

**What the user sees.** Every single visit to /apps/:appId/edit, in every language, renders the literal uppercase word
"LOADING" flush against the top-left of the content area while the compose diff is fetched and parsed — no spinner, no
card, no centering. On a slow appliance, or permanently in the parse-failure case above, that debug-looking string is
the entire screen.

**Fix.** Replace `<div>{t('LOADING')}</div>` with `<PageLoadingSpinner />` (already imported by the sibling details
page), or at minimum use the existing `COMMON_LOADING` key. A test asserting `i18next.exists(key)` for every literal
passed to `t()` would catch the whole class.

### /apps/create is unreachable from anywhere in the UI

`high` · functionality · `packages/frontend/src/routes.ts:41`

Confirmed the assigned KNOWN item. `grep -rn "apps/create" packages/frontend/src packages/desktop` returns only
routes.ts and a comment inside compose-schema-usage.test.ts — no Link, no navigate(), no button, no menu item. The
only sibling creation route, `/apps/expose`, IS linked (app-store-sidebar.tsx:81), which makes the omission look
accidental rather than deliberate. Worse, that sidebar is `hidden … md:flex` (app-store-sidebar.tsx:58) and the mobile
category strip (app-store-page.tsx:296-340) reproduces All / Alternatives / categories but NOT the expose link, so
below 768px BOTH creation entry points vanish.

**What the user sees.** A user on /store wants to run their own nginx image. They scan the store sidebar (All, Expose
a port, Alternatives, categories), the store header (search + "Check for updates"), and the dashboard nav, and find
nothing. The whole multi-service form — five tabs, a JSON editor, ~700 lines of UI — is only reachable by typing
/apps/create into the address bar, which the Tauri desktop shell and the mobile app do not expose. On a phone, even
"Expose a port" is gone.

**Fix.** Add a "Create custom app" entry beside PORT_EXPOSE_SIDEBAR_LINK in app-store-sidebar.tsx:78-84, and mirror
both it and the expose link into the md:hidden control row at app-store-page.tsx:296 so the two creation paths exist
below 768px.

### multiServiceStore is a never-reset singleton, so /apps/create opens pre-filled with the last app you edited

`high` · functionality · `packages/frontend/src/stores/multiServiceStore.ts:181`

`services` lives in a module-level zustand store with no per-route scoping. `custom-app-edit-page.tsx:63` calls
`setServices(...)` with the edited app's services and nothing ever clears them: `resetToDefaults` is defined at line
181 but `grep -rn resetToDefaults packages/frontend/src` finds zero callers — it is dead code.
`custom-app-create-page.tsx` neither calls it on mount nor after a successful create, and `MultiServiceForm` seeds
`defaultValues: { services }` straight from the store (multi-service-form.tsx:66-68).

**What the user sees.** User opens /apps/grafana/edit (store now holds grafana's 3 services with their images, volumes
and env vars), backs out, then navigates to /apps/create. The create form is pre-populated with grafana's entire
service list instead of the default single `web` / `nginx:alpine` service. They type a new name and submit, silently
creating a second copy of grafana. The same store bleed also means creating app A, then returning to /apps/create,
shows A's services again.

**Fix.** Call `resetToDefaults()` in a mount effect in custom-app-create-page.tsx (and in `createCustomApp.onSuccess`
before navigating), or move the store behind a provider scoped to the form so each mount of MultiServiceForm gets
fresh state.

---

## Settings: general and security

### Switch sets aria-label to the raw form field key, so screen readers announce "guestDashboard" and "advancedSettings" instead of the visible labels

`high` · accessibility · `packages/frontend/src/components/ui/Switch/Switch.tsx:17`

`aria-label={props.name}` puts the HTML `name` attribute on the accessible-name computation, where `aria-label`
outranks both the element's content and the wrapping `<label>`. Every switch on these screens driven by
react-hook-form's `Controller` spreads `{...rest}`, which includes `name` — so `guestDashboard`,
`allowErrorMonitoring`, `allowAutoThemes`, `advancedSettings` (user-settings-form.tsx:228, :259, :304, :343) and
`persistTraefikConfig` (:481) all announce as their camelCase field key rather than their translated label, and the
visible label span is never read. The Switch test suite hides this: Switch.test.tsx:9 renders `<Switch label="Test
Label" />` with no `name`, the one case where the wrapping label is used. The same line also emits `<span
id={props.name}>` plus `aria-labelledby={props.name}` on the `<label>` element itself, which is both inert and a
duplicate-id hazard for any two switches sharing a field name on one page.

**What the user sees.** A screen-reader user tabs through Settings → General settings. Instead of "Enable guest
dashboard, switch, off" they hear "guestDashboard, switch, off", and for the switch behind the warning modal they hear
"advancedSettings" with no hint that confirming it can break the install.

**Fix.** Drop `aria-label={props.name}` and `aria-labelledby={props.name}` from the wrapper; give the label span a
`useId()`-derived id and point the Root's `aria-labelledby` at it (keeping `aria-label` only as a fallback when no
`label` is passed). Add a Switch test that renders with both `name` and `label` and asserts `getByRole('switch', {
name: label })`.

### Revoking an API key is a single unconfirmed click that can silently break an installed app

`high` · functionality · `packages/frontend/src/modules/settings/containers/api-keys.tsx:362`

`onClick={() => void revokeKey(key.id)}` fires DELETE /api/api-keys/:id immediately — there is no confirmation dialog,
and no `API_KEYS_REVOKE_CONFIRM*` string exists in packages/common/i18n/translations/en.json, so none was ever
planned. The asymmetry is stark inside this one file: *raising* a key's capability routes through a two-step confirm
with the consequence spelled out (api-keys.tsx:219-222, :474-497), and merely *changing* a managed key's level warns
which app owns it (:455-459) — but destroying that same managed key needs no confirmation and gives no app-name
warning. The Revoke button sits 4px (`gap-1`, :356) from "Change" at `size="sm"`, both `variant="ghost"`. There is
also no per-row pending state, so the row looks inert while the DELETE is in flight. The existing test at
__tests__/api-keys.test.tsx:518 asserts the DELETE fires straight off the click, confirming no guard.

**What the user sees.** An operator means to click "Change" on the managed key belonging to their installed Memory
app, misses by 4px, and hits "Revoke". The key is destroyed instantly, a green "API key revoked" toast appears, the
row vanishes, and the app's Hub callbacks start failing — with no undo and no indication of which app just lost its
credential.

**Fix.** Route revoke through a confirm dialog that names the key and, for a managed key, names the owning app (reuse
`API_KEYS_CAPABILITY_MANAGED_WARNING`'s `app` interpolation and the `changeStep`-style two-faced dialog already in
this file), and add a per-row pending state so the button disables while the DELETE is in flight.

### "Advanced Mode" and "Advanced settings" are two different flags with near-identical names, and the first one's help text describes the second one's job

`high` · copy · `packages/frontend/src/modules/settings/containers/user-settings.tsx:85`

The Settings tab presents two switches that read as the same control. The "Experience" card's "Advanced Mode" switch
(user-settings.tsx:75 title, :85 label) writes `user.advancedMode`, which has exactly one consumer in the whole
frontend: packages/frontend/src/modules/app/components/install-form/install-form.tsx:148. The "Advanced settings"
switch further down the same page (user-settings-form.tsx:357) writes `userSettings.advancedSettings`, which is what
actually gates the settings page's advanced block (user-settings-form.tsx:468) and the read-only state of the
local-domain field (:428). No settings page reads `advancedMode` at all. Yet its hint string
(`SETTINGS_GENERAL_ADVANCED_MODE_HINT`, en.json) promises "Show all configuration options in install dialogs and
settings pages... When off, advanced options like subdomain, auth, environment variables, and backup settings are
hidden" — backup settings (`maxBackups`) are gated by the *other* flag. Also violates docs/writing-style.md sentence
case ("Advanced Mode" should be "Advanced mode"), which is why the two labels don't even look like they belong to the
same system.

**What the user sees.** An operator wants to change the Hub's SSL port. They scroll to the top of Settings, read
"Advanced Mode — show all configuration options in ... settings pages", and switch it on. Nothing appears anywhere on
the Settings tab. The port field is behind a differently-named switch 400px further down that additionally requires
Save plus an instance restart.

**Fix.** Rename and re-scope the copy so the two flags cannot be confused: make the per-user flag "Show advanced
options in install dialogs" (and delete "and settings pages" plus the "backup settings" example from its hint, since
neither is true of `advancedMode`), and title the server-config one "Advanced appliance configuration". Better still,
collapse them into one flag if the product intent is one setting.

### Neither write path on the Settings tab shows pending state: "Update settings" never disables and the Advanced Mode switch never moves until the server answers

`high` · functionality · `packages/frontend/src/modules/settings/containers/user-settings.tsx:101`

UserSettingsForm accepts `loading?: boolean` and wires it to the submit button (user-settings-form.tsx:93, :746), and
accepts `submitErrors` to map server field errors onto fields (:94, :127-133) — but its one and only call site
(user-settings.tsx:101-106, confirmed by grep) passes neither, though `updateSettings.isPending` is right there. So
the submit button has no spinner, never disables, and server-side validation failures are only toasted, never shown
against the offending field. Separately, the Advanced Mode switch is controlled by `checked={user.advancedMode}` (:81)
with no optimistic update and no `disabled` during `updateAdvancedMode.isPending` (:45-54), so the thumb does not move
on click and the switch stays clickable.

**What the user sees.** On a loaded appliance the operator edits the time zone and presses "Update settings". Nothing
changes on screen, so they press it again — two PATCH /api/settings requests go out and two toasts arrive. On the
Advanced Mode switch the same uncertainty produces rapid re-toggling: the thumb stays put on each click until the
mutation plus `refreshAppContext()` round-trip lands, and the final server state depends on which request resolves
last.

**Fix.** Pass `loading={updateSettings.isPending}` (Button already disables itself when `loading` is set,
Button.tsx:71) and map the mutation's field errors into `submitErrors`. For the switch, add
`disabled={updateAdvancedMode.isPending}` or drive it from optimistic local state.

### The settings tab strip is 40px tall with overflow-x-auto, so its own 12px scrollbar clips the tab labels on every phone and most tablets

`high` · layout · `packages/frontend/src/modules/settings/pages/settings-page.tsx:55`

`<TabsList className="max-w-full justify-start overflow-x-auto ...">` adds horizontal scrolling to a primitive with a
hard `h-10` and `p-1` (packages/frontend/src/components/ui/tabs/tabs.tsx:14), leaving a 32px content box. Scrollbars
in this app are deliberately non-overlay and 12px: globals.css:76-81 resets `scrollbar-width`/`scrollbar-color` to
`auto` so the tokens' `::-webkit-scrollbar { width: 12px; height: 12px }`
(node_modules/@companionintelligence/tokens/src/globals.css:473) applies. A 12px horizontal scrollbar therefore takes
real layout height inside the strip, leaving ~20px for triggers whose own height is `py-1.5` + `text-sm` (~26px), and
because `overflow-x: auto` computes `overflow-y` to `auto` as well, the strip can acquire a second, vertical
scrollbar. The code comment at :48-54 asserts the eight triggers "scroll comfortably in the 358px mobile pane" — the
width math is right, the height math was never done. The repo already has the fix pattern one file over:
app-store-page.tsx:298 pairs `overflow-x-auto` with `no-scrollbar` and `pb-2`.

**What the user sees.** Open /settings at 375px width in the Tauri desktop app or Chromium (or on macOS with "Always
show scrollbars"). A 12px teal scrollbar renders inside the tab strip and the eight tab labels are vertically cut off,
with a second scrollbar appearing on the strip itself.

**Fix.** Add the existing `no-scrollbar` utility to the TabsList and let its height grow: `className="h-auto min-h-10
max-w-full justify-start overflow-x-auto no-scrollbar ..."`. Mirror app-store-page.tsx:298, which already solved this
for the store's chip strip.

### The operators table has no loading and no empty state, so a slow fetch is indistinguishable from "nobody has access"

`medium` · functionality · `packages/frontend/src/modules/settings/components/operators-list/operators-list.tsx:39`

The render branches only on `operators.isError`; `operators.isLoading` is never consulted and `(operators.data ??
[]).map(...)` (:54) renders zero rows while the query is in flight. There is no skeleton (contrast api-keys.tsx:291,
which uses `<Skeleton>` for exactly this card's neighbour) and no empty-state copy (contrast `API_KEYS_EMPTY`), so the
in-flight state, the genuinely-empty state, and a route that returns `{}` on an older Hub all render the identical
five-column header with nothing under it. The card is titled "People on this Hub" with the subtitle "Removed
organization members stay listed as blocked until they are invited back" — which makes an empty table read as a
positive security claim.

**What the user sees.** An owner opens Settings → Security on a Hub whose Portal check-in is slow. The "People on this
Hub" card shows the header row Email / Role / Status / Last org check / Offline password with no rows beneath it, and
they conclude no one else can reach the appliance. A second later the rows appear — or, if the fetch simply hangs,
they never do and the screen keeps making the wrong claim.

**Fix.** Add `operators.isLoading` → `<Skeleton className="h-24 w-full" />` matching the API keys card, and an
explicit empty state for a resolved-but-empty list. Add `scope="col"` to the five `<th>` elements while in there.

### Every "?" help bubble on both tabs is hover-only and keyboard-unreachable, and it is the only place these settings are explained

`medium` · accessibility · `packages/frontend/src/modules/settings/containers/user-settings.tsx:89`

The hint is a bare `<span className="... cursor-help advanced-mode-hint">?</span>` with a `react-tooltip`
`anchorSelect` matching that class. There is no `tabIndex`, no `role`, no `aria-describedby`, and no `title`, so the
span is not focusable and react-tooltip has nothing to open on focus — the text is reachable by mouse hover only. The
same hand-rolled pattern (an identical five-class `clsx()` string, which is a no-op around a single literal) repeats
fourteen more times in user-settings-form.tsx (:240, :271, :316, :361, :411, :441, :493, :515, :537, :559, :583, :609,
:636, :662, :687, :709). It carries load-bearing content that exists nowhere else in the UI or in docs/: what
"Advanced settings" risks, what "Persist Traefik config" does, what "Events timeout" measures. This is also
design-system drift — `react-tooltip` is not among the Radix primitives Part II of docs/UI-STYLE-GUIDE.md sanctions.

**What the user sees.** A keyboard-only operator tabs to the "Advanced settings" switch. They can reach and flip it,
but can never reach the "?" beside it, so the only explanation of what it changes and that misconfiguration "can
result in a broken install" is unavailable to them — the warning modal that follows says the same thing, but the
fourteen other hints have no modal behind them.

**Fix.** Extract one `<HintBubble>` primitive backed by a Radix Tooltip (or at minimum a `<button type="button"
tabIndex={0} aria-describedby>` with react-tooltip's `id`/`data-tooltip-id` rather than a class selector) and replace
all fifteen call sites. A focusable trigger also makes the hints readable on touch, where `cursor-help` does nothing.

---

## Settings: network and pool

### A pairing PIN that is not exactly six digits is silently dropped, and the field lives in a different block from the button that consumes it

`high` · functionality · `packages/frontend/src/modules/settings/containers/hub-pool-settings.tsx:390`

`pairMutation` attaches the PIN only when `/^\d{6}$/.test(pairingPinInput)` passes; otherwise it posts `{ nodeFqdn }`
alone and the request degrades to the unauthenticated request/approve flow. There is no inline validation, no error,
and the success toast is the same `HUB_POOL_PAIR_SUCCESS` ("Pairing request sent.") either way. Compounding it, the
input sits in the "Pairing PIN" block (line 1229-1236) while its only consumer is the Pair button in the "Discoverable
devices" block rendered below it (line 1260-1268), so nothing on screen connects the two — the field reads as part of
the mint/cancel widget above it. The input also has no `label`, `name`, `id` or `aria-label`, so its only accessible
name is the placeholder.

**What the user sees.** Operator reads a PIN off the other Hub, mistypes five of the six digits (or types the PIN and
then clicks Pair on a second device, where the field has already been cleared by the first success at line 393), and
clicks Pair. The UI toasts "Pairing request sent." The far side receives an unverified request with no pinned key, so
its confirm row shows HUB_POOL_PEER_FINGERPRINT_UNVERIFIED ("No key — this request arrived without a pairing PIN, so
the name is only a claim") — the exact case the PIN exists to close — and the operator has no way to tell from their
own screen that the PIN was discarded.

**Fix.** Validate on the field: mark it invalid (Input already supports `error`/`isInvalid`) when 1-5 digits are
present, and either block the Pair click or send the PIN and let the backend 401 surface. Give the input a real
`label` and `name`, and move it next to the Pair buttons (or render it inside the Discoverable devices block) so the
field and its consumer are visually one control.

### The minted pairing PIN is displayed with no expiry and is never invalidated, although it dies after 10 minutes and on first use

`high` · functionality · `packages/frontend/src/modules/settings/containers/hub-pool-settings.tsx:1197`

The mint response's digits are held in local state and rendered at `text-2xl` indefinitely; the branch is chosen
purely by `mintedPin ?` and never consults `status.pairingPin`. `PoolPairingPinState.expiresAt` is declared at line
118 and polled every 15s, but is rendered nowhere — the comment at line 456-460 claims polling exists so "the
countdown" can be rendered, and no countdown was built. The backend PIN lives `PAIRING_PIN_TTL_MS = 600_000`
(packages/backend/src/modules/hub-pool/hub-pool-pairing-pin.service.ts:8) and `consume()` destroys it on first
success, so the displayed digits go dead in two different ways that the screen never reflects.

**What the user sees.** Operator clicks Generate PIN, walks to the other Hub in another room, gets distracted, and
comes back 12 minutes later. The Hub Pool card still shows the same six digits in large type with a live-looking
"Cancel PIN" button beside them, while `status.pairingPin.active` has already flipped to false. They type those digits
on the other Hub and get only "Failed to send pairing request." — with nothing on either screen saying the PIN
expired, so the natural conclusion is that pairing is broken.

**Fix.** Render the remaining validity from `status.pairingPin.expiresAt` next to the digits (a relative countdown;
`relativeAge` is already re-exported by this tab's barrel), and when `mintedPin` is set but `status.pairingPin.active`
is false, replace the digits with an expired/consumed state and the Generate PIN button rather than continuing to show
dead digits.

### The model presence matrix encodes everything in coloured dots with no text alternative and no table header association

`high` · accessibility · `packages/frontend/src/modules/settings/containers/hub-pool-settings.tsx:1060`

Presence is `<StatusDot tone={sole ? 'warn' : 'ok'} />` and absence is a decorative `·` in a muted span. `StatusDot`
is an empty `<span>` with only colour utility classes — no `role`, `aria-label`, `title` or text
(packages/frontend/src/components/ui/dense/dense.tsx:42-44). The sole-sourced warning on the model cell (line 1054) is
likewise a bare dot. `Th` emits no `scope="col"` and the model cell is a `Td` rather than `th scope="row"`
(dense.tsx:113-142), so even an assistive technology that could see the cells has no row/column association in a
matrix of up to 7 columns. The comment at dense.tsx:144-148 acknowledges that the cells are glyphs and solves it for
tests (data attributes) but not for users.

**What the user sees.** A screen-reader user opens Network to check which nodes can serve `qwen3.6:27b` before
disabling a peer. The row announces the model name followed by six empty cells, so the answer — served by 2 of 6
nodes, and one of those is the only source for three other models — is unobtainable. A user with red/green colour
deficiency sees dots in every populated cell but cannot separate `tone="ok"` from `tone="warn"`, which is the single
fact the block exists to convey (comment at line 996-1004: which model lives on exactly one node).

**Fix.** Give each presence cell text content for assistive tech (a visually hidden "available"/"not available", or
`aria-label` plus `role="img"` on the dot), add `scope="col"` to `Th` and render the model cell as `th scope="row"`,
and pair the sole-sourced hue with a non-colour mark (the existing uppercase micro-badge treatment, or the count
already computed as `soleSourced`).

### A failed status fetch renders as "Inactive" on both the Private VPN and Cloudflare Tunnel cards, with no error and no actions

`high` · functionality · `packages/frontend/src/modules/settings/containers/network-settings.tsx:109`

Both cards gate only on `isLoading`, which is false once a query has errored, then derive everything from `data?`:
`active = data?.installed && data?.connected` and `canConnectFlow = data?.installed && !active` (line 109-111), and
`connected={!!status?.tunnelEnabled}` (line 188). Neither query's `isError` is read. So an errored
`/api/tailscale/status` renders the badge as `SETTINGS_NETWORK_INACTIVE`, no Connect button (because `canConnectFlow`
is falsy), no detail grid and no `cliUnavailable` warning — a card with a false claim and zero affordances. The
sibling Hub Pool section in the same file deliberately does the opposite (`isPending`/`isError` with an explicit error
card, hub-pool-settings.tsx:316-512), so the inconsistency is within one screen.

**What the user sees.** The Tailscale sidecar is up and connected, but the Hub's own `/api/tailscale/status` call
fails (session expiry mid-poll, sidecar restart, a 502 from the backend). The operator sees "Private VPN (Tailscale) —
Inactive" with no IP, no hostname, no explanation and no button to press, and concludes the VPN dropped. Directly
below, the Hub Pool card contradicts it by showing the tailnet FQDN and connected peers.

**Fix.** Mirror the Hub Pool pattern: read `isPending` for the skeleton and `isError` for a short "could not read this
status, retrying" notice, and do not render an Active/Inactive badge from absent data.

### Nothing at the top of the densest screen says a pairing request is waiting; the approve/reject controls are the last of twelve blocks

`medium` · layout · `packages/frontend/src/modules/settings/containers/hub-pool-settings.tsx:614`

The KPI row deliberately omits pending/unreachable/disabled counts (comment at line 610-613), the header badge shows
only routing/local-only/off (line 573-578), and when `routingActive` is true the state sentence is `sr-only` (line
587-590), so a visually browsing operator gets no signal at all. The only representation of a pending inbound request
is the "Pending requests" block at line 1299, after the paired-Hubs table, the model matrix (a `max-h-[340px]`
scroller) and the routing log (a `max-h-[220px]` scroller). `status.peerCounts.pending` is fetched and never rendered;
`HUB_POOL_PEER_COUNTS` ("{{connected}} connected · {{pending}} pending · …") is now a dead translation key with no
call site. With no in-page navigation anywhere on the tab, the first card (Private VPN) and the twelfth block are
separated only by scroll distance.

**What the user sees.** Another Hub sends a pairing request. The operator opens Settings → Network, sees "Hub Pool —
Routing", five KPI chips (Peers 3, Served 41, Failed 0, In flight 0, Hardware high) and a healthy paired-Hubs table,
and closes the tab. The request sits unapproved because approving it requires scrolling past nine paired rows, a model
matrix and a routing table with nothing above them hinting that anything needs attention.

**Fix.** Surface `peerCounts.pending` at the top — either a sixth StatChip toned `warn` when non-zero, or an
actionable notice next to the header badge that scrolls to the Pending requests block — and add an in-page section
jump list for the card's eight blocks (the block titles already exist as `Block` headings).

### A peer with no display name prints its FQDN twice, stacked, in the same table cell

`medium` · copy · `packages/frontend/src/modules/settings/containers/hub-pool-settings.tsx:917`

`peerLabel` falls back to the FQDN when `displayName` is null (line 207), and the Node cell renders `peerLabel(peer)`
as the bold identity (line 917) and then always renders `peer.nodeFqdn` as the mono second line (line 939-941). For a
peer with a display name this reads as label + identity; for a peer without one it is the same string twice. This is
also the cause of the mixed naming observed live: the column shows short names for peers that have `displayName`
(core-3, beta-1, fzzy) and full tailnet FQDNs for those that do not (<node>.<tailnet>.ts.net), so one column mixes two
naming schemes and one row can be twice as tall as its neighbours.

**What the user sees.** On a nine-row appliance table, the row for a peer paired without a display name shows
"<node>.<tailnet>.ts.net" in bold and "<node>.<tailnet>.ts.net" in mono immediately beneath, while the row above shows
"fzzy" over "<node>.<tailnet>.ts.net". An operator comparing nodes cannot scan the column, and reasonably reads the
doubled row as a duplicate pairing.

**Fix.** Render the second line only when it differs from the first (`peer.displayName ? peer.nodeFqdn : null`), and
normalise the primary label — either always the short host portion of the FQDN with the full name on the second line,
or always the FQDN — so one column carries one naming scheme.

### Per-peer switches and Unpair buttons carry no peer identity for assistive tech, and the pool switches announce camelCase field names

`medium` · accessibility · `packages/frontend/src/modules/settings/containers/hub-pool-settings.tsx:972`

Every row's switch gets the same static `aria-label={t('HUB_POOL_PEER_TOGGLE_LABEL')}` — "In the pool" — and every
row's button is just "Unpair", with the peer name only in adjacent cell text that is not part of either control's
accessible name. Separately, `Switch` sets `aria-label={props.name}` before spreading props
(packages/frontend/src/components/ui/Switch/Switch.tsx:17), so the three pool switches, which pass no `aria-label`,
are named after their form field: "hubPoolEnabled", "hubPoolOutboundEnabled", "hubPoolInboundEnabled". The visible
labels ("Pool inference with paired Hubs", "Send work to paired Hubs", "Serve work for paired Hubs") are in a sibling
span referenced by `aria-labelledby` on the wrapping `<label>`, which does not name the switch.

**What the user sees.** A screen-reader user tabs through the paired-Hubs table on a nine-peer appliance and hears "In
the pool, switch, on" then "Unpair, button" nine times over, with no way to know which Hub each pair belongs to, and
toggles or unpairs the wrong node. Moving up to the controls block, the same user hears "hubPoolOutboundEnabled,
switch, on" instead of "Send work to paired Hubs".

**Fix.** Pass a peer-qualified `aria-label` to each row's switch and an `aria-label` (or visually hidden suffix) to
each Unpair button using `peerLabel(peer)`. In `Switch`, drop `aria-label={props.name}` and instead give the label
span a generated id that the Root references via `aria-labelledby`, so the visible text is the accessible name.

---

## Settings: AI and MCP

### Model pull and pin failures are announced as a success toast with only a count, and the reasons are discarded

`high` · functionality · `packages/frontend/src/modules/settings/containers/ai-settings.tsx:579`

`handleSave` collects precise, actionable messages into `modelOperationErrors` — `Failed to pull ${modelId}:
${message}`, `... timed out`, `Failed to pin ...`, `Failed to unpin ...` (lines 550, 556, 563, 574) — and then throws
all of them away, passing only `count` to `toast.success(t('AI_SETTINGS_SAVED_WITH_ISSUES', { count }))` at line 580.
The rendered string is "AI settings saved with 1 model issue(s)." on a green success toast; nothing on the screen ever
names the model or the reason. Compounding this, nothing guards the save against a budget the UI has already flagged
as impossible: `ResourceSummaryBar` computes `budget.overDisk` and renders a red bar plus `budget.diskReason`
(resource-summary-bar.tsx:85-89), but the Save button (line 884) is never disabled and the confirmation dialog copy
(`AI_SETTINGS_CONFIRM_DESCRIPTION`) does not mention the overrun.

**What the user sees.** On a Hub with 30 GB free, select a 40 GB model. The budget bar immediately turns red and says
the download needs more space than is available. Save is still enabled; the confirmation dialog says only "Updating
these settings will restart your apps that use AI models. Continue?". The user confirms, the button spins for as long
as ten minutes (`waitForModelPulls` timeout at line 548), and the outcome is a green toast reading "AI settings saved
with 1 model issue(s)." The user is told the save succeeded, is never told which model failed or that the disk filled
up, and the card still shows the model checked.

**Fix.** Surface the collected messages: render `modelOperationErrors` in a dismissible error panel in the
Downloaded-models section (or a dialog), and switch the partial-failure toast to `toast.error` with the first message
plus "and N more". Separately, either disable Save while `budget.overDisk` is true or add the overrun to the
confirmation dialog body so the user sees the cost before committing ten minutes. Also replace the "issue(s)" copy
with an i18next plural form.

### Installed-MCP-app name links to a route that does not exist, with reversed URN segments

`high` · functionality · `packages/frontend/src/modules/settings/containers/mcp-settings.tsx:292`

The link is built as `/app-store/${entry.urn.replace(':', '/')}`. Two independent faults. (1) There is no `/app-store`
route: `packages/frontend/src/routes.ts` defines the app-detail pages under `store/:storeId/:appId` (line 31) and
`apps/:storeId/:appId` (line 44), and `/app-store/...` therefore falls through to the catch-all `route('*',
'./routes/not-found.tsx')` (routes.ts:52). This is the only `/app-store/` string left in the frontend. (2) A Hub URN
is `appName:storeId` — every other consumer destructures it that way (`app-card.tsx:31` builds
`/store/${storeId}/${appId}`, `horizontal-app-list.tsx:86` builds `/apps/${storeId}/${appName}`) — so `.replace(':',
'/')` also emits the two segments backwards. Even after fixing the prefix, the URL would be
`/store/<appName>/<storeId>`.

**What the user sees.** Install a marketplace app that exposes MCP tools (for example
`openclaw:companionintelligence`), open Settings → MCP, and click the app name in the "Installed MCP servers" table.
The URL becomes `/app-store/openclaw/companionintelligence` and the user lands on the not-found page instead of the
app's detail page. There is no other link from this table, so the only path out is the browser back button.

**Fix.** Destructure the URN instead of replacing the separator, and use the live route: `const [appName, storeId] =
entry.urn.split(':')` then `to={`/apps/${storeId}/${appName}`}` (the installed-app detail route, matching
`horizontal-app-list.tsx:86`). Add a mcp-settings test that renders one installed MCP app and asserts the anchor's
`href`.

### A failed installed-apps fetch renders the "no MCP servers installed" empty state

`high` · functionality · `packages/frontend/src/modules/settings/containers/mcp-settings.tsx:84`

`loadInstalledMcpApps` returns silently on a non-OK response (line 84) and swallows every throw (lines 118-120, `catch
{ /* optional section */ }`), leaving `installedMcpApps` at `[]`. The render then takes the empty branch at line
275-276 and prints `MCP_SETTINGS_INSTALLED_EMPTY` — "No MCP server apps installed yet." The section has no loading
state and no error state at all, so a failure is indistinguishable from a genuine empty appliance. The per-app bridge
probe has the same shape (lines 106-108): when `/api/apps/{urn}/mcp/status` fails, `bridge` stays `undefined` and the
Bridge column prints a bare em dash (line 298) that a user cannot tell apart from "container has no status yet".

**What the user sees.** With two bridged MCP apps installed, restart the backend or otherwise make
`/api/apps/installed` return 500 (or let the request time out) and open Settings → MCP. The status card above still
loads normally, so the tab looks healthy, while the "Installed MCP servers" card positively asserts that nothing is
installed. An operator debugging why their agent cannot reach an app's tools concludes the app is gone and reinstalls
it.

**Fix.** Give the section its own three states: track `installedLoading` and `installedError`, render a `Skeleton`
while in flight, and render an error line with a retry button (the same shape as lines 224-233) when the fetch fails.
Keep the empty copy only for a successful response with zero MCP apps. For the per-app probe, distinguish "probe
failed" from "no status" so the Bridge column can say "Unknown" rather than an em dash.

### "Other models" group labels contradict the ranges they actually filter on, and one uses a literal `<=`

`medium` · copy · `packages/common/i18n/translations/en.json:1207`

The group labels and the matchers disagree at the boundary. `OTHER_MODEL_GROUPS` (model-selection-card.tsx:329-359)
puts a model in `large` only when `parameterScale > 70` and in `medium` when `> 14 && <= 70`, but the labels shipped
in en.json:1207-1209 read "Large models - 70B+" and "Medium models - 15-70B" — so a model whose `parameterScale` is
exactly 70 is filed under Medium while the Large label promises it. The small group has a second, independent defect:
en.json:1209 is `"Small models - <=14B"`, an ASCII `<=` in user-facing copy, where the code's own fallback title on
line 346 is the correct `Small models · ≤14B`; the en.json values also downgrade the `·` separator to a hyphen, so the
shipped labels never match the code's intent. es-ES.json:933 has copied the same hyphen form.

**What the user sees.** On Settings → AI, expand "Other models" while the catalog contains a 70B model. The user opens
"Large models - 70B+" looking for it, does not find it, and concludes the Hub cannot run it; the model is sitting in
"Medium models - 15-70B". A user scanning the same list also reads the third group as "Small models - <=14B", with the
comparison operator rendered as two ASCII characters mid-sentence.

**Fix.** Pick one boundary and state it: either change the `large` matcher to `>= 70` or change the label to "Large
models · over 70B", and make the medium label match ("15B to 70B"). Replace `<=` with `≤` (or the words "14B and
under") in en.json and es-ES.json, and restore the `·` separator so the shipped strings match the code fallbacks. A
small unit test over `OTHER_MODEL_GROUPS` asserting which group a 14B, a 70B, and a 71B model land in would pin the
boundary.

### Model cards show three bare numbers — RAM, disk, and an intelligence score — with no label, no scale, and no aria on the bars

`medium` · accessibility · `packages/frontend/src/modules/onboarding/components/ai-setup/model-selection-card.tsx:68`

`modelMeta` renders memory footprint and disk size as two adjacent figures whose only distinguishing mark is a
decorative lucide glyph (`MemoryStick`, `HardDrive`, lines 72 and 77). Neither icon has `aria-label` or `title`,
neither figure has a text label, and the wrapper has no accessible name, so the card exposes "24.9 GB 22.6 GB" with
nothing to say which is which — a screen reader user gets two unattributed sizes, and a sighted user has to decode two
12px monochrome glyphs. The same two values are properly labelled in the other-models table (RAM / Disk column headers
at lines 304-305), so the card is the outlier. The intelligence score has a matching problem in
`primitives.tsx:266-278`: `ScoreBar` prints the label "Intelligence" and a number with no maximum shown anywhere, and
its proportional bar is a plain `<span>` with no `role="progressbar"`, `aria-valuenow`, or `aria-valuemax`, so the bar
conveys nothing to assistive tech and the length is invisible to it. Worse, the bar's scale is wrong at the top end:
`SCORE_BAR_MAX = 40` (levels.ts:46) while the file's own comment (levels.ts:42-44) records that frontier models score
about 53 on the index the catalog now uses, and `pct` clamps at 100 (primitives.tsx:267). The two budget bars in
`resource-summary-bar.tsx:52-57` and `:65-70` are likewise div-width-only with no aria.

**What the user sees.** On Settings → AI a recommended card reads "Qwen 3.6 35B — Intelligence [half-full bar] 19 —
24.9 GB 22.6 GB". A user comparing two models cannot tell whether 24.9 GB is what the model needs in memory or on
disk, and reads 19 as a poor score out of 100 when it is in fact roughly half of the practical 40-point ceiling. Put a
40-score and a 53-score model side by side and both bars render completely full, so the bar says they are equal. With
a screen reader, the card announces "Intelligence 19, 24.9 GB, 22.6 GB" and the bar is skipped entirely.

**Fix.** Label the figures: wrap each in a span with visible short text (`RAM 24.9 GB`, `Disk 22.6 GB`) or at minimum
add `aria-label`/`title` to each and `aria-hidden="true"` to the lucide glyphs. In `ScoreBar`, render the denominator
(`19 / 40`) or append the index name, and give the track `role="progressbar"` with `aria-valuenow`,
`aria-valuemin={0}`, `aria-valuemax={SCORE_BAR_MAX}` and `aria-label={label}`; do the same for the two budget bars.
Re-derive `SCORE_BAR_MAX` from the current catalog distribution so scores above it cannot collapse into an identical
full bar.

### Hardware tier badge uses emoji as its icon and raw Tailwind palette colours instead of tokens

`medium` · design-system · `packages/frontend/src/modules/onboarding/helpers/hardware-display.ts:25`

`TIER_BADGES` pairs each hardware tier with a literal emoji — 🚀 high, ⚡ medium, 💡 low, 🔧 cpu-only, ☁️ insufficient
(lines 26-34) — plus 🎮 for an AMD APU (line 42) and ✨ for Apple silicon (line 49). `system-overview.tsx:93` renders it
as `{badge.emoji} {badge.label}` inside the AI tab's header, which is otherwise built entirely from lucide icons
(`Monitor`, `Cpu`, `MemoryStick`, `HardDrive`, `AlertTriangle` in that same file). The emoji is not `aria-hidden`, so
it is read out. The colours are also raw Tailwind palette rather than tokens: `bg-green-100 text-green-800
dark:bg-green-900 …`, `bg-violet-100 text-violet-900 dark:bg-violet-950 …`, `bg-slate-200 …`, which is exactly the
drift the style guide flags (docs/UI-STYLE-GUIDE.md H-3, "prefer token-based status colors") and which the sibling
`levels.ts` already fixed by moving onto the `--level-*` tokens. The in-file comment at lines 17-24 explains why the
*polarity* cannot be mapped onto `--level-*`, but it does not excuse the palette classes or the emoji.

**What the user sees.** Open Settings → AI on a Strix Halo appliance. Next to the "System overview" heading — which
sits beside a crisp lucide monitor glyph — a violet pill renders a game-controller emoji followed by "APU", drawn by
the platform emoji font at whatever size and colour the OS chooses, ignoring the theme entirely. A screen reader
announces "video game APU". The badge also keeps its violet/green/slate palette when the user picks a different theme
base, so it is the one element on the tab that does not follow the theme.

**Fix.** Replace the emoji map with lucide components (e.g. `Rocket`, `Zap`, `Lightbulb`, `Wrench`, `Cloud`,
`Gamepad2`, `Sparkles`) rendered with `aria-hidden="true"` at the same `[&_svg]:h-4` sizing the rest of the card uses,
and back the badge colours with semantic tokens (`--success` / `--warning` / `--destructive` / `--primary`) so the
pill follows the theme. If the tier polarity genuinely cannot map onto `--level-*`, add the three or four tier tokens
rather than keeping palette classes.

### Hardcoded English strings in otherwise localized screens, including the AI tab's primary button

`medium` · copy · `packages/frontend/src/modules/settings/containers/ai-settings.tsx:885`

The AI tab's primary action is the literal JSX text `Save AI Settings` — no `t()` call — while every other string on
the tab goes through i18next, and `es-ES.json` does translate this screen (`AI_SETTINGS_RECOMMENDED_MODELS_SUBTITLE`,
`AI_SETTINGS_SAVED`, `COMMON_RECOMMENDED_MODELS` are all present). It also breaks the sentence-case rule in
docs/writing-style.md ("Sentence case for titles and headings"); the matching toast key already reads "AI settings
saved". Two more hardcoded English strings reach this same tab from the budget helper:
`packages/frontend/src/modules/onboarding/helpers/onboarding-model-selection.ts:61` (`Selected downloads need …
Deselect models or free disk space before continuing.`) and `:66` (`New model selections may need … Hub will attempt
best-effort downloads…`), both rendered by resource-summary-bar.tsx:85-89. On the MCP tab the installed-apps table is
hardcoded the same way: headers `App`, `Status`, `Bridge`, `Tools` (mcp-settings.tsx:282-285) and the values
`Connected` / `Needs attention` (line 298).

**What the user sees.** Switch the Hub UI to Spanish and open Settings → AI. The section heading reads "Modelos
recomendados" and the subtitle is fully translated, but the button that commits the whole screen reads "Save AI
Settings". Select a model that overruns the disk and the red warning underneath is a paragraph of English. On Settings
→ MCP the installed-servers table keeps English column headers while its own card title and description are
translated.

**Fix.** Add `AI_SETTINGS_SAVE_BUTTON` ("Save AI settings") and use it at line 885. Move the two budget strings into
translation keys and have `computeSelectionBudget` return keys plus interpolation values rather than formatted English
(it is a pure helper, so pass `t` in or return `{ key, values }`). Add keys for the four MCP table headers and the two
bridge states.

### The tool runner fetches each tool's inputSchema and never shows it, so arguments are typed blind

`medium` · functionality · `packages/frontend/src/modules/settings/containers/mcp-settings.tsx:400`

`McpToolInfo` carries `inputSchema: Record<string, unknown>` (line 38) and `/api/mcp-admin/tools` returns it for every
tool, but the schema is never rendered anywhere. `openRunner` seeds the textarea with the literal `'{}'` (line 170)
and the dialog offers a bare `<textarea>` labelled only "Arguments" (lines 397-406). The dialog title is the tool name
and the catalog's one-line description is not carried into the dialog either, so once the runner opens the operator
has no parameter names, no types, and no required/optional information on screen. The only feedback loop is submitting
and reading the backend's validation error.

**What the user sees.** Open Settings → MCP, find a write tool such as a task-creating tool in the catalog, click Run,
and press Run with the default `{}`. The backend rejects it and the failure text appears under a heading that reads
"Result", styled identically to a successful result (line 418-421). To discover that the tool wanted, say, `title` and
`dueDate`, the operator has to read the Hub's source or guess one key at a time.

**Fix.** Render the schema in the dialog: list `inputSchema.properties` keys with their `type` and a required marker
above the textarea, and pre-fill the textarea with a skeleton object containing the required keys. Also echo the
tool's `description` in the dialog body, and style a failed call (`body.ok === false`) with `text-destructive` and an
"Error" heading rather than reusing the neutral "Result" heading.

---

## Settings: system and logs

### Factory-reset confirmation phrase survives Cancel, so reopening the dialog arms a one-click wipe

`high` · functionality · `packages/frontend/src/modules/settings/containers/general-actions.tsx:543`

`factoryResetPhrase` is component state (line 62) and nothing clears it. Cancel (line 543), the dialog X, Escape, and
an outside click all only call `setFactoryResetOpen(false)`. The confirm button's gate is
`disabled={factoryResetPhrase.trim() !== FACTORY_RESET_CONFIRMATION}` (line 549), evaluated against that surviving
state. The System tab keeps the container mounted the whole time you stay on it, so the phrase persists for the rest
of the visit.

**What the user sees.** On /settings?tab=system an operator clicks Factory reset Hub, types `factory-reset`,
reconsiders and clicks Cancel. Five minutes later, still on the System tab, they click Factory reset Hub again to
re-read what it destroys. The dialog opens with `factory-reset` already in the input and the red Factory reset Hub
button already enabled. One click — with no typing, which is the entire point of the gate — truncates `user`, `app`,
`api_key` and `device_registration` and wipes every app data mount.

**Fix.** Clear the phrase whenever the dialog closes: pass `onOpenChange={(open) => { setFactoryResetOpen(open); if
(!open) setFactoryResetPhrase(''); }}` and reset it in the Cancel handler, so every open starts from an empty input.

### A factory reset that fails or is interrupted midway leaves a half-wiped Hub while the UI says it failed

`high` · functionality · `packages/frontend/src/modules/settings/containers/general-actions.tsx:111`

`FactoryResetService.execute()` (packages/backend/src/modules/system/factory-reset.service.ts:55-73) is seven
sequential destructive steps with no rollback: tearDownApps, wipeDataMounts, wipeDatabase, clearRegistrationArtifacts,
resetRegistration, resetSettings, cache clears. `wipeDatabase` already TRUNCATEs `user`/`api_key` and invalidates the
session cache (lines 102-124) before `clearRegistrationArtifacts` or `resetSettings` can throw — and `resetSettings`
writes `state/settings.json`, which is root-owned on appliance stacks, so EACCES there is a realistic mid-sequence
failure. The frontend catch (lines 111-114) does one thing: `toast.error('Factory reset failed. Try `cihub reset
--yes` from the CLI if the Hub is unreachable.')`. It does not call `clearClientHubState()`, does not navigate, and
does not distinguish a 403 (the controller rejects non-operators at factory-reset.controller.ts:20) from a 500 after
the database was already destroyed. Separately, `onOpenChange={setFactoryResetOpen}` (line 522) with the default
`showCloseButton` leaves Escape, the X and outside-click live during the run, and the per-app teardown loop has no
progress reporting, so the only signal is one spinner on the confirm button.

**What the user sees.** An operator on an appliance Hub confirms the reset. Apps are torn down, data mounts are
deleted, the user table and every API key are truncated, then `writeSettingsJsonFile` hits EACCES on the root-owned
settings.json and the request 500s. The dialog stays open with a red toast reading 'Factory reset failed' and advice
to run the CLI 'if the Hub is unreachable' — but the Hub is reachable and the reset largely happened. The operator
reasonably concludes nothing was destroyed and clicks Cancel; every subsequent request 401s against a wiped user
table, their agents' API keys are already dead, and their apps are gone. A non-operator admin sees the same 'failed'
toast and the same wrong CLI advice for what is actually a permissions refusal.

**Fix.** Return per-step results from `execute()` and render them in the dialog as a checklist, so a partial reset
tells the user exactly what was destroyed and what was not. On any non-2xx, keep the dialog open with that breakdown,
call `clearClientHubState()` and force `/login` whenever the database step reported success, and branch the message on
status (403 -> 'Only Hub operators can factory reset', 5xx -> the CLI fallback). Block dismissal while
`factoryResetting` with `onOpenChange={(open) => { if (!factoryResetting) setFactoryResetOpen(open); }}` plus
`showCloseButton={!factoryResetting}`.

### After any Hub-stack update outcome the update controls are replaced by an undismissable status strip

`high` · functionality · `packages/frontend/src/modules/settings/containers/general-actions.tsx:324`

`renderUpdateButton()` returns the status strip first: `if (stackMessage) return (...)` (lines 324-336), so a non-null
`stackMessage` short-circuits both the Update-stack button (line 346) and the Check-for-updates button (line 376). The
strip's only control, Stop waiting, is rendered `{updating && ...}` (line 329). Both terminal paths set a message and
clear `updating`: `subscribeStackUpdate` on completion or non-confirmation (lines 137-143) and the failure branches of
`handleUpdate` (lines 197-203). `handleCheckForUpdates` is the only code that clears `stackMessage`, and its button is
unreachable while the message is set.

**What the user sees.** An operator clicks Update stack to 0.2.71. `performStackUpdate` fails because the host
listener is down, so the card now shows a grey strip reading 'Update request failed' with no spinner, no Stop waiting
button, and no Update or Check for updates button anywhere on the Hub stack card. There is no way to retry or dismiss
without a full page reload — and switching to another settings tab and back does reset it, which is undiscoverable.
The same dead end follows a successful update ('Updated. The Hub is running 0.2.71.') and the not-confirmed case,
whose own copy tells the user to go read the Logs tab and come back to a card that no longer has a button.

**Fix.** Always render the action button alongside the strip, and give the strip a dismiss control that is not gated
on `updating` — e.g. keep `Stop waiting` while `updating` and show a `Dismiss` that calls `setStackMessage(null)`
otherwise. At minimum clear `stackMessage` at the top of `handleUpdate` and `handleCheckForUpdates` and render the
button below the message rather than instead of it.

### The Logs tab renders nothing at all for connecting, empty, and failed states

`high` · functionality · `packages/frontend/src/modules/settings/containers/logs.tsx:19`

`LogsContainer` holds one piece of state, `logs`, initialised to `[]`, and passes it straight to `LogsTerminal`, which
joins it into `dangerouslySetInnerHTML` (packages/frontend/src/components/logs-terminal/logs-terminal.tsx:30-33,
73-79). There is no `isConnecting`, no empty state, and no error state. `useSSE` is called with no `onError` and no
`onOpen` (logs.tsx:19-34), so a failure only reaches `console.error` and an exponential-backoff retry that stretches
to 60s between attempts (packages/frontend/src/lib/hooks/use-sse.ts:103-133). The backend's stream comes from
`getLogsStream` through `docker logs` (packages/backend/src/core/sse/sse.controller.ts:25-29, sse.service.ts:103-127),
so an unavailable Docker socket produces a stream that never emits. The `<Suspense>` at logs.tsx:61 also has no
fallback, so the lazy chunk load shows nothing either.

**What the user sees.** An operator whose Hub is misbehaving opens /settings?tab=logs. The session cookie has expired,
so the EventSource 401s, or dockerode cannot reach the socket so no line is ever emitted. They see the follow/wrap
switches, the max-lines box, the Download full logs button, and a completely blank bordered panel. Nothing says
connecting, disconnected, or 'no logs yet'. They wait, reload, wait again — the retry backoff is already at 32s — and
reasonably conclude the Hub produces no logs, on the one screen they opened to find out why the Hub is broken.

**Fix.** Track connection state from `useSSE`'s `onOpen`/`onError`/`onReconnecting` callbacks and render three
explicit states inside the terminal frame: 'Connecting to the log stream…', 'No log lines yet' once open with an empty
buffer, and a 'Log stream disconnected — retrying in Ns' row with a Retry button on error. Give the `<Suspense>` a
fallback matching the other tabs.

### The Auto-update stack toggle is a hand-rolled switch with no accessible name, and its failures are silent

`medium` · accessibility · `packages/frontend/src/modules/settings/containers/general-actions.tsx:411`

Lines 411-422 hand-roll `<button type="button" role="switch" aria-checked={autoUpdates}>` whose only child is a
decorative `<span>`. It carries no `aria-label`, no `aria-labelledby` pointing at the `<h3>` on line 408, and no text
content, so it has no accessible name. The repo already ships a labelled Radix switch —
`packages/frontend/src/components/ui/Switch/Switch.tsx` wires `label`, `htmlFor` and `aria-label` — and the sibling
Logs tab uses it (logs-terminal.tsx:56-57). `handleAutoUpdatesToggle` (lines 234-245) swallows every error in a bare
`catch { // ignore }` and only calls `setAutoUpdates(newValue)` on success, and the state is optimistically seeded
`true` (line 58) before `getAutoUpdates()` resolves.

**What the user sees.** A screen-reader user tabbing through the System tab hears 'switch, on' with no name, three
cards deep, with no way to tell which setting it controls. A sighted fleet admin on an appliance under test clicks the
toggle to stop the Hub replacing itself mid-run; the PATCH 403s or 500s, the catch swallows it, the knob springs back
to on, and no toast or inline message appears — so they believe auto-update is off, walk away, and the node updates
itself anyway. On first paint the same toggle shows 'on' on a node where auto-update is off, until the GET resolves.

**Fix.** Replace the hand-rolled button with the existing `Switch` primitive and give it a name
(`name="auto-update-stack"` plus the `SETTINGS_ACTIONS_AUTO_UPDATE_STACK_TITLE` label, or `aria-labelledby` on an id
added to the `<h3>`). In `handleAutoUpdatesToggle`, toast the error and revert explicitly, and initialise
`autoUpdates` to `null`/undefined so the control renders indeterminate or disabled until `getAutoUpdates()` answers.

### Typing a larger Max lines value destroys the log buffer digit by digit, and can never fetch more history

`medium` · functionality · `packages/frontend/src/modules/settings/containers/logs.tsx:36`

`updateMaxLines` truncates on every keystroke: `setLogs((currentLogs) => currentLogs.slice(currentLogs.length -
linesToKeep))` (lines 36-40), driven by the number input's `onChange` (logs-terminal.tsx:61-69). Raising the cap is
also inert in the other direction: the SSE `maxLines` param is only read when the EventSource is constructed, and
`useSSE`'s effect runs once on mount with `[]` deps (use-sse.ts:138-173), while `maxLines` lives in a ref that never
triggers a resubscribe. The backend applies the value once as the `docker logs` tail at subscribe time
(sse.controller.ts:26-29, sse.service.ts:103-104), so after mount the client can only ever shrink its buffer.

**What the user sees.** An operator with 1000 buffered lines wants 5000 so they can scroll back through an install
failure. They select the field and type `5000`. The first keystroke sets the cap to 5 and immediately discards 995
lines; the next sets it to 50, then 500, then 5000. The buffer is gone and cannot come back — the stream only pushes
new lines from here, and the 5000-line tail they asked for is never requested. The panel now shows a handful of lines
and slowly refills, with no undo and no hint that the number they typed did nothing except delete their history.

**Fix.** Only apply the cap on blur or Enter (or debounce it), keep the typed value in local input state so
intermediate digits never truncate, and make the buffer cap independent of the fetch: when the value rises above the
subscribed tail, resubscribe with the new `maxLines` (move it into state so `useSSE` re-runs) or say in the UI that
the cap trims the view and does not refetch history.

---

## Resource monitor

### Status is signalled by an 8px coloured dot with no text, no aria-label, and no title

`high` · accessibility · `packages/frontend/src/components/ui/dense/dense.tsx:41`

`StatusDot` renders a bare `<span>` whose only content is a background-colour class from `TONE_BG` (ok = `--success`,
bad = `--destructive`). It is the entire content of the STATE column in the workload table (local-resources.tsx:365,
tone derived from `app.degraded` / `app.responsive`), of the STATE column in the local-models table
(local-resources.tsx:256), and of the OUTCOME column in the routing feed (pool-activity.tsx:296). The routing feed's
word is only on the `<td>`'s `title` (line 285) and the workload table's only when `app.reason` is non-null (line 364)
— both mouse-hover only. The pool-node table is the one place that pairs a dot with a word (pool-nodes.tsx:314), so
the pattern is already available.

**What the user sees.** A screen-reader operator reads the "Workload resource usage" table and hears "Immich, 12.4%,
300 MB, 2" and then nothing for STATE — a degraded workload and a healthy one are announced identically. A red/green
colour-blind operator on a phone (where there is no hover) cannot tell served from failed in a 40-row routing feed,
and the page's whole verdict rests on that distinction.

**Fix.** Give `StatusDot` a required `label` and render it as `role="img" aria-label={label}` plus a `<span
className="sr-only">`; then pass the already-translated status word (`RESOURCE_MONITOR_RESPONSIVE` / `_UNRESPONSIVE` /
`_DEGRADED_BADGE`, `entry.outcome`) at each call site, and show the word beside the dot from `@sm` up as
pool-nodes.tsx already does.

### The verdict's "requests no node took" fault is counted over the whole ring buffer, so one old unplaced request keeps the page red for days

`high` · functionality · `packages/frontend/src/modules/system/pages/resource-monitor-page.tsx:112`

`activity = routingActivity(entries)` counts all 200 entries with no window (pool-node-series.ts:452-484; `if
(!entry.node) activity.unplaced += 1`), and that raw count is handed to `pageVerdict` as `routing.unplaced`, which
raises a `tone: 'bad'` fault (triage.ts:105). The rail's own 30-minute counters deliberately use `buckets` instead for
exactly this reason, and the one rail figure that is whole-log is explicitly captioned "whole log, not 30m"
(kpi-rail.tsx:279, en.json DASHBOARD_RAIL_FAILOVERS_SUB) — the verdict chip carries no such qualifier, and the verdict
is the line an operator reads instead of the panels.

**What the user sees.** Three outbound requests go unplaced at 09:00 while a peer reboots. At 17:00, with the pool
healthy and "Routed 30m" showing 0, the page still opens on a red "3 faults · 3 requests no node took". Nothing clears
it but 200 further routing entries or a Hub restart, and on a quiet Hub that ring spans days — so the page's headline
is permanently red and the operator stops reading it.

**Fix.** Derive the verdict's unplaced count from the same 30-minute window the rail uses (extend `routingBuckets` to
carry `unplaced`, or filter `entries` to `now - BUCKET_MS * BUCKET_COUNT` before `routingActivity`), or add the window
to `DASHBOARD_VERDICT_UNPLACED` so "3 requests no node took" cannot read as "right now".

### A minute that routed one request draws a shorter bar than a minute that routed none

`high` · layout · `packages/frontend/src/modules/system/panels/pool-activity.tsx:68`

Bars are `height: (bucket.failed|served / max) * 100%` of the flex column inside an `h-24 ... p-2` box, i.e. ~80px of
usable height, while the measured-zero bucket draws a fixed `h-[2px]` tick (line 74). Any bucket below 2.5% of the
busiest minute therefore renders shorter than the "nothing was routed" marker, and below ~1.25% it is sub-pixel and
antialiased away entirely. The panel has no y-axis label at all — only "{total} in window · busiest minute {peak}"
underneath (line 81) — so there is nothing to read the height against.

**What the user sees.** An OpenClaw burst puts 300 requests in one minute; the following 29 minutes carry 1-3 requests
each. Those 29 minutes draw 0.27-0.8px slivers while any truly idle minute draws a crisp 2px tick, so the chart says
the Hub was busier when it was idle than when it was serving. An operator scanning for "when did traffic stop" reads
the wrong minute.

**Fix.** Floor a non-zero bar at 2-3px (`style={{ height: `max(3px, ${pct}%)` }}` or `minHeight: 3`), and move the
measured-zero tick out of the same stack — draw it at 1px on the baseline rule, or tone it `muted-foreground/15` so it
can never out-rank a real bar.

### GPU trend axis is computed in bytes from megabyte data: caption reads "scale to 256 TB" and every GPU trace flattens onto the baseline

`high` · functionality · `packages/frontend/src/modules/system/panels/workload-trends.tsx:167`

For `metric === 'gpu'` the axis ceiling is `computeMemoryChartScale(values).max`, but `values` are `gpuVramMb`
MEGABYTES while that helper is written for BYTES (packages/frontend/src/modules/system/resource-monitor-chart.ts:30-58
— `const MIB = 1024 ** 2`, minimum step 256 MiB). A 24 GB resident model (24576 MB) is treated as 24576 bytes, so the
ceiling floors at 256 MiB = 268,435,456, and `formatAxis` (line 110) multiplies that by 1024*1024 a second time before
`humanBytes`, printing 256 TB. The same wrong ceiling is handed to `StepAreaChart` as `max` alongside points still in
MB, so `y()` (dense.tsx:380) puts 24576/268435456 = 0.009% of a 38px row — the trace is drawn on the baseline, which
on this page is the encoding for a measured zero. Verified numerically: axisMax 268435456, label "256 TB", trace
height 0.009%.

**What the user sees.** On beta-max (121 GB unified, ollama holding a 24 GB model), the "GPU memory by workload" tile
prints "scale to 256 TB" above rows that correctly read "24 GB · peak 24 GB" while every trace is a flat line pinned
to the bottom of its row — indistinguishable from a workload that holds no VRAM at all. CPU and memory tiles beside it
are correct, so the operator concludes the GPU sampler is broken.

**Fix.** Scale in the metric's own unit: pass `values.map((v) => v * 1024 * 1024)` into `computeMemoryChartScale` (and
drop the second `* 1024 * 1024` in `formatAxis`), or add a `computeVramChartScale` that takes MB. Then extend
workload-trends.test.tsx:172 — it asserts the row value "600 MB" but never the axis caption, which is why a 256 TB
axis passes today.

### Model memory budget rounds megabyte values to whole gigabytes, printing "0G" for real usage

`medium` · copy · `packages/frontend/src/modules/system/panels/local-resources.tsx:180`

Every field of `/inference/memory` is in MB (use-dashboard-data.ts:220: "The eleven fields of `/inference/memory`, all
measured in MB") and each is rendered as `${Math.round(value / 1024)}G` — the Docker overhead line (line 180), the
used/budget line (lines 150-151), the installed total (166) and the pinned figure (167). Anything below 512 MB
therefore prints "0G", and anything below 1.5 GB prints "1G". `dockerOverheadMb` is `runningAppContainerCount * 500`
(packages/backend/src/modules/inference/memory-manager.service.ts:7,28), so it lands in that range constantly. The
pinned string is even keyed `DASHBOARD_MEMORY_PINNED_MB` while formatted in G, and the rail directly above prints the
same class of quantity through `humanBytes` as "24 GB" — two unit conventions on one screen.

**What the user sees.** A Hub running one app container shows "Holds back an estimated 0G for running app containers."
when it is holding back 500 MB. On beta-max's 2048 MB VRAM card, a row with 400 MB of models loaded against a 1.6 GB
budget reads "0G of 2G · 25%" beside a bar that is visibly a quarter full — the operator reads it as a broken panel
and cannot use the number to size a model.

**Fix.** Format these through `humanBytes(mb * 1024 * 1024)` so sub-gigabyte values keep a decimal and the unit string
matches the rail and the container table, and rename `DASHBOARD_MEMORY_PINNED_MB` or restore its MB formatting.

### 1,351 characters of instrumentation prose in a KPI tile set the height of the whole first band

`medium` · layout · `packages/frontend/src/modules/system/panels/workload-coverage.tsx:117`

The tile renders two `CoverageBlock`s of three paragraphs each at `text-[11px] leading-snug` — measured 1,351
characters across the eleven `DASHBOARD_COVERAGE_*` strings, 398 and 349 of them in the two `_WHY` paragraphs alone —
inside an `xl:col-span-3` track (~300px at 1440px). That is ~30 wrapped lines, roughly 450px, against ~290px for each
of the three sibling `WorkloadTrend` tiles. The board grid (resource-monitor-page.tsx:120) sets no `items-start`, so
CSS `align-items: stretch` grows all four cards to the tallest. The copy is also off-house-style for a UI surface:
SHOUTING CAPS mid-sentence ("is NOT measured", "UTILIZATION", "per MODEL"), and raw CLI/kernel jargon with no gloss
("rocm-smi's CU occupancy", "nvidia-smi", "DRM fdinfo accounting or a newer profiling API") against
docs/writing-style.md's "buzzwords and unexplained jargon" rule.

**What the user sees.** At 1440x900 the "Workloads on this machine" band is ~450px tall; each of the CPU, memory, and
GPU cards carries ~150px of empty card below its last trace, and band B ("This machine") starts below the fold — so
the first screen of a monitoring dashboard is dominated by an essay about measurements that do not exist. On a 375px
phone the tile is a full-width wall of ~35 lines of grey 11px text sitting between the charts and the host capacity
panel.

**Fix.** Keep the two labels, their tags, and the live host-GPU line in the tile; move the four `_WHY` / `_ENABLE`
paragraphs behind the `HintText` affordance this board already uses for hints (dense.tsx:78, StatChip `hint`/`hintId`)
or into docs/inference-supervision.md with one sentence and a link. Add `items-start` to the board grid so no tile
ever stretches to a neighbour's height. Note workload-coverage.test.tsx:54-64 pins the caps strings, so it has to move
with the copy.

### Trend tiles silently drop every workload past the fifth, with no count and no "more" affordance

`medium` · functionality · `packages/frontend/src/modules/system/panels/workload-trends.tsx:141`

`.slice(0, CHART_SLOTS.length)` caps each tile at five rows because the colour ramp has five slots (line 56), and
nothing on the tile says a cap was applied. These three panels are the only ones on the board whose `Panel` carries no
`actions` count — local-resources.tsx:218, local-resources.tsx:315, network-resources.tsx:83, pool-activity.tsx:131
and pool-nodes.tsx:259 all print their row count. The ranking is by SUM over the window (lines 124-137), so a workload
that spiked once ranks below four steadily-busy ones.

**What the user sees.** A Hub running nine installed apps shows exactly five rows in each of the CPU, memory, and GPU
tiles, looking identical to a Hub running five. An operator chasing a memory spike in the sixth-ranked app sees
neither its row nor any hint that four workloads were omitted — and the container table two bands down lists all nine,
so the two panels appear to disagree about how many workloads exist.

**Fix.** Put `{rows.length} of {apps.length}` in the panel's `actions` slot as the sibling panels do, and render the
remainder as a collapsed "+N more" line (or let the ramp repeat past slot 5 — the trace colour is not read anyway, see
the ramp finding).

### The chart colour ramp is applied only to a legend dot that keys nothing, and slot 1 is this page's failure red

`medium` · design-system · `packages/frontend/src/modules/system/panels/workload-trends.tsx:196`

`row.color` (`var(--chart-N)`) is used in exactly one place: the `size-2 rounded-full` dot beside the workload name.
`StepAreaChart` accepts no colour prop, and with `tone="plain"` (line 211) its runs render `TONE_TEXT['plain'] ||
'text-foreground/70'` — `TONE_TEXT.plain` is `''` (dense.tsx:27), so all five traces draw in the same
`text-foreground/70`. The file's own header (lines 49-55) claims the ramp colours the series and that the point is to
avoid "a healthy container ended up drawn in this app's failure red" — but `--chart-1` is `var(--heat)` = `#ff3f00` in
light mode against `--destructive: #ee3533`, and the dot is visually the same primitive as `StatusDot` (dense.tsx:41),
which means status in every table on this same page.

**What the user sees.** In light mode the busiest workload in each tile — always ranked first, so always slot 1 — gets
an orange-red dot beside its name, 8px and round, the same shape and near the same hue as the `bad` status dot used in
the workload table below. A healthy top-CPU app reads as flagged. Meanwhile the operator looks for the mint/amber
traces the dots promise and finds five identical grey ones, so the colour key encodes nothing at all.

**Fix.** Either pass the row colour through to `StepAreaChart` (add a `color` prop that overrides the tone class at
dense.tsx:440) so the dot keys a real trace, or drop the dot entirely — in a small-multiples layout each row already
owns its plot, so a categorical ramp buys nothing and collides with the page's status vocabulary. If the dot stays,
skip `--chart-1` while it resolves to `--heat`.

---

## App shell and shared states

### The phone menu has no max-height or scroll, so Logout is unreachable on short viewports

`high` · layout · `packages/frontend/src/components/header/header.tsx:187`

`MobileAppMenu`'s dropdown is `absolute right-0 top-full z-50 mt-2 w-56 … p-1` with no `max-height` and no
`overflow-y-auto`. When logged in it stacks 8 rows of `min-h-[44px]` (Home, App Store, Resources, Settings, Light,
Dark, System, Logout) plus a "Theme" label and two dividers — roughly 400px of content — starting at about y=52 in a
browser, or y=111 on iOS where `--safe-area-top` is forced to at least 59px
(packages/frontend/src/styles/globals.css:52). Nothing can scroll to the overflow: `app.css:19` sets `body { overflow:
hidden }`, and the menu lives inside the `fixed` header rather than inside the `<main>` scroller.

**What the user sees.** Rotate an iPhone to landscape (375 CSS px tall) on a Hub, or resize a desktop browser window
to 800×420, then tap the hamburger. The menu renders from ~y=111 down past y=513: "System" and "Logout" are drawn
below the bottom of the viewport with no scrollbar and no way to reach them. On a phone in landscape the user cannot
sign out at all without rotating the device.

**Fix.** Give the dropdown `max-h-[calc(100dvh-var(--header-offset)-1rem)] overflow-y-auto overscroll-contain`, and
add a regression test that renders the menu at a 420px viewport height and asserts the Logout item's bottom is inside
the viewport.

### Every Intel Mac is told it is Apple silicon, so the Docker guide offers the arm64 DMG

`high` · functionality · `packages/frontend/src/components/hub-status/hub-status.tsx:96`

`isAppleSilicon()` tries `navigator.userAgentData.architecture` first, but that field only exists in the high-entropy
values returned by `getHighEntropyValues()` — the plain `navigator.userAgentData` object carries only `brands`,
`mobile`, and `platform`, and WKWebView (the macOS Tauri shell) has no `userAgentData` at all. So it always falls
through to line 96, where `/Mac/.test(navigator.platform)` matches `"MacIntel"` — the value Safari reports on *both*
Intel and Apple silicon Macs. The function therefore returns `true` on every Mac. That value is passed straight into
`getDockerDesktopGuideContent('macos', isAppleSilicon())` (line 471), which picks
`https://desktop.docker.com/mac/main/arm64/Docker.dmg` (line 139), and it also seeds the arch toggle's initial state
(line 190).

**What the user sees.** An operator opens Companion Hub on an Intel MacBook Pro with no Docker installed. The
Docker-required screen appears with the pill selector already on "Apple silicon" and the primary call to action
reading "Download Docker Desktop for Mac". Clicking it downloads the arm64 DMG; macOS refuses to install it. The only
recovery is to notice the small "Intel chip" pill under the button and click it — nothing on screen says the default
was a guess.

**Fix.** Stop guessing from the UA. Add a Tauri command that returns `std::env::consts::ARCH` (or read it from
`tauri_plugin_os::arch()`) and resolve the arch asynchronously, defaulting the download button to a disabled/neutral
state until it answers. Where no Tauri invoke is available (browser), render both download links side by side instead
of picking one.

### The error screen's header says "Login" to an already-signed-in operator and hides every nav link

`high` · functionality · `packages/frontend/src/components/layouts/dashboard/layout.tsx:28`

`DashboardLayoutSuspense` hard-codes `<Header isLoggedIn={false} allowAutoThemes={false} />`. `Header` resolves auth
as `props.isLoggedIn ?? userContext.isLoggedIn` (header.tsx:27), and `false` is not `undefined`, so the prop wins over
the real session. `DashboardLayoutSuspense` is the wrapper for the authenticated ErrorBoundary fallback
(authenticated-route.tsx:170-172) and for the restore-drift gate (authenticated-route.tsx:81-85), both of which only
ever run for a signed-in user.

**What the user sees.** A signed-in operator opens Settings and a child component throws (or a TanStack query rejects
under the QueryErrorResetBoundary). The error page renders inside `DashboardLayoutSuspense`, so the top bar loses Home
/ App Store / Resources / Settings / Logout and instead shows a "Login" button. The operator's only in-app action is
Retry; clicking "Login" sends them to `/login`, whose loader bounces them back to `/home`, silently discarding the
page they were on.

**Fix.** Drop the hard-coded props and let `DashboardLayoutSuspense` render `<Header />` so it reads
`useUserContext()`, or thread the real `isLoggedIn` through. Assert in a test that the ErrorBoundary fallback still
renders the Home and Settings links for a logged-in user.

### The phone menu claims the ARIA menu pattern but has no keyboard behaviour and an invisible full-screen Close button

`medium` · accessibility · `packages/frontend/src/components/header/header.tsx:183`

The dropdown declares `role="menu"` with `role="menuitem"` children (lines 186-246) and the trigger declares
`aria-haspopup="menu"` and `aria-expanded` (lines 172-173), but none of the pattern's behaviour is implemented: no
arrow-key navigation, no Escape-to-close, no focus moved into the menu on open, no focus returned to the trigger on
close, no `aria-controls` linking trigger to menu, and no focus containment. Worse, the scrim at line 183 is a real
`<button aria-label="Close" className="fixed inset-0 z-40 bg-black/25">` rendered *before* the menu in DOM order, so
it is the first tab stop after the trigger.

**What the user sees.** On a tablet or a sub-1024px window, a keyboard user tabs to the hamburger and presses Enter.
Focus stays on the trigger. Pressing Tab moves focus to an invisible button that covers the entire viewport — no
visible focus ring anywhere on screen — and only the Tab after that reaches "Home". Pressing Escape does nothing. A
screen-reader user who enters the menu and presses Down Arrow (the interaction `role="menu"` promises) gets no
movement.

**Fix.** Either use the repo's existing Radix `DropdownMenu` primitive with `modal={false}` (already required for
phones per docs/system/frontend.md:85), or keep the hand-rolled version but make the scrim a non-focusable `<div>`,
add `onKeyDown` Escape handling, focus the first item on open, restore focus to the trigger on close, and add
`aria-controls`.

### Logout has no pending or error state and leaves the phone menu open

`medium` · functionality · `packages/frontend/src/components/header/header.tsx:32`

`logoutMutation` is wired with `onSuccess` only — no `onError`, and the QueryClient in providers.tsx:16-20 configures
no `MutationCache` error handler, so a rejected logout is swallowed entirely. Neither trigger is guarded: the desktop
icon button (line 123) and the menu item (line 229) have no `disabled={logout.isPending}` and render no spinner. The
menu item is also the only item in `MobileAppMenu` that does not call `setOpen(false)` — every sibling does (lines
191, 199, 207, 211).

**What the user sees.** An operator on a phone whose Hub has just gone unreachable taps Logout. The POST to
/api/auth/logout rejects; the response interceptor throws a TranslatableError that React Query catches and no one
renders. No toast, no spinner, no error — and the menu stays open with the dark scrim over the app. The operator taps
Logout again (and again), each tap firing another request, and walks away believing they are signed out while the
session cookie is still valid.

**Fix.** Add `onError: () => toast.error(t('COMMON_AN_ERROR_OCCURRED'))` to the mutation, pass
`loading={logout.isPending}` / `disabled={logout.isPending}` to both triggers, and call `setOpen(false)` in the menu
item's handler like its siblings do.

### The header's Login button uses a nonexistent key with an English default, so it never translates

`medium` · copy · `packages/frontend/src/components/header/header.tsx:104`

Both the desktop button (line 104) and the phone menu item (line 245) call `t('login', 'Login')`. There is no `login`
key in any of the 32 files under `packages/common/i18n/translations/` (checked all of them), so i18next always returns
the hard-coded `'Login'` default. The correctly-cased key exists and is translated: `COMMON_LOGIN` is `"Login"` in
en.json and `"Iniciar sesión"` in es-ES.json. Every neighbouring label in the same component does resolve
(`COMMON_HOME`, `COMMON_APP_STORE`, `HEADER_LOGOUT`, `COMMON_SETTINGS`).

**What the user sees.** An operator running the Hub in Spanish reaches the logged-out header (guest dashboard, or the
error/restore gates described in finding 3). The top bar reads "Inicio", "App Store", "Recursos" — and then an
untranslated "Login" button. Adding a Spanish translation is impossible without a code change, because no
translator-visible key exists.

**Fix.** Change both call sites to `t('COMMON_LOGIN')`. While there, drop the `'Settings'` / `'Logout'` string
defaults on lines 114/120/126/131/213/231 — those keys exist, and the defaults mask a missing translation as English
instead of surfacing it.

### The onboarding redirect is duplicated, the live copy is untested, and the tested copy is dead code

`medium` · docs-tests · `packages/frontend/src/components/layouts/dashboard/layout.tsx:73`

Verified: the same `!hasCompletedOnboarding → <Navigate to="/onboarding">` guard exists at authenticated-route.tsx:110
and layout.tsx:73. `DashboardLayout` is rendered only from authenticated-route.tsx (lines 98 and 116 — grep finds no
other production caller). Line 98 runs while `isAppLoading`, which layout.tsx:73 explicitly excludes; line 116 runs
only after the guard at line 110 has already passed. So layout.tsx:73 can never fire in production. It also carries a
condition the live copy lacks (`!location.pathname.startsWith('/onboarding')`), which is itself unnecessary because
`/onboarding` is a top-level route outside this layout (routes.ts:16). The consequence is a test-coverage inversion:
`layout.onboarding-gate.test.tsx` has four cases covering the dead copy, while `authenticated-route.tsx` — the file
that actually decides whether an operator sees the wizard, the restore-apps redirect, or the requested page — has zero
tests (no file in the repo imports it).

**What the user sees.** An agent changes the gate order in authenticated-route.tsx (for example moving the
`isAppLoading` early return below the onboarding check, reintroducing the bug its own comment warns about) and every
existing test still passes, because the onboarding-gate suite exercises the unreachable copy in layout.tsx.
Cold-loading a deep link then bounces the operator through /onboarding out to /home and their deep link is lost.

**Fix.** Delete the guard at layout.tsx:73 and move the four cases in `layout.onboarding-gate.test.tsx` onto
`authenticated-route.tsx`'s default export, adding cases for the session-loading gate, the restore-drift redirect, and
`loadFailed` keeping the requested page.

---

## Mobile surfaces

### Nothing reserves the iOS home-indicator inset; --safe-area-bottom is defined and consumed by nothing

`high` · layout · `packages/frontend/src/components/layouts/dashboard/layout.tsx:118`

`--safe-area-bottom` is declared twice (globals.css:39 and globals.css:53, the latter flooring it at 34px under
`html.ci-mobile`) and a repo-wide grep finds zero consumers. The dashboard shell is `height: calc(100vh -
var(--titlebar-height))` with `overflow-hidden` (line 113) and the scrolling `<main>` gets `marginTop:
var(--header-offset); paddingTop: 0.5rem` and no bottom padding at all. So the top inset is honoured via
`--header-offset` while the bottom inset is silently dropped, and because the outer shell is `overflow-hidden` at
`100vh` there is no slack to scroll the last content clear.

**What the user sees.** iPhone 15 running the Tauri shell, /settings?tab=security scrolled to the end: the last
control in the tab (e.g. the Factory reset button in general-actions.tsx) renders inside the bottom 34px
home-indicator band. It cannot be scrolled clear because the scroll container's own bottom edge is the screen's bottom
edge, and taps in that band are consumed by the iOS home gesture, so the button is visible but effectively untappable.
Same for the last app tile on /home, whose section only adds pb-4 (16px).

**Fix.** Add `paddingBottom: var(--safe-area-bottom, 0px)` to the scrolling `<main>` in both `DashboardLayout` and
`DashboardLayoutSuspense`, and switch the shell height to `calc(100dvh - var(--titlebar-height, 0px))` so the Android
soft-nav case works too. Then assert in a test that `--safe-area-bottom` has at least one consumer.

### Load watchdog takes over a working dashboard whenever any spinner is animating

`high` · functionality · `packages/frontend/src/lib/mobile-load-watchdog.ts:24`

`looksStuck()` bails out only if the page contains a `form`, an `input`, or one of four named test IDs (lines 6-14).
None of those exist on `/home`. It then falls through to line 24, which returns true for ANY `.animate-spin` element
anywhere in the document — not just a full-page loader. The two ticks fire at 6s and 12s after root mount (lines
104-105), long after a warm-session phone has already landed on the dashboard, and `showOverlay()` appends a `zIndex:
2147483646` fixed panel to `document.body` with no dismiss affordance and no removal when the app recovers.

**What the user sees.** Phone with a valid session opens the app and reaches /home in ~2s with one app still
installing, so `simple-app-tile.tsx:29` renders `<Loader2 className="... animate-spin" />`. At t=6s the watchdog
matches that tile spinner, finds no form/input on /home, and covers the fully working dashboard with a full-screen
"This Hub isn't responding." panel. The user's only choices are Retry (full reload) or Switch Hub, which deletes the
stored Hub URL and forces the entire Safari PKCE sign-in again. The same fires for `queued-installs-indicator.tsx:33`
while installs are queued.

**Fix.** Scope the stuck check to the startup gate rather than any spinner: match only
`[data-testid="connecting-to-local-api"]`, `[aria-busy="true"] .animate-spin` where the busy node is `#root` itself,
or an empty `#root`. Drop the bare `.animate-spin` branch. Also cancel the second tick once `#root` has rendered real
content, and remove the overlay if the app later paints.

### MobileAppMenu is a hand-rolled menu with no focus management, no Escape, and a full-screen button in the tab order

`medium` · accessibility · `packages/frontend/src/components/header/header.tsx:183`

The phone menu declares `role="menu"` / `role="menuitem"` (lines 184-247) but implements none of the menu pattern:
opening it does not move focus into the menu, there is no `keydown` handler so Escape does not close it, and there is
no arrow-key navigation or roving tabindex. The scrim at line 183 is a real `<button aria-label="Close">` covering
`fixed inset-0`, rendered before the menu in DOM order, so it is focusable and announced. The three theme rows (lines
217-227) are plain `role="menuitem"` buttons with no `menuitemradio`/`aria-checked`, so nothing conveys which theme is
active. Line 229 also uses raw `text-red-600` for Logout instead of the `text-destructive` token. Radix `DropdownMenu`
already exists in the repo (components/ui/DropdownMenu) and solves all of this; docs/system/frontend.md:85 requires
only `modal={false}` on a phone, not hand-rolling.

**What the user sees.** A phone user with VoiceOver, or anyone on an iPad with a keyboard, taps the hamburger. Focus
stays on the trigger, so a screen reader is still on "Open menu" with no announcement that a menu opened; Escape does
nothing; and the first Tab lands on an invisible full-viewport "Close" button instead of "Home", which on activation
closes the menu they just opened. A user who wants to check which theme is selected sees Light / Dark / System with no
marked state.

**Fix.** Rebuild MobileAppMenu on `components/ui/DropdownMenu` with `modal={false}` (per the frontend.md invariant),
which brings focus trapping, Escape, arrow keys and `aria-*` for free. Use `DropdownMenuRadioGroup`/`RadioItem` bound
to the current `theme` value for the three theme rows, replace the scrim button with Radix's own overlay, and swap
`text-red-600` for `text-destructive`.

### Stacked dialog footers have zero gap below 640px, so a destructive button sits flush against Cancel

`medium` · layout · `packages/frontend/src/components/ui/Dialog/Dialog.tsx:90`

`DialogFooter` is `flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2` — the spacing is declared only for
the `sm:` row direction. Below 640px the buttons stack with `items: stretch` and no `gap`, so two full-width buttons
share a single border with no separation. Of the 30 `<DialogContent>` call sites only `install-dialog.tsx:115` adds
`gap-2` to its footer; every other two-button dialog, including all the `type="danger"` ones, inherits the gapless
version.

**What the user sees.** Phone at 375px, Settings → Factory reset (general-actions.tsx:542-549): the red "Factory
reset" button and "Cancel" render as two full-width buttons touching with 0px between them. A thumb aimed at the top
edge of Cancel lands on the destructive confirm. Same shape in delete-app-store-dialog.tsx:46,
hub-account-settings.tsx:200, hub-pool-settings.tsx:1400 and api-keys.tsx:416.

**Fix.** Add `gap-2` to the DialogFooter base class (`flex flex-col-reverse gap-2 sm:flex-row sm:justify-end
sm:gap-2`) and drop the now-redundant `sm:space-x-2`. Remove the local override in install-dialog.tsx once the base is
fixed.

### Watchdog overlay is hardcoded hex; its hint and its only escape link fail contrast in dark mode

`medium` · design-system · `packages/frontend/src/lib/mobile-load-watchdog.ts:55`

Because it renders outside React the overlay hardcodes every colour instead of using tokens: background
`#18181b`/`#f4f4f5` (line 43), text `#fafafa`/`#18181b` (line 44), hint `#52525b` (line 55), Retry `#2563eb` on `#fff`
(lines 65-68), and Switch Hub `#52525b` (line 82). `#52525b` on the dark `#18181b` background is 2.3:1, below the 3:1
non-text floor and far below the 4.5:1 AA body-text requirement. `#2563eb` is Tailwind blue-600, not the CI canon
`--primary` phthalo teal (docs/UI-STYLE-GUIDE.md:50). The equivalent React screen, mobile-load-error.tsx, uses
`bg-primary`/`text-muted-foreground` correctly, so the two paths look like different products.

**What the user sees.** A phone user who has set the theme to Dark loses their Hub. The overlay appears on `#18181b`;
the explanatory line "Check that the Hub is online, or switch to a different Hub." and the underlined "Switch Hub"
link both render in `#52525b` at 2.3:1 and are essentially unreadable — so the one control that gets a stranded user
to a different Hub is the hardest thing on the screen to see, while the Retry button is a bright generic blue that
does not match any other button in the app.

**Fix.** Read the token values off the computed style of `document.documentElement`
(`getComputedStyle(root).getPropertyValue('--background')`, `--foreground`, `--muted-foreground`, `--primary`,
`--primary-foreground`) and assign those, falling back to hardcoded values only if the lookup is empty. At minimum
raise the hint/Switch-Hub colour to something that clears 4.5:1 against both backgrounds and use the CI primary for
Retry.

### Settings tab strip scrolls horizontally at phone width but never scrolls the active tab into view

`medium` · layout · `packages/frontend/src/modules/settings/pages/settings-page.tsx:55`

The `TabsList` carries `overflow-x-auto` for narrow viewports, and the eight triggers measure roughly 570px total
(each is `whitespace-nowrap px-3 text-sm`, tabs.tsx:26), so the strip overflows below about 570px. Nothing scrolls the
selected trigger into view: Radix Tabs does not do it, there is no `scrollIntoView` anywhere in the settings module
(the only one in the codebase is ai-settings.tsx:420 for an unrelated section), and there is no edge fade or chevron
to hint that more tabs exist to the right. The strip also has no bottom padding to absorb a scrollbar inside its fixed
`h-10`.

**What the user sees.** On a 375px phone, opening /settings?tab=logs — or tapping a deep link such as the
`/settings?tab=network` link in install-form.tsx:733 — lands on the right content while the tab strip stays scrolled
to offset 0, showing "Settings | Security | App stores" with none of them highlighted. The user sees content that does
not match any visible tab, has no visual cue that the strip scrolls, and cannot tell where they are or how to get back
to General.

**Fix.** On mount and on `currentTab` change, call `scrollIntoView({ inline: 'center', block: 'nearest' })` on the
trigger whose `data-state` is `active` (query it by `value`). Add a scroll-edge mask or a subtle `after:` gradient on
the list so the overflow is discoverable on touch.

---

## Desktop bootstrap and tray

### Primary buttons have an invisible keyboard focus indicator

`high` · accessibility · `packages/desktop/bootstrap/bootstrap.css:662`

`.btn:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--primary); }` (lines 662-665) removes the UA focus
ring and replaces it with a 1px, zero-offset ring in `var(--primary)`. Every action button on these screens is
`.btn-primary`, whose background *is* `var(--primary)` (lines 672-677) — `#c5e8dc` dark / `#0a6358` light. A
same-colour 1px ring drawn flush against the button edge is not visible. The `.link` buttons are fine (`outline: 2px
solid var(--primary); outline-offset: 2px`, lines 714-719), and the React twin uses a visible ring with a
card-coloured gap (`focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-card`,
hub-status.tsx:721). The titlebar controls have no `:focus-visible` rule at all (bootstrap.css:204-230).

**What the user sees.** On the "CI Hub is stopped" screen a keyboard-only user presses Tab. Focus lands on the only
control, Start Hub, and nothing on screen changes — they cannot tell whether Enter will do anything. On the
couldn't-start screen, tabbing through Try again → Copy error → View logs makes the indicator appear to vanish on the
first control and reappear on the other two.

**Fix.** Match the React contract: `.btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }`
(or a `box-shadow: 0 0 0 2px var(--card), 0 0 0 4px var(--primary)` double ring) and add the same rule to
`.titlebar-controls button:focus-visible`.

### Status panel is rebuilt from scratch every second, so the Docker error cannot be selected or scrolled

`high` · functionality · `packages/desktop/bootstrap/bootstrap.js:747`

`setInterval(render, 1000)` (line 747) calls `render()`, which unconditionally calls `renderFacts`
(`el.facts.replaceChildren(...)`, line 497), `renderRows` (`el.rows.replaceChildren(...)`, line 527) and
`renderCounts` (`el.counts.replaceChildren(...)`, line 546) in every non-checking view. Every service row — including
the `.row-detail` element that carries Docker's verbatim error and is a `max-height: 6.4em; overflow-y: auto` scroll
box (bootstrap.css:458-462) — is destroyed and recreated once per second. The React half does not do this: it renders
a keyed `<ServiceRow>` list (hub-status.tsx:1049-1059) so the DOM nodes and their scroll/selection state persist
across polls.

**What the user sees.** A container fails and the couldn't-start screen shows a 30-line compose error clipped to 4
lines. The user drags to select part of the message, or wheel-scrolls down inside the box to read the rest. Within at
most one second the selection is silently dropped and the box snaps back to line 1, every time. Copy error is the only
way to get the text out, and reading past line 4 is impossible in practice.

**Fix.** Diff instead of replace: key rows by `service.container`, create each row once, and on each tick only update
the state label, the tone class and the mark. Failing that, skip `renderRows`/`renderFacts`/`renderCounts` unless the
progress payload actually changed (`page.progressAt`), and drive only the per-second clocks (`#progress-time`, the
stuck row's `Starting for m:ss`) from the 1 s interval.

### pollProgress has no in-flight guard and the checking view has no timeout, so a hung Docker leaves a permanent spinner

`high` · functionality · `packages/desktop/bootstrap/bootstrap.js:749`

`setInterval(() => void pollProgress(), PROGRESS_POLL_MS)` (line 749) fires every 2 s with no re-entrancy guard,
unlike the React twin which keeps `let inFlight = false; if (inFlight) return;` (hub-status.tsx:601-614).
`get_startup_progress_command` runs `get_startup_progress` on `spawn_blocking` (main.rs:275-279), which shells out to
the Docker CLI, so a wedged docker socket never resolves the promise. Separately, `pickView` returns `'checking'` for
as long as `page.progress` is null (lines 258-260) with no deadline, and `renderActions` offers nothing at all in that
view — `startHub`/`restartHub`/`keepWaiting`/`tryAgain`/`installDocker`/`copyError`/`openLogs` are all gated on other
views (lines 569-577), so `el.actions.hidden` is true.

**What the user sees.** Docker Desktop is mid-start (or the socket is wedged) when the app launches. `docker` blocks,
so no poll ever resolves. The splash shows "Checking CI Hub / Looking at Docker and the Hub's services… /
Initialising..." with a spinner indefinitely — no error, no Restart Hub, no View logs, no Keep waiting, nothing but
Quit from the tray. Meanwhile a fresh blocking task is spawned every 2 s, and once the Tokio blocking pool fills, the
other IPC commands (`start_hub_command`, `check_hub_status`, `open_logs_dir_command`) stop answering too, so even the
tray's Start Hub goes dead.

**Fix.** Add the same in-flight flag the React hook uses, and give the checking view an escape hatch: after ~15-20 s
with no successful poll, switch the heading to something like "CI Hub can't read Docker" and show View logs plus Try
again (both already wired) rather than holding the spinner forever.

### Install Docker hides its own button mid-install and throws away the needs-restart result

`high` · functionality · `packages/desktop/bootstrap/bootstrap.js:680`

`installDocker()` (lines 680-694) sets the button text to "Installing Docker…", awaits `install_docker_command`, and
discards the resolved value. Two problems. (1) The per-second `renderActions` keeps running and hides the button
whenever `access !== 'not_installed'` (line 574) — and a partway-complete Linux install flips `docker_access` from
`not_installed` to `permission_denied`, so the only in-progress indicator is removed while the installer is still
running. (2) `install_docker_command` returns `DockerInstallResult { state, detail }` and on Linux `state` is always
`NeedsRestart` (installers/docker.rs:9-13), which this code never reads, so nothing ever tells the user to log out and
back in. The React guide does both correctly: a persistent `installState === 'installing'` spinner block
(hub-status.tsx:395-400) and an explicit needs-restart message (hub-status.tsx:402-406).

**What the user sees.** On Linux with no Docker, the user clicks Install Docker, authenticates at the pkexec prompt,
and the apt install starts. About 20 s in, `docker_access` becomes `permission_denied`: the button disappears, the
heading changes to "CI Hub can't use Docker / Your account isn't allowed to use Docker. Add it to the docker group,
then log out and back in." and a `sudo usermod -aG docker $USER` command box appears — while the installer is still
running and already did exactly that. There is no spinner and no sign work is in progress, and when it finishes
nothing distinguishes "installed, just log back in" from "misconfigured".

**Fix.** Track the install in `page` state (e.g. `page.installing`) and have `renderActions` keep the disabled
"Installing Docker…" control visible while it is true, regardless of `docker_access`. Read the resolved `{ state,
detail }` and, on `needs_restart`, render a success line saying Docker is installed and asking the user to log out and
back in — reuse the same wording as `HUB_STATUS_LINUX_INSTALL_NEEDS_RESTART`.

### Tray's Clear Tunnel Token stops the whole stack and every installed app with no confirmation and no feedback

`high` · functionality · `packages/desktop/src-tauri/src/tray.rs:90`

The menu item is labelled "Clear Tunnel Token (not full reset)" (lines 90-96). Its handler (lines 275-342) runs three
destructive steps in order: `stop_hub` on the Hub compose project, `stop_managed_app_containers()` for every
marketplace app container, then `clear_tunnel_token(&data)`. There is no confirmation dialog, no `MenuItem`
accelerator guard, and no success/failure surface anywhere in the UI — every outcome goes only to
`append_desktop_log_for(&data, "tray.reset", …)`. It sits one row below "View Logs" in the same flat menu, with only a
separator between them.

**What the user sees.** The user opens the tray to check the Status line and clicks one row low. Instantly the Hub
stack and every running app container are brought down and the Cloudflare tunnel token is deleted, so the public
hostname stops serving. Nothing on screen says it happened: the tray Status line just turns to "Status: Disconnected
✗" 10 s later, and the only record is a line in `logs/desktop.log`. The label gave no warning that the Hub and all
installed apps would be stopped.

**Fix.** Gate it behind a confirmation — a Tauri dialog listing what will stop — and rename it to describe the real
blast radius (for example "Stop Hub and clear tunnel token…", with the trailing ellipsis signalling a prompt). Report
the outcome by focusing the main window on a result screen or a toast, not only to the log file.

### View logs does two different things either side of the handover, and its failure is silent on the splash

`medium` · functionality · `packages/desktop/bootstrap/bootstrap.js:741`

The splash's View logs invokes `open_logs_dir_command` and swallows every error (`.catch(() => undefined)`, lines
741-743): it opens an OS file-manager window on the log directory. The React screen's identically-labelled control
invokes `read_desktop_logs_command` and renders the last 200 lines inline as a colourised "Recent logs" panel with a
Hide button (hub-status.tsx:1443-1454 and 1537-1551), only falling back to opening the folder if that invoke throws.
Both halves are documented as "deliberately the same screens — same headings, progress bar, status panel, copy and
actions" (bootstrap.js:5-10), so the same label in the same position on the same screen does two unrelated things.

**What the user sees.** The Hub has been starting for 91 s and the View logs link appears. The user clicks it and a
file-manager window covers the app with a folder of `.log` files; on a host with no working `xdg-open` (a headless or
minimal desktop session) absolutely nothing happens and the link looks broken, because the rejection is swallowed.
Seconds later the Hub API answers, React takes over the same screen, and clicking the same link now renders the log
text inside the window.

**Fix.** Call `read_desktop_logs_command` from the splash too and render the lines in a collapsible panel in the card,
keeping `open_logs_dir_command` as the fallback — the mirror image of the React path. At minimum, surface the
rejection instead of swallowing it so the button is never silently inert.

### Splash and tray are hardcoded English while the app ships 19 locales, so the handover is a visible language switch

`medium` · copy · `packages/desktop/bootstrap/bootstrap.js:426`

Every user-facing string in the splash is an inline English literal — `headFor` (lines 426-460), `dockerHead`
(408-424), `SERVICE_PHRASE`/`STATE_LABEL`/`DOCKER_FACT`/`COUNTS` (296-348), `timeFor` (462-472), `renderRows`' note
(523), plus index.html:22-68 — with no `t()` and no way to reach i18next from `tauri://`. The tray is the same in Rust
(tray.rs:81-99, 437, 546). The React half translates all of it (`HUB_STATUS_*` keys, en.json:2127-2130 et al.) and the
app offers 19 languages (`lib/i18n/locales.ts:1-21`). The tray strings are also Title Case ("View Logs", "Account
Management", "Clear Tunnel Token") against the sentence-case rule in docs/writing-style.md:9, and against the app's
own "View logs" (en.json `HUB_STATUS_VIEW_LOGS`).

**What the user sees.** A user sets the Hub's language to 日本語 (or Español, or any of the other 17). Every desktop cold
start now shows "Checking CI Hub / Looking at Docker and the Hub's services… / Initialising..." and, on a Docker
failure, the entire Docker screen in English; the moment the Hub API answers the same card silently switches to their
language mid-sentence. The tray menu stays English forever. On a Docker-not-installed machine the user never gets past
the English screen at all.

**Fix.** Ship a small string table in the bootstrap keyed by the same `HUB_STATUS_*` ids, generated at build time from
`packages/common/i18n/translations/*.json`, and pick the locale from `navigator.language` (or expose the stored
theme/locale through a Tauri command so the splash can read the user's actual choice). For the tray, resolve labels
through the same generated table in Rust and switch them to sentence case.

### Splash is pinned to the dark palette at the window level and cannot see the user's chosen theme

`medium` · design-system · `packages/desktop/src-tauri/tauri.conf.json:80`

`"backgroundColor": "#041620"` is the *dark* `--background` value unconditionally (matches tokens.css dark `:root`
`--background: #041620`), so the window paints near-black before the WebView renders, whatever the OS or user theme.
The splash CSS then follows `prefers-color-scheme` only (bootstrap.css:87-117) and its own comment (81-86) admits it
cannot read the stored theme because that lives in the Hub origin's `localStorage` (theme-provider.tsx:28, 60) which
`tauri://` cannot reach — so it resolves the `system` default but not an explicit override. Separately, ~30 token hex
values are hand-transcribed into bootstrap.css:40-54 and 91-105 with a provenance comment claiming
`@companionintelligence/tokens v0.3`, while packages/frontend/package.json:22 pins `^1.1.0`; the values happen to
match v1.1.0 today, but nothing asserts that — and UI-STYLE-GUIDE.md:24-26 records that a hand-kept copy is exactly
what drifted last time (`--primary: #0f717a` for a month after canon moved to `#0a6358`).

**What the user sees.** A user on a light-mode Mac launches Companion Hub: the window paints a near-black rectangle
for the frames before the WebView paints, then flips to the light splash. A user who explicitly chose Dark in Hub
settings on a light-mode OS gets the reverse — a light splash for the whole cold start that flips to a dark app at the
handover the file claims should "look like nothing happened". And the next `@companionintelligence/tokens` bump
changes the app's primary/card colours while the splash keeps the old ones, with no test or lint to catch it.

**Fix.** Persist the resolved theme where the shell can read it (the Tauri `settings.json` store already used for
window geometry in tray.rs:20-30), have the splash apply it via `data-theme` on `<html>` and have Rust set the window
background to the matching token before the first paint. Generate the bootstrap token block from
`@companionintelligence/tokens/dist/tokens.css` at build time, or add a unit test that parses both files and asserts
the copied values are identical.

---

## Refuted and dropped

Raised by a reviewer and rejected by its verifier. Recorded so they are not re-raised.

- auth: The six OTP boxes overflow the card on a 360px phone (The finding's *mechanism* checks out, but its
*arithmetic* omits the card's right padding, and the stated failure does not occur on the device it names. Verifi)
- device-reg: Step 2 renders no instructions at all — the string that tells you to click Add Device exists in en.json
and is referenced nowhere (The mechanical half of the finding checks out, but the user-visible failure does not.
VERIFIED TRUE: - `packages/frontend/src/modules/auth/pages/device-registr)
- device-reg: The Restore choice has no in-flight guard, and Start fresh stays clickable while it runs — a destructive
race in a forced-choice modal (The code description is accurate but the failure scenario is not reachable and its
claimed end state is explicitly prevented. (a) No Portal round trip exists on)
- device-reg: The only on-screen explanations are hover-only tooltips, on elements given tabIndex=0 with no aria (The
finding's load-bearing mechanical claims are false, so the described failure does not occur. 1. "hover events only ...
no focus trigger" — WRONG. `HintText)
- device-reg: The first setup screen bypasses the setup shell, so it has no h1, no step indicator, and visibly jumps
size against the next setup screens (Most of the finding's supporting detail is factually wrong, and the concrete
user-visible failure it describes does not occur. (1) SetupPageShell consumers: gr)
- onboarding-wizard: External remediation links are dead in the Tauri desktop app (The finding's premise — that a
`target="_blank"` anchor is inert in the Tauri desktop app because nothing routes it away from the wry webview — is
false in this)
- onboarding-install: The common restore path shows no progress indicator at all (The code observation is literally
true — `setIsExecuting(true)` appears only at restore-apps-page.tsx:121, so the `status.completed` branch (108-119)
awaits `ru)
- onboarding-install: The install list's fixed-height inner scroller traps the scroll gesture and hides Continue on a
phone (The stated mechanism does not exist in the code. (1) No scroll trap: install-step.tsx:604 is a plain
`overflow-y-auto` with no overscroll-behavior override (the)
- dashboard: Installed-app grid overflows sideways on 360 px phones, and its scrollbar is explicitly hidden (The code
facts check out, but the stated user-visible failure does not. Verified in source: -
packages/frontend/src/modules/dashboard/components/horizontal-app)
- app-details: Access points claim "Enabled" with a live URL for a stopped app, and the Link field echoes the badge
when a route is off (See above.)
- app-details: Hero shows a hardcoded "0.0" star rating and uses raw emerald/yellow palette instead of tokens (Code
facts check out but the finding's central argument and its stated failure scenario are both wrong. (1) The yellow star
is EXPLICITLY SANCTIONED. docs/syst)
- custom-apps: Emptying the JSON editor enables "Save JSON", which crashes the page and discards the whole config (The
code mechanism is accurately described, but the claimed user-visible failure is not what happens. Verified code facts
(all true): - packages/frontend/src/c)
- custom-apps: Port-expose details page shows no status at all — the Open button is silently disabled when the
exposure is broken (The finding's central user-visible failure — a greyed-out "Open" button on a Cloudflare port
expose whose route has not propagated — is not reachable. For expos)
- settings-core: In the "Enable advanced settings?" warning dialog, Cancel is the filled primary button and the risky
Enable is the secondary-looking one (The finding's supporting citations are all accurate, but the mechanism that
produces the claimed user-visible failure is factually wrong, and the failure scenar)
- settings-network: `intent="danger"` is silently dropped on Unpair and Remove-from-account, so both render as neutral
outline buttons (The mechanical half is true — Button.tsx:48-63 prioritises `variant` and drops `intent` (destructured
at line 43, never forwarded), so `variant="outline" intent)
- settings-system: The Factory reset Hub button renders as a neutral outline button because `variant` silently
overrides `intent="danger"` (The mechanical half of the claim checks out: Button.tsx:48-50 sets `let finalVariant =
variant` and only maps `intent` when no variant is passed, so `variant="o)
- settings-system: System inspector presents the backend's all-zero error fallback as real telemetry (The all-zero
fallback exists exactly as quoted (system-inspector.service.ts:212-224), and the frontend does only guard
`isLoading`/`!data` (system-inspector.tsx)
- shell: The app's only route ErrorBoundary offers no way out — fatal in the desktop window (The static code claims
check out, but the "concrete user-visible failure" does not — the named scenario is specifically engineered against,
in three independent)
- mobile: .safe-area-inset uses raw env() and so ignores the html.ci-mobile notch floor it exists for (The CSS
observation is accurate (globals.css:145-150 uses raw env() and so misses the 59px/34px floors set for html.ci-mobile
at globals.css:51-54), but the con)
- mobile: /connect shows a green "active" pill for every Hub on the primary sign-in path, including dead ones (The
code facts are accurate but the causal claim and severity are not. Confirmed: portal-client.ts:198 hardcodes `status:
'active'` in `listHubsWithOauthToken`;)

