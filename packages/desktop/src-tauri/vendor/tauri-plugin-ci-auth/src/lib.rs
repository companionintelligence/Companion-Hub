// vendored-from: tauri-plugin-ci-auth@0.1.0 packages/tauri-plugin-ci-auth/src/lib.rs
// Copyright (c) Lifescope Inc. Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md.

//! tauri-plugin-ci-auth: RFC 8252 sign-in over a loopback redirect, and secure storage for the
//! Companion Intelligence apps. Desktop stores in the OS keychain. iOS and Android store through the
//! plugin's native code, which uses the Keychain and the Android Keystore. Loopback sign-in is desktop
//! only. README.md covers registration, the command contract and the error codes.

mod error;
mod loopback;
#[cfg(any(target_os = "ios", target_os = "android"))]
mod mobile;
mod secure;

use std::fmt;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::plugin::{Builder, PluginApi, TauriPlugin};
use tauri::{Manager, Runtime, State};

pub use error::AuthError;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub use secure::KeyringBackend;
pub use secure::{
    MemoryBackend, SecureBackend, UnavailableBackend, MAX_KEY_BYTES, MAX_VALUE_UNITS,
};

#[cfg(any(target_os = "ios", target_os = "android"))]
use mobile::MobileBackend;

use loopback::{bind, local_port, redirect_uri, resolve_timeout, success_page, wait_for_callback};
#[cfg(not(any(target_os = "ios", target_os = "android")))]
use secure::default_backend;
use secure::{validate_key, validate_value};

// The Swift entry point of the iOS plugin. It returns the plugin object that the Swift code retains.
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_ci_auth);

/// Plugin name. Commands are invoked as `plugin:ci-auth|<command>`.
pub const PLUGIN_NAME: &str = "ci-auth";
/// Keychain service used when the config does not name one.
pub const DEFAULT_SERVICE: &str = "ci-auth";
/// Longest service name the config may use, in bytes.
const MAX_SERVICE_BYTES: usize = 128;
/// The Android package and class of the native plugin, under `android/src/main/java`.
#[cfg(target_os = "android")]
const ANDROID_PLUGIN_IDENTIFIER: &str = "com.companionintelligence.tauri.ciauth";
#[cfg(target_os = "android")]
const ANDROID_PLUGIN_CLASS: &str = "CiAuthPlugin";
/// How long a sign-in may stay pending while no await_loopback has taken it. It is also the longest
/// timeout await_loopback accepts.
const PENDING_SIGN_IN_TTL: Duration = Duration::from_millis(loopback::MAX_TIMEOUT_MS);

/// Plugin settings from `plugins.ci-auth` in tauri.conf.json. A missing entry means the defaults.
#[derive(Debug, Clone, Deserialize)]
#[serde(from = "Option<RawConfig>")]
pub struct Config {
    /// Keychain service name that entries are stored under.
    pub service: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawConfig {
    service: Option<String>,
}

impl From<Option<RawConfig>> for Config {
    fn from(raw: Option<RawConfig>) -> Self {
        let service = raw
            .and_then(|raw| raw.service)
            .unwrap_or_else(|| DEFAULT_SERVICE.to_owned());
        Self { service }
    }
}

/// Response of begin_loopback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginLoopbackResponse {
    /// The loopback port the listener is bound to.
    pub port: u16,
    /// The redirect URI to register with the identity provider.
    pub redirect_uri: String,
}

/// Response of await_loopback. The URL carries the authorization code, so Debug redacts it.
#[derive(Serialize)]
pub struct AwaitLoopbackResponse {
    /// The full callback URL, including its query.
    pub url: String,
}

impl fmt::Debug for AwaitLoopbackResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AwaitLoopbackResponse")
            .field("url", &"<redacted>")
            .finish()
    }
}

/// Response of secure_get. The value is a secret, so Debug redacts it.
#[derive(Serialize)]
pub struct SecureGetResponse {
    /// The stored value, or None when the key is absent.
    pub value: Option<String>,
}

