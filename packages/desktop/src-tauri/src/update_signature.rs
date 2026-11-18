//! The signature on a desktop release's `manifest.json`.
//!
//! ⚠ THE DOWNLOAD SERVER IS NOT TRUSTED. `manifest.json` names each installer and its SHA-256, and it
//! comes from the same R2 bucket as the installers, written by the same upload token. A hash from
//! there only proves the file is the one the bucket meant; whoever can write to the bucket can swap
//! both. So the manifest is signed (Ed25519) in the release workflow by a job that has the signing key
//! and no R2 token, and this binary carries the public keys it accepts. An unsigned manifest, or one
//! no listed key signed, is refused: no installer is downloaded from it.
//!
//! The signature is over [`SIGNED_MESSAGE_PREFIX`] followed by the manifest's exact bytes, and sits
//! beside it as `manifest.json.sig`: 128 hex characters. Production and dev releases have keys of
//! their own (each a secret on its GitHub Environment), so a dev key cannot sign a production update.
//!
//! Rotating a key: add the new public key here, release, and only then sign with the new key. Every
//! install that took the release with both keys accepts either. Remove the old key a release later.
//! `.github/scripts/sign-desktop-manifest.mjs` refuses to sign with a key this file does not list for
//! that environment, so a release cannot ship a manifest its own binaries would refuse.

use ring::signature::{UnparsedPublicKey, ED25519};

/// Prefixed to the manifest before signing, so a signature made for anything else is never one here.
pub(crate) const SIGNED_MESSAGE_PREFIX: &[u8] = b"companion-hub desktop update manifest v1\n";

/// Ed25519 public keys (32 bytes, hex) that sign production releases (`dl.ci.computer`).
pub(crate) const PRODUCTION_UPDATE_KEYS: &[&str] = &[];

/// Ed25519 public keys (32 bytes, hex) that sign dev releases (`dl-dev.ci.computer`).
pub(crate) const DEV_UPDATE_KEYS: &[&str] = &[];

/// Debug builds only: a key to accept as well, for a local update server (`CI_HUB_UPDATE_BASE_URL`).
#[cfg(debug_assertions)]
const UPDATE_PUBLIC_KEY_ENV: &str = "CI_HUB_UPDATE_PUBLIC_KEY";

/// The keys this binary accepts: production's in a production build, dev's otherwise.
pub(crate) fn trusted_update_keys() -> Vec<[u8; 32]> {
    let listed = match option_env!("CI_HUB_ENVIRONMENT").map(str::trim) {
        Some("production") => PRODUCTION_UPDATE_KEYS,
        _ => DEV_UPDATE_KEYS,
    };
    #[allow(unused_mut)]
    let mut keys: Vec<[u8; 32]> = listed.iter().filter_map(|key| decode_key(key)).collect();
    #[cfg(test)]
    keys.push(test_key::public());
    #[cfg(debug_assertions)]
    if let Some(key) = std::env::var(UPDATE_PUBLIC_KEY_ENV)
        .ok()
        .and_then(|key| decode_key(&key))
    {
        keys.push(key);
    }
    keys
}

/// Whether one of `keys` signed `manifest`. `signature_file` is the text of `manifest.json.sig`.
pub(crate) fn verify_manifest_signature(
    manifest: &[u8],
    signature_file: &str,
    keys: &[[u8; 32]],
) -> Result<(), String> {
    if keys.is_empty() {
        return Err(
            "This build has no update signing key, so it installs no update. Download the new version from ci.computer."
                .to_string(),
        );
    }
    let signature = decode_hex(signature_file.trim())
        .filter(|bytes| bytes.len() == 64)
        .ok_or_else(|| {
            "The release manifest's signature is malformed — refusing to update".to_string()
        })?;
    let mut message = Vec::with_capacity(SIGNED_MESSAGE_PREFIX.len() + manifest.len());
    message.extend_from_slice(SIGNED_MESSAGE_PREFIX);
    message.extend_from_slice(manifest);
    if keys.iter().any(|key| {
        UnparsedPublicKey::new(&ED25519, key)
            .verify(&message, &signature)
            .is_ok()
    }) {
        return Ok(());
    }
    Err(
        "The release manifest is not signed by Companion Intelligence — refusing to update"
            .to_string(),
    )
}

