use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::time::Duration;

const SERVICE_TYPE: &str = "_ci-hub._tcp.local.";

/// Scan the local network for CI OS Hub instances via mDNS.
/// Returns a list of URLs like "http://192.168.1.42:5002".
pub async fn find_hubs() -> Result<Vec<String>, Box<dyn std::error::Error + Send + Sync>> {
    let mdns = ServiceDaemon::new()?;
    let receiver = mdns.browse(SERVICE_TYPE)?;

    let mut hubs: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }

        match tokio::time::timeout(remaining, tokio::task::spawn_blocking({
            let rx = receiver.clone();
            move || rx.recv_timeout(Duration::from_millis(500))
        }))
        .await
        {
            Ok(Ok(Ok(ServiceEvent::ServiceResolved(info)))) => {
                let port = info.get_port();
                for addr in info.get_addresses() {
                    hubs.push(format!("http://{}:{}", addr, port));
                }
            }
            _ => {
                // Timeout or non-resolved event — continue scanning
                continue;
            }
        }
    }

    let _ = mdns.shutdown();

    // Always include localhost default
    if hubs.is_empty() {
        hubs.push("http://localhost:5002".to_string());
    }

    Ok(hubs)
}