impl fmt::Debug for SecureGetResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecureGetResponse")
            .field("value", &self.value.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Plugin state: the secure store and the one active sign-in.
pub struct AuthState {
    backend: Arc<dyn SecureBackend>,
    sign_in: Mutex<SignInSlot>,
    /// How long a pending sign-in survives while no await_loopback has taken it.
    pending_ttl: Duration,
    /// The page the browser gets once the callback arrives.
    success_page: String,
}

#[derive(Default)]
struct SignInSlot {
    next_id: u64,
    active: Option<ActiveSignIn>,
}

struct ActiveSignIn {
    id: u64,
    port: u16,
    /// None while an await_loopback call owns the listener.
    listener: Option<TcpListener>,
    cancelled: Arc<AtomicBool>,
    /// When a sign-in that no await_loopback has taken is dropped. An await_loopback call ends the
    /// sign-in it owns, so this does not apply once one has started.
    expires_at: Instant,
}

impl fmt::Debug for AuthState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AuthState").finish_non_exhaustive()
    }
}

impl AuthState {
    /// Creates the state around a secure store backend.
    pub fn new(backend: Arc<dyn SecureBackend>) -> Self {
        Self {
            backend,
            sign_in: Mutex::new(SignInSlot::default()),
            pending_ttl: PENDING_SIGN_IN_TTL,
            success_page: success_page(None),
        }
    }

    /// Names the app on the page the browser shows after the callback. The plugin passes the
    /// `productName` from the app's Tauri config. With no name the page says "the app".
    pub fn with_app_name(mut self, app_name: Option<&str>) -> Self {
        self.success_page = success_page(app_name);
        self
    }

    /// Creates the state with a different pending TTL, so a test can check the deadline it sets.
    #[cfg(test)]
    fn with_pending_ttl(backend: Arc<dyn SecureBackend>, pending_ttl: Duration) -> Self {
        Self {
            pending_ttl,
            ..Self::new(backend)
        }
    }

    /// Binds the loopback listener and makes it the active sign-in. A pending sign-in that is past
    /// its deadline is dropped first, so it no longer blocks this call.
    pub fn begin_loopback(&self) -> Result<BeginLoopbackResponse, AuthError> {
        let now = Instant::now();
        let mut slot = self.lock_sign_in();
        expire_pending(&mut slot, now);
        if slot.active.is_some() {
            return Err(AuthError::SignInAlreadyInProgress);
        }
        let listener = bind()?;
        let port = local_port(&listener)?;
        slot.next_id = slot.next_id.wrapping_add(1);
        slot.active = Some(ActiveSignIn {
            id: slot.next_id,
            port,
            listener: Some(listener),
            cancelled: Arc::new(AtomicBool::new(false)),
            expires_at: now + self.pending_ttl,
        });
        Ok(BeginLoopbackResponse {
            port,
            redirect_uri: redirect_uri(port),
        })
    }

    /// Ends the active sign-in. A pending await_loopback returns Cancelled within a short poll
    /// interval, and its listener is dropped then. With no sign-in active this does nothing.
    pub fn cancel_loopback(&self) {
        let taken = self.lock_sign_in().active.take();
        if let Some(active) = taken {
            active.cancelled.store(true, Ordering::SeqCst);
        }
    }

    /// Waits for the callback of the active sign-in. Blocks the calling thread. The sign-in ends
    /// with this call, whatever the outcome, so a later begin_loopback can start a new one.
    pub fn await_loopback(&self, timeout: Duration) -> Result<AwaitLoopbackResponse, AuthError> {
        let (id, port, listener, cancelled) = {
            let mut slot = self.lock_sign_in();
            expire_pending(&mut slot, Instant::now());
            let active = slot.active.as_mut().ok_or(AuthError::NoActiveSignIn)?;
            let listener = active
                .listener
                .take()
                .ok_or(AuthError::SignInAlreadyInProgress)?;
            (
                active.id,
                active.port,
                listener,
                Arc::clone(&active.cancelled),
            )
        };
        let outcome = wait_for_callback(&listener, port, &cancelled, timeout, &self.success_page);
        drop(listener);
        let mut slot = self.lock_sign_in();
        if slot.active.as_ref().is_some_and(|active| active.id == id) {
            slot.active = None;
        }
        drop(slot);
        outcome.map(|url| AwaitLoopbackResponse { url })
    }

