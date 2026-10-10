use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

/// Shown before Clear Tunnel Token runs. It stops the Hub and installed apps
/// and removes only the tunnel token — it is not a factory reset.
pub(crate) const CLEAR_TUNNEL_TOKEN_CONFIRM: &str =
    "This stops the Hub and installed apps and removes only the tunnel token.";

pub(crate) fn clear_tunnel_token_result(problems: &[String]) -> String {
    if problems.is_empty() {
        "Stopped the Hub and installed apps, and removed the tunnel token.".to_string()
    } else {
        format!(
            "Clear tunnel token stopped partway.\n{}",
            problems.join("\n")
        )
    }
}

/// What saving the window geometry reads from the window, so a test can stand in for one.
pub(crate) trait GeometrySource {
    fn is_maximized(&self) -> bool;
    fn outer_position(&self) -> Option<tauri::PhysicalPosition<i32>>;
    fn inner_size(&self) -> Option<tauri::PhysicalSize<u32>>;
}

impl<R: tauri::Runtime> GeometrySource for tauri::WebviewWindow<R> {
    fn is_maximized(&self) -> bool {
        tauri::WebviewWindow::is_maximized(self).unwrap_or(false)
    }

    fn outer_position(&self) -> Option<tauri::PhysicalPosition<i32>> {
        tauri::WebviewWindow::outer_position(self).ok()
    }

    fn inner_size(&self) -> Option<tauri::PhysicalSize<u32>> {
        tauri::WebviewWindow::inner_size(self).ok()
    }
}

pub(crate) struct SavedGeometry {
    pub position: Option<tauri::PhysicalPosition<i32>>,
    pub size: Option<tauri::PhysicalSize<u32>>,
}

/// The position and size the next launch restores, or `None` for a maximized window.
///
/// The size is the inner one, because the restore in `main.rs` passes it to `set_size`, which sets
/// the inner size. The outer size also counts the invisible resize borders Windows keeps around the
/// undecorated window, so saving it made the window bigger on every launch (Companion-Hub#1932).
pub(crate) fn window_geometry_to_save(window: &impl GeometrySource) -> Option<SavedGeometry> {
    // A maximized window would bake the full screen size into the store;
    // keep the last normal geometry instead.
    if window.is_maximized() {
        return None;
    }
    Some(SavedGeometry {
        position: window.outer_position(),
        size: window.inner_size(),
    })
}

pub(crate) fn save_window_geometry(app_handle: &tauri::AppHandle) {
    if let Some(win) = app_handle.get_webview_window("main") {
        let Some(geometry) = window_geometry_to_save(&win) else {
            return;
        };
        if let Ok(store) = app_handle.store("settings.json") {
            if let Some(pos) = geometry.position {
                store.set("window_x", serde_json::json!(pos.x));
                store.set("window_y", serde_json::json!(pos.y));
            }
            if let Some(size) = geometry.size {
                store.set("window_width", serde_json::json!(size.width));
                store.set("window_height", serde_json::json!(size.height));
            }
            let _ = store.save();
        }
    }
}

fn describe_hub_status(status: &crate::hub_manager::HubStatus) -> String {
    match status {
        crate::hub_manager::HubStatus::DockerNotAvailable => "docker not available".to_string(),
        crate::hub_manager::HubStatus::Stopped => "stopped".to_string(),
        crate::hub_manager::HubStatus::Starting => "starting".to_string(),
        crate::hub_manager::HubStatus::Running => "running".to_string(),
        crate::hub_manager::HubStatus::Error { message } => format!("error: {}", message),
    }
}

