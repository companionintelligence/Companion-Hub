// vendored-from: tauri-plugin-ci-auth@0.1.0 packages/tauri-plugin-ci-auth/src/error.rs
// Copyright (c) Lifescope Inc. Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md.

//! The error model. Every error serializes to a stable snake_case code and carries no message
//! text, so a callback URL, a key or a secret value can never end up inside an error.

use std::fmt;

use serde::Serialize;

/// Errors returned by the commands. The TypeScript driver switches on the codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthError {
    /// No callback arrived before the timeout. The sign-in is over.
    Timeout,
    /// cancel_loopback ended the pending sign-in.
    Cancelled,
    /// await_loopback ran without a sign-in started by begin_loopback.
    NoActiveSignIn,
    /// begin_loopback ran while a sign-in is active, or a second await_loopback ran.
    SignInAlreadyInProgress,
    /// An argument is out of range or malformed.
    BadRequest,
    /// A value is longer than 1024 UTF-16 code units, or the store refused it as too long.
    ValueTooLarge,
    /// The OS keychain is missing, locked or refused the operation. There is no file fallback.
    SecureStoreUnavailable,
    /// The loopback sign-in commands are not available on iOS and Android.
    UnsupportedPlatform,
    /// The OS refused a loopback socket, or a background task did not finish.
    InternalError,
}

impl AuthError {
    /// The stable code the TypeScript driver matches on.
    pub fn code(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::NoActiveSignIn => "no_active_sign_in",
            Self::SignInAlreadyInProgress => "sign_in_already_in_progress",
            Self::BadRequest => "bad_request",
            Self::ValueTooLarge => "value_too_large",
            Self::SecureStoreUnavailable => "secure_store_unavailable",
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::InternalError => "internal_error",
        }
    }

    /// Maps the code a native secure store rejects with. The native stores use the codes of `code()`.
    /// The Rust side checks keys and values first, so only `bad_request` and `value_too_large` are passed
    /// through. Any other code, or none, fails closed as `secure_store_unavailable`.
    pub fn from_native_code(code: &str) -> Self {
        match code {
            "bad_request" => Self::BadRequest,
            "value_too_large" => Self::ValueTooLarge,
            _ => Self::SecureStoreUnavailable,
        }
    }
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for AuthError {}
