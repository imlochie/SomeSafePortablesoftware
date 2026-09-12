# ARCHIVE ASSISTANT

ARCHIVE ASSISTANT is a Windows-first, local-first personal media archive control system.

## Product status

The project is designed to act as a control layer for a personal media archive, with foundations for Plex integration, media acquisition, processing, archive management, and future AI-assisted workflows.

---

### Intentionally deferred

- Production AI assistant responses and local-model integration.
- Autonomous archive actions.
- Bundled media-tool packaging (FFmpeg, FFprobe, and yt-dlp).

The UI reports unconfigured providers as disconnected and surfaces real provider errors instead of fabricating availability.

Plex synchronization, archive scanning and review, controlled archive
operations, provider-backed acquisitions, and durable operational history are
implemented. See [`docs/archive-goals-freeze-review.md`](docs/archive-goals-freeze-review.md)
for the original-goal classification and remaining release work.

The desktop application launches the Node.js API locally as a managed sidecar.

The API is assigned an available loopback port and the desktop shell waits for the API health endpoint before exposing the application.

The production local API binds to 127.0.0.1 and is not exposed to the network.

## Build the Windows desktop installer

Run `pnpm --filter @workspace/archive-assistant run desktop:build` on Windows.
The NSIS package includes the Node runtime used for the build, the API bundle,
the frontend, and a verified media-tool bundle selected for the Tauri target
architecture. Windows x64 and ARM64 installers are supported; unsupported
architectures fail during staging instead of producing an incompatible
installer. Installed desktop launches do not require Node on `PATH`.
`ARCHIVE_NODE_PATH` remains available as a diagnostic override.

Desktop defaults place the SQLite database under the application's local data
directory and archive folders under `%USERPROFILE%\ARCHIVE`. The Node API binds
its own available loopback port and reports startup diagnostics to the shell;
credential-like values are redacted before an error is displayed.

## Authentication modes

Implemented:

Tauri desktop application.
Windows development runtime.
Managed Node.js API sidecar.
Automatic local API startup.
Automatic API health checks.
Dynamic loopback API port selection.
Automatic API shutdown when the desktop application closes.
SQLite persistence.
Windows application icon generation.
Local development workflow through tauri dev.

The desktop shell has been successfully tested with the existing ARCHIVE ASSISTANT interface and local archive database.

Application

Production local mode binds to `127.0.0.1` by default. Development and Replit workflows continue binding to `0.0.0.0`. The desktop shell directs the generated client to its managed sidecar; web builds continue using relative `/api` URLs.

HOME
ASSISTANT
QUEUE
ARCHIVE
PLEX
SOURCES
HISTORY
SETTINGS

The application is split into a React/Vite interface and an Express API. The API owns SQLite access, dependency checks, settings, Plex secrets, media extraction, downloads, FFmpeg processing, and archive management. A Tauri shell starts this existing Node engine with its bundled Node runtime as a managed sidecar.

Local Engine

The Node.js API provides the application's local engine.

Current foundations include:

SQLite database access.
Persistent application settings.
Plex configuration storage.
Archive item storage.
Media metadata structures.
Source tracking.
Queue and job structures.
Processing job structures.
Assistant conversations and messages.
System event logging.
Dependency detection.
Local mock mode.
Server-side configuration and secret handling.

The API is responsible for future filesystem operations, media acquisition, processing, Plex integration, and archive actions.

Database

ARCHIVE ASSISTANT uses SQLite for persistent local state.

The default local database path is:

data/archive-assistant.sqlite

The database path can be overridden with:

ARCHIVE_DB_PATH

Runtime database files are intentionally excluded from Git.

This includes:

archive-assistant.sqlite
archive-assistant.sqlite-wal
archive-assistant.sqlite-shm

Local database backups should also remain outside the repository unless intentionally archived elsewhere.

Runtime Configuration

The local engine supports:

PORT
API_HOST
API_ALLOWED_ORIGINS

ARCHIVE_DB_PATH
ARCHIVE_DATA_PATH
ARCHIVE_DOWNLOAD_PATH
ARCHIVE_LIBRARY_PATH
ARCHIVE_TEMP_PATH