fn stack_dev_mode_enabled() -> bool {
    std::env::var("CI_HUB_STACK_DEV")
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn non_empty_path_env(var_name: &str) -> Option<PathBuf> {
    std::env::var(var_name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

async fn hub_health_ok(client: &reqwest::Client, base_url: &str) -> bool {
    for endpoint in ["/api/health/live", "/api/health"] {
        if client
            .get(format!("{base_url}{endpoint}"))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
        {
            return true;
        }
    }

    false
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
        "Clear Tunnel Token (not full reset)",
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
                    save_window_geometry(&app_handle);
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

                    match crate::hub_manager::stop_managed_app_containers(&data) {
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
                let app_handle = app.clone();
                app.dialog()
                    .message(CLEAR_TUNNEL_TOKEN_CONFIRM)
                    .title("Clear Tunnel Token?")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Clear Tunnel Token".to_string(),
                        "Cancel".to_string(),
                    ))
                    .show(move |confirmed| {
                        if !confirmed {
                            return;
                        }
                        let _ = crate::hub_manager::append_desktop_log_for(
                            &data,
                            "tray.reset",
                            "Clear tunnel token requested from tray — stops containers and removes the local tunnel token only. Use Settings → Factory reset or `cihub reset --yes` for a full wipe.",
                        );
                        let data_for_result = data.clone();
                        let app_for_result = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let mut problems = Vec::new();
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
                                    problems.push(format!("Could not stop the Hub: {error}"));
                                }
                            }

                            // 2. Stop any managed app containers (best-effort).
                            match crate::hub_manager::stop_managed_app_containers(&data) {
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
                                        &format!(
                                            "Managed app containers cleanup failed: {}",
                                            error
                                        ),
                                    );
                                    problems
                                        .push(format!("Could not stop installed apps: {error}"));
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
                                    problems.push(format!(
                                        "Could not remove the tunnel token: {error}"
                                    ));
                                }
                            }

                            let summary = clear_tunnel_token_result(&problems);
                            let _ = crate::hub_manager::append_desktop_log_for(
                                &data_for_result,
                                "tray.reset",
                                &summary,
                            );
                            let kind = if problems.is_empty() {
                                MessageDialogKind::Info
                            } else {
                                MessageDialogKind::Error
                            };
                            app_for_result
                                .dialog()
                                .message(summary)
                                .title("Clear Tunnel Token")
                                .kind(kind)
                                .show(|_| {});
                        });
                    });
            }
            "open_portal" => {
                // The CI_CLOUD_URL the running stack was started with, so an override opens here
                // only once a launch has applied it (and in stack-dev, the stack-dev env file).
                let paths = app.state::<crate::hub_manager::HubPaths>();
                let portal_url = crate::hub_manager::portal_url_from_env_file(&paths.env_path);
                let _ = app.opener().open_url(portal_url, None::<&str>);
            }
            "view_logs" => {
                if let Err(error) = crate::open_logs_folder(app) {
                    app.dialog()
                        .message(error)
                        .title("Couldn't open logs")
                        .kind(MessageDialogKind::Error)
                        .show(|_| {});
                }
            }
            "quit" => {
                save_window_geometry(app);
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
    let stack_dev_mode = stack_dev_mode_enabled();
    let env_path_for_health = if stack_dev_mode {
        non_empty_path_env("CI_HUB_STACK_DEV_ENV_PATH")
            .unwrap_or_else(crate::hub_manager::hub_env_path)
    } else {
        crate::hub_manager::hub_env_path()
    };
    let data_dir_for_watchdog = crate::hub_manager::get_hub_data_dir();
    let compose_path_for_watchdog = if stack_dev_mode {
        non_empty_path_env("CI_HUB_STACK_DEV_COMPOSE_PATH")
            .unwrap_or_else(|| data_dir_for_watchdog.join(crate::hub_manager::HUB_COMPOSE_FILENAME))
    } else {
        data_dir_for_watchdog.join(crate::hub_manager::HUB_COMPOSE_FILENAME)
    };
    tauri::async_runtime::spawn(async move {
        let mut last_ok: Option<bool> = None;
        let mut consecutive_failures: u32 = 0;
        let mut last_watchdog_start: Option<std::time::Instant> = None;
        loop {
            let api_port = crate::port_manager::read_api_port(&env_path_for_health);
            // Try resolved port first, then local source-dev port
            let ok = hub_health_ok(&client, &format!("http://localhost:{}", api_port)).await
                || hub_health_ok(&client, "http://localhost:5004").await;

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
                consecutive_failures = 0;
                let _ = status_ref.set_text("Status: Connected ✓");
                let _ = start_ref.set_enabled(false);
                let _ = stop_ref.set_enabled(true);
            } else {
                consecutive_failures = consecutive_failures.saturating_add(1);
                let cooldown_secs = last_watchdog_start.map(|t| t.elapsed().as_secs());
                let compose_ready = compose_path_for_watchdog.is_file();
                let hub_status = crate::hub_manager::get_hub_status();
                let api_container_up = matches!(
                    hub_status,
                    crate::hub_manager::HubStatus::Running
                        | crate::hub_manager::HubStatus::Starting
                );
                let action = if !compose_ready {
                    // Desktop initialize copies compose into the data dir; don't race it.
                    crate::hub_manager::HubWatchdogAction::None
                } else {
                    crate::hub_manager::decide_hub_watchdog_action(
                        consecutive_failures,
                        cooldown_secs,
                        stack_dev_mode
                            || crate::hub_manager::is_user_stopped(&data_dir_for_watchdog),
                        crate::hub_manager::is_start_failed(&data_dir_for_watchdog),
                        api_container_up,
                        crate::hub_manager::is_docker_available(),
                    )
                };
                match action {
                    crate::hub_manager::HubWatchdogAction::None => {}
                    crate::hub_manager::HubWatchdogAction::StartHub => {
                        let _ = crate::hub_manager::append_desktop_log(
                            "tray.watchdog",
                            &format!(
                                "Hub API unreachable for {} consecutive checks — auto-starting hub.",
                                consecutive_failures
                            ),
                        );
                        last_watchdog_start = Some(std::time::Instant::now());
                        consecutive_failures = 0;
                        let compose = compose_path_for_watchdog.clone();
                        let env = env_path_for_health.clone();
                        let data = data_dir_for_watchdog.clone();
                        tauri::async_runtime::spawn(async move {
                            match tokio::task::spawn_blocking(move || {
                                crate::hub_manager::start_hub(&compose, &env, &data)
                            })
                            .await
                            {
                                Ok(Ok(summary)) => {
                                    let _ = crate::hub_manager::append_desktop_log(
                                        "tray.watchdog",
                                        &format!("Watchdog start_hub succeeded: {summary}"),
                                    );
                                }
                                Ok(Err(err)) => {
                                    let _ = crate::hub_manager::append_desktop_log(
                                        "tray.watchdog",
                                        &format!("Watchdog start_hub failed: {err}"),
                                    );
                                }
                                Err(join_err) => {
                                    let _ = crate::hub_manager::append_desktop_log(
                                        "tray.watchdog",
                                        &format!("Watchdog start_hub task panicked: {join_err}"),
                                    );
                                }
                            }
                        });
                    }
                    crate::hub_manager::HubWatchdogAction::RestartWedgedContainer => {
                        let _ = crate::hub_manager::append_desktop_log(
                            "tray.watchdog",
                            &format!(
                                "Hub API unreachable for {} consecutive checks while container is up — restarting ci-hub only.",
                                consecutive_failures
                            ),
                        );
                        last_watchdog_start = Some(std::time::Instant::now());
                        consecutive_failures = 0;
                        tauri::async_runtime::spawn(async move {
                            match tokio::task::spawn_blocking(
                                crate::hub_manager::restart_wedged_hub_container,
                            )
                            .await
                            {
                                Ok(Ok(summary)) => {
                                    let _ = crate::hub_manager::append_desktop_log(
                                        "tray.watchdog",
                                        &format!("Watchdog container restart succeeded: {summary}"),
                                    );
                                }
                                Ok(Err(err)) => {
                                    let _ = crate::hub_manager::append_desktop_log(
                                        "tray.watchdog",
                                        &format!("Watchdog container restart failed: {err}"),
                                    );
                                }
                                Err(join_err) => {
                                    let _ = crate::hub_manager::append_desktop_log(
                                        "tray.watchdog",
                                        &format!(
                                            "Watchdog container restart task panicked: {join_err}"
                                        ),
                                    );
                                }
                            }
                        });
                    }
                }
                let _ = status_ref.set_text("Status: Disconnected ✗");
                let _ = start_ref.set_enabled(true);
                let _ = stop_ref.set_enabled(false);
            }

            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        clear_tunnel_token_result, window_geometry_to_save, GeometrySource,
        CLEAR_TUNNEL_TOKEN_CONFIRM,
    };
    use tauri::{PhysicalPosition, PhysicalSize};

    /// The main window as Windows lays it out at 125% scaling. Decorations are off, but tao keeps
    /// invisible resize borders around the window, 9 + 9 px across and 9 + 1 px down. The outer
    /// size counts them and the inner size does not.
    struct WindowsMainWindow {
        position: PhysicalPosition<i32>,
        outer: PhysicalSize<u32>,
    }

    impl WindowsMainWindow {
        const BORDERS: PhysicalSize<u32> = PhysicalSize {
            width: 18,
            height: 10,
        };

        /// The window a launch opens. The restore in `main.rs` hands the saved position to
        /// `set_position`, which places the outer frame, and the saved size to `set_size`, which
        /// sets the inner size.
        fn opened_with(position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Self {
            Self {
                position,
                outer: PhysicalSize::new(
                    size.width + Self::BORDERS.width,
                    size.height + Self::BORDERS.height,
                ),
            }
        }

        /// The size the user sees, since the borders are invisible.
        fn visible_size(&self) -> PhysicalSize<u32> {
            PhysicalSize::new(
                self.outer.width - Self::BORDERS.width,
                self.outer.height - Self::BORDERS.height,
            )
        }
    }

    impl GeometrySource for WindowsMainWindow {
        fn is_maximized(&self) -> bool {
            false
        }

        fn outer_position(&self) -> Option<PhysicalPosition<i32>> {
            Some(self.position)
        }

        fn inner_size(&self) -> Option<PhysicalSize<u32>> {
            Some(self.visible_size())
        }
    }

    /// The window grew by its invisible borders on every launch: 960×700, then 978×710, then
    /// 996×720 (Companion-Hub#1932).
    #[test]
    fn the_window_reopens_at_the_size_and_place_it_was_closed_at() {
        let place = PhysicalPosition::new(240, 120);
        let size = PhysicalSize::new(960, 700);
        let mut window = WindowsMainWindow::opened_with(place, size);

        for launch in 1..=3 {
            let saved = window_geometry_to_save(&window).expect("the window is not maximized");
            window = WindowsMainWindow::opened_with(
                saved.position.expect("a position"),
                saved.size.expect("a size"),
            );
            assert_eq!(window.visible_size(), size, "size after launch {launch}");
            assert_eq!(window.position, place, "place after launch {launch}");
        }
    }

    #[test]
    fn confirm_says_clear_tunnel_token_stops_apps_and_removes_only_the_token() {
        assert!(CLEAR_TUNNEL_TOKEN_CONFIRM.contains("stops the Hub and installed apps"));
        assert!(CLEAR_TUNNEL_TOKEN_CONFIRM.contains("removes only the tunnel token"));
    }

    #[test]
    fn clear_tunnel_token_result_says_when_it_finished() {
        let message = clear_tunnel_token_result(&[]);
        assert!(message.contains("Stopped the Hub and installed apps"));
        assert!(message.contains("removed the tunnel token"));
    }

    #[test]
    fn clear_tunnel_token_result_reports_a_partial_stop() {
        let message =
            clear_tunnel_token_result(&["Could not stop the Hub: docker down".to_string()]);
        assert!(message.contains("stopped partway"));
        assert!(message.contains("Could not stop the Hub: docker down"));
    }
}
