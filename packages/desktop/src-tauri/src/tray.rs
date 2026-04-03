use tauri_plugin_store::StoreExt;
use tauri::{
    image::Image,
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
    let view_logs = MenuItem::with_id(app, "view_logs", "View Logs", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let status = MenuItem::with_id(app, "status", "Status: Checking…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[
        &show_hide, &sep1,
        &start_hub, &stop_hub, &sep2,
        &open_portal, &view_logs, &sep3,
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
        .icon(Image::from_path("icons/icon.png").unwrap_or_else(|_| Image::from_bytes(include_bytes!("../icons/icon.png")).expect("failed to load tray icon")))
        .icon_as_template(true)
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
                let paths = app.state::<crate::hub_manager::HubPaths>();
                let compose = paths.compose_path.clone();
                let env = paths.env_path.clone();
                let data = paths.data_dir.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::hub_manager::start_hub(&compose, &env, &data);
                });
            }
            "stop_hub" => {
                let paths = app.state::<crate::hub_manager::HubPaths>();
                let compose = paths.compose_path.clone();
                let env = paths.env_path.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::hub_manager::stop_hub(&compose, &env);
                    // Also stop managed app containers
                    if let Ok(output) = crate::hub_manager::docker_command()
                        .args(["ps", "-q", "--filter", "label=ci-hub.managed"])
                        .output()
                    {
                        let ids = String::from_utf8_lossy(&output.stdout);
                        let ids: Vec<&str> = ids.split_whitespace().collect();
                        if !ids.is_empty() {
                            let mut cmd = crate::hub_manager::docker_command();
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
            "view_logs" => {
                let log_dir = crate::hub_manager::get_hub_data_dir().join("logs");
                // Create log dir if it doesn't exist
                let _ = std::fs::create_dir_all(&log_dir);
                let init_log = log_dir.join("init.log");
                if init_log.exists() {
                    // Open the log file with the system default text editor
                    let _ = app.shell().open(init_log.to_string_lossy().to_string(), None::<tauri_plugin_shell::open::Program>);
                } else {
                    // Open the logs directory in the file explorer
                    let _ = app.shell().open(log_dir.to_string_lossy().to_string(), None::<tauri_plugin_shell::open::Program>);
                }
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
