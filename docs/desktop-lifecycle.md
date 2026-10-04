# Desktop lifecycle foundation

Archive Assistant keeps the Tauri application as a thin Windows shell. The bundled Node/API process remains the authority for settings, scans, Plex synchronization, activity, acquisition, approvals, and archive mutations.

## Startup

`startWithWindows` is stored in the normal local settings database and defaults to `false`. Existing installs therefore remain opt-in. When enabled from Settings, the shell registers the Tauri autostart entry with `--minimized`; Windows startup keeps the app in the tray and starts the bundled API/runtime without opening the main window. A normal user launch opens the window.

## Tray

The tray menu is intentionally non-destructive:

- Open Archive Assistant
- Start/resume archive scan
- Sync Plex
- View Activity
- Settings
- Quit

Tray commands are emitted to the webview and routed by the existing frontend API calls. Rust does not create a second control plane. Closing the window hides it; Quit exits the shell and terminates the sidecar.

The shell currently exposes the tray action routing and the existing web/API status surfaces. Live online/scanning/Plex state can be added to the tray tooltip without moving authority into Rust.

## Updates

Release updates use the official Tauri updater plugin and a pinned GitHub release manifest:

```text
Arena/GitHub release
  -> signed Windows installer and updater artifact
  -> app checks the release endpoint on operator request
  -> app shows availability and version
  -> operator approves installation
  -> signed package installs and the app restarts
```

The updater public key is embedded in `src-tauri/tauri.conf.json`. The corresponding private signing key must remain in the release secret store; it must never be committed. Development builds and release builds are separate: development uses the local dev server and does not install arbitrary commits, while release updates come only from the configured release endpoint and are signature-verified by Tauri.

Updates are optional and are not silently installed. The local app database/configuration lives in the per-user app-data/runtime paths and is not inside the installed application bundle, so an installer update must preserve it.

## Windows verification still required

The following must be verified on a real Windows machine and signed build:

1. enabling/disabling the preference creates/removes the expected per-user startup registration;
2. boot launch starts the bundled Node runtime and stays tray-only;
3. tray actions reach the existing API and the sidecar survives hide/show cycles;
4. WebView2/Tauri updater signature verification, installer download, restart, and rollback/failure behavior;
5. the database path and settings remain unchanged across an update;
6. tray icon rendering and menu behavior on Windows 10/11.
