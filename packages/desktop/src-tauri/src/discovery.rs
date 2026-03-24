use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::time::Duration;
use tokio::sync::mpsc;

const SERVICE_TYPE: &str = "_ci-hub._tcp.local.";

/// Scan the local network for CI OS Hub instances via mDNS.
/// Returns a list of URLs like "http://192.168.1.42:5002".
pub async fn find_hubs() -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let mdns = ServiceDaemon::new()?;
    let receiver = mdns.browse(SERVICE_TYPE)?;

    let mut hubs: Vec<String> = Vec::new();

    // A single long-lived blocking task forwards mDNS events over an async channel.
    // This avoids spawning a new blocking task on every iteration, which could
    // exhaust the blocking threadpool when timeouts fire before recv_timeout returns.
    let (tx, mut rx) = mpsc::channel::<ServiceEvent>(32);
    let _worker = tokio::task::spawn_blocking(move || loop {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(event) => {
                if tx.blocking_send(event).is_err() {
                    // Async receiver was dropped (deadline elapsed); stop.
                    break;
                }
            }
            Err(_) => {
                // recv_timeout timed out or the mDNS channel disconnected.
                if tx.is_closed() {
                    break;
                }
            }
        }
    });

    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }

        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(ServiceEvent::ServiceResolved(info))) => {
                let port = info.get_port();
                for addr in info.get_addresses() {
                    hubs.push(format!("http://{}:{}", addr, port));
                }
            }
            Ok(Some(_)) => {
                // Non-resolved event — continue scanning
            }
            _ => break, // Deadline elapsed or channel closed
        }
    }

    // Dropping `rx` closes the async channel, signalling the blocking task to stop.
    drop(rx);
    // Wait for the blocking worker to exit before shutting down the mDNS daemon.
    let _ = _worker.await;

    let _ = mdns.shutdown();

    // Always include localhost default
    if hubs.is_empty() {
        hubs.push("http://localhost:5002".to_string());
    }

    Ok(hubs)
}
