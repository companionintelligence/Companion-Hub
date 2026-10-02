//! Lowercase hex for SHA-256 output.

use std::fmt::Write;

/// Lowercase hex of `bytes`, two digits per byte: what `format!("{:x}", hasher.finalize())` printed
/// before sha2 0.11, whose output type no longer formats as hex.
///
/// The text must not change. The installer check compares it with the release manifest's `sha256`,
/// and `.config-hash` stores it, so a different spelling would refuse every update or recreate the
/// stack on the next start.
pub(crate) fn lower_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::lower_hex;
    use sha2::{Digest, Sha256};

    #[test]
    fn spells_a_sha256_as_the_manifest_does() {
        // FIPS 180-2's example digest of "abc".
        assert_eq!(
            lower_hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn keeps_leading_zeros_and_lower_case() {
        assert_eq!(lower_hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
        assert_eq!(lower_hex(&[]), "");
    }
}
