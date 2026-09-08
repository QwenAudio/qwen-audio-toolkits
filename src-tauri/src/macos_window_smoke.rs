//! Opt-in native regression check. Run only in a disposable debug app bundle.
use std::{
    process::Command,
    sync::atomic::Ordering,
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

fn wait_for(label: &str, mut condition: impl FnMut() -> bool) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if condition() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(format!("timed out waiting for {label}"))
}

fn reopen(app: &tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|ext| ext == "app"))
        .ok_or("smoke test must run inside an .app bundle")?;
    // Launch Services sends the same reopen Apple event as clicking the Dock icon.
    let status = Command::new("open")
        .arg(bundle)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Launch Services could not reopen test app".into());
    }
    wait_for("visible, focused main window", || {
        app.get_webview_window("main").is_some_and(|w| {
            w.is_visible().unwrap_or(false)
                && !w.is_minimized().unwrap_or(true)
                && w.is_focused().unwrap_or(false)
        })
    })
}

fn check(app: &tauri::AppHandle) -> Result<(), String> {
    // Let the frontend finish applying persisted settings before controlling them.
    thread::sleep(Duration::from_secs(3));
    app.state::<super::CloseBehavior>()
        .0
        .store(false, Ordering::Relaxed);
    for cycle in 1..=3 {
        let window = app
            .get_webview_window("main")
            .ok_or("main window is missing")?;
        window.close().map_err(|e| e.to_string())?;
        wait_for("hidden main window", || {
            !window.is_visible().unwrap_or(true)
        })?;
        if app.get_webview_window("main").is_none() {
            return Err("close destroyed the main window".into());
        }
        reopen(app)?;
        eprintln!("WINDOW_SMOKE: close/reopen cycle {cycle} passed");
    }
    let window = app
        .get_webview_window("main")
        .ok_or("main window is missing")?;
    window.minimize().map_err(|e| e.to_string())?;
    wait_for("minimized main window", || {
        window.is_minimized().unwrap_or(false)
    })?;
    reopen(app)?;
    eprintln!("WINDOW_SMOKE: minimize/reopen passed");

    window.destroy().map_err(|e| e.to_string())?;
    wait_for("main window destruction", || {
        app.get_webview_window("main").is_none()
    })?;
    reopen(app)?;
    eprintln!("WINDOW_SMOKE: missing-window recovery passed");

    // Keep an auxiliary window present to reproduce the original quit failure.
    if app.get_webview_window("captions").is_none() {
        return Err("caption test window is missing".into());
    }
    thread::sleep(Duration::from_secs(2));
    app.state::<super::CloseBehavior>()
        .0
        .store(true, Ordering::Relaxed);
    eprintln!("WINDOW_SMOKE: requesting full exit with captions still present");
    app.get_webview_window("main")
        .ok_or("main window is missing")?
        .close()
        .map_err(|e| e.to_string())?;
    thread::sleep(Duration::from_secs(5));
    Err("quit-on-close left the application running".into())
}

pub(super) fn start(app: tauri::AppHandle) {
    // Protect normal app data from this opt-in destructive window test.
    if !app.config().identifier.ends_with(".windowtest") {
        eprintln!("WINDOW_SMOKE: refusing to run outside a .windowtest app");
        app.exit(1);
        return;
    }
    thread::spawn(move || {
        if let Err(error) = check(&app) {
            eprintln!("WINDOW_SMOKE: FAIL: {error}");
            app.exit(1);
        }
    });
}
