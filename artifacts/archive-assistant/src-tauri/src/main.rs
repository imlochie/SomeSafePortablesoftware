#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::VecDeque,
    env,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WebviewWindow, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_updater::UpdaterExt;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const READY_PREFIX: &str = "ARCHIVE_ASSISTANT_READY ";

/// How many recent sidecar output lines to keep for a startup failure report.
///
/// This buffer is permanent, not scaffolding. A packaged launch has no console
/// (`windows_subsystem = "windows"` discards `eprintln!`) and no attached
/// terminal, so without it a sidecar that dies during startup surfaces as a
/// bare timeout with no way to tell a crash from a slow boot. Keeping the tail
/// of stdout/stderr is what made the packaged failures in this area
/// diagnosable from a single screenshot instead of a rebuild cycle.
///
/// It only ever runs on the failure path, and every line passes through
/// `redact_diagnostic` first, so a healthy launch pays nothing and no secret
/// reaches the window.
const DIAGNOSTIC_LINES: usize = 20;

struct SidecarState {
    child: Mutex<Option<Child>>,
}

impl SidecarState {
    fn new(child: Child) -> Self {
        Self {
            child: Mutex::new(Some(child)),
        }
    }

    fn shutdown(&self) {
        let Ok(mut child) = self.child.lock() else {
            return;
        };
        if let Some(mut process) = child.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

fn workspace_root() -> PathBuf {
    strip_verbatim_prefix(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")),
    )
}

/// Removes Windows' extended-length (`\\?\`) prefix from a path.
///
/// `Path::canonicalize` on Windows returns a "verbatim" path such as
/// `\\?\C:\dir\file`. Rust and the Win32 API handle that form fine, but Node
/// does not: it parses `\\?\C:\...` as a UNC path with server `?` and share
/// `C:`, so `resolveMainPath` -> `toRealPath` -> `realpathSync` stats the
/// share component and fails with
/// `EISDIR: illegal operation on a directory, lstat 'C:'` before any user code
/// runs. Anything handed to the Node sidecar -- the script path, and every
/// path passed through the environment -- must therefore be in plain form.
///
/// Only the `\\?\C:\`-style drive form is unwrapped. A `\\?\UNC\server\share`
/// path is left untouched, because rewriting it correctly means restoring the
/// leading `\\` and that is not a safe blind string edit.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    const VERBATIM_PREFIX: &str = r"\\?\";

    let Some(text) = path.to_str() else {
        return path;
    };
    let Some(remainder) = text.strip_prefix(VERBATIM_PREFIX) else {
        return path;
    };

    // Accept only `X:\...` or a bare `X:` drive specifier.
    let mut characters = remainder.chars();
    let is_drive_path = matches!(characters.next(), Some(drive) if drive.is_ascii_alphabetic())
        && matches!(characters.next(), Some(':'))
        && matches!(characters.next(), None | Some('\\'));

    if !is_drive_path {
        return path;
    }

    // `\\?\C:` must become `C:\`, never a bare `C:`. On Windows `C:` is
    // *drive-relative* -- it means "the current directory on drive C" rather
    // than the root of C. Node resolves such a path to the root component `C:`
    // and stats it, which is a directory, producing
    // `EISDIR: illegal operation on a directory, lstat 'C:'`. Appending the
    // separator keeps the path absolute, and `C:\` is already correct.
    if remainder.len() == 2 {
        return PathBuf::from(format!("{remainder}\\"));
    }

    PathBuf::from(remainder)
}

/// Resolves a configured path, always yielding a Node-safe plain form.
///
/// Every value produced here is handed to the sidecar through the environment
/// and resolved by Node, so a verbatim `\\?\` path would be misparsed the same
/// way the API entry path was. Derived defaults inherit the prefix from
/// `workspace_root`/`app_local_data_dir`, so the strip is applied to the final
/// value rather than only at the source.
fn configured_path(name: &str, fallback: impl FnOnce() -> PathBuf) -> String {
    let value = env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(fallback);

    strip_verbatim_prefix(value).to_string_lossy().into_owned()
}

/// Resource-relative locations that may hold the bundled API entry point.
///
/// `tauri.conf.json` maps `../../api-server/dist/` to the explicit destination
/// `api-server/dist/`, so the canonical installed location is
/// `$RESOURCE/api-server/dist/index.mjs`. The `_up_` entries remain because the
/// array form of `resources` rewrites each leading `..` to `_up_`; keeping them
/// means an installer produced from an older configuration still resolves.
const API_ENTRY_RESOURCE_CANDIDATES: [&[&str]; 4] = [
    &["api-server", "dist", "index.mjs"],
    &["_up_", "_up_", "api-server", "dist", "index.mjs"],
    &["_up_", "api-server", "dist", "index.mjs"],
    &["dist", "index.mjs"],
];

fn api_entry_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    // The source-tree bundle is a development convenience only. It must never
    // be considered by an installed build: CARGO_MANIFEST_DIR is baked in at
    // compile time, so on the machine that produced the installer that
    // directory still exists and this candidate wins over the real packaged
    // resource -- pointing the sidecar at the developer's source tree.
    #[cfg(debug_assertions)]
    candidates.push(
        workspace_root()
            .join("artifacts")
            .join("api-server")
            .join("dist")
            .join("index.mjs"),
    );

