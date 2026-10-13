//! Tell the local Hub that this window is signed out and waiting for a sign-in.
//!
//! While the Hub holds that flag, a Companion Account sign-in started in a browser on this
//! machine's loopback address hands off to the desktop app. Only the desktop app may set it, so
//! the request carries a proof that only something able to read the Hub's `state/settings.json`
//! can make: an HMAC of a fixed label under the host-local key. The key itself is never sent,
//! since this runs every minute against whatever answers on the API port, and the proof is good
//! for nothing but this flag. The backend checks the same HMAC (`desktopSignInWaitProof` in
//! `packages/backend/src/modules/auth/portal-sso.ts`).

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

const PROOF_HEADER: &str = "x-ci-hub-desktop-proof";
/// What the proof signs. The backend signs the same text.
const PROOF_LABEL: &[u8] = b"ci-hub desktop sign-in wait";
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

fn sign_in_wait_proof(hub_local_key: &str) -> String {
    crate::digest_hex::lower_hex(&hmac_sha256(hub_local_key.as_bytes(), PROOF_LABEL))
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

/// `Ok(true)` when the Hub took it, `Ok(false)` when it refused or there is no key to sign with
/// yet (the Hub mints it on its first boot). `Err` when the Hub could not be reached.
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
    let response = client
        .post(format!("{api_base_url}{WAITING_PATH}"))
        .header(PROOF_HEADER, sign_in_wait_proof(&key))
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

    /// Answers one request with `status_line` and hands back what it received.
    fn one_shot_hub(status_line: &'static str) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base_url = format!("http://{}", listener.local_addr().expect("addr"));
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
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
            let _ =
                stream.write_all(format!("{status_line}\r\nContent-Length: 0\r\n\r\n").as_bytes());
            let _ = sender.send(String::from_utf8_lossy(&request).into_owned());
        });
        (base_url, receiver)
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
        // The same key and proof are asserted in the backend's portal-sso.test.ts.
        assert_eq!(
            sign_in_wait_proof(KEY),
            "508600150d97db091ee116f7e70b8fcf75a73221c045ff87f6b0f967f8e1acb6"
        );
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
    fn sends_the_proof_and_never_the_key() {
        let data_dir = settings_with(&format!(r#"{{"hubLocalKey":"{KEY}"}}"#));
        let (base_url, received) = one_shot_hub("HTTP/1.1 204 No Content");

        let accepted = block_on(announce(
            &base_url,
            &data_dir.path().join("state").join("settings.json"),
        ));

        assert_eq!(accepted, Ok(true));
        let request = received
            .recv_timeout(Duration::from_secs(5))
            .expect("request");
        assert!(
            request.starts_with("POST /api/auth/portal/desktop-waiting HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request.contains(&format!("{PROOF_HEADER}: {}\r\n", sign_in_wait_proof(KEY))),
            "{request}"
        );
        assert!(!request.contains(KEY), "{request}");
    }

    #[test]
    fn reports_a_refusal() {
        let data_dir = settings_with(&format!(r#"{{"hubLocalKey":"{KEY}"}}"#));
        let (base_url, _received) = one_shot_hub("HTTP/1.1 401 Unauthorized");

        let accepted = block_on(announce(
            &base_url,
            &data_dir.path().join("state").join("settings.json"),
        ));

        assert_eq!(accepted, Ok(false));
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
