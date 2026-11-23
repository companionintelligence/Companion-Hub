// vendored-from: tauri-plugin-ci-auth@0.1.0 packages/tauri-plugin-ci-auth/src/loopback.rs
// Copyright (c) Lifescope Inc. All rights reserved.
// Private & Confidential — Property of Lifescope Inc. Do not distribute.

//! Loopback redirect receiver (RFC 8252, section 7.3). It binds 127.0.0.1 on an ephemeral port,
//! accepts one GET to /callback and returns that URL. Any other request gets an error response and
//! the wait goes on. Reads are bounded in size and time. Nothing from a request is logged, and
//! nothing from a request is placed in an error.

use std::fmt;
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::AuthError;

/// The only path that completes a sign-in.
pub const CALLBACK_PATH: &str = "/callback";
/// Largest request head read, including the blank line that ends it.
pub const MAX_HEAD_BYTES: usize = 8 * 1024;
/// Timeout used when await_loopback is called without one.
pub const DEFAULT_TIMEOUT_MS: u64 = 300_000;
/// Upper bound on any await_loopback timeout.
pub const MAX_TIMEOUT_MS: u64 = 600_000;

/// Longest time one connection may take to send its request head.
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Longest app name the success page shows, in characters. A longer name is cut there.
const MAX_APP_NAME_CHARS: usize = 64;

/// Sent with every response. The success page loads nothing (no script, stylesheet, font or image)
/// and its styles are inline, so everything else can be refused.
const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; style-src 'unsafe-inline'; \
                                       base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// The success page in three parts, joined around the escaped title and the line naming the app. The
// palette is phthalo-mist from @companionintelligence/tokens: dark by default, light when the system
// asks for it.
const SUCCESS_PAGE_HEAD: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>"#;

const SUCCESS_PAGE_BODY: &str = r#"</title>
<style>
:root {
  color-scheme: dark light;
  --bg: #041620;
  --card: #0c323c;
  --fg: #e8f2f4;
  --muted: #a3babf;
  --border: #154550;
  --accent: #c5e8dc;
  --accent-soft: rgba(197, 232, 220, 0.12);
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f3faf7;
    --card: #ffffff;
    --fg: #0a222e;
    --muted: #3a524b;
    --border: #dfece6;
    --accent: #0a6358;
    --accent-soft: rgba(10, 99, 88, 0.1);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.5 Manrope, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.card {
  width: 100%;
  max-width: 420px;
  padding: 36px 32px 32px;
  text-align: center;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
}
.badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin: 0 auto 20px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
}
.badge svg { width: 28px; height: 28px; display: block; }
h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
p { margin: 0; color: var(--muted); font-size: 14px; }
p + p { margin-top: 4px; }
</style>
</head>
<body>
<main class="card">
<div class="badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
<h1>You&rsquo;re signed in</h1>
<p>"#;

const SUCCESS_PAGE_TAIL: &str = r#"</p>
<p>You can close this tab.</p>
</main>
</body>
</html>
"#;

/// The page the browser shows once the callback has arrived. `app_name` is the app's product name.
/// Without a usable one the page says "the app" instead.
pub fn success_page(app_name: Option<&str>) -> String {
    let name = app_name
        .and_then(display_name)
        .map(|name| escape_html(&name));
    let (title, back_to) = match &name {
        Some(name) => (format!("Signed in to {name}"), name.as_str()),
        None => ("Signed in".to_owned(), "the app"),
    };
    let mut page = String::with_capacity(4096);
    page.push_str(SUCCESS_PAGE_HEAD);
    page.push_str(&title);
    page.push_str(SUCCESS_PAGE_BODY);
    page.push_str("Return to ");
    page.push_str(back_to);
    page.push_str(" to continue.");
    page.push_str(SUCCESS_PAGE_TAIL);
    page
}

/// The name as the page shows it: trimmed, without control characters, at most MAX_APP_NAME_CHARS.
/// None when nothing is left.
fn display_name(raw: &str) -> Option<String> {
    let name: String = raw
        .trim()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_APP_NAME_CHARS)
        .collect();
    let name = name.trim_end();
    (!name.is_empty()).then(|| name.to_owned())
}

