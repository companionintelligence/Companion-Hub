use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

#[allow(deprecated)]
fn open_logs_target<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let data_dir = crate::hub_manager::get_hub_data_dir();
    let log_dir = crate::hub_manager::desktop_logs_dir(&data_dir);
    let _ = std::fs::create_dir_all(&log_dir);

    let target = crate::hub_manager::preferred_logs_target(&data_dir);
    let _ = crate::hub_manager::log_desktop_event(
        &data_dir,
        "tray",
        &format!("Tray requested log view. Opening {}.", target.display()),
    );

    if let Err(error) = app.shell().open(
        target.to_string_lossy().to_string(),
        None::<tauri_plugin_shell::open::Program>,
    ) {
        let _ = crate::hub_manager::log_desktop_event(
            &data_dir,
            "tray",
            &format!("Failed to open {}: {}", target.display(), error),
        );

        if target != log_dir {
            let _ = crate::hub_manager::log_desktop_event(
                &data_dir,
                "tray",
                &format!("Falling back to {}.", log_dir.display()),
            );
            if let Err(fallback_error) = app.shell().open(
                log_dir.to_string_lossy().to_string(),
                None::<tauri_plugin_shell::open::Program>,
            ) {
                let _ = crate::hub_manager::log_desktop_event(
                    &data_dir,
                    "tray",
                    &format!(
                        "Failed to open fallback logs directory {}: {}",
                        log_dir.display(),
                        fallback_error
                    ),
                );
            }
        }
    }
}

#[allow(deprecated)]
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
            &status,
            &quit,
        ],
    )?;

    let window_visible = Arc::new(AtomicBool::new(true));
    let visible_for_event = Arc::clone(&window_visible);

    let status_item = Arc::new(status);
    let start_item = Arc::new(start_hub);
    let stop_item = Arc::new(stop_hub);
    let show_hide_item = Arc::new(show_hide);

    let show_hide_for_close = Arc::clone(&show_hide_item);
    let visible_for_close = Arc::clone(&window_visible);

    if let Some(window) = app.get_webview_window("main") {
        let app_handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(win) = app_handle.get_webview_window("main") {
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
        .icon(Image::from_path("icons/icon.png").unwrap_or_else(|_| {
            Image::from_bytes(include_bytes!("../icons/icon.png"))
                .expect("failed to load tray icon")
        }))
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
                let _ = crate::hub_manager::log_desktop_event(
                    &data,
                    "tray",
                    "Tray requested hub start.",
                );
                tauri::async_runtime::spawn(async move {
                    let _ = crate::hub_manager::start_hub(&compose, &env, &data);
                });
            }
            "stop_hub" => {
                let paths = app.state::<crate::hub_manager::HubPaths>();
                let compose = paths.compose_path.clone();
                let env = paths.env_path.clone();
                let data = paths.data_dir.clone();
                let _ = crate::hub_manager::log_desktop_event(
                    &data,
                    "tray",
                    "Tray requested hub stop.",
                );
                tauri::async_runtime::spawn(async move {
                    let _ = crate::hub_manager::stop_hub(&compose, &env, &data);
                    let _ = crate::hub_manager::stop_managed_app_containers(&data);
                });
            }
            "open_portal" => {
                let portal_url = option_env!("CI_HUB_CLOUD_URL")
                    .unwrap_or("https://portal.companionintelligence.com");
                let _ = app
                    .shell()
                    .open(portal_url, None::<tauri_plugin_shell::open::Program>);
            }
            "view_logs" => open_logs_target(app),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(5))
        .build()?;

    let status_ref = Arc::clone(&status_item);
    let start_ref = Arc::clone(&start_item);
    let stop_ref = Arc::clone(&stop_item);
    let env_path_for_health = crate::hub_manager::get_hub_data_dir().join(".env");
    tauri::async_runtime::spawn(async move {
        loop {
            let api_port = crate::port_manager::read_api_port(&env_path_for_health);
            let ok = client
                .get(format!("http://localhost:{}/api/health", api_port))
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
