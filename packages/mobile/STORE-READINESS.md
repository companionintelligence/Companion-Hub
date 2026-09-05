# Store readiness — Companion Hub mobile

Delivery checklist for shipping `packages/mobile` to the **App Store** and
**Google Play**, from a review of the app against current (2025-26) store
requirements.

**Status: code and both release pipelines are ready; the remaining gates are
account/ops work.** Everything that could be fixed in the repo has been,
including the signed-IPA lane (`ios-release`) and the ASC build-number
stamping. What's left needs an Apple Developer account, a Play Console
account, and a decision about how App Review signs in.

- App: **Companion Hub** · id **`computer.ci.app.hub`** · version **0.1.0**
- Roadmap for post-v1 capabilities: [`ROADMAP.md`](./ROADMAP.md)

---

## 1. Blockers — you must do these (not code)

| # | Gate | Why | Owner |
|---|------|-----|-------|
| 1 | **Apple Developer Program** enrollment | Nothing ships without it. Then: register `computer.ci.app.hub`, create the App Store Connect record, generate a Distribution cert + App Store provisioning profile (or an ASC API key for cloud signing). Store as repo secrets and set `bundle.iOS.developmentTeam`. | Ops |
| 2 | **Play Console account** (use an **organization** account) | New *personal* accounts must run a 14-day / 12-tester closed test before production; org accounts are exempt. `applicationId` is permanent once uploaded. | Ops |
| 3 | **Play upload keystore** + App Signing enrollment | `keytool` an upload key, enroll in Play App Signing, add the 4 secrets below. The gradle loader is already wired — it just needs the key. | Ops |
| 4 | **Privacy policy URL** | Hard-required by both stores for an app with sign-in. Must cover: email+password sent to `hub.ci.computer`, the Hub session stored on-device, traffic to the user's own Hub appliances. | Legal/Ops |
| 5 | **App Review demo access** (Apple 2.1) | ⚠️ **The most likely rejection.** The app is unusable without a CI cloud account *and* a registered Hub appliance — a reviewer with zero devices hits a dead end. See §4. | Product |
| 6 | **Account deletion** (Apple 5.1.1(v) / Play data-deletion) | No self-serve deletion exists on the Portal (better-auth has no `deleteUser` plugin). Cross-repo CI-Portal work + an in-app link. See §4. | CI-Portal |

**Android signing secrets** (used by the `android-release` job):
`ANDROID_KEY_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_STORE_PASSWORD`