/// Escapes text for an HTML element body.
fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// What a request line asks for.
#[derive(PartialEq, Eq)]
pub enum Route {
    /// GET /callback. Carries the request target (path and query) exactly as the browser sent it.
    Callback(String),
    /// A GET for any other path.
    NotFound,
    /// Any method other than GET.
    MethodNotAllowed,
}

/// Prints the variant name only. A Callback holds the authorization code and state, so its target
/// must never reach a log or a panic message.
impl fmt::Debug for Route {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Callback(_) => "Callback",
            Self::NotFound => "NotFound",
            Self::MethodNotAllowed => "MethodNotAllowed",
        })
    }
}

/// Why a request head could not be read.
enum HeadError {
    /// The head did not end within MAX_HEAD_BYTES.
    TooLarge,
    /// The peer closed, reset or went quiet before the head ended, or the deadline passed.
    Closed,
}

/// Binds the loopback listener. Never 0.0.0.0, never localhost, never [::1].
pub fn bind() -> Result<TcpListener, AuthError> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| AuthError::InternalError)
}

/// The port the listener is bound to.
pub fn local_port(listener: &TcpListener) -> Result<u16, AuthError> {
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|_| AuthError::InternalError)
}

/// The redirect URI to register with the identity provider.
pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

/// Maps the optional timeoutMs argument to a Duration. A missing value means the default, a value
/// above the cap is capped, and zero is refused because it could never succeed.
pub fn resolve_timeout(timeout_ms: Option<u64>) -> Result<Duration, AuthError> {
    match timeout_ms {
        None => Ok(Duration::from_millis(DEFAULT_TIMEOUT_MS)),
        Some(0) => Err(AuthError::BadRequest),
        Some(ms) => Ok(Duration::from_millis(ms.min(MAX_TIMEOUT_MS))),
    }
}

/// Parses the request line at the start of `head`. A line that is not HTTP/1.x with three parts is
/// BadRequest. A method other than GET is MethodNotAllowed. A GET for a path other than /callback is
/// NotFound.
pub fn parse_request_line(head: &[u8]) -> Result<Route, AuthError> {
    let line_end = head.iter().position(|&b| b == b'\n').unwrap_or(head.len());
    let line = head[..line_end]
        .strip_suffix(b"\r")
        .unwrap_or(&head[..line_end]);
    if line.is_empty() || !line.iter().all(|&b| b == b' ' || b.is_ascii_graphic()) {
        return Err(AuthError::BadRequest);
    }
    // Only printable ASCII gets this far, so the conversion cannot fail.
    let text = std::str::from_utf8(line).map_err(|_| AuthError::BadRequest)?;
    let mut parts = text.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(AuthError::BadRequest);
    };
    if method.is_empty() || target.is_empty() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err(AuthError::BadRequest);
    }
    if method != "GET" {
        return Ok(Route::MethodNotAllowed);
    }
    let path = target.split_once('?').map_or(target, |(path, _query)| path);
    if path == CALLBACK_PATH {
        Ok(Route::Callback(target.to_owned()))
    } else {
        Ok(Route::NotFound)
    }
}

/// Waits for the callback that completes the sign-in and returns its full URL. The callback gets
/// `success_page` as its response. The wait ends with Timeout when `timeout` passes, or with Cancelled
/// when `cancelled` is set. The caller owns the listener and drops it afterwards.
pub fn wait_for_callback(
    listener: &TcpListener,
    port: u16,
    cancelled: &AtomicBool,
    timeout: Duration,
    success_page: &str,
) -> Result<String, AuthError> {
    listener
        .set_nonblocking(true)
        .map_err(|_| AuthError::InternalError)?;
    let deadline = Instant::now() + timeout;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(AuthError::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(AuthError::Timeout);
        }
        match listener.accept() {
            Ok((mut stream, _peer)) => {
                if let Some(target) =
                    serve_connection(&mut stream, deadline, cancelled, success_page)
                {
                    return Ok(format!("http://127.0.0.1:{port}{target}"));
                }
            }
            // Nothing is queued yet (WouldBlock), or the accept failed for a transient reason.
            Err(_) => thread::sleep(POLL_INTERVAL),
        }
    }
}