    /// Reads a value from the secure store.
    pub fn secure_get(&self, key: &str) -> Result<Option<String>, AuthError> {
        validate_key(key)?;
        self.backend.get(key)
    }

    /// Writes a value to the secure store. A value over MAX_VALUE_UNITS never reaches the backend.
    pub fn secure_set(&self, key: &str, value: &str) -> Result<(), AuthError> {
        validate_key(key)?;
        validate_value(value)?;
        self.backend.set(key, value)
    }

    /// Removes a value from the secure store.
    pub fn secure_remove(&self, key: &str) -> Result<(), AuthError> {
        validate_key(key)?;
        self.backend.remove(key)
    }

    fn lock_sign_in(&self) -> MutexGuard<'_, SignInSlot> {
        self.sign_in.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Drops a pending sign-in once its deadline has passed. A sign-in that an await_loopback call owns is
/// left alone, because that call ends it.
fn expire_pending(slot: &mut SignInSlot, now: Instant) {
    let expired = slot
        .active
        .as_ref()
        .is_some_and(|active| active.listener.is_some() && now >= active.expires_at);
    if expired {
        slot.active = None;
    }
}

/// On iOS and Android the loopback commands fail with unsupported_platform before they touch any state.
/// The secure_* commands are not affected: they run on the native store there.
fn ensure_supported() -> Result<(), AuthError> {
    if cfg!(any(target_os = "ios", target_os = "android")) {
        Err(AuthError::UnsupportedPlatform)
    } else {
        Ok(())
    }
}

/// Runs blocking work (sockets, keychain calls, possible keychain prompts) off the main thread.
async fn run_blocking<T, F>(task: F) -> Result<T, AuthError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AuthError> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(task).await {
        Ok(result) => result,
        Err(_) => Err(AuthError::InternalError),
    }
}

/// Reads an optional argument. A missing argument and a null both mean the default. A value that does
/// not fit the type is bad_request, and the serde message is dropped so it never repeats the value.
fn optional_arg<T: DeserializeOwned>(value: Option<Value>) -> Result<Option<T>, AuthError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value)
            .map(Some)
            .map_err(|_| AuthError::BadRequest),
    }
}

/// Reads a required argument. A missing or null value is bad_request, as is one of the wrong type.
fn required_arg<T: DeserializeOwned>(value: Option<Value>) -> Result<T, AuthError> {
    optional_arg(value)?.ok_or(AuthError::BadRequest)
}

/// The timeoutMs argument of await_loopback, resolved to a Duration.
fn await_timeout(timeout_ms: Option<Value>) -> Result<Duration, AuthError> {
    resolve_timeout(optional_arg(timeout_ms)?)
}

/// The key and value arguments of secure_set.
fn secure_set_args(
    key: Option<Value>,
    value: Option<Value>,
) -> Result<(String, String), AuthError> {
    Ok((required_arg(key)?, required_arg(value)?))
}

#[tauri::command]
fn begin_loopback(state: State<'_, Arc<AuthState>>) -> Result<BeginLoopbackResponse, AuthError> {
    ensure_supported()?;
    state.begin_loopback()
}

#[tauri::command]
async fn await_loopback(
    state: State<'_, Arc<AuthState>>,
    timeout_ms: Option<Value>,
) -> Result<AwaitLoopbackResponse, AuthError> {
    ensure_supported()?;
    let timeout = await_timeout(timeout_ms)?;
    let state = state.inner().clone();
    run_blocking(move || state.await_loopback(timeout)).await
}

#[tauri::command]
fn cancel_loopback(state: State<'_, Arc<AuthState>>) -> Result<(), AuthError> {
    ensure_supported()?;
    state.cancel_loopback();
    Ok(())
}

