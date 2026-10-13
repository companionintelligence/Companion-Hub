//! Tell the local Hub that this window is signed out and waiting for a sign-in.
//!
//! While the Hub holds that flag, a Companion Account sign-in started in a browser on this
//! machine's loopback address hands off to the desktop app. Only the desktop app may set it, so
//! the shell first asks the Hub for a challenge, then answers it with a proof that only something
//! able to read the Hub's `state/settings.json` can make: an HMAC of `desktop-waiting:<nonce>`
//! under the host-local key. The Hub takes each nonce once, so a proof can't be replayed, and no
//! clock is involved. The key itself is never sent, since this runs every minute against whatever
//! answers on the API port. The backend checks the same HMAC (`desktopSignInWaitProof` in
//! `packages/backend/src/modules/auth/portal-sso.ts`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

const NONCE_HEADER: &str = "x-ci-hub-desktop-nonce";
const PROOF_HEADER: &str = "x-ci-hub-desktop-proof";
const CHALLENGE_PATH: &str = "/api/auth/portal/desktop-waiting/challenge";
const WAITING_PATH: &str = "/api/auth/portal/desktop-waiting";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// HMAC-SHA256 (RFC 2104), from the `sha2` crate the app already has.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut block = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }

    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

/// The backend signs the same text.
fn sign_in_wait_proof(hub_local_key: &str, nonce: &str) -> String {
    let message = format!("desktop-waiting:{nonce}");
    crate::digest_hex::lower_hex(&hmac_sha256(hub_local_key.as_bytes(), message.as_bytes()))
}

