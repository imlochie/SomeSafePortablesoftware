#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::VecDeque,
    env,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, ChildStderr, ChildStdout, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, RunEvent, WebviewWindow};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);
const READY_PREFIX: &str = "ARCHIVE_ASSISTANT_READY ";
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

fn configured_path(name: &str, fallback: impl FnOnce() -> PathBuf) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback().to_string_lossy().into_owned())
}

/// Resource-relative locations that may hold the bundled API entry point.
///
/// `tauri.conf.json` declares `../../api-server/dist` as a bundled resource.
/// When Tauri packages a resource whose path escapes the `src-tauri` directory
/// it rewrites every leading `..` component to `_up_`, so the canonical
/// installed location is `$RESOURCE/_up_/_up_/api-server/dist/index.mjs`.
/// The remaining entries keep flattened and legacy layouts working.
const API_ENTRY_RESOURCE_CANDIDATES: [&[&str]; 4] = [
    &["_up_", "_up_", "api-server", "dist", "index.mjs"],
    &["_up_", "api-server", "dist", "index.mjs"],
    &["api-server", "dist", "index.mjs"],
    &["dist", "index.mjs"],
];

fn api_entry_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = vec![workspace_root()
        .join("artifacts")
        .join("api-server")
        .join("dist")
        .join("index.mjs")];

    let resource_dir = app
        .path()
        .resource_dir()
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

fn api_entry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let candidates = api_entry_candidates(app);
    if let Some(found) = candidates.iter().find(|candidate| candidate.exists()) {
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

fn node_command(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(configured) = env::var_os("ARCHIVE_NODE_PATH").filter(|value| !value.is_empty()) {
        return Ok(configured.into());
    }

    let bundled = app
        .path()
        .resource_dir()
        .ok()
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
        return Err(format!(
            "The bundled Node runtime is missing from this installation (expected at {location}). Reinstall ARCHIVE ASSISTANT, or set ARCHIVE_NODE_PATH to a Node executable for diagnostics."
        ));
    }

    Ok(PathBuf::from(BUNDLED_NODE_FILE_NAME))
}

fn bundled_media_tools_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|resource_dir| resource_dir.join("runtime").join("media-tools"))
        .filter(|path| path.is_dir())
}

fn sidecar_command(app: &AppHandle) -> Result<Command, String> {
    let root = workspace_root();
    let app_data = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| root.join("data"));
    let archive_root = app
        .path()
        .home_dir()
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
    let script = format!(
        "window.__ARCHIVE_API_BASE_URL__ = {};",
        serde_json::to_string(&base_url).unwrap_or_else(|_| "\"http://127.0.0.1:8080\"".into())
    );
    window
        .eval(&script)
        .map_err(|error| format!("Could not configure the desktop API base URL: {error}"))?;
    window
        .show()
        .map_err(|error| format!("Could not reveal the desktop window: {error}"))?;
    Ok(state)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "The main desktop window is missing.".to_string())?;
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