#[tauri::command]
async fn secure_get(
    state: State<'_, Arc<AuthState>>,
    key: Option<Value>,
) -> Result<SecureGetResponse, AuthError> {
    let key: String = required_arg(key)?;
    let state = state.inner().clone();
    run_blocking(move || {
        state
            .secure_get(&key)
            .map(|value| SecureGetResponse { value })
    })
    .await
}

#[tauri::command]
async fn secure_set(
    state: State<'_, Arc<AuthState>>,
    key: Option<Value>,
    value: Option<Value>,
) -> Result<(), AuthError> {
    let (key, value) = secure_set_args(key, value)?;
    let state = state.inner().clone();
    run_blocking(move || state.secure_set(&key, &value)).await
}

#[tauri::command]
async fn secure_remove(
    state: State<'_, Arc<AuthState>>,
    key: Option<Value>,
) -> Result<(), AuthError> {
    let key: String = required_arg(key)?;
    let state = state.inner().clone();
    run_blocking(move || state.secure_remove(&key)).await
}

/// Builds the plugin. Register it with `tauri::Builder::default().plugin(init())`.
pub fn init<R: Runtime>() -> TauriPlugin<R, Config> {
    Builder::<R, Config>::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![
            begin_loopback,
            await_loopback,
            cancel_loopback,
            secure_get,
            secure_set,
            secure_remove
        ])
        .setup(|app, api| {
            let service = api.config().service.clone();
            validate_service(&service)?;
            let backend = platform_backend(&api, &service)?;
            let app_name = app.config().product_name.as_deref();
            app.manage(Arc::new(AuthState::new(backend).with_app_name(app_name)));
            Ok(())
        })
        .build()
}

/// Keychain service names are 1 to 128 letters, digits, dots, underscores or hyphens. On Android the name is
/// also part of a preference file name and a key alias, so the same rule holds on every platform.
fn validate_service(service: &str) -> Result<(), String> {
    let valid = (1..=MAX_SERVICE_BYTES).contains(&service.len())
        && service
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err("plugins.ci-auth.service must be 1 to 128 letters, digits, dots, underscores or hyphens".to_owned())
    }
}

/// The backend on this platform. Desktop uses the OS keychain. iOS and Android register the native plugin,
/// and their secure_* commands run there.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
fn platform_backend<R: Runtime>(
    _api: &PluginApi<R, Config>,
    service: &str,
) -> Result<Arc<dyn SecureBackend>, Box<dyn std::error::Error>> {
    Ok(default_backend(service))
}

#[cfg(target_os = "ios")]
fn platform_backend<R: Runtime>(
    api: &PluginApi<R, Config>,
    service: &str,
) -> Result<Arc<dyn SecureBackend>, Box<dyn std::error::Error>> {
    let handle = api.register_ios_plugin(init_plugin_ci_auth)?;
    Ok(Arc::new(MobileBackend::new(handle, service)))
}

