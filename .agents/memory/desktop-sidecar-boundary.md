---
name: Desktop sidecar boundary
description: Durable constraints for the ARCHIVE ASSISTANT Tauri desktop wrapper and its Node sidecar.
---

The desktop application must remain a thin Tauri shell around the existing React/Vite frontend and Node/Express engine. Rust starts and stops Node, selects a loopback port, waits for `/api/healthz`, and supplies the API base URL; it must not own SQLite, authentication decisions, Plex credentials, media processing, or archive policy.

**Why:** Preserving one backend and one database owner prevents desktop and web behavior from diverging and keeps the local/Clerk ownership boundary enforceable server-side.

**How to apply:** Pass `AUTH_MODE=local`, `API_HOST=127.0.0.1`, an explicit `ARCHIVE_DB_PATH`, and the existing configurable data/archive/download/temp/tool paths to the sidecar. Hosted web builds must continue to use Clerk mode and relative `/api` requests.

Windows installer builds bundle the Node executable running the build, while yt-dlp, FFmpeg, and FFprobe remain configurable external tools. In the Linux workspace, `cargo check` is the reliable cross-platform desktop validation.

**Why:** Bundling Node makes launches self-contained without moving SQLite, media, provider, or filesystem responsibilities into Rust. Media tools remain separately configurable because operators may manage their versions independently.

**How to apply:** Stage the active Windows Node executable during the Tauri build, prefer that packaged runtime at launch, and retain `ARCHIVE_NODE_PATH` plus existing media tool variables as explicit overrides.