use tauri_plugin_store::StoreExt;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};
use tauri_plugin_shell::ShellExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub fn create_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show_hide = MenuItem::with_id(app, "show_hide", "Hide Hub", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let start_hub = MenuItem::with_id(app, "start_hub", "Start Hub", true, None::<&str>)?;
    let stop_hub = MenuItem::with_id(app, "stop_hub", "Stop Hub", false, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let open_portal = MenuItem::with_id(app, "open_portal", "Open Portal", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let status = MenuItem::with_id(app, "status", "Status: Checking…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[
        &show_hide, &sep1,
        &start_hub, &stop_hub, &sep2,
        &open_portal, &sep3,
        &status, &quit,
    ])?;

    // Track window visibility
    let window_visible = Arc::new(AtomicBool::new(true));
    let visible_for_event = Arc::clone(&window_visible);

    // Keep refs for background updates
    let status_item = Arc::new(status);
    let start_item = Arc::new(start_hub);
    let stop_item = Arc::new(stop_hub);
    let show_hide_item = Arc::new(show_hide);

    // Share show_hide_item with the window close event handler
    let show_hide_for_close = Arc::clone(&show_hide_item);
    let visible_for_close = Arc::clone(&window_visible);

    // Register close-requested handler to hide instead of quit
    if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(win) = app_handle.get_webview_window("main") {
                    // Save geometry
                    if let Ok(store) = app_handle.store("settings.json") {
                        if let Ok(pos) = win.outer_position() {
                            store.set("window_x", serde_json::json!(pos.x));
                            store.set("window_y", serde_json::json!(pos.y));
                        }
                        if let Ok(size) = win.outer_size() {
                            store.set("window_width", serde_json::json!(size.width));
                            store.set("window_height", serde_json::json!(size.height));
                        }
                        let _ = store.save();
                    }
                    let _ = win.hide();
                    visible_for_close.store(false, Ordering::Relaxed);
                    let _ = show_hide_for_close.set_text("Show Hub");
                }
            }
        });
    }

    let show_hide_for_menu = Arc::clone(&show_hide_item);

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("Companion Hub")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show_hide" => {
                if let Some(window) = app.get_webview_window("main") {
                    if visible_for_event.load(Ordering::Relaxed) {
                        let _ = window.hide();
                        visible_for_event.store(false, Ordering::Relaxed);
                        let _ = show_hide_for_menu.set_text("Show Hub");
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                        visible_for_event.store(true, Ordering::Relaxed);
                        let _ = show_hide_for_menu.set_text("Hide Hub");
                    }
                }
            }
            "start_hub" => {
                tauri::async_runtime::spawn(async {
                    // Start in order: db, queue, hub
                    let _ = std::process::Command::new("docker")
                        .args(["start", "ci-hub-db", "ci-os-hub-queue", "ci-os-hub"])
                        .output();
                });
            }
            "stop_hub" => {
                tauri::async_runtime::spawn(async {
                    // Stop hub containers
                    let _ = std::process::Command::new("docker")
                        .args(["stop", "ci-os-hub", "ci-hub-db", "ci-os-hub-queue"])
                        .output();
                    // Stop managed app containers
                    if let Ok(output) = std::process::Command::new("docker")
                        .args(["ps", "-q", "--filter", "label=ci-hub.managed"])
                        .output()
                    {
                        let ids = String::from_utf8_lossy(&output.stdout);
                        let ids: Vec<&str> = ids.split_whitespace().collect();
                        if !ids.is_empty() {
                            let mut cmd = std::process::Command::new("docker");
                            cmd.arg("stop");
                            for id in ids {
                                cmd.arg(id);
                            }
                            let _ = cmd.output();
                        }
                    }
                });
            }
            "open_portal" => {
                let _ = app.shell().open("https://portal.companionintelligence.com", None::<tauri_plugin_shell::open::Program>);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    // Build reusable HTTP client for health checks
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(5))
        .build()?;

    // Spawn background health-check loop
    let status_ref = Arc::clone(&status_item);
    let start_ref = Arc::clone(&start_item);
    let stop_ref = Arc::clone(&stop_item);
    tauri::async_runtime::spawn(async move {
        loop {
            // Try prod port first, then dev port
            let ok = client
                .get("http://localhost:5002/api/health")
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false)
                || client
                    .get("http://localhost:3000/api/health")
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false);

            if ok {
                let _ = status_ref.set_text("Status: Connected ✓");
                let _ = start_ref.set_enabled(false);
                let _ = stop_ref.set_enabled(true);
            } else {
                let _ = status_ref.set_text("Status: Disconnected ✗");
                let _ = start_ref.set_enabled(true);
                let _ = stop_ref.set_enabled(false);
            }

            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });

    Ok(())
}
