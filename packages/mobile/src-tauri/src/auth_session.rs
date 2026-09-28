//! In-app sign-in sheet.
//!
//! iOS presents `ASWebAuthenticationSession`. Android presents Chrome Auth Tab
//! (Custom Tabs when the browser is older than Chrome 137, or the URL is
//! http). Desktop never calls this — the frontend falls through to the system
//! opener. The command still exists everywhere so a stale JS bundle gets a
//! structured error instead of a missing-command reject.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthSessionError {
    Cancelled,
    /// Desktop only. Android and iOS always have a sheet.
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
    Unavailable,
    Failed(String),
}

impl AuthSessionError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed(message.into())
    }
}

impl std::fmt::Display for AuthSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "Sign-in cancelled"),
            Self::Unavailable => write!(f, "Could not open the sign-in sheet."),
            Self::Failed(message) => write!(f, "{message}"),
        }
    }
}

impl Serialize for AuthSessionError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("message", &self.to_string())?;
        map.serialize_entry(
            "code",
            match self {
                Self::Cancelled => "CANCELLED",
                Self::Unavailable | Self::Failed(_) => "FAILED",
            },
        )?;
        map.end()
    }
}

/// `Ok(Some(url))` is a captured `cihub://` callback. `Ok(None)` means a
/// Custom Tab was opened and the existing deep-link intent filter will finish
/// the login. Waiting on that close would surface a cancel and abort a
/// successful OIDC exchange.
pub async fn start(
    app: &tauri::AppHandle,
    url: &str,
    callback_scheme: &str,
) -> Result<Option<String>, AuthSessionError> {
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        return ios::start(url, callback_scheme).await.map(Some);
    }
    #[cfg(target_os = "android")]
    {
        return android::start(app, url, callback_scheme).await;
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (app, url, callback_scheme);
        Err(AuthSessionError::Unavailable)
    }
}

/// Maps the Kotlin / Swift callback into a deep-link URL, an "already opened"
/// signal, or a structured error. Pure so host tests cover the Android codes.
fn interpret(
    url: Option<&str>,
    code: Option<&str>,
    message: Option<&str>,
) -> Result<Option<String>, AuthSessionError> {
    if let Some(callback) = url.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(Some(callback.to_string()));
    }
    match code.unwrap_or("").trim() {
        "OPENED" => Ok(None),
        "CANCELLED" => Err(AuthSessionError::Cancelled),
        _ => Err(AuthSessionError::failed(
            message
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Sign-in failed"),
        )),
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::{interpret, AuthSessionError};
    use jni::objects::{JClass, JObject, JString, JValue};
    use jni::JNIEnv;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use tauri::Manager;

    static PENDING: Mutex<Option<mpsc::Sender<Result<Option<String>, AuthSessionError>>>> =
        Mutex::new(None);

    fn finish(url: Option<String>, code: Option<String>, message: Option<String>) {
        let result = interpret(url.as_deref(), code.as_deref(), message.as_deref());
        if let Ok(mut pending) = PENDING.lock() {
            if let Some(tx) = pending.take() {
                let _ = tx.send(result);
            }
        }
    }

    fn java_string(env: &mut JNIEnv, value: &JString) -> Option<String> {
        if value.as_raw().is_null() {
            return None;
        }
        env.get_string(value).ok().map(|text| text.into())
    }

    /// Called from `AuthSession.nativeOnResult`. Auth Tab delivers the
    /// redirect here. Custom Tabs delivers `OPENED` as soon as the tab is up.
    #[no_mangle]
    pub extern "system" fn Java_computer_ci_app_hub_AuthSession_nativeOnResult<'local>(
        mut env: JNIEnv<'local>,
        _class: jni::objects::JClass<'local>,
        url: JString<'local>,
        code: JString<'local>,
        message: JString<'local>,
    ) {
        finish(
            java_string(&mut env, &url),
            java_string(&mut env, &code),
            java_string(&mut env, &message),
        );
    }

    fn launch(env: &mut JNIEnv, activity: &JObject, url: &str, scheme: &str) -> Result<(), String> {
        let class_name = env
            .new_string("computer.ci.app.hub.AuthSession")
            .map_err(|err| err.to_string())?;
        let class_obj = env
            .call_method(
                activity,
                "getAppClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&*class_name)],
            )
            .and_then(|value| value.l())
            .map_err(|err| err.to_string())?;
        let class = JClass::from(class_obj);
        let url_j = env.new_string(url).map_err(|err| err.to_string())?;
        let scheme_j = env.new_string(scheme).map_err(|err| err.to_string())?;
        env.call_static_method(
            &class,
            "start",
            "(Landroid/app/Activity;Ljava/lang/String;Ljava/lang/String;)V",
            &[
                JValue::Object(activity),
                JValue::Object(&*url_j),
                JValue::Object(&*scheme_j),
            ],
        )
        .map_err(|err| err.to_string())?;
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
            return Err("Could not open the sign-in sheet.".to_string());
        }
        Ok(())
    }

    pub async fn start(
        app: &tauri::AppHandle,
        url: &str,
        callback_scheme: &str,
    ) -> Result<Option<String>, AuthSessionError> {
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = PENDING
                .lock()
                .map_err(|_| AuthSessionError::failed("Sign-in sheet is unavailable"))?;
            if let Some(previous) = pending.take() {
                let _ = previous.send(Err(AuthSessionError::Cancelled));
            }
            *pending = Some(tx);
        }

        let Some(webview) = app.webview_windows().into_values().next() else {
            if let Ok(mut pending) = PENDING.lock() {
                pending.take();
            }
            return Err(AuthSessionError::failed("Sign-in sheet is unavailable"));
        };

        let url = url.to_string();
        let scheme = callback_scheme.to_string();
        let queued = webview.with_webview(move |platform| {
            platform.jni_handle().exec(move |env, activity, _webview| {
                if let Err(message) = launch(env, activity, &url, &scheme) {
                    finish(None, Some("FAILED".to_string()), Some(message));
                }
            });
        });
        if let Err(err) = queued {
            if let Ok(mut pending) = PENDING.lock() {
                pending.take();
            }
            return Err(AuthSessionError::failed(err.to_string()));
        }

        tauri::async_runtime::spawn_blocking(move || {
            rx.recv().unwrap_or_else(|_| {
                Err(AuthSessionError::failed(
                    "Sign-in sheet closed unexpectedly",
                ))
            })
        })
        .await
        .map_err(|_| AuthSessionError::failed("Sign-in sheet closed unexpectedly"))?
    }
}