    let resource_dir = app
        .path()
        .resource_dir()
        .map(strip_verbatim_prefix)
        .unwrap_or_else(|_| workspace_root());
    for segments in API_ENTRY_RESOURCE_CANDIDATES {
        let mut candidate = resource_dir.clone();
        for segment in segments {
            candidate = candidate.join(segment);
        }
        candidates.push(candidate);
    }

    candidates
}

/// Rejects a path Node cannot use as a main module.
///
/// A drive-relative path such as `C:` or `C:foo` means "relative to the current
/// directory on that drive". Node resolves it to the bare root component and
/// stats that directory, failing with `EISDIR ... lstat 'C:'` before any user
/// code runs. Catching it here turns an opaque Node stack trace into a message
/// that names the offending value.
fn reject_drive_relative(path: &Path, label: &str) -> Result<(), String> {
    let Some(text) = path.to_str() else {
        return Ok(());
    };
    let mut characters = text.chars();
    let looks_drive_relative =
        matches!(characters.next(), Some(drive) if drive.is_ascii_alphabetic())
            && matches!(characters.next(), Some(':'))
            && !matches!(characters.next(), None | Some('\\') | Some('/'));

    if looks_drive_relative || text.len() == 2 && text.ends_with(':') {
        return Err(format!(
            "The {label} resolved to the drive-relative path {text:?}, which Node cannot execute. This indicates a path normalisation bug in the desktop shell."
        ));
    }
    Ok(())
}

fn api_entry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let candidates = api_entry_candidates(app);
    if let Some(found) = candidates.iter().find(|candidate| candidate.exists()) {
        reject_drive_relative(found, "API bundle path")?;
        return Ok(found.clone());
    }

    let probed = candidates
        .iter()
        .map(|candidate| candidate.display().to_string())
        .collect::<Vec<_>>()
        .join("\n  ");
    Err(format!(
        "The API bundle was not found. Build the API before launching the desktop shell. Probed:\n  {probed}"
    ))
}

#[cfg(windows)]
const BUNDLED_NODE_FILE_NAME: &str = "node.exe";
#[cfg(not(windows))]
const BUNDLED_NODE_FILE_NAME: &str = "node";

/// Lists the packaged resource tree, two levels deep.
///
/// Used only on a failure path, to report which resources actually shipped.
fn describe_resource_tree(app: &AppHandle) -> String {
    let Ok(resource_dir) = app.path().resource_dir().map(strip_verbatim_prefix) else {
        return "The application resource directory could not be resolved.".to_string();
    };

    let mut lines = vec![format!("Resource directory: {}", resource_dir.display())];
    let Ok(entries) = std::fs::read_dir(&resource_dir) else {
        lines.push("  <unreadable>".to_string());
        return lines.join("\n");
    };

    let mut names: Vec<_> = entries.flatten().map(|entry| entry.path()).collect();
    names.sort();
    if names.is_empty() {
        lines.push("  <empty>".to_string());
    }
    for path in names {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if path.is_dir() {
            let children: Vec<String> = std::fs::read_dir(&path)
                .map(|entries| {
                    let mut children: Vec<String> = entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .collect();
                    children.sort();
                    children.truncate(12);
                    children
                })
                .unwrap_or_default();
            lines.push(format!("  {name}/ -> {}", children.join(", ")));
        } else {
            lines.push(format!("  {name}"));
        }
    }
    lines.join("\n")
}