/// Handles one connection. Returns the request target when the request was the callback, which
/// ends the wait. Every other outcome returns None and the wait goes on.
fn serve_connection(
    stream: &mut TcpStream,
    deadline: Instant,
    cancelled: &AtomicBool,
    success_page: &str,
) -> Option<String> {
    // On macOS an accepted socket inherits O_NONBLOCK from the listener, and the reads below need
    // blocking mode with timeouts.
    if stream.set_nonblocking(false).is_err() {
        return None;
    }
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let head_deadline = deadline.min(Instant::now() + HEAD_READ_TIMEOUT);
    let head = match read_head(stream, head_deadline) {
        Ok(head) => head,
        Err(HeadError::TooLarge) => {
            respond(stream, "431 Request Header Fields Too Large", "", "");
            return None;
        }
        Err(HeadError::Closed) => return None,
    };
    match parse_request_line(&head) {
        Ok(Route::Callback(target)) => {
            if cancelled.load(Ordering::SeqCst) {
                return None;
            }
            respond(stream, "200 OK", "", success_page);
            Some(target)
        }
        Ok(Route::NotFound) => {
            respond(stream, "404 Not Found", "", "");
            None
        }
        Ok(Route::MethodNotAllowed) => {
            respond(stream, "405 Method Not Allowed", "Allow: GET\r\n", "");
            None
        }
        Err(_) => {
            respond(stream, "400 Bad Request", "", "");
            None
        }
    }
}

/// Reads the request head up to and including its blank line. It never buffers more than
/// MAX_HEAD_BYTES, and it stops at `deadline` even if the peer keeps trickling bytes in.
fn read_head(stream: &mut TcpStream, deadline: Instant) -> Result<Vec<u8>, HeadError> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    loop {
        if let Some(end) = find_head_end(&head) {
            head.truncate(end);
            return Ok(head);
        }
        if head.len() >= MAX_HEAD_BYTES {
            return Err(HeadError::TooLarge);
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or(HeadError::Closed)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| HeadError::Closed)?;
        let room = (MAX_HEAD_BYTES - head.len()).min(chunk.len());
        match stream.read(&mut chunk[..room]) {
            Ok(0) => return Err(HeadError::Closed),
            Ok(read) => head.extend_from_slice(&chunk[..read]),
            Err(err) if err.kind() == ErrorKind::Interrupted => {}
            Err(_) => return Err(HeadError::Closed),
        }
    }
}

/// Index just past the blank line that ends a request head. Both CRLF and bare LF line endings are
/// accepted.
pub fn find_head_end(buf: &[u8]) -> Option<usize> {
    let mut line_start = 0;
    for (index, &byte) in buf.iter().enumerate() {
        if byte == b'\n' {
            let line = &buf[line_start..index];
            if line.is_empty() || line == b"\r" {
                return Some(index + 1);
            }
            line_start = index + 1;
        }
    }
    None
}