**iOS signing secrets** (used by the `ios-release` job — the lane is wired, it
just needs the values from blocker §1.1):

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE_BASE64` | Distribution cert `.p12`, base64'd (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | Password you set when exporting the `.p12` |
| `APPLE_PROVISIONING_PROFILE_BASE64` | App Store provisioning profile, base64'd |
| `APPLE_DEVELOPMENT_TEAM` | 10-char Team ID from developer.apple.com ▸ Membership |

Optional — only to push straight to TestFlight (otherwise the `.ipa` is a
downloadable artifact you can send with Transporter):
`APPSTORE_API_KEY_ID`, `APPSTORE_API_ISSUER_ID`, `APPSTORE_API_PRIVATE_KEY_BASE64`
(App Store Connect ▸ Users and Access ▸ Integrations).

---

## 2. Done in-repo ✅

Fixed as part of this prep — no action needed:

**iOS**
- `PrivacyInfo.xcprivacy` — required-reason APIs (FileTimestamp `C617.1`, SystemBootTime `35F9.1`, UserDefaults `CA92.1`), `NSPrivacyTracking=false`, email+credentials declared app-functionality. Registered as a bundle resource in `project.yml`.
- 1024 marketing icon **alpha flattened** (ASC rejects transparent marketing icons at upload) — both the asset catalog and the `icons/ios` source. Verified in a built bundle 2026-08-03: the 1024 entry is `Opaque: True` with PNG colorType 2 (no alpha channel at all). The *runtime* icons do carry an alpha channel (`Opaque: False` in `assetutil`), but their alpha range is 254–255 — anti-aliasing from the downscale, not real transparency — which is normal and not a rejection cause. Don't "fix" it on the basis of an `assetutil` glance alone.
- `NSLocalNetworkUsageDescription` (the LAN Hub URLs trigger iOS's local-network prompt) and `ITSAppUsesNonExemptEncryption=false` (pre-answers export compliance).
- iOS 16 deployment target; UIScene lifecycle adopted; App Intents shipped.

**Android**
- `allowBackup=false` — the Hub session token was riding Google auto-backup.
- Release `signingConfig` loader (`keystore.properties`, gitignored) + a secrets-gated **release AAB** job.
- Adaptive icon (`mipmap-anydpi-v26`) — Android 8+ was masking the legacy PNG.
- `windowSoftInputMode=adjustResize`.
- Already compliant: `targetSdk=36` (Play's 2025 floor is 35), `minSdk=24`, R8 + proguard on release, `usesCleartextTraffic=false` in release, INTERNET-only permissions.

**Security / UX**
- **Self-updater gated off mobile.** `isTauri()` is true on iOS/Android, so the desktop update checker was mounting there and polling our own release feed from inside a store-shipped app — it can only offer `.dmg`/`.exe` artifacts a phone cannot install, and self-updating outside the store is an App Store rejection (2.4.5 / 3.2.2). It stayed silent only by accident: the mobile Rust shell never registers `get_desktop_release_version_command`, so the invoke rejected. The gate is now explicit (`canSelfUpdate()`) and covered by tests, so adding a version command later can't silently arm it.
- Removed `tauri-plugin-notification` (zero callers, but it added POST_NOTIFICATIONS/RECEIVE_BOOT_COMPLETED/WAKE_LOCK to the manifest).
- CSP: dropped bare `http:` from `img-src`.
- Fixed the infinite "Connecting…" trap when a stored Hub is unreachable.
- Sentry enabled + correctly tagged (`ios-web`/`android-web`) on mobile.
- a11y: input labels, real 44px touch targets, pill contrast.

---

## 3. Store metadata to fill in

**App Store Connect**
- Privacy labels: *Contact Info → Email Address* (linked, App Functionality) and credentials. **Not** used for tracking → no ATT prompt. Add *Diagnostics* only if you keep Sentry on for store builds (it's now enabled in CI builds — decide, see §4).
- Export compliance: standard TLS → exempt (pre-answered by `ITSAppUsesNonExemptEncryption`).
- Screenshots — **including iPad** (the app currently ships universal; see §4).
- Review notes: demo credentials + the native-capability list from §4.

**Play Console**
- Data safety: Email (collected, required, account management, encrypted in transit, not shared, not sold); password transmitted but never persisted; on-device: Hub URL + session id. No analytics/ads SDKs.
- Content rating (IARC — utility, no UGC, no ads → Everyone/PEGI 3), target audience **18+ / not child-directed**, store listing assets (512 icon, 1024×500 feature graphic, ≥2 phone screenshots).
- Account deletion URL (§1.6).

---

## 4. Decisions to make before submitting

**a) How App Review signs in** (blocker §1.5). Best → worst:
1. **Dedicated review account + an always-on fleet Hub.** `appreview@ci.computer` on the production Portal with one fleet appliance registered to it. Fleet Hubs are already publicly reachable at `hub-<device>-<org>.ci.computer` via the Portal tunnel, so the reviewer needs no LAN access. Mostly ops work — **recommended**.
2. **In-app demo/sandbox Hub mode** (mock device + canned data). More engineering, but permanently removes the hardware dependency from review.
3. Review notes + a demo video — weakest; reviewers routinely reject when they can't drive the app.

**b) Apple 4.2 "minimum functionality."** A Tauri app rendering a React SPA carries **real rejection risk**. Genuine mitigations to cite in review notes: the SPA is **embedded** (not a browser pointed at a website — it's a native client for the user's own appliance), 5 native **App Intents** + AppShortcutsProvider (Siri/Shortcuts/Spotlight/Action Button), `cihub://` deep-link SSO + pairing. A widget or push would harden this further ([`ROADMAP.md`](./ROADMAP.md) phases 2-3).