/// The Hub hands out 64 hex digits. Anything that isn't hex of a sane length isn't signed or sent.
fn is_plausible_nonce(nonce: &str) -> bool {
    (16..=256).contains(&nonce.len()) && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The settings file this Hub reads. Compose mounts `${ROOT_FOLDER_HOST}/state` into the Hub, so
/// that is where the key is, including for a stack-dev stack whose data lives elsewhere.
pub(crate) fn hub_settings_path(data_dir: &Path, env_path: &Path) -> PathBuf {
    crate::hub_manager::host_data_dir_from_env_path(env_path)
        .unwrap_or_else(|| data_dir.to_path_buf())
        .join("state")
        .join("settings.json")
}

fn read_hub_local_key(settings_path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(settings_path).ok()?;
    let settings: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let key = settings.get("hubLocalKey")?.as_str()?.trim();
    (!key.is_empty()).then(|| key.to_string())
}

/// `Ok(true)` when the Hub took it. `Ok(false)` when it gave no usable challenge, refused the
/// proof, or there is no key to sign with yet (the Hub mints it on its first boot). `Err` when the
/// Hub could not be reached.
pub(crate) async fn announce(api_base_url: &str, settings_path: &Path) -> Result<bool, String> {
    let Some(key) = read_hub_local_key(settings_path) else {
        return Ok(false);
    };

    // Straight to loopback, never through a proxy from the environment.
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())?;

    let challenge = client
        .post(format!("{api_base_url}{CHALLENGE_PATH}"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !challenge.status().is_success() {
        return Ok(false);
    }
    let nonce = challenge
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|body| body.get("nonce")?.as_str().map(str::to_string))
        .filter(|nonce| is_plausible_nonce(nonce));
    let Some(nonce) = nonce else {
        return Ok(false);
    };

    let response = client
        .post(format!("{api_base_url}{WAITING_PATH}"))
        .header(NONCE_HEADER, &nonce)
        .header(PROOF_HEADER, sign_in_wait_proof(&key, &nonce))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    Ok(response.status().is_success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    const KEY: &str = "3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f";
    const NONCE: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    fn settings_with(contents: &str) -> tempfile::TempDir {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let state_dir = data_dir.path().join("state");
        std::fs::create_dir_all(&state_dir).expect("mkdir state");
        std::fs::write(state_dir.join("settings.json"), contents).expect("write settings");
        data_dir
    }

    /// Answers one request per connection with each of `responses` in turn, closing each
    /// connection, and hands back every request it received.
    fn scripted_hub(responses: Vec<String>) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base_url = format!("http://{}", listener.local_addr().expect("addr"));
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .expect("timeout");
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let _ = stream.write_all(response.as_bytes());
                let _ = sender.send(String::from_utf8_lossy(&request).into_owned());
            }
        });
        (base_url, receiver)
    }

    fn reply(status_line: &str, body: &str) -> String {
        format!(
            "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn challenge_reply(nonce: &str) -> String {
        reply("HTTP/1.1 200 OK", &format!(r#"{{"nonce":"{nonce}"}}"#))
    }

    fn header(request: &str, name: &str) -> Option<String> {
        let prefix = format!("{name}: ");
        request
            .lines()
            .find_map(|line| line.strip_prefix(prefix.as_str()))
            .map(str::to_string)
    }

    fn announce_with_key(base_url: &str) -> Result<bool, String> {
        let data_dir = settings_with(&format!(r#"{{"hubLocalKey":"{KEY}"}}"#));
        block_on(announce(
            base_url,
            &data_dir.path().join("state").join("settings.json"),
        ))
    }

    #[test]
    fn hmac_matches_rfc_4231_test_case_2() {
        assert_eq!(
            crate::digest_hex::lower_hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hmac_hashes_a_key_longer_than_one_block() {
        // RFC 4231 test case 6.
        assert_eq!(
            crate::digest_hex::lower_hex(&hmac_sha256(
                &[0xaa; 131],
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn proof_matches_the_backend() {
        // The same key, nonce and proof are asserted in the backend's portal-sso.test.ts.
        assert_eq!(
            sign_in_wait_proof(KEY, NONCE),
            "7a460e26999017e65eaa1c282c52201b9b79bb408fdbd2e0893b1af334e84bc2"
        );
    }

    #[test]
    fn proof_changes_with_the_nonce() {
        assert_ne!(
            sign_in_wait_proof(KEY, NONCE),
            sign_in_wait_proof(KEY, &"ab".repeat(32))
        );
    }

    #[test]
    fn signs_only_a_nonce_shaped_like_the_hubs() {
        assert!(is_plausible_nonce(NONCE));
        assert!(!is_plausible_nonce(""));
        assert!(!is_plausible_nonce("abc"));
        assert!(!is_plausible_nonce(&"a".repeat(257)));
        assert!(!is_plausible_nonce("0011223344556677\r\nx-injected: 1"));
    }

    #[test]
    fn reads_the_key_the_hub_minted() {
        let data_dir = settings_with(&format!(r#"{{"logLevel":"info","hubLocalKey":" {KEY} "}}"#));
        let path = data_dir.path().join("state").join("settings.json");
        assert_eq!(read_hub_local_key(&path).as_deref(), Some(KEY));
    }

    #[test]
    fn has_no_key_before_the_hub_mints_one() {
        for contents in [
            "{}",
            r#"{"hubLocalKey":""}"#,
            r#"{"hubLocalKey":7}"#,
            "[]",
            "not json",
        ] {
            let data_dir = settings_with(contents);
            let path = data_dir.path().join("state").join("settings.json");
            assert_eq!(read_hub_local_key(&path), None, "{contents}");
        }
        assert_eq!(
            read_hub_local_key(Path::new("/no/such/settings.json")),
            None
        );
    }

    #[test]
    fn finds_settings_under_the_folder_compose_mounts() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let stack_root = tempfile::tempdir().expect("tempdir");
        let env_path = data_dir.path().join(".env");

        std::fs::write(&env_path, "API_PORT=5002\n").expect("write env");
        assert_eq!(
            hub_settings_path(data_dir.path(), &env_path),
            data_dir.path().join("state").join("settings.json")
        );

        std::fs::write(
            &env_path,
            format!("ROOT_FOLDER_HOST={}\n", stack_root.path().display()),
        )
        .expect("write env");
        assert_eq!(
            hub_settings_path(data_dir.path(), &env_path),
            stack_root.path().join("state").join("settings.json")
        );
    }

    #[test]
    fn answers_the_hubs_challenge_and_never_sends_the_key() {
        let (base_url, received) = scripted_hub(vec![
            challenge_reply(NONCE),
            reply("HTTP/1.1 204 No Content", ""),
        ]);

        assert_eq!(announce_with_key(&base_url), Ok(true));

        let challenge = received
            .recv_timeout(Duration::from_secs(5))
            .expect("challenge");
        let answer = received
            .recv_timeout(Duration::from_secs(5))
            .expect("answer");
        assert!(
            challenge.starts_with("POST /api/auth/portal/desktop-waiting/challenge HTTP/1.1\r\n"),
            "{challenge}"
        );
        assert!(
            answer.starts_with("POST /api/auth/portal/desktop-waiting HTTP/1.1\r\n"),
            "{answer}"
        );
        assert_eq!(header(&answer, NONCE_HEADER).as_deref(), Some(NONCE));
        assert_eq!(
            header(&answer, PROOF_HEADER),
            Some(sign_in_wait_proof(KEY, NONCE))
        );
        assert!(!challenge.contains(KEY) && !answer.contains(KEY));
    }

    #[test]
    fn reports_a_refused_proof() {
        let (base_url, _received) = scripted_hub(vec![
            challenge_reply(NONCE),
            reply("HTTP/1.1 401 Unauthorized", ""),
        ]);

        assert_eq!(announce_with_key(&base_url), Ok(false));
    }

    #[test]
    fn stops_when_the_hub_gives_no_challenge() {
        let (base_url, received) =
            scripted_hub(vec![reply("HTTP/1.1 429 Too Many Requests", "{}")]);

        assert_eq!(announce_with_key(&base_url), Ok(false));
        assert!(received.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(received.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn does_not_sign_a_challenge_that_is_not_a_nonce() {
        let (base_url, received) = scripted_hub(vec![challenge_reply("not-a-nonce")]);

        assert_eq!(announce_with_key(&base_url), Ok(false));
        assert!(received.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(received.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn sends_nothing_without_a_key() {
        let data_dir = settings_with("{}");
        // Nothing listens here; a request would come back as Err.
        let accepted = block_on(announce(
            "http://127.0.0.1:9",
            &data_dir.path().join("state").join("settings.json"),
        ));

        assert_eq!(accepted, Ok(false));
    }
}
