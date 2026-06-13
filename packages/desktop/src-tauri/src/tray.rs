use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

fn describe_hub_status(status: &crate::hub_manager::HubStatus) -> String {
    match status {
        crate::hub_manager::HubStatus::DockerNotAvailable => "docker not available".to_string(),
        crate::hub_manager::HubStatus::Stopped => "stopped".to_string(),
        crate::hub_manager::HubStatus::Starting => "starting".to_string(),
        crate::hub_manager::HubStatus::Running => "running".to_string(),
        crate::hub_manager::HubStatus::Error { message } => format!("error: {}", message),
    }
}

pub fn create_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let show_hide = MenuItem::with_id(app, "show_hide", "Hide Hub", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let start_hub = MenuItem::with_id(app, "start_hub", "Start Hub", true, None::<&str>)?;
    let stop_hub = MenuItem::with_id(app, "stop_hub", "Stop Hub", false, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let open_portal =
        MenuItem::with_id(app, "open_portal", "Account Management", true, None::<&str>)?;
    let view_logs = MenuItem::with_id(app, "view_logs", "View Logs", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let reset_hub = MenuItem::with_id(
        app,
        "reset_hub",
        "Reset Hub & Clear Tunnel Token",
        true,
        None::<&str>,
    )?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    let status = MenuItem::with_id(app, "status", "Status: Checking…", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &sep1,
            &start_hub,
            &stop_hub,
            &sep2,
            &open_portal,
            &view_logs,
            &sep3,
            &reset_hub,
            &sep4,
            &status,
            &quit,
        ],
    )?;

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

    // Load the tray icon defensively: prefer the packaged file, fall back to the
    // embedded bytes, and if both fail (corrupt asset / unusual packaging) build
    // the tray without an icon instead of panicking. A missing tray icon must
    // never abort startup.
    let tray_icon = Image::from_path("icons/icon.png")
        .or_else(|_| Image::from_bytes(include_bytes!("../icons/icon.png")))
        .map_err(|error| log::warn!("Tray icon unavailable, continuing without one: {error}"))
        .ok();

    let mut tray_builder = TrayIconBuilder::new();
    if let Some(icon) = tray_icon {
        tray_builder = tray_builder.icon(icon).icon_as_template(true);
    }
    let _tray = tray_builder
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
                let _ = crate::hub_manager::append_desktop_log_for(
                    &data,
                    "tray.start",
                    "Start Hub requested from the tray menu.",
                );
                let data_for_log = data.clone();
                tauri::async_runtime::spawn(async move {
                    match tokio::task::spawn_blocking(move || {
                        crate::hub_manager::start_hub(&compose, &env, &data)
                    })
                    .await
                    {
                        Ok(Ok(message)) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data_for_log,
                                "tray.start",
                                &message,
                            );
                        }
                        Ok(Err(error)) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data_for_log,
                                "tray.start",
                                &format!("Tray start request failed: {}", error),
                            );
                        }
                        Err(join_err) => {
                            let msg = if join_err.is_panic() {
                                format!("start_hub task panicked: {}", join_err)
                            } else {
                                format!("start_hub task was cancelled: {}", join_err)
                            };
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data_for_log,
                                "tray.start",
                                &msg,
                            );
                        }
                    }
                });
            }
            "stop_hub" => {
                let paths = app.state::<crate::hub_manager::HubPaths>();
                let compose = paths.compose_path.clone();
                let env = paths.env_path.clone();
                let data = paths.data_dir.clone();
                let _ = crate::hub_manager::append_desktop_log_for(
                    &data,
                    "tray.stop",
                    "Stop Hub requested from the tray menu.",
                );
                tauri::async_runtime::spawn(async move {
                    match crate::hub_manager::stop_hub(&compose, &env) {
                        Ok(message) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.stop",
                                &message,
                            );
                        }
                        Err(error) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.stop",
                                &format!("Tray stop request failed: {}", error),
                            );
                        }
                    }

                    match crate::hub_manager::stop_managed_app_containers() {
                        Ok(Some(summary)) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.stop",
                                &summary,
                            );
                        }
                        Ok(None) => {}
                        Err(error) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.stop",
                                &format!("Managed app containers cleanup failed: {}", error),
                            );
                        }
                    }
                });
            }
            "reset_hub" => {
                let paths = app.state::<crate::hub_manager::HubPaths>();
                let compose = paths.compose_path.clone();
                let env = paths.env_path.clone();
                let data = paths.data_dir.clone();
                let _ = crate::hub_manager::append_desktop_log_for(
                    &data,
                    "tray.reset",
                    "Reset Hub requested from the tray menu — will stop containers and clear tunnel token.",
                );
                tauri::async_runtime::spawn(async move {
                    // 1. Stop the Hub compose project (best-effort — keep going on error).
                    match crate::hub_manager::stop_hub(&compose, &env) {
                        Ok(message) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.reset",
                                &message,
                            );
                        }
                        Err(error) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.reset",
                                &format!("stop_hub during reset failed: {}", error),
                            );
                        }
                    }

                    // 2. Stop any managed app containers (best-effort).
                    match crate::hub_manager::stop_managed_app_containers() {
                        Ok(Some(summary)) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.reset",
                                &summary,
                            );
                        }
                        Ok(None) => {}
                        Err(error) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.reset",
                                &format!("Managed app containers cleanup failed: {}", error),
                            );
                        }
                    }

                    // 3. Clear the Cloudflare tunnel token from disk. Local-only;
                    // server-side tunnel invalidation requires a Portal call that is
                    // not wired here yet — tracked in issue #453.
                    match crate::hub_manager::clear_tunnel_token(&data) {
                        Ok(message) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.reset",
                                &message,
                            );
                        }
                        Err(error) => {
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data,
                                "tray.reset",
                                &format!("Tunnel token cleanup failed: {}", error),
                            );
                        }
                    }
                });
            }
            "open_portal" => {
                let portal_url =
                    option_env!("CI_HUB_CLOUD_URL").unwrap_or(crate::hub_manager::default_ci_cloud_url());
                let _ = app.opener().open_url(portal_url, None::<&str>);
            }
            "view_logs" => {
                let logs_dir = crate::hub_manager::logs_open_target();
                let _ = std::fs::create_dir_all(&logs_dir);
                let _ = crate::hub_manager::append_desktop_log(
                    "tray.logs",
                    &format!("Opening logs folder: {}", logs_dir.display()),
                );
                let path = logs_dir.display().to_string();
                let _ = app.opener().open_path(path, None::<&str>);
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
    let env_path_for_health = crate::hub_manager::hub_env_path();
    tauri::async_runtime::spawn(async move {
        let mut last_ok: Option<bool> = None;
        loop {
            let api_port = crate::port_manager::read_api_port(&env_path_for_health);
            // Try resolved port first, then local source-dev port
            let ok = client
                .get(format!("http://localhost:{}/api/health", api_port))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false)
                || client
                    .get("http://localhost:5004/api/health")
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false);

            if last_ok != Some(ok) {
                let transition = match last_ok {
                    Some(previous) => format!(
                        "Hub connectivity changed: {} -> {} (api port {}).",
                        if previous {
                            "connected"
                        } else {
                            "disconnected"
                        },
                        if ok { "connected" } else { "disconnected" },
                        api_port
                    ),
                    None => format!(
                        "Initial hub connectivity status: {} (api port {}).",
                        if ok { "connected" } else { "disconnected" },
                        api_port
                    ),
                };
                let _ = crate::hub_manager::append_desktop_log("tray.health", &transition);
                if !ok {
                    let status = crate::hub_manager::get_hub_status();
                    let _ = crate::hub_manager::append_desktop_log(
                        "tray.health",
                        &format!(
                            "Hub status snapshot while disconnected: {}",
                            describe_hub_status(&status)
                        ),
                    );
                }
                last_ok = Some(ok);
            }

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
