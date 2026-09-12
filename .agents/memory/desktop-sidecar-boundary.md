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

Resource paths in `tauri.conf.json` do not survive packaging verbatim: Tauri v2
rewrites each leading `..` to `_up_` and an absolute root to `_root_`. So
`"../../api-server/dist"` installs to
`$RESOURCE/_up_/_up_/api-server/dist`, while a plain `"runtime"` stays at
`$RESOURCE/runtime`. A packaged install must never fall back to a system Node;
a missing bundled runtime is a hard error in release builds.

**Why:** The dev-path probe in `api_entry_path()` masks a wrong packaged path
during `pnpm dev`, so this class of bug only reproduces in a built installer —
and a silent `node.exe`-on-PATH fallback turns a broken install into a
confusing downstream failure while defeating the no-system-Node guarantee.

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
