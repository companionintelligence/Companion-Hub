<!--
  Copyright (c) Lifescope Inc. All rights reserved.
  Private & Confidential — Property of Lifescope Inc. Do not distribute.
-->

# tauri-plugin-ci-auth

Tauri v2 plugin for the Companion Intelligence desktop apps. On desktop it does two things:

- **Sign-in over a loopback redirect** (RFC 8252). It binds `127.0.0.1` on an ephemeral port, waits for one `GET /callback`, and returns the full callback URL.
- **Secure storage in the OS keychain**: Keychain on macOS, Credential Manager on Windows, Secret Service on Linux and BSD. Nothing is written to disk outside the keychain.

On iOS and Android the three `secure_*` commands store through the platform's own secure store, in native code in `ios/` and `android/`: the Keychain on iOS and an AndroidKeyStore key on Android. The loopback commands are desktop only and return `unsupported_platform` there. This crate has no mobile sign-in sheet. A Capacitor app takes its sheet from `@companionintelligence/capacitor-plugin-ci-auth`.

Built against Tauri 2.12.5 and tauri-build 2.7.4, the versions the Companion Hub and Companion Memory desktop apps lock, with tauri-plugin 2.7.1, which needs Rust 1.90 or later. `Cargo.toml` pins the two Tauri crates exactly, so adding this crate does not move the Companion Hub's runtime. Bump them together with the Hub. This crate is not published. Consume it by path or by git, pinned to a commit.

## Register the plugin

In the app's `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-ci-auth = { path = "../../CI-Common/packages/tauri-plugin-ci-auth" }
```

In the app's `src-tauri/src/lib.rs`:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_ci_auth::init())
```

Grant the default permission set in a capability file such as `src-tauri/capabilities/default.json`:

```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default", "ci-auth:default"]
}
```

Optional: name the keychain service in `tauri.conf.json`. Without it the service is `ci-auth`. Callers namespace their own keys. The name is 1 to 128 letters, digits, dots, underscores or hyphens, on every platform, because on Android it is part of a preference file name.

```json
"plugins": { "ci-auth": { "service": "com.example.hub" } }
```

Changing the service later makes the stored values unreadable, so treat it as part of the stored data.

### Mobile wiring

The crate registers the mobile plugin itself, so an app needs no extra setup in Rust. The Android class is `com.companionintelligence.tauri.ciauth.CiAuthPlugin`. The iOS entry point is `init_plugin_ci_auth`. The crate's build script copies the Tauri iOS API to `.tauri/tauri-api` at the crate root, which the iOS Swift package uses. The Android module needs the app's `tauri-android` project, as for any Tauri plugin.

## Commands

Invoke them as `plugin:ci-auth|<command>`.

| Command | Arguments | Returns |
| --- | --- | --- |
| `begin_loopback` | none | `{ port, redirectUri }` |
| `await_loopback` | `{ timeoutMs? }` | `{ url }` |
| `cancel_loopback` | none | `null` |
| `secure_get` | `{ key }` | `{ value }`, where `value` is `null` when the key is absent |
| `secure_set` | `{ key, value }` | `null` |
| `secure_remove` | `{ key }` | `null` |

The `secure_*` commands behave the same on every platform. Only the store behind them differs.

Sign-in flow: call `begin_loopback`, send the user to the identity provider with `redirectUri` as the redirect URI, then call `await_loopback`. The plugin returns the callback URL as the browser sent it. It does not check `state`, PKCE or the issuer. The caller must do that before it exchanges the code. The URL contains the authorization code, so treat it as sensitive.

Behaviour:

