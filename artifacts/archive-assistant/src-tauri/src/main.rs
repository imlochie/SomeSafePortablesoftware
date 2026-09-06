#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, RunEvent, WebviewWindow};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(20);

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

fn choose_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not reserve a local API port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not read the reserved local API port: {error}"))
}

fn configured_path(name: &str, fallback: impl FnOnce() -> PathBuf) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback().to_string_lossy().into_owned())
}

fn api_entry_path(app: &AppHandle) -> PathBuf {
    let development_path = workspace_root()
        .join("artifacts")
        .join("api-server")
        .join("dist")
        .join("index.mjs");
    if development_path.exists() {
        return development_path;
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| workspace_root());
    let packaged_path = resource_dir.join("dist").join("index.mjs");
    if packaged_path.exists() {
        return packaged_path;
    }
    resource_dir
        .join("api-server")
        .join("dist")
        .join("index.mjs")
}

fn node_command() -> String {
    env::var("ARCHIVE_NODE_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "node.exe".to_string()
            } else {
                "node".to_string()
            }
        })
}

fn sidecar_command(app: &AppHandle, port: u16) -> Result<Command, String> {
    let root = workspace_root();
    let database_path = configured_path("ARCHIVE_DB_PATH", || {
        root.join("data").join("archive-assistant.sqlite")
    });
    let api_entry = api_entry_path(app);
    if !api_entry.exists() {
        return Err(format!(
            "The API bundle was not found at {}. Build the API before launching the desktop shell.",
            api_entry.display()
        ));
    }

    let mut command = Command::new(node_command());
    command
        .arg("--enable-source-maps")
        .arg(api_entry)
        .env("NODE_ENV", "production")
        .env("AUTH_MODE", "local")
        .env("API_HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("ARCHIVE_DB_PATH", database_path)
        .env(
            "ARCHIVE_DATA_PATH",
            configured_path("ARCHIVE_DATA_PATH", || PathBuf::from("~/ARCHIVE/data")),
        )
        .env(
            "ARCHIVE_DOWNLOAD_PATH",
            configured_path("ARCHIVE_DOWNLOAD_PATH", || {
                PathBuf::from("~/ARCHIVE/downloads")
            }),
        )
        .env(
            "ARCHIVE_LIBRARY_PATH",
            configured_path("ARCHIVE_LIBRARY_PATH", || {
                PathBuf::from("~/ARCHIVE/library")
            }),
        )
        .env(
            "ARCHIVE_TEMP_PATH",
            configured_path("ARCHIVE_TEMP_PATH", || PathBuf::from("~/ARCHIVE/tmp")),
        )
        .env(
            "YT_DLP_PATH",
            configured_path("YT_DLP_PATH", || PathBuf::from("yt-dlp")),
        )
        .env(
            "FFMPEG_PATH",
            configured_path("FFMPEG_PATH", || PathBuf::from("ffmpeg")),
        )
        .env(
            "FFPROBE_PATH",
            configured_path("FFPROBE_PATH", || PathBuf::from("ffprobe")),
        )
        .env(
            "ARCHIVE_MOCK_MODE",
            configured_path("ARCHIVE_MOCK_MODE", || PathBuf::from("false")),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

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
    let port = choose_loopback_port()?;
    let child = sidecar_command(app, port)?.spawn().map_err(|error| {
        format!(
            "Could not start the local Node API. Check ARCHIVE_NODE_PATH and the Node runtime: {error}"
        )
    })?;
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