fn node_command(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("ARCHIVE_NODE_PATH").filter(|value| !value.is_empty()) {
        return Ok(configured.into());
    }

    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(strip_verbatim_prefix)
        .map(|resource_dir| resource_dir.join("runtime").join(BUNDLED_NODE_FILE_NAME));
    if let Some(bundled) = bundled.as_ref() {
        if bundled.exists() {
            return Ok(bundled.clone());
        }
    }

    // A packaged install must stay self-contained. Silently falling back to a
    // system Node here would defeat the "no system Node required" guarantee and
    // run the API on an unverified runtime, so release builds fail loudly
    // instead. Development builds may still fall back to Node on PATH.
    if !cfg!(debug_assertions) {
        let location = bundled
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "the application resource directory".to_string());
        // A missing bundled runtime means a resource failed to ship, which is a
        // packaging fault rather than anything the user did. Listing what the
        // resource directory actually contains turns that into a single
        // self-diagnosing report instead of a round trip.
        return Err(format!(
            "The bundled Node runtime is missing from this installation (expected at {location}). Reinstall ARCHIVE ASSISTANT, or set ARCHIVE_NODE_PATH to a Node executable for diagnostics.\n\n{}",
            describe_resource_tree(app)
        ));
    }

    Ok(PathBuf::from(BUNDLED_NODE_FILE_NAME))
}

fn bundled_media_tools_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(strip_verbatim_prefix)
        .map(|resource_dir| resource_dir.join("runtime").join("media-tools"))
        .filter(|path| path.is_dir())
}

fn sidecar_command(app: &AppHandle) -> Result<Command, String> {
    let root = workspace_root();
    let app_data = app
        .path()
        .app_local_data_dir()
        .map(strip_verbatim_prefix)
        .unwrap_or_else(|_| root.join("data"));
    let archive_root = app
        .path()
        .home_dir()
        .map(strip_verbatim_prefix)
        .unwrap_or_else(|_| app_data.clone())
        .join("ARCHIVE");
    let database_path = configured_path("ARCHIVE_DB_PATH", || {
        app_data.join("archive-assistant.sqlite")
    });
    let api_entry = api_entry_path(app)?;
    let media_tools_dir = bundled_media_tools_path(app);

    let mut command = Command::new(node_command(app)?);
    command
        .arg("--enable-source-maps")
        .arg(api_entry)
        .env("NODE_ENV", "production")
        .env("AUTH_MODE", "local")
        .env("API_HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("ARCHIVE_DB_PATH", database_path)
        .env(
            "ARCHIVE_DATA_PATH",
            configured_path("ARCHIVE_DATA_PATH", || archive_root.join("data")),
        )
        .env(
            "ARCHIVE_DOWNLOAD_PATH",
            configured_path("ARCHIVE_DOWNLOAD_PATH", || archive_root.join("downloads")),
        )
        .env(
            "ARCHIVE_LIBRARY_PATH",
            configured_path("ARCHIVE_LIBRARY_PATH", || archive_root.join("library")),
        )
        .env(
            "ARCHIVE_TEMP_PATH",
            configured_path("ARCHIVE_TEMP_PATH", || archive_root.join("tmp")),
        )
        .env(
            "ARCHIVE_MOCK_MODE",
            configured_path("ARCHIVE_MOCK_MODE", || PathBuf::from("false")),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(media_tools_dir) = media_tools_dir {
        command.env("ARCHIVE_MEDIA_TOOLS_DIR", media_tools_dir);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    Ok(command)
}

fn health_check(port: u16) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(250))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(
            format!(
                "GET /api/healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .map_err(|error| error.to_string())?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err(format!(
            "API health endpoint returned an unexpected response: {response}"
        ))
    }
}

