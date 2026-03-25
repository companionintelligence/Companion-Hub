use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};
use std::sync::Arc;

pub fn create_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open Hub", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "Status: Checking…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &status, &quit])?;

    // Keep a reference to the status item for background updates
    let status_item = Arc::new(status);

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("CI OS Hub")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    // Build a single reusable client with explicit connect + overall timeouts
    // so the health-check loop can never stall indefinitely.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(5))
        .build()?;

    // Spawn background health-check loop
    let status_ref = Arc::clone(&status_item);
    tauri::async_runtime::spawn(async move {
        loop {
            let ok = client
                .get("http://localhost:5002/api/health")
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);

            let label = if ok {
                "Status: Connected ✓"
            } else {
                "Status: Disconnected ✗"
            };

            let _ = status_ref.set_text(label);

            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });

    Ok(())
}