#[cfg(target_os = "android")]
fn platform_backend<R: Runtime>(
    api: &PluginApi<R, Config>,
    service: &str,
) -> Result<Arc<dyn SecureBackend>, Box<dyn std::error::Error>> {
    let handle = api.register_android_plugin(ANDROID_PLUGIN_IDENTIFIER, ANDROID_PLUGIN_CLASS)?;
    Ok(Arc::new(MobileBackend::new(handle, service)))
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpStream};
    use std::sync::atomic::AtomicUsize;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    fn memory_state() -> AuthState {
        AuthState::new(Arc::new(MemoryBackend::default()))
    }

    /// True once an await_loopback call has taken the listener.
    fn is_awaiting(state: &AuthState) -> bool {
        state
            .lock_sign_in()
            .active
            .as_ref()
            .is_some_and(|active| active.listener.is_none())
    }

    /// Waits until an await_loopback call has taken the listener, so a cancel lands on a pending await.
    fn wait_until_awaiting(state: &AuthState) {
        let waited = Instant::now();
        while !is_awaiting(state) {
            assert!(
                waited.elapsed() < Duration::from_secs(5),
                "await never started"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    /// Moves the active sign-in's deadline into the past, so the next expiry check treats it as
    /// passed. A test uses this instead of sleeping through the TTL.
    fn make_overdue(state: &AuthState) {
        let mut slot = state.lock_sign_in();
        let active = slot.active.as_mut().expect("an active sign-in");
        active.expires_at = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
    }

    #[test]
    fn begin_returns_a_loopback_redirect_uri_and_the_port() {
        let state = memory_state();
        let begun = state.begin_loopback().expect("begin");
        assert_ne!(begun.port, 0);
        assert_eq!(
            begun.redirect_uri,
            format!("http://127.0.0.1:{}/callback", begun.port)
        );
        state.cancel_loopback();
    }

    #[test]
    fn a_second_begin_is_refused_while_a_sign_in_is_active() {
        let state = memory_state();
        state.begin_loopback().expect("first begin");
        assert_eq!(
            state.begin_loopback().err(),
            Some(AuthError::SignInAlreadyInProgress)
        );
        state.cancel_loopback();
    }

    #[test]
    fn await_without_a_begin_is_no_active_sign_in() {
        let state = memory_state();
        assert_eq!(
            state.await_loopback(Duration::from_millis(10)).err(),
            Some(AuthError::NoActiveSignIn)
        );
    }

    #[test]
    fn cancel_with_no_sign_in_does_nothing() {
        memory_state().cancel_loopback();
    }

    #[test]
    fn a_timeout_ends_the_sign_in_so_a_new_one_can_begin() {
        let state = memory_state();
        state.begin_loopback().expect("begin");
        assert_eq!(
            state.await_loopback(Duration::from_millis(50)).err(),
            Some(AuthError::Timeout)
        );
        assert_eq!(
            state.await_loopback(Duration::from_millis(10)).err(),
            Some(AuthError::NoActiveSignIn)
        );
        state.begin_loopback().expect("begin again after a timeout");
        state.cancel_loopback();
    }

    #[test]
    fn an_unawaited_sign_in_expires_so_a_new_one_can_begin() {
        let state = memory_state();
        state.begin_loopback().expect("begin");
        make_overdue(&state);
        state
            .begin_loopback()
            .expect("begin again once the pending sign-in has expired");
        state.cancel_loopback();
    }

    #[test]
    fn an_expired_pending_sign_in_is_no_active_sign_in_for_await() {
        let state = memory_state();
        state.begin_loopback().expect("begin");
        make_overdue(&state);
        assert_eq!(
            state.await_loopback(Duration::from_millis(10)).err(),
            Some(AuthError::NoActiveSignIn)
        );
    }

    #[test]
    fn a_pending_sign_in_gets_its_deadline_from_the_ttl_at_begin() {
        let ttl = Duration::from_secs(7);
        let state = AuthState::with_pending_ttl(Arc::new(MemoryBackend::default()), ttl);
        let before = Instant::now();
        state.begin_loopback().expect("begin");
        let after = Instant::now();
        let expires_at = state
            .lock_sign_in()
            .active
            .as_ref()
            .expect("an active sign-in")
            .expires_at;
        assert!(expires_at >= before + ttl);
        assert!(expires_at <= after + ttl);
        state.cancel_loopback();
    }

    #[test]
    fn the_deadline_never_drops_a_sign_in_that_an_await_owns() {
        // The default TTL cannot lapse while the waiter thread is still starting, so the await
        // always takes the listener first.
        let state = memory_state();
        state.begin_loopback().expect("begin");
        thread::scope(|scope| {
            let waiter = scope.spawn(|| state.await_loopback(Duration::from_secs(30)));
            wait_until_awaiting(&state);
            make_overdue(&state);
            assert_eq!(
                state.begin_loopback().err(),
                Some(AuthError::SignInAlreadyInProgress)
            );
            state.cancel_loopback();
            assert_eq!(
                waiter.join().expect("await thread").err(),
                Some(AuthError::Cancelled)
            );
        });
    }

    #[test]
    fn cancel_resolves_a_pending_await_with_cancelled() {
        let state = memory_state();
        state.begin_loopback().expect("begin");
        let started = Instant::now();
        let result = thread::scope(|scope| {
            let waiter = scope.spawn(|| state.await_loopback(Duration::from_secs(30)));
            wait_until_awaiting(&state);
            state.cancel_loopback();
            waiter.join().expect("await thread")
        });
        assert_eq!(result.err(), Some(AuthError::Cancelled));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_second_await_is_refused_while_the_first_owns_the_listener() {
        let state = memory_state();
        state.begin_loopback().expect("begin");
        thread::scope(|scope| {
            let first = scope.spawn(|| state.await_loopback(Duration::from_secs(30)));
            wait_until_awaiting(&state);
            assert_eq!(
                state.await_loopback(Duration::from_millis(10)).err(),
                Some(AuthError::SignInAlreadyInProgress)
            );
            state.cancel_loopback();
            assert_eq!(
                first.join().expect("first await").err(),
                Some(AuthError::Cancelled)
            );
        });
    }

    #[test]
    fn the_callback_page_names_the_app() {
        let state = memory_state().with_app_name(Some("Companion Hub"));
        let port = state.begin_loopback().expect("begin").port;
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            stream
                .write_all(b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .expect("write");
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            response
        });
        state
            .await_loopback(Duration::from_secs(10))
            .expect("callback");
        let response = client.join().expect("client");
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("<p>Return to Companion Hub to continue.</p>"));
        assert!(response.contains("<p>You can close this tab.</p>"));
    }

    #[test]
    fn a_callback_completes_the_sign_in_and_is_single_use() {
        let state = memory_state();
        let port = state.begin_loopback().expect("begin").port;
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
            stream
                .write_all(b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .expect("write");
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            response
        });
        let done = state
            .await_loopback(Duration::from_secs(10))
            .expect("callback");
        assert_eq!(
            done.url,
            format!("http://127.0.0.1:{port}/callback?code=abc&state=xyz")
        );
        assert!(client
            .join()
            .expect("client")
            .starts_with("HTTP/1.1 200 OK"));
        assert_eq!(
            state.await_loopback(Duration::from_millis(10)).err(),
            Some(AuthError::NoActiveSignIn)
        );
        state
            .begin_loopback()
            .expect("a new sign-in can begin after a completed one");
        state.cancel_loopback();
    }

    #[test]
    fn secure_round_trip_through_the_backend() {
        let state = memory_state();
        assert_eq!(state.secure_get("hub:refresh").expect("get"), None);
        state.secure_set("hub:refresh", "token-1").expect("set");
        assert_eq!(
            state.secure_get("hub:refresh").expect("get"),
            Some("token-1".to_owned())
        );
        state
            .secure_set("hub:refresh", "token-2")
            .expect("overwrite");
        assert_eq!(
            state.secure_get("hub:refresh").expect("get"),
            Some("token-2".to_owned())
        );
        state.secure_remove("hub:refresh").expect("remove");
        assert_eq!(state.secure_get("hub:refresh").expect("get"), None);
        state
            .secure_remove("hub:refresh")
            .expect("removing an absent key succeeds");
    }

    #[test]
    fn an_unavailable_keychain_fails_closed() {
        let state = AuthState::new(Arc::new(UnavailableBackend));
        assert_eq!(
            state.secure_get("k").err(),
            Some(AuthError::SecureStoreUnavailable)
        );
        assert_eq!(
            state.secure_set("k", "v").err(),
            Some(AuthError::SecureStoreUnavailable)
        );
        assert_eq!(
            state.secure_remove("k").err(),
            Some(AuthError::SecureStoreUnavailable)
        );
    }

    #[test]
    fn bad_keys_are_refused_before_the_backend_is_asked() {
        let state = AuthState::new(Arc::new(UnavailableBackend));
        assert_eq!(state.secure_get("").err(), Some(AuthError::BadRequest));
        assert_eq!(
            state.secure_set("bad\nkey", "v").err(),
            Some(AuthError::BadRequest)
        );
        assert_eq!(
            state.secure_remove(&"k".repeat(MAX_KEY_BYTES + 1)).err(),
            Some(AuthError::BadRequest)
        );
        // A key at the length limit is valid, so the unavailable backend is what answers.
        assert_eq!(
            state.secure_get(&"k".repeat(MAX_KEY_BYTES)).err(),
            Some(AuthError::SecureStoreUnavailable)
        );
    }

    /// Refuses every write as too long, the way a store with a blob limit does. It counts the writes
    /// that reach it.
    #[derive(Default)]
    struct TooLongBackend {
        writes: AtomicUsize,
    }

    impl SecureBackend for TooLongBackend {
        fn get(&self, _key: &str) -> Result<Option<String>, AuthError> {
            Ok(None)
        }

        fn set(&self, _key: &str, _value: &str) -> Result<(), AuthError> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            Err(AuthError::ValueTooLarge)
        }

        fn remove(&self, _key: &str) -> Result<(), AuthError> {
            Ok(())
        }
    }

    #[test]
    fn values_are_limited_to_1024_utf16_code_units() {
        let state = memory_state();
        state
            .secure_set("hub:token", &"a".repeat(MAX_VALUE_UNITS))
            .expect("1024 code units is accepted");
        assert_eq!(
            state
                .secure_set("hub:token", &"a".repeat(MAX_VALUE_UNITS + 1))
                .err(),
            Some(AuthError::ValueTooLarge)
        );
        // Each emoji is two UTF-16 code units, so 512 of them sit exactly on the limit.
        let emoji = "\u{1F600}";
        state
            .secure_set("hub:token", &emoji.repeat(512))
            .expect("512 emoji is 1024 code units");
        assert_eq!(
            state.secure_set("hub:token", &emoji.repeat(513)).err(),
            Some(AuthError::ValueTooLarge)
        );
    }

    #[test]
    fn an_oversized_value_is_refused_before_the_backend_is_asked() {
        let backend = Arc::new(TooLongBackend::default());
        let state = AuthState::new(backend.clone());
        assert_eq!(
            state
                .secure_set("k", &"a".repeat(MAX_VALUE_UNITS + 1))
                .err(),
            Some(AuthError::ValueTooLarge)
        );
        assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_backend_refusal_for_length_stays_value_too_large() {
        let backend = Arc::new(TooLongBackend::default());
        let state = AuthState::new(backend.clone());
        assert_eq!(
            state.secure_set("k", "short").err(),
            Some(AuthError::ValueTooLarge)
        );
        assert_eq!(backend.writes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_wrong_typed_argument_is_bad_request_and_never_repeats_the_value() {
        let timeout = await_timeout(Some(serde_json::json!("SECRET-TIMEOUT")))
            .expect_err("a string is not a timeout");
        let value = secure_set_args(
            Some(serde_json::json!("hub:token")),
            Some(serde_json::json!(70_000_123)),
        )
        .expect_err("an integer is not a value");
        let timeout_response = serde_json::to_string(&timeout).expect("serialize");
        let value_response = serde_json::to_string(&value).expect("serialize");
        assert_eq!(timeout_response, "\"bad_request\"");
        assert_eq!(value_response, "\"bad_request\"");
        assert!(!timeout_response.contains("SECRET-TIMEOUT"));
        assert!(!value_response.contains("70000123"));
    }

    #[test]
    fn missing_and_null_arguments_take_defaults_and_required_ones_are_checked() {
        let default = Duration::from_millis(loopback::DEFAULT_TIMEOUT_MS);
        assert_eq!(await_timeout(None), Ok(default));
        assert_eq!(await_timeout(Some(Value::Null)), Ok(default));
        assert_eq!(
            await_timeout(Some(serde_json::json!(1_234))),
            Ok(Duration::from_millis(1_234))
        );
        assert_eq!(
            await_timeout(Some(serde_json::json!(0))).err(),
            Some(AuthError::BadRequest)
        );
        assert_eq!(
            required_arg::<String>(None).err(),
            Some(AuthError::BadRequest)
        );
        assert_eq!(
            secure_set_args(Some(serde_json::json!("k")), Some(serde_json::json!("v"))),
            Ok(("k".to_owned(), "v".to_owned()))
        );
        assert_eq!(
            secure_set_args(Some(serde_json::json!("k")), Some(Value::Null)).err(),
            Some(AuthError::BadRequest)
        );
    }

    #[test]
    fn error_codes_are_stable_and_match_their_serialized_form() {
        let all = [
            AuthError::Timeout,
            AuthError::Cancelled,
            AuthError::NoActiveSignIn,
            AuthError::SignInAlreadyInProgress,
            AuthError::BadRequest,
            AuthError::ValueTooLarge,
            AuthError::SecureStoreUnavailable,
            AuthError::UnsupportedPlatform,
            AuthError::InternalError,
        ];
        for error in all {
            let json = serde_json::to_string(&error).expect("serialize");
            assert_eq!(json, format!("\"{}\"", error.code()));
            assert_eq!(error.to_string(), error.code());
        }
        assert_eq!(
            AuthError::SignInAlreadyInProgress.code(),
            "sign_in_already_in_progress"
        );
        assert_eq!(
            AuthError::SecureStoreUnavailable.code(),
            "secure_store_unavailable"
        );
        assert_eq!(
            AuthError::UnsupportedPlatform.code(),
            "unsupported_platform"
        );
        assert_eq!(AuthError::ValueTooLarge.code(), "value_too_large");
    }

    #[test]
    fn debug_output_never_shows_a_code_or_a_secret() {
        let response = AwaitLoopbackResponse {
            url: "http://127.0.0.1:1/callback?code=TOPSECRET".to_owned(),
        };
        assert!(!format!("{response:?}").contains("TOPSECRET"));
        let stored = SecureGetResponse {
            value: Some("TOPSECRET".to_owned()),
        };
        assert!(!format!("{stored:?}").contains("TOPSECRET"));
    }

    #[test]
    fn plugin_config_defaults_when_the_entry_is_missing() {
        let missing: Config =
            serde_json::from_value(serde_json::Value::Null).expect("missing config");
        assert_eq!(missing.service, DEFAULT_SERVICE);

        let named: Config =
            serde_json::from_value(serde_json::json!({ "service": "com.example.app" }))
                .expect("named config");
        assert_eq!(named.service, "com.example.app");

        assert!(serde_json::from_value::<Config>(serde_json::json!({ "servce": "typo" })).is_err());
    }

    #[test]
    fn native_rejections_keep_their_code_and_fail_closed_otherwise() {
        assert_eq!(
            AuthError::from_native_code("bad_request"),
            AuthError::BadRequest
        );
        assert_eq!(
            AuthError::from_native_code("value_too_large"),
            AuthError::ValueTooLarge
        );
        assert_eq!(
            AuthError::from_native_code("secure_store_unavailable"),
            AuthError::SecureStoreUnavailable
        );
        assert_eq!(
            AuthError::from_native_code("some_future_code"),
            AuthError::SecureStoreUnavailable
        );
        assert_eq!(
            AuthError::from_native_code(""),
            AuthError::SecureStoreUnavailable
        );
    }

    #[test]
    fn the_service_name_is_a_plain_identifier_on_every_platform() {
        assert!(validate_service("ci-auth").is_ok());
        assert!(validate_service("com.companionintelligence.hub").is_ok());
        assert!(validate_service("hub_2.beta-1").is_ok());
        assert!(validate_service(&"a".repeat(MAX_SERVICE_BYTES)).is_ok());
        assert!(validate_service("").is_err());
        assert!(validate_service("bad/service").is_err());
        assert!(validate_service("has space").is_err());
        assert!(validate_service(&"a".repeat(MAX_SERVICE_BYTES + 1)).is_err());
    }
}
