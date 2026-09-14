---
name: Desktop sidecar boundary
description: Durable constraints for the ARCHIVE ASSISTANT Tauri desktop wrapper and its Node sidecar.
---

The desktop application must remain a thin Tauri shell around the existing React/Vite frontend and Node/Express engine. Rust starts and stops Node, selects a loopback port, waits for `/api/healthz`, and supplies the API base URL; it must not own SQLite, authentication decisions, Plex credentials, media processing, or archive policy.

**Why:** Preserving one backend and one database owner prevents desktop and web behavior from diverging and keeps the local/Clerk ownership boundary enforceable server-side.

**How to apply:** Pass `AUTH_MODE=local`, `API_HOST=127.0.0.1`, an explicit `ARCHIVE_DB_PATH`, and the existing configurable data/archive/download/temp/tool paths to the sidecar. Hosted web builds must continue to use Clerk mode and relative `/api` requests.

Windows installer builds bundle the Node executable running the build and a
pinned, checksum-verified x64 media-tool bundle. yt-dlp, FFmpeg, and FFprobe
remain configurable through explicit operator overrides. In the Linux
workspace, `cargo check` is the reliable cross-platform desktop validation.

**Why:** Bundling Node and the portable media tools makes launches
self-contained without moving SQLite, media, provider, or filesystem
responsibilities into Rust. Explicit overrides preserve operator control over
versions and diagnostics.

**How to apply:** Stage the active Windows Node executable and the verified
media tools during the Tauri build, prefer those packaged resources at launch,
and retain `ARCHIVE_NODE_PATH`, `YT_DLP_PATH`, `FFMPEG_PATH`, and
`FFPROBE_PATH` as explicit overrides.

Declare `bundle.resources` in the map form, `{"source/": "destination/"}`, with
a trailing slash on both sides. Tauri v2's source syntax defines `dir/`
(recursive), `dir/*` (non-recursive) and explicit globs; a **bare directory
name has no defined meaning**. A plain `"runtime"` entry packaged nothing while
the build still reported success, so `node.exe` was staged and then never
copied into the installer. The map form also pins an explicit destination,
which avoids relying on the array form's `..` → `_up_` and absolute → `_root_`
rewriting.

On Windows `resource_dir()` is the directory containing the executable — in
`tauri-utils`, `resolve_resource_dir` returns `exe_dir` directly under
`cfg!(target_os = "windows")`. There is **no `resources` segment**; that is the
macOS layout (`${exe_dir}/../Resources`). So resources sit beside the exe:
`target/release/<resource>` for a local build, and `$INSTDIR/<resource>` once
NSIS installs. Verifying a `resources/` subdirectory checks a path the
application never reads.

A packaged install must never fall back to a system Node; a missing bundled
runtime is a hard error in release builds.

Startup failures must stay self-reporting. A packaged launch has no console, so
the sidecar's recent stdout/stderr and — when a resource is missing — the actual
packaged resource tree are included in the error shown in the window.

**Why:** The dev-path probe in `api_entry_path()` masks a wrong packaged path
during `pnpm dev`, so this class of bug only reproduces in a built installer —
and a silent `node.exe`-on-PATH fallback turns a broken install into a
confusing downstream failure while defeating the no-system-Node guarantee.
Worse, a resource that fails to package is not a build error: the bundler
reports success either way, so only an assertion against the built layout
catches it.

The desktop frontend must resolve its API base URL before React mounts. Rust
starts the sidecar with `PORT=0` and injects `window.__ARCHIVE_API_BASE_URL__`
only after the readiness and health handshake, whereas the webview begins
loading `index.html` immediately — so reading that global at module scope
always loses the race and leaves requests as relative `/api` paths against the
webview origin. `EventSource` bypasses the generated client's `setBaseUrl`
entirely and needs the same treatment. The API's CORS allowlist must accept
every desktop webview origin: `tauri://localhost` on macOS/Linux **and**
`http://tauri.localhost` on Windows WebView2, whose hostname is not `localhost`
and whose protocol is not `tauri:`.

**How to apply:** Keep the Rust resource lookups and the `bundle.resources`
config in sync, and let
`artifacts/archive-assistant/test/packaged-resource-layout.test.ts` pin that
contract — it is the regression guard available in a Linux workspace where
`cargo` and the Tauri CLI cannot be installed (rustup and the Debian mirrors
are both blocked by the network allowlist).
Bundled media tools must be pinned to immutable release assets. A rolling tag
(FFmpeg-Builds `latest`, or any `nightly`/`continuous` tag) republishes its
assets in place, so a pinned `downloadBytes`/`sha256` pair silently stops
matching and fails the staging guard. Prefer BtbN month-end `autobuild-*` tags:
daily autobuilds are pruned after roughly two weeks, month-end snapshots are
retained for over a year.

**Why:** The size and SHA-256 checks are the only thing preventing a mismatched
binary from being bundled into an installer, so they must never be relaxed to
accommodate upstream drift — the manifest is what changes.

**How to apply:** When refreshing a tool, read `size` and `digest` from the
GitHub release API (`gh api repos/OWNER/REPO/releases/tags/TAG`) rather than a
rolling URL, update `totalDownloadBytes`, and let
`artifacts/archive-assistant/test/media-tools-manifest.test.ts` reject rolling
tags in CI. Note that `release-assets.githubusercontent.com` is blocked by the
workspace network allowlist, so assets cannot be downloaded here for
independent hashing; the API digest is the available source of truth.
