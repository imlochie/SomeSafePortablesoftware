---
name: Desktop sidecar boundary
description: Durable constraints for the ARCHIVE ASSISTANT Tauri desktop wrapper and its Node sidecar.
---

The desktop application must remain a thin Tauri shell around the existing React/Vite frontend and Node/Express engine. Rust starts and stops Node, selects a loopback port, waits for `/api/healthz`, and supplies the API base URL; it must not own SQLite, authentication decisions, Plex credentials, media processing, or archive policy.

**Why:** Preserving one backend and one database owner prevents desktop and web behavior from diverging and keeps the local/Clerk ownership boundary enforceable server-side.

**How to apply:** Pass `AUTH_MODE=local`, `API_HOST=127.0.0.1`, an explicit `ARCHIVE_DB_PATH`, and the existing configurable data/archive/download/temp/tool paths to the sidecar. Hosted web builds must continue to use Clerk mode and relative `/api` requests.

The proof of concept intentionally does not bundle Node, yt-dlp, FFmpeg, or FFprobe. A packaged Windows build therefore needs a later runtime-packaging decision. In the current Linux workspace, `cargo check` is the reliable cross-platform desktop validation; a full release link also needs the Nix zlib library path supplied to the linker.

**Why:** Bundling runtimes and media tools would turn a shell proof of concept into installer engineering and would change the existing path policy.

**How to apply:** Keep `ARCHIVE_NODE_PATH` and the existing tool-path variables configurable, and treat Windows packaging/runtime availability as a separate follow-up.