- `timeoutMs` defaults to 300000 and is capped at 600000. Zero is `bad_request`.
- Arguments are JSON values. Only `timeoutMs` has a default, so a missing or null `timeoutMs` takes it. A missing or null `key` or `value` is `bad_request`, as is a value of the wrong type, such as a string for `timeoutMs`. The error never repeats the value.
- A key is 1 to 256 bytes with no control characters.
- A stored value is limited to 1024 UTF-16 code units on every platform, so callers keep access and id tokens out of the keychain. A longer value fails with `value_too_large` before the store is called.
- `begin_loopback` and `cancel_loopback` return at once. `await_loopback` and the `secure_*` commands run on a background thread, so they never block the UI.
- One sign-in at a time. `begin_loopback` fails while one is active. `await_loopback` ends the sign-in whatever the outcome, so a new one can begin.
- A sign-in that no `await_loopback` has taken within 600 seconds of `begin_loopback` is dropped, so a later `begin_loopback` can start. Its `await_loopback` then reports `no_active_sign_in`. Pair every `begin_loopback` with `await_loopback` or `cancel_loopback` in a `finally` block. Otherwise the listener stays bound until the deadline passes.
- `cancel_loopback` with no sign-in active does nothing. A pending `await_loopback` returns `cancelled` promptly and closes its listener. A client that is partway through a request can delay that by up to 5 seconds.

## Error codes

Errors are these strings and carry no other text.

| Code | Meaning |
| --- | --- |
| `timeout` | No callback arrived in time. The sign-in is over. |
| `cancelled` | `cancel_loopback` ended the pending sign-in. |
| `no_active_sign_in` | `await_loopback` ran without a `begin_loopback`. |
| `sign_in_already_in_progress` | `begin_loopback` ran during a sign-in, or a second `await_loopback` ran. |
| `bad_request` | An argument is malformed or out of range. |
| `value_too_large` | The value is longer than 1024 UTF-16 code units, or the store refused it as too long. |
| `secure_store_unavailable` | The keychain is missing, locked or refused the operation. There is no file fallback. |
| `unsupported_platform` | A loopback command ran on iOS or Android, where it is not supported. |
| `internal_error` | The OS refused the loopback socket, or a background task did not finish. |

## Loopback rules

- Bound to `127.0.0.1` only. Never `0.0.0.0`, `localhost` or `[::1]`.
- Accepts exactly one `GET /callback`, then closes the listener. Any other path gets `404`. A non-GET gets `405`. A malformed or oversized head gets `400` or `431`. None of these ends the wait.
- The request head is capped at 8 KiB and must arrive within 5 seconds.
- The success page names the app from `productName` in its Tauri config, tells the user to return to it and says the tab can be closed. With no `productName` it says "the app". The page loads nothing: its styles are inline, and every response carries a Content-Security-Policy that refuses scripts and every other resource.
- Request targets are never logged.

## Platform notes

- Linux and BSD use the Secret Service over D-Bus. Without a running Secret Service the keychain is unavailable.
- Windows Credential Manager refuses a value whose UTF-16 form is over 2560 bytes. The plugin's limit of 1024 UTF-16 code units keeps every platform under that. A store that still refuses the length reports `value_too_large`, never `secure_store_unavailable`.
- **iOS.** Items are generic passwords under the service, with the key as the account. They use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable after the first unlock following a boot, never synced, never restored to another device. Nothing is gated on unlock or biometrics.
- **Android.** A 256-bit AES-GCM key lives in the AndroidKeyStore under the alias `ci-secure-store.<service>.aes-gcm.v1`. It needs no user authentication and no unlocked device. Each value is stored as ciphertext in the app's private SharedPreferences `ci-secure-store.<service>`, with the key name as additional authenticated data. The Keystore key cannot be exported, so a restored copy of the preferences without its key cannot be read. Set `android:allowBackup="false"` in the app, or exclude that file from backup, so the app does not keep a copy it cannot read. A value that cannot be decrypted reports `secure_store_unavailable`.
- Both native stores fail closed. Neither falls back to a plaintext or weaker store, and neither has a simulator or development shortcut.
- Native readers outside the plugin, such as iOS App Intents, must use the same service, account and accessibility class to read these items.

## Tests

`cargo test` uses an in-memory backend and a real loopback socket. It never touches the real keychain. It does not build or run the iOS or Android code. That code is compiled only when the Tauri build targets iOS or Android.