/// Writes a complete HTTP/1.1 response and closes the connection. Write errors are ignored, because
/// the browser has gone and there is nothing else to do with the connection.
fn respond(stream: &mut TcpStream, status: &str, extra_headers: &str, body: &str) {
    let len = body.len();
    let response = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Cache-Control: no-store\r\n\
         Content-Security-Policy: {CONTENT_SECURITY_POLICY}\r\n\
         Referrer-Policy: no-referrer\r\n\
         X-Content-Type-Options: nosniff\r\n\
         {extra_headers}\
         Connection: close\r\n\
         \r\n\
         {body}"
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Write);
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{IpAddr, TcpStream};
    use std::sync::atomic::AtomicBool;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    /// The page a test's listener answers the callback with.
    const PAGE: &str = "<p>test page</p>";

    /// Sends raw bytes to the listener and returns everything the server wrote before it closed.
    fn send_raw(port: u16, request: &[u8]) -> String {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).expect("connect");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("read timeout");
        stream.write_all(request).expect("write request");
        let mut response = Vec::new();
        let _ = stream.read_to_end(&mut response);
        String::from_utf8_lossy(&response).into_owned()
    }

    /// A connected pair of sockets on loopback, as (client, server).
    fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let client = TcpStream::connect(listener.local_addr().expect("addr")).expect("connect");
        let (server, _) = listener.accept().expect("accept");
        (client, server)
    }

    #[test]
    fn parses_a_callback_request_line() {
        let head = b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(
            parse_request_line(head),
            Ok(Route::Callback("/callback?code=abc&state=xyz".to_owned()))
        );
    }

    #[test]
    fn route_debug_prints_only_the_variant_name() {
        let route = Route::Callback("/callback?code=TOPSECRET&state=xyz".to_owned());
        let shown = format!("{route:?}");
        assert_eq!(shown, "Callback");
        assert!(!shown.contains("TOPSECRET"));
        assert_eq!(format!("{:?}", Route::NotFound), "NotFound");
    }

    #[test]
    fn accepts_the_bare_callback_path_over_http_1_0() {
        assert_eq!(
            parse_request_line(b"GET /callback HTTP/1.0\r\n\r\n"),
            Ok(Route::Callback("/callback".to_owned()))
        );
    }

    #[test]
    fn refuses_an_invalid_method_with_405() {
        assert_eq!(
            parse_request_line(b"POST /callback?code=abc HTTP/1.1\r\n\r\n"),
            Ok(Route::MethodNotAllowed)
        );
    }

    #[test]
    fn treats_a_wrong_path_as_not_found() {
        assert_eq!(
            parse_request_line(b"GET /callbackx?code=abc HTTP/1.1\r\n\r\n"),
            Ok(Route::NotFound)
        );
        assert_eq!(
            parse_request_line(b"GET /other HTTP/1.1\r\n\r\n"),
            Ok(Route::NotFound)
        );
    }

    #[test]
    fn rejects_malformed_request_lines() {
        let cases: [&[u8]; 6] = [
            b"",
            b"GET\r\n\r\n",
            b"GET /callback\r\n\r\n",
            b"GET /callback HTTP/2\r\n\r\n",
            b"GET  /callback HTTP/1.1\r\n\r\n",
            b"GET /call\x00back HTTP/1.1\r\n\r\n",
        ];
        for case in cases {
            assert_eq!(parse_request_line(case), Err(AuthError::BadRequest));
        }
    }

    #[test]
    fn finds_the_end_of_a_head_with_crlf_or_bare_lf() {
        let crlf = b"GET / HTTP/1.1\r\nHost: x\r\n\r\nBODY";
        let end = find_head_end(crlf).expect("crlf head ends");
        assert_eq!(&crlf[..end], b"GET / HTTP/1.1\r\nHost: x\r\n\r\n");

        let lf = b"GET / HTTP/1.1\nHost: x\n\n";
        assert_eq!(find_head_end(lf), Some(lf.len()));

        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\nHost: x\r\n"), None);
    }

    #[test]
    fn redirect_uri_is_the_loopback_callback() {
        assert_eq!(redirect_uri(54321), "http://127.0.0.1:54321/callback");
    }

    #[test]
    fn timeout_defaults_caps_and_refuses_zero() {
        assert_eq!(
            resolve_timeout(None),
            Ok(Duration::from_millis(DEFAULT_TIMEOUT_MS))
        );
        assert_eq!(
            resolve_timeout(Some(1_234)),
            Ok(Duration::from_millis(1_234))
        );
        assert_eq!(
            resolve_timeout(Some(u64::MAX)),
            Ok(Duration::from_millis(MAX_TIMEOUT_MS))
        );
        assert_eq!(resolve_timeout(Some(0)), Err(AuthError::BadRequest));
    }

    #[test]
    fn binds_only_to_the_ipv4_loopback_address() {
        let listener = bind().expect("bind");
        let addr = listener.local_addr().expect("local addr");
        assert_eq!(addr.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_ne!(addr.port(), 0);
    }

    #[test]
    fn wrong_path_gets_404_and_the_wait_continues() {
        let listener = bind().expect("bind");
        let port = local_port(&listener).expect("port");
        let cancelled = AtomicBool::new(false);
        let client = thread::spawn(move || {
            let not_found = send_raw(
                port,
                b"GET /elsewhere?code=nope HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            );
            let callback = send_raw(
                port,
                b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            );
            (not_found, callback)
        });
        let url = wait_for_callback(&listener, port, &cancelled, Duration::from_secs(10), PAGE)
            .expect("callback");
        let (not_found, callback) = client.join().expect("client thread");
        assert!(not_found.starts_with("HTTP/1.1 404 "), "{not_found}");
        assert!(callback.starts_with("HTTP/1.1 200 OK"), "{callback}");
        assert!(callback.contains(PAGE), "{callback}");
        assert!(
            callback.contains(&format!(
                "Content-Security-Policy: {CONTENT_SECURITY_POLICY}\r\n"
            )),
            "{callback}"
        );
        assert_eq!(
            url,
            format!("http://127.0.0.1:{port}/callback?code=abc&state=xyz")
        );
    }

    #[test]
    fn non_get_gets_405_with_an_allow_header_and_the_wait_continues() {
        let listener = bind().expect("bind");
        let port = local_port(&listener).expect("port");
        let cancelled = AtomicBool::new(false);
        let client = thread::spawn(move || {
            let refused = send_raw(port, b"POST /callback?code=abc HTTP/1.1\r\n\r\n");
            let _ = send_raw(port, b"GET /callback?code=ok&state=s HTTP/1.1\r\n\r\n");
            refused
        });
        let url = wait_for_callback(&listener, port, &cancelled, Duration::from_secs(10), PAGE)
            .expect("callback");
        let refused = client.join().expect("client thread");
        assert!(refused.starts_with("HTTP/1.1 405 "), "{refused}");
        assert!(refused.contains("Allow: GET"));
        assert_eq!(
            url,
            format!("http://127.0.0.1:{port}/callback?code=ok&state=s")
        );
    }

    #[test]
    fn read_head_accepts_a_head_of_exactly_8_kib() {
        let suffix = b"\r\n\r\n";
        let mut head = b"GET /callback?pad=".to_vec();
        head.resize(MAX_HEAD_BYTES - suffix.len(), b'a');
        head.extend_from_slice(suffix);
        assert_eq!(head.len(), MAX_HEAD_BYTES);

        let (mut client, mut server) = socket_pair();
        let sent = head.clone();
        let writer = thread::spawn(move || {
            client.write_all(&sent).expect("write");
            client
        });
        let got = read_head(&mut server, Instant::now() + Duration::from_secs(5)).ok();
        assert_eq!(got, Some(head));
        let _client = writer.join().expect("writer thread");
    }

    #[test]
    fn read_head_caps_an_oversized_head_at_8_kib() {
        let (mut client, mut server) = socket_pair();
        let writer = thread::spawn(move || {
            client
                .write_all(&vec![b'a'; MAX_HEAD_BYTES])
                .expect("write");
            client
        });
        let outcome = read_head(&mut server, Instant::now() + Duration::from_secs(5));
        assert!(matches!(outcome, Err(HeadError::TooLarge)));
        let _client = writer.join().expect("writer thread");
    }

    #[test]
    fn oversized_head_gets_431_and_the_wait_continues() {
        let listener = bind().expect("bind");
        let port = local_port(&listener).expect("port");
        let cancelled = AtomicBool::new(false);
        let client = thread::spawn(move || {
            let mut flood = b"GET /callback?pad=".to_vec();
            flood.resize(MAX_HEAD_BYTES, b'a');
            let refused = send_raw(port, &flood);
            let _ = send_raw(port, b"GET /callback?code=ok&state=s HTTP/1.1\r\n\r\n");
            refused
        });
        let url = wait_for_callback(&listener, port, &cancelled, Duration::from_secs(10), PAGE)
            .expect("callback");
        let refused = client.join().expect("client thread");
        assert!(refused.starts_with("HTTP/1.1 431 "), "{refused}");
        assert_eq!(
            url,
            format!("http://127.0.0.1:{port}/callback?code=ok&state=s")
        );
    }

    #[test]
    fn times_out_when_no_callback_arrives() {
        let listener = bind().expect("bind");
        let port = local_port(&listener).expect("port");
        let cancelled = AtomicBool::new(false);
        let started = Instant::now();
        let result =
            wait_for_callback(&listener, port, &cancelled, Duration::from_millis(50), PAGE);
        assert_eq!(result, Err(AuthError::Timeout));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_set_cancel_flag_ends_the_wait_with_cancelled() {
        let listener = bind().expect("bind");
        let port = local_port(&listener).expect("port");
        let cancelled = AtomicBool::new(true);
        let result = wait_for_callback(&listener, port, &cancelled, Duration::from_secs(10), PAGE);
        assert_eq!(result, Err(AuthError::Cancelled));
    }

    #[test]
    fn success_page_names_the_app_and_says_the_tab_can_close() {
        let page = success_page(Some("Companion Hub"));
        assert!(page.starts_with("<!doctype html>"));
        assert!(page.contains("<title>Signed in to Companion Hub</title>"));
        assert!(page.contains("<p>Return to Companion Hub to continue.</p>"));
        assert!(page.contains("<p>You can close this tab.</p>"));
        assert!(page.contains("You&rsquo;re signed in"));
    }

    #[test]
    fn success_page_without_a_name_says_the_app() {
        for missing in [None, Some(""), Some("   "), Some("\u{7}\n")] {
            let page = success_page(missing);
            assert!(page.contains("<title>Signed in</title>"), "{missing:?}");
            assert!(
                page.contains("<p>Return to the app to continue.</p>"),
                "{missing:?}"
            );
        }
    }

    #[test]
    fn success_page_escapes_the_app_name() {
        let page = success_page(Some(r#"<script>alert("x")</script> & 'co'"#));
        assert!(!page.contains("<script"));
        assert!(page.contains(
            "Return to &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;co&#39; to continue."
        ));
    }

    #[test]
    fn success_page_trims_and_cuts_a_long_name() {
        let long = format!("  {}  ", "n".repeat(MAX_APP_NAME_CHARS + 10));
        let page = success_page(Some(&long));
        let shown = "n".repeat(MAX_APP_NAME_CHARS);
        assert!(page.contains(&format!("Return to {shown} to continue.")));
        assert!(!page.contains(&format!("{shown}n")));
    }

    #[test]
    fn success_page_loads_nothing_from_anywhere() {
        let page = success_page(Some("Companion Hub"));
        for needle in ["<script", "<link", "src=", "href=", "url(", "@import"] {
            assert!(
                !page.contains(needle),
                "the page should not contain {needle}"
            );
        }
    }

    #[test]
    fn error_responses_carry_the_content_security_policy() {
        let listener = bind().expect("bind");
        let port = local_port(&listener).expect("port");
        let cancelled = AtomicBool::new(false);
        let client = thread::spawn(move || {
            let not_found = send_raw(port, b"GET /elsewhere HTTP/1.1\r\n\r\n");
            let _ = send_raw(port, b"GET /callback?code=ok&state=s HTTP/1.1\r\n\r\n");
            not_found
        });
        wait_for_callback(&listener, port, &cancelled, Duration::from_secs(10), PAGE)
            .expect("callback");
        let not_found = client.join().expect("client thread");
        assert!(not_found.starts_with("HTTP/1.1 404 "), "{not_found}");
        assert!(not_found.contains("Content-Security-Policy: default-src 'none';"));
    }
}
