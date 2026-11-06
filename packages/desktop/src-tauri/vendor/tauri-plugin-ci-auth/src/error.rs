// vendored-from: tauri-plugin-ci-auth@0.1.0 packages/tauri-plugin-ci-auth/src/error.rs
// Copyright (c) Lifescope Inc. All rights reserved.
// Private & Confidential — Property of Lifescope Inc. Do not distribute.

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
    /// The command is not available on iOS and Android.
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
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for AuthError {}