#[cfg(target_os = "ios")]
mod ios {
    use super::AuthSessionError;
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::sync::mpsc;
    use std::sync::Mutex;

    type AuthSessionCallback = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char);

    unsafe extern "C" {
        fn cihub_start_auth_session(
            url: *const c_char,
            callback_scheme: *const c_char,
            cb: AuthSessionCallback,
        );
    }

    static PENDING: Mutex<Option<mpsc::Sender<Result<String, AuthSessionError>>>> =
        Mutex::new(None);

    unsafe extern "C" fn on_auth_session_done(
        url: *const c_char,
        code: *const c_char,
        message: *const c_char,
    ) {
        let result = if !url.is_null() {
            Ok(CStr::from_ptr(url).to_string_lossy().into_owned())
        } else {
            let code = if code.is_null() {
                String::new()
            } else {
                CStr::from_ptr(code).to_string_lossy().into_owned()
            };
            let message = if message.is_null() {
                "Sign-in failed".to_string()
            } else {
                CStr::from_ptr(message).to_string_lossy().into_owned()
            };
            if code == "CANCELLED" {
                Err(AuthSessionError::Cancelled)
            } else {
                Err(AuthSessionError::Failed(message))
            }
        };

        if let Ok(mut pending) = PENDING.lock() {
            if let Some(tx) = pending.take() {
                let _ = tx.send(result);
            }
        }
    }

    pub async fn start(url: &str, callback_scheme: &str) -> Result<String, AuthSessionError> {
        let url_c =
            CString::new(url).map_err(|_| AuthSessionError::failed("Invalid sign-in URL"))?;
        let scheme_c = CString::new(callback_scheme)
            .map_err(|_| AuthSessionError::failed("Invalid callback scheme"))?;
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = PENDING
                .lock()
                .map_err(|_| AuthSessionError::failed("Sign-in sheet is unavailable"))?;
            *pending = Some(tx);
        }

        unsafe {
            cihub_start_auth_session(url_c.as_ptr(), scheme_c.as_ptr(), on_auth_session_done);
        }

        tauri::async_runtime::spawn_blocking(move || {
            rx.recv().unwrap_or_else(|_| {
                Err(AuthSessionError::failed(
                    "Sign-in sheet closed unexpectedly",
                ))
            })
        })
        .await
        .map_err(|_| AuthSessionError::failed("Sign-in sheet closed unexpectedly"))?
    }
}

#[cfg(test)]
mod tests {
    use super::{interpret, AuthSessionError};

    #[test]
    fn cancelled_serializes_the_code_the_js_hook_checks() {
        let json = serde_json::to_value(AuthSessionError::Cancelled).expect("serialize");
        assert_eq!(json["code"], "CANCELLED");
        assert_eq!(json["message"], "Sign-in cancelled");
    }

    #[test]
    fn missing_sheet_is_unavailable_not_a_cancel() {
        let json = serde_json::to_value(AuthSessionError::Unavailable).expect("serialize");
        assert_eq!(json["code"], "FAILED");
        assert_eq!(json["message"], "Could not open the sign-in sheet.");
    }

    #[test]
    fn auth_tab_callback_is_a_deep_link() {
        let url = interpret(Some("cihub://auth?token=abc"), None, None).expect("ok");
        assert_eq!(url.as_deref(), Some("cihub://auth?token=abc"));
    }

    #[test]
    fn custom_tabs_open_does_not_invent_a_callback() {
        // None means "tab is open, wait for the cihub:// intent". Feeding an
        // empty URL through handle_deep_link_url would be a second, fake login.
        assert_eq!(interpret(None, Some("OPENED"), None).expect("ok"), None);
    }

    #[test]
    fn dismissed_sheet_is_a_cancel_not_a_failure() {
        let err = interpret(None, Some("CANCELLED"), Some("Sign-in cancelled")).unwrap_err();
        assert_eq!(err, AuthSessionError::Cancelled);
    }
}
