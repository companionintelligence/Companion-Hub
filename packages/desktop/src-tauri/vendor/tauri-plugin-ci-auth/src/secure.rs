// vendored-from: tauri-plugin-ci-auth@0.1.0 packages/tauri-plugin-ci-auth/src/secure.rs
// Copyright (c) Lifescope Inc. All rights reserved.
// Private & Confidential — Property of Lifescope Inc. Do not distribute.

//! Secure storage behind a trait. Production uses the OS keychain through keyring. Tests use
//! MemoryBackend. Nothing here writes a secret to disk, and when the keychain is unavailable every
//! operation fails with secure_store_unavailable instead of falling back to anything weaker.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::error::AuthError;

/// Longest key a caller may use, in bytes.
pub const MAX_KEY_BYTES: usize = 256;

/// Longest value a caller may store, in UTF-16 code units. Windows Credential Manager refuses a
/// value whose UTF-16 form is over 2560 bytes, which is 1280 code units. This limit keeps every
/// platform clear of that refusal.
pub const MAX_VALUE_UNITS: usize = 1024;

/// A key/value store for secrets. Implementations must fail closed rather than fall back to a
/// weaker store.
pub trait SecureBackend: Send + Sync {
    /// Returns the value stored under `key`, or None when there is none.
    fn get(&self, key: &str) -> Result<Option<String>, AuthError>;
    /// Stores `value` under `key`, replacing any earlier value.
    fn set(&self, key: &str, value: &str) -> Result<(), AuthError>;
    /// Removes `key`. Removing a key that is absent succeeds.
    fn remove(&self, key: &str) -> Result<(), AuthError>;
}

/// Checks a caller-supplied key: 1 to MAX_KEY_BYTES bytes, with no control characters.
pub fn validate_key(key: &str) -> Result<(), AuthError> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES || key.chars().any(char::is_control) {
        return Err(AuthError::BadRequest);
    }
    Ok(())
}

/// Checks a caller-supplied value against MAX_VALUE_UNITS. It runs before any backend is asked.
pub fn validate_value(value: &str) -> Result<(), AuthError> {
    if value.encode_utf16().count() > MAX_VALUE_UNITS {
        return Err(AuthError::ValueTooLarge);
    }
    Ok(())
}

/// In-memory store for tests and examples. Nothing is persisted.
#[derive(Default)]
pub struct MemoryBackend {
    entries: Mutex<HashMap<String, String>>,
}

impl MemoryBackend {
    fn entries(&self) -> MutexGuard<'_, HashMap<String, String>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl SecureBackend for MemoryBackend {
    fn get(&self, key: &str) -> Result<Option<String>, AuthError> {
        Ok(self.entries().get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), AuthError> {
        self.entries().insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn remove(&self, key: &str) -> Result<(), AuthError> {
        self.entries().remove(key);
        Ok(())
    }
}

impl fmt::Debug for MemoryBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MemoryBackend").finish_non_exhaustive()
    }
}

/// A backend that reports the store as unavailable for every operation. It is the backend on iOS
/// and Android, where the commands are not supported, so nothing can be stored there by accident.
#[derive(Debug, Default)]
pub struct UnavailableBackend;

impl SecureBackend for UnavailableBackend {
    fn get(&self, _key: &str) -> Result<Option<String>, AuthError> {
        Err(AuthError::SecureStoreUnavailable)
    }

    fn set(&self, _key: &str, _value: &str) -> Result<(), AuthError> {
        Err(AuthError::SecureStoreUnavailable)
    }

    fn remove(&self, _key: &str) -> Result<(), AuthError> {
        Err(AuthError::SecureStoreUnavailable)
    }
}

/// The OS keychain through keyring. Entries live under `service`, with the caller's key as the
/// account name. A store that is missing or refuses the operation is secure_store_unavailable.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub struct KeyringBackend {
    service: String,
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
impl KeyringBackend {
    /// Creates a backend that stores entries under `service`.
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, AuthError> {
        keyring::Entry::new(&self.service, key).map_err(|_| AuthError::SecureStoreUnavailable)
    }

    /// Maps a failed keyring write. A store that refuses the length, as Windows does for a value over
    /// its blob limit, is value_too_large. Any other failure is secure_store_unavailable.
    fn set_error(err: &keyring::Error) -> AuthError {
        match err {
            keyring::Error::TooLong(..) => AuthError::ValueTooLarge,
            _ => AuthError::SecureStoreUnavailable,
        }
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
impl SecureBackend for KeyringBackend {
    fn get(&self, key: &str) -> Result<Option<String>, AuthError> {
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AuthError::SecureStoreUnavailable),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), AuthError> {
        validate_value(value)?;
        self.entry(key)?
            .set_password(value)
            .map_err(|err| Self::set_error(&err))
    }

    fn remove(&self, key: &str) -> Result<(), AuthError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AuthError::SecureStoreUnavailable),
        }
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
impl fmt::Debug for KeyringBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyringBackend")
            .field("service", &self.service)
            .finish()
    }
}

/// The backend the plugin uses unless the app supplies another one.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub(crate) fn default_backend(service: &str) -> Arc<dyn SecureBackend> {
    Arc::new(KeyringBackend::new(service))
}

/// On iOS and Android the keychain is not wired up yet, so the store reports unavailable.
#[cfg(any(target_os = "ios", target_os = "android"))]
pub(crate) fn default_backend(_service: &str) -> Arc<dyn SecureBackend> {
    Arc::new(UnavailableBackend)
}

#[cfg(all(test, not(any(target_os = "ios", target_os = "android"))))]
mod tests {
    use super::*;

    #[test]
    fn a_store_that_refuses_the_length_reports_value_too_large() {
        let refused = keyring::Error::TooLong("password encoded as UTF-16".to_owned(), 2560);
        assert_eq!(
            KeyringBackend::set_error(&refused),
            AuthError::ValueTooLarge
        );
    }

    #[test]
    fn every_other_store_failure_reports_secure_store_unavailable() {
        assert_eq!(
            KeyringBackend::set_error(&keyring::Error::NoDefaultStore),
            AuthError::SecureStoreUnavailable
        );
        assert_eq!(
            KeyringBackend::set_error(&keyring::Error::NoEntry),
            AuthError::SecureStoreUnavailable
        );
    }
}