fn wait_for_health(port: u16) -> Result<(), String> {
    let started = Instant::now();
    let mut last_error = String::from("The API did not answer yet.");
    while started.elapsed() < HEALTH_TIMEOUT {
        match health_check(port) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err(format!(
        "The local API did not become ready within {} seconds: {last_error}",
        HEALTH_TIMEOUT.as_secs()
    ))
}

fn redact_diagnostic(line: &str) -> String {
    let mut redacted = line.to_string();
    for marker in [
        "authorization",
        "cookie",
        "token",
        "secret",
        "password",
        "api_key",
        "apikey",
    ] {
        if let Some(index) = redacted.to_lowercase().find(marker) {
            redacted.truncate(index + marker.len());
            redacted.push_str("=[REDACTED]");
            break;
        }
    }
    if redacted.len() > 500 {
        redacted.truncate(500);
        redacted.push('…');
    }
    redacted
}

fn pipe_lines(
    reader: impl Read + Send + 'static,
    source: &'static str,
    sender: mpsc::Sender<(String, String)>,
) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = sender.send((source.to_string(), line));
        }
    });
}

fn wait_for_ready(
    child: &mut Child,
    stdout: ChildStdout,
    stderr: ChildStderr,
) -> Result<(u16, String), String> {
    let (sender, receiver) = mpsc::channel();
    pipe_lines(stdout, "stdout", sender.clone());
    pipe_lines(stderr, "stderr", sender);
    let started = Instant::now();
    let mut diagnostics = VecDeque::with_capacity(DIAGNOSTIC_LINES);

    while started.elapsed() < HEALTH_TIMEOUT {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let detail = diagnostics.into_iter().collect::<Vec<_>>().join("\n");
            return Err(format!(
                "The local API exited before it was ready ({status}).{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!("\nRecent diagnostics:\n{detail}")
                }
            ));
        }
        if let Ok((source, line)) = receiver.recv_timeout(Duration::from_millis(100)) {
            if let Some(payload) = line.strip_prefix(READY_PREFIX) {
                let value: serde_json::Value = serde_json::from_str(payload).map_err(|_| {
                    "The local API returned an invalid readiness message.".to_string()
                })?;
                let port = value["port"]
                    .as_u64()
                    .and_then(|port| u16::try_from(port).ok())
                    .filter(|port| *port > 0)
                    .ok_or_else(|| {
                        "The local API did not report a valid loopback port.".to_string()
                    })?;
                return Ok((port, diagnostics.into_iter().collect::<Vec<_>>().join("\n")));
            }
            if diagnostics.len() == DIAGNOSTIC_LINES {
                diagnostics.pop_front();
            }
            diagnostics.push_back(format!("[{source}] {}", redact_diagnostic(&line)));
        }
    }

    let detail = diagnostics.into_iter().collect::<Vec<_>>().join("\n");
    Err(format!(
        "The local API did not report readiness within {} seconds.{}",
        HEALTH_TIMEOUT.as_secs(),
        if detail.is_empty() {
            String::new()
        } else {
            format!("\nRecent diagnostics:\n{detail}")
        }
    ))
}

fn show_startup_error(window: &WebviewWindow, message: &str) {
    let escaped =
        serde_json::to_string(message).unwrap_or_else(|_| "\"Unknown startup error\"".into());
    let script = format!(
        "document.body.innerHTML = '<main style=\"font-family:system-ui;padding:48px;color:#263844\"><h1>ARCHIVE ASSISTANT could not start</h1><p>' + {escaped} + '</p><p>Close this window and try again after checking the local API and Node runtime.</p></main>';"
    );
    let _ = window.eval(&script);
    let _ = window.show();
}

