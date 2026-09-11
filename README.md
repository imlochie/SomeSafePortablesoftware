# ARCHIVE ASSISTANT

ARCHIVE ASSISTANT is a Windows-first, local-first personal media archive control system. It uses a React/Vite interface and an Express/Node local engine with SQLite persistence.

## Product status

### Implemented

- Dark desktop application shell with HOME, ASSISTANT, QUEUE, ARCHIVE, PLEX, SOURCES, HISTORY, and SETTINGS navigation.
- Embedded SQLite database initialized automatically at `data/archive-assistant.sqlite`.
- Schema foundation for Plex libraries and media, archive items, sources, download and processing jobs, queue items, file records, assistant conversations and messages, system events, and settings.
- Persistent settings and Plex configuration storage through the local API.
- System health overview with honest status labels.
- Dependency detection for Node.js, SQLite, FFmpeg, and yt-dlp without running arbitrary shell commands.
- Mock mode, local logging, and server-side secret handling.
- Windows launch files: `install.ps1`, `start.ps1`, and `start.bat`.

### Intentionally deferred

- Production AI assistant responses and local-model integration.
- Autonomous archive actions.
- Bundled media-tool packaging (FFmpeg, FFprobe, and yt-dlp).

The UI reports unconfigured providers as disconnected and surfaces real provider errors instead of fabricating availability.

Plex synchronization, archive scanning and review, controlled archive
operations, provider-backed acquisitions, and durable operational history are
implemented. See [`docs/archive-goals-freeze-review.md`](docs/archive-goals-freeze-review.md)
for the original-goal classification and remaining release work.

## Run on Windows

1. Install Node.js 22 or newer.
2. Enable pnpm if needed: `corepack enable`.
3. Run `.\install.ps1` from PowerShell.
4. Run `.\start.ps1`, or double-click `start.bat`.
5. Open `http://localhost:3000`. Local mode opens HOME directly without Clerk.

The API runs on port 8080 and the SQLite database path can be overridden with `ARCHIVE_DB_PATH`. The local start script sets it to the project `data` folder.

## Build the Windows desktop installer

Run `pnpm --filter @workspace/archive-assistant run desktop:build` on Windows.
The NSIS package includes the Node runtime used for the build, the API bundle,
and the frontend. Installed desktop launches do not require Node on `PATH`.
`ARCHIVE_NODE_PATH` remains available as a diagnostic override.

Desktop defaults place the SQLite database under the application's local data
directory and archive folders under `%USERPROFILE%\ARCHIVE`. The Node API binds
its own available loopback port and reports startup diagnostics to the shell;
credential-like values are redacted before an error is displayed.

## Authentication modes

- `AUTH_MODE=local` is the default for the local engine. Requests resolve server-side to the stable `__local__` owner, while existing ownership filters remain active.
- `AUTH_MODE=clerk` preserves the hosted sign-in flow and derives ownership from Clerk user IDs.
- Set frontend `VITE_AUTH_MODE` to the same value. Clerk mode also requires the existing Clerk publishable key.

Legacy `__legacy__` rows may be claimed once by the first active owner. Rows already owned by a real Clerk user are never reassigned automatically.

## Runtime configuration

The local engine centrally accepts `PORT`, `API_HOST`, `API_ALLOWED_ORIGINS`, `ARCHIVE_DB_PATH`, `ARCHIVE_DATA_PATH`, `ARCHIVE_DOWNLOAD_PATH`, `ARCHIVE_LIBRARY_PATH`, `ARCHIVE_TEMP_PATH`, `YT_DLP_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH`, and `ARCHIVE_MOCK_MODE`.

Production local mode binds to `127.0.0.1` by default. Development and Replit workflows continue binding to `0.0.0.0`. The desktop shell directs the generated client to its managed sidecar; web builds continue using relative `/api` URLs.

## Architecture

The application is split into a React/Vite interface and an Express API. The API owns SQLite access, dependency checks, settings, Plex secrets, media extraction, downloads, FFmpeg processing, and archive management. A Tauri shell starts this existing Node engine with its bundled Node runtime as a managed sidecar.

All user-configured filesystem paths should be validated against configured directories before future file operations are enabled. Tokens and API keys must stay server-side.