/// A fixed key that test builds alone accept, for the updater's local test servers to sign with.
#[cfg(test)]
pub(crate) mod test_key {
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn pair() -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]).expect("test seed")
    }

    pub(crate) fn public() -> [u8; 32] {
        pair().public_key().as_ref().try_into().expect("32 bytes")
    }

    /// `manifest.json.sig` for `manifest`.
    pub(crate) fn sign(manifest: &[u8]) -> String {
        let mut message = super::SIGNED_MESSAGE_PREFIX.to_vec();
        message.extend_from_slice(manifest);
        pair()
            .sign(&message)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

fn decode_key(hex: &str) -> Option<[u8; 32]> {
    decode_hex(hex.trim())?.try_into().ok()
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let digit = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    };
    text.as_bytes()
        .chunks(2)
        .map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn key_pair() -> Ed25519KeyPair {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).expect("generate");
        Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse")
    }

    fn public(pair: &Ed25519KeyPair) -> [u8; 32] {
        pair.public_key().as_ref().try_into().expect("32 bytes")
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn sign(pair: &Ed25519KeyPair, manifest: &[u8]) -> String {
        let mut message = SIGNED_MESSAGE_PREFIX.to_vec();
        message.extend_from_slice(manifest);
        format!("{}\n", hex(pair.sign(&message).as_ref()))
    }

    const MANIFEST: &[u8] = br#"{"version":"0.3.14","platforms":{}}"#;

    #[test]
    fn accepts_a_manifest_a_listed_key_signed() {
        let pair = key_pair();
        let other = key_pair();
        let signature = sign(&pair, MANIFEST);
        assert!(verify_manifest_signature(MANIFEST, &signature, &[public(&pair)]).is_ok());
        // Any listed key will do, as during a rotation.
        assert!(
            verify_manifest_signature(MANIFEST, &signature, &[public(&other), public(&pair)])
                .is_ok()
        );
        assert!(
            verify_manifest_signature(MANIFEST, &signature.to_uppercase(), &[public(&pair)])
                .is_ok()
        );
    }

    #[test]
    fn refuses_another_key_a_changed_manifest_and_a_bare_signature() {
        let pair = key_pair();
        let signature = sign(&pair, MANIFEST);

        assert!(verify_manifest_signature(MANIFEST, &signature, &[public(&key_pair())]).is_err());
        let changed = br#"{"version":"0.3.15","platforms":{}}"#;
        assert!(verify_manifest_signature(changed, &signature, &[public(&pair)]).is_err());
        // A signature over the manifest alone, without the prefix, is not one.
        let bare = hex(pair.sign(MANIFEST).as_ref());
        assert!(verify_manifest_signature(MANIFEST, &bare, &[public(&pair)]).is_err());
    }

    #[test]
    fn refuses_a_malformed_or_missing_signature_and_a_build_with_no_key() {
        let pair = key_pair();
        for bad in [
            "",
            "zz",
            &"ab".repeat(63),
            &"ab".repeat(65),
            "<html>404</html>",
        ] {
            assert!(
                verify_manifest_signature(MANIFEST, bad, &[public(&pair)]).is_err(),
                "{bad:?}"
            );
        }
        let error = verify_manifest_signature(MANIFEST, &sign(&pair, MANIFEST), &[]).unwrap_err();
        assert!(error.contains("no update signing key"));
    }

    /// The same key, manifest and signature as `scripts/__tests__/desktop-update-manifest.test.ts`,
    /// where `sign-desktop-manifest.mjs` makes it: the release signs exactly what this checks.
    #[test]
    fn matches_the_release_workflow_signer() {
        const MANIFEST: &[u8] = br#"{"version":"0.3.14","platforms":{}}"#;
        const PUBLIC: &str = "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c";
        const SIGNATURE: &str = "14247a3a3e967fd14ed154b28a750a59f48f2aa80332a87b17c3751298b220e05038e6c87e358473d94017bc28b088dda8bb1cfc5dc8147af1ca5bc7cf31e60c";
        assert_eq!(hex(&test_key::public()), PUBLIC);
        assert_eq!(test_key::sign(MANIFEST), SIGNATURE);
        let key = decode_key(PUBLIC).expect("key");
        assert!(verify_manifest_signature(MANIFEST, &format!("{SIGNATURE}\n"), &[key]).is_ok());
    }

    #[test]
    fn every_listed_key_is_a_32_byte_hex_key() {
        for key in PRODUCTION_UPDATE_KEYS.iter().chain(DEV_UPDATE_KEYS) {
            assert!(decode_key(key).is_some(), "{key}");
        }
    }
}