**c) iPad.** The project ships `TARGETED_DEVICE_FAMILY="1,2"` and declares iPad orientations, so review **will** run it on iPad and iPad screenshots are mandatory — with no tablet layout work done (responsive Tailwind only). Either budget an iPad pass or set iPhone-only. Same question for the Leanback/AndroidTV launcher category in the Android manifest.

**d) Sentry on store builds.** Now enabled in CI mobile builds. `sendDefaultPii: true` + `setUser(device_id)` means the privacy labels must declare Diagnostics (incl. IP) linked to the user. Either accept that, or set `sendDefaultPii: false` for mobile before filling the forms. **Decide before submitting** — changing it later means re-declaring.

**e) Sign in with Apple (4.8) — currently N/A.** Login is exclusively to our own service (CI-Portal better-auth: email/password + passkey + its own OIDC, **no** social providers). Own-account systems are exempt. ⚠️ If the Portal login page ever gains a third-party social button, 4.8 attaches immediately and Sign in with Apple becomes mandatory.

---

## 5. Release process

```bash
# Both lanes are secrets-gated and skip cleanly when the secrets are absent.
gh workflow run mobile-build.yml
#   → companion-hub-android-release-aab   (needs the 4 Android secrets)
#   → companion-hub-ios-release-ipa       (needs the 4 Apple secrets)
```

> ⚠️ **The iOS build-number stamping is currently a no-op** (verified
> 2026-09-05). `scripts/set-ios-version.mjs` writes only `project.yml`, but
> `gen/apple/…/Info.plist` is committed and is what ships — xcodegen does **not**
> regenerate it during `tauri ios build`. Until the script also writes the plist,
> assume every upload carries the committed `CFBundleVersion`, and ASC will
> reject the second one. See the README's "Generated Apple files are committed".

- **Versioning:** bump `version` in `tauri.conf.json` — it is the single source for both platforms. Android `versionName`/`versionCode` derive from it (`major*1e6 + minor*1e3 + patch`); iOS gets it via `scripts/set-ios-version.mjs`, which stamps `CFBundleShortVersionString` from that same field and sets `CFBundleVersion` to `$IOS_BUILD_NUMBER` (CI passes `github.run_number`, which is monotonic). Run `node scripts/set-ios-version.mjs --check` to catch marketing-version drift.

> ⚠️ **Do not use tauri's `--build-number` flag for App Store builds.** It
> *appends* to the app version rather than replacing the build number, so
> `--build-number 4242` yields `CFBundleVersion = 0.1.0.4242`. Apple allows at
> most **three** period-separated integers, so ASC rejects that at upload.
> Verified 2026-08-03 by inspecting the resulting `.xcarchive`. The
> `set-ios-version.mjs` step in the `ios-release` job exists precisely because
> the built-in flag can't be used here.
- **Ship-blocking caveat:** the app has only ever been verified on the **iOS Simulator + Android emulator**. Deep links from the system browser (`cihub://auth` SSO), App Intents via Siri, and the local-network prompt all need a **signed device build via TestFlight** before submission. The `ios-release` lane now produces that build — it is the *account*, not the pipeline, that is missing.
- **Last simulator verification:** 2026-08-03, Xcode 27.0 / iOS 27.0 sim (iPhone 17 Pro), against `dev` after the mobile PR merged. App installs, launches, stays alive, loads all webview assets over the `tauri://` scheme with no failed loads or JS errors, and boots the SPA (confirmed by the `i18nextLng` key appearing in the app's WebKit `localstorage.sqlite3` — React/i18next only writes it after mount). `cihub` is registered in the built bundle's `CFBundleURLTypes`, and the app survives an incoming `cihub://` deep link. Note `simctl io screenshot` renders the WKWebView layer **black** — that is a simulator capture artifact, not a blank screen; verify via the storage/log evidence above or Safari ▸ Develop.
- **iOS + Xcode 27:** local device builds currently need the vendored `swift-rs` workarounds in [`README.md`](./README.md). CI's stable Xcode doesn't (verified), so CI is the reliable iOS build path today.
