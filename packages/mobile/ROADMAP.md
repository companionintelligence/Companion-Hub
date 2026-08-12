# Companion Hub mobile — roadmap

Where the app goes after v1, grounded in what actually exists today (verified
against the code, not aspiration). Store-submission gates live in
[`STORE-READINESS.md`](./STORE-READINESS.md); build instructions in
[`README.md`](./README.md).

**What the app is:** a Tauri 2 thin remote client. A phone can't run a Hub (no
Docker), so it embeds the shared React SPA and points it at a remote Hub
appliance chosen from the cloud device picker. Everything mobile is gated by
`isTauriMobileSync()`, so web/desktop are unaffected.

## Where we are

| Capability | State |
|---|---|
| Connect flow (Portal sign-in → pick Hub → Hub login) | ✅ Shipped, 49 tests incl. a routed login-journey suite |
| `cihub://` deep links (SSO callback, pairing, intents) | ✅ Works end-to-end on both platforms (verified on-device) |
| iOS App Intents (Siri/Shortcuts/Spotlight/Action Button) | ✅ 5 intents + AppShortcutsProvider, verified in `Metadata.appintents` |
| CI builds (APK + iOS sim `.app`; secrets-gated AAB) | ✅ `mobile-build.yml` |
| Sentry | 🟡 JS enabled + correctly tagged; **no Rust panic hook, no source maps** |
| Notifications | ❌ Plugin removed (was dead plumbing); **no push anywhere** |
| Universal / App Links | ❌ Custom scheme only — hijackable (see P1) |
| Biometric lock, widgets, tablet layout | ❌ None |

---

## P0 — ship v1 (now)

Close out [`STORE-READINESS.md`](./STORE-READINESS.md). The code is done; the
work is accounts, the App Review demo Hub, account deletion, and **TestFlight
validation on a real device** (nothing has ever run on physical hardware).

---

## P1 — hardening (right after v1)

**1. Universal Links + App Links.** *Also a security fix, not just polish.*
`cihub://` is claimable by any installed app. The OIDC leg is safe (PKCE
verifier never leaves the app), but **`cihub://auth?token=…` carries a bearer
one-time token with no client binding** — a scheme-squatting app that wins the
race gets a full Hub session. Pairing codes are similarly exposed.
- iOS: `com.apple.developer.associated-domains` (`applinks:hub.ci.computer`) + an AASA file on the domain (needs the Team ID → gated on the Apple account).
- Android: `https` intent-filter with `autoVerify` + `assetlinks.json` carrying the **release** cert SHA-256 (→ gated on the upload keystore).
- Hosting: `hub.ci.computer` is the CI-Portal CF worker — two static routes (AASA must be `application/json`, no redirect). **Cross-repo.**
- Keep `cihub://` for the app's own `intent/*` bridge (self-generated, low risk).

**2. Session token → Keychain / Android Keystore.** The Hub session id sits in
plaintext WebView `localStorage` (~7-day validity). `allowBackup=false` stopped
the backup leak, but on-device it's still plaintext. Adoption note:
`getTauriSessionId()` is called *synchronously* in the request interceptor and
Keychain APIs are async → hydrate an in-memory cache during the already-async
`initMobileConnection()`, async write-through, migrate-and-delete the old value.

**3. Complete Sentry.** JS is live and tagged; add: sentry-cli source-map
inject/upload in `mobile-build.yml` (copy `desktop-release.yml`), and port
`packages/desktop/src-tauri/src/error_reporting.rs` for Rust panic capture.
Native crash handlers (iOS Mach / Android NDK) are **not** covered by
sentry-rust — explicitly deferred; JS + Rust-panic first.

**4. Android back button.** The picker's `pick` step is `useState` with no
history entry, so hardware back **exits the app** instead of returning to
sign-in. Drive the step from a search param or push a history entry.

**5. Min-version gate.** No self-updater on mobile by design (stores own
updates). Serve a min-supported-version from the Portal, check on connect, show
an update interstitial — protects the API when the appliance ships breaking
changes faster than store review.

---

## P2 — capabilities

**6. Push notifications** *(epic, cross-repo)*. No official Tauri remote-push
plugin exists, and the Hub backend has **no notification fan-out** (the only
web-push code generates VAPID keys for *marketplace apps*). Needs: APNs `.p8` +
FCM project; Swift `UNUserNotificationCenter` / Kotlin `FirebaseMessagingService`
glue; `aps-environment` entitlement; a device-token registration API + a **push
relay on CI-Portal** (appliance Hubs sit behind tunnels/LAN, so Portal is the
natural egress); and an event source on the Hub. Restore
`tauri-plugin-notification` for the local half. Also unblocks background refresh
(deferred until there's something to refresh) — and materially helps the Apple
4.2 "native functionality" case.

**7. App Intents phase 2.** Sequence matters — everything stacks on (a):
- **(a) `AppEntity` + `EntityQuery`** so Shortcuts *suggests* real Hubs. Needs an **App Group** shared store: `EntityQuery` runs out-of-process and can't read the Tauri store file. Also restores the parameterized Siri phrase ("Open *<Hub>*") that Xcode rejects for free-form `String` params.
- **(b)** WidgetKit widget (new extension target + App Group) — medium-large.
- **(c)** Control Center controls (iOS 18+) — small once (a) lands.
- **(d)** Spotlight via `IndexedEntity` — depends on (a).

**8. Android parity.** Cheap 80%: a static `res/xml/shortcuts.xml` (long-press
launcher: Connect / Switch / Settings) firing the **existing** `cihub://intent/*`
URIs — the Rust capture and JS routing already handle them unchanged. Assistant
App Actions is the larger follow-up.

**9. Biometric app-lock.** `tauri-plugin-biometric` (Face ID / BiometricPrompt)
fits the threat model given a persisted session token. Cargo dep + capability +
`NSFaceIDUsageDescription` + a gate in `root.tsx`. Small-medium.

---

## P3 — polish

- **Bundle Montserrat** instead of loading Google Fonts at every cold start (an IP disclosure to Google per launch; GDPR-relevant, and a font flash offline — which a thin client hits often). Then drop both Google hosts from the CSP.
- **Post-connect safe areas** — `--titlebar-height` is never set on mobile while `enableEdgeToEdge()` is on, so the Hub header likely renders under the status bar/notch once connected. **Needs a device check.**
- **Edge-to-edge status-bar icon contrast** — Android 15+ picks icon contrast from the *system* theme, not our forced-dark UI: a light-mode device gets dark icons on dark navy. Pass an explicit `SystemBarStyle`.
- **i18n the Portal error paths** — timeouts surface as raw English / browser `TimeoutError` strings; add keys + inline errors instead of toast-only.
- **Custom Portal URLs** silently fail — the Advanced field accepts any host, but the http capability allowlist only covers `*.ci.computer` + corporate domains + RFC1918 (and is missing `172.16/12`). Widen, or catch the denial and say so.
- **Tablet/TV decision** (see STORE-READINESS §4c).
- **Keep telemetry error-only.** There is zero analytics tooling (`tracesSampleRate: 0`, no PostHog/Plausible). For a privacy-first brand that's the right default — codify it so store privacy answers stay consistent.

---

## Explicitly deferred

- **Native crash handlers** (sentry-cocoa / sentry-android NDK) — JS + Rust panics first.
- **Background refresh** — nothing to refresh until push exists.
- **Self-updater** — stores own binary updates; desktop's `updater.rs` is deliberately not ported.
- **Vendoring the swift-rs Xcode-27 workarounds** — CI's stable Xcode doesn't need them; revisit only if local device builds become a shared bottleneck or swift-rs stays behind.
