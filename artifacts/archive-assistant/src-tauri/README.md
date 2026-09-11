# ARCHIVE ASSISTANT desktop proof of concept

This is a minimal Tauri v2 shell around the existing React/Vite frontend and
Express/Node API. It is intentionally not final installer engineering.

## Development

From the repository root:

```text
pnpm --filter @workspace/archive-assistant exec tauri dev
```

The shell starts the existing Vite development server, builds or reuses the
existing API bundle, starts the API on an available `127.0.0.1` port, waits for
`/api/healthz`, and only then shows the desktop window.

Development uses `node` from `PATH`; `ARCHIVE_NODE_PATH` can override it.
Existing runtime variables such as `ARCHIVE_DB_PATH`, archive directories, and
tool paths are forwarded to the sidecar. The desktop shell always overrides
`AUTH_MODE` to `local` and `API_HOST` to `127.0.0.1`. Node binds an available
loopback port directly and reports it to the shell, avoiding a port reservation
race.

## Production build

```text
pnpm --filter @workspace/archive-assistant run desktop:build
```

Run the build on Windows. It stages the Node executable running the build and
downloads the pinned, SHA-256 verified portable media-tool bundle matching the
Tauri target architecture into the installer resources. The supported targets
are Windows x64 (`x86_64-pc-windows-msvc`) and Windows ARM64
(`aarch64-pc-windows-msvc`). Unsupported architectures fail before an
installer is produced. The installed app therefore does not require separate
Node, FFmpeg, FFprobe, or yt-dlp installs. `ARCHIVE_NODE_PATH`,
`YT_DLP_PATH`, `FFMPEG_PATH`, and `FFPROBE_PATH` remain explicit diagnostic or
operator overrides.

The x64 media bundle adds 187,748,260 bytes (about 179.1 MiB) of verified
download inputs before installer compression. The ARM64 bundle adds
137,996,596 bytes (about 131.6 MiB): yt-dlp 2026.07.04 (22,250,288 bytes) and
the FFmpeg n8.1 LGPL Windows ARM64 archive (115,746,308 bytes). Versions,
source URLs, licenses, and digests for both architectures live in
`scripts/media-tools-manifest.json`; update that manifest and rebuild to
refresh the bundle. The FFmpeg build is LGPL 2.1-or-later and yt-dlp is
Unlicensed. The installed copy also includes
`runtime/media-tools/THIRD-PARTY-NOTICES.txt`.

The existing web workflow, Clerk mode, SQLite schema, database location policy,
media engine, and API ownership boundary are unchanged.