fn start_sidecar(app: &AppHandle, window: &WebviewWindow) -> Result<SidecarState, String> {
    let mut child = sidecar_command(app)?.spawn().map_err(|error| {
        format!(
            "Could not start the bundled local API runtime. ARCHIVE_NODE_PATH may override it for diagnostics: {error}"
        )
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture local API output.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not capture local API diagnostics.".to_string())?;
    let port = match wait_for_ready(&mut child, stdout, stderr) {
        Ok((port, _)) => port,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let state = SidecarState::new(child);

    if let Err(error) = wait_for_health(port) {
        state.shutdown();
        show_startup_error(window, &error);
        return Err(error);
    }

    let base_url = format!("http://127.0.0.1:{port}");
    // The frontend waits for this value before it mounts, because the port is
    // only known once the sidecar is listening. Dispatch an event as well as
    // setting the global so the wait ends immediately rather than on the next
    // poll tick.
    let script = format!(
        "window.__ARCHIVE_API_BASE_URL__ = {}; window.dispatchEvent(new Event('archive:api-base-url'));",
        serde_json::to_string(&base_url).unwrap_or_else(|_| "\"http://127.0.0.1:8080\"".into())
    );
    window
        .eval(&script)
        .map_err(|error| format!("Could not configure the desktop API base URL: {error}"))?;
    // Autostart passes --minimized. Normal launches reveal the window; boot
    // launches remain tray-only until the user chooses Open.
    if !env::args().any(|argument| argument == "--minimized") {
        window
            .show()
            .map_err(|error| format!("Could not reveal the desktop window: {error}"))?;
    }
    Ok(state)
}

#[derive(serde::Serialize)]
struct UpdateStatus {
    available: bool,
    version: Option<String>,
    date: Option<String>,
    body: Option<String>,
}

#[tauri::command]
fn set_start_with_windows(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|error| error.to_string())?;
    } else {
        manager.disable().map_err(|error| error.to_string())?;
    }
    manager.is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_archive_assistant(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "The main desktop window is missing.".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<UpdateStatus, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(match update {
        Some(update) => UpdateStatus {
            available: true,
            version: Some(update.version),
            date: update.date.map(|date| date.to_string()),
            body: update.body,
        },
        None => UpdateStatus { available: false, version: None, date: None, body: None },
    })
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "No signed release update is available.".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    app.restart();
}

fn install_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // The application icon configured in tauri.conf.json is embedded into the
    // generated Tauri context, but tray icons are not inferred from it. An
    // explicit icon is required or Windows can create a functioning tray
    // object with no visible notification-area glyph.
    let tray_icon = app
        .default_window_icon()
        .cloned()
        .ok_or("The bundled application icon is unavailable for the tray")?;

    let open = MenuItemBuilder::with_id("open", "Open Archive Assistant").build(app)?;
    let scan = MenuItemBuilder::with_id("scan", "Start/resume archive scan").build(app)?;
    let plex = MenuItemBuilder::with_id("plex", "Sync Plex").build(app)?;
    let activity = MenuItemBuilder::with_id("activity", "View Activity").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Settings").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&open, &scan, &plex, &activity, &settings, &quit])
        .build()?;

    TrayIconBuilder::with_id("archive-assistant")
        .icon(tray_icon)
        .menu(&menu)
        .tooltip("ARCHIVE ASSISTANT")
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                app.exit(0);
                return;
            }
            let _ = app.emit("tray://action", event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().args(["--minimized"]).build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            set_start_with_windows,
            open_archive_assistant,
            check_for_update,
            install_update,
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "The main desktop window is missing.".to_string())?;
            install_tray(&app.handle()).map_err(|error| error.to_string())?;

            // Handle the native close request on the window itself. Tauri's
            // window callback runs before the platform close is committed;
            // preventing it here is what keeps the event loop and sidecar
            // alive on Windows. Handling this only from RunEvent is too late
            // for some Windows window-manager paths and can leave a stale tray
            // menu after the sidecar has exited.
            let close_window = window.clone();
            // Tauri returns a drop guard for window listeners. It must live for
            // the lifetime of the app; dropping it at the end of setup silently
            // unregisters the close handler, which lets Windows destroy the
            // webview and leaves only a stale-looking tray icon behind.
            let close_handler = window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = close_window.hide();
                }
            });
            std::mem::forget(close_handler);

            match start_sidecar(&app.handle(), &window) {
                Ok(state) => {
                    app.manage(state);
                    Ok(())
                }
                Err(error) => {
                    eprintln!("{error}");
                    show_startup_error(&window, &error);
                    Ok(())
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ARCHIVE ASSISTANT")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                if let Some(state) = app.try_state::<SidecarState>() {
                    state.shutdown();
                }
            }
        });
}