YT_DLP_PATH
FFMPEG_PATH
FFPROBE_PATH

ARCHIVE_MOCK_MODE

The desktop runtime configures the API automatically.

For local desktop execution:

AUTH_MODE=local
API_HOST=127.0.0.1

The desktop shell dynamically selects an available loopback port for the managed API.

Development
Requirements

Windows development currently requires:

Node.js
pnpm
Rust
Visual Studio Build Tools
Visual C++ build tools
Windows SDK

The Microsoft linker (link.exe) must be available for the Rust MSVC toolchain.

Verify it with:

where link

and:

link
Run the Desktop Application

From the repository root:

pnpm --filter @workspace/archive-assistant exec tauri dev

This will:

Build the API server.
Start the Vite development server.
Compile the Tauri application.
Launch the desktop application.
Start the local Node.js API sidecar.
Wait for the API health check.
Load the application interface.
Frontend Development

The Vite frontend runs on:

http://localhost:3000

During development, API requests can be proxied to the local API.

The production desktop application uses its managed local API runtime.

Icons

The Tauri icon set is generated from:

artifacts/archive-assistant/src-tauri/icons/icon.png

To regenerate the platform icon assets:

pnpm --filter @workspace/archive-assistant exec tauri icon src-tauri/icons/icon.png

This generates:

Windows .ico
macOS .icns
PNG sizes
Android assets
iOS assets
Windows Store assets
Authentication

The application currently supports two authentication modes:

Local
AUTH_MODE=local

Local mode uses the stable local owner:

__local__

This is the primary mode for the local desktop application.

Clerk
AUTH_MODE=clerk

Clerk mode preserves the hosted authentication architecture.

Existing ownership rules remain active and real Clerk user data is not automatically reassigned.

Implemented Foundations

The project currently has foundations for:

Local desktop runtime.
Managed API process.
SQLite persistence.
Archive state.
Plex configuration.
Media metadata.
Sources.
Download and processing jobs.
Queue management.
Assistant conversations.
System events.
Dependency detection.
Local runtime configuration.
Not Yet Fully Implemented

The following areas remain future development work:

Real Plex library synchronization.
Plex library browsing.
Media acquisition through yt-dlp.
Download execution.
FFmpeg processing pipelines.
Hardware-accelerated transcoding.
Filesystem monitoring.
Duplicate detection.
Archive automation.
Real job execution.
AI provider connections.
AI assistant responses.
Automated archive workflows.

The application should continue to show unfinished systems honestly rather than presenting them as connected functionality.

Project Direction

ARCHIVE ASSISTANT is moving toward a local media archive operating system.

The intended progression is:

Foundation
    ↓
Desktop Runtime
    ↓
Operational Core
    ↓
Safe Actions
    ↓
Job System
    ↓
Media Acquisition
    ↓
Processing
    ↓
Archive Intelligence
    ↓
AI Assistant

The immediate focus is the operational core.

That means turning the existing data structures and interface foundations into real, observable application behaviour before expanding into AI-driven features.

Repository Safety

The repository intentionally excludes:

node_modules/
data/
artifacts/api-server/data/
artifacts/archive-assistant/src-tauri/target/

The local SQLite database and runtime artifacts are not committed.

The source code, desktop runtime architecture, generated application icons, configuration, and scripts are committed.

Historical Reconstruction

ARCHIVE ASSISTANT has been developed through multiple reconstruction and migration stages.

The current SQLite archive represents accumulated historical work and should be treated as operational data rather than disposable development seed data.

Before major database migrations or identity reconstruction operations:

Create a database backup.
Record the migration purpose.
Preserve any migration report.
Validate results before deleting older backups.

Database backups belong outside the Git repository.

Current Milestone

The project has reached the following checkpoint:

ARCHIVE ASSISTANT successfully runs as a local Windows desktop application with a Tauri shell, React/Vite interface, managed Node.js API sidecar, SQLite persistence, and existing archive state.

The next phase is to build the operational core.