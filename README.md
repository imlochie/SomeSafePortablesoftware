# ARCHIVE ASSISTANT

ARCHIVE ASSISTANT is a Windows-first, local-first personal media archive control system. Phase 1 provides the foundation and control surface for future AI, Plex, yt-dlp, FFmpeg, filesystem monitoring, duplicate detection, and persistent media jobs.

## Phase 1 status

### Implemented

- Dark desktop application shell with HOME, ASSISTANT, QUEUE, ARCHIVE, PLEX, SOURCES, HISTORY, and SETTINGS navigation.
- Embedded SQLite database initialized automatically at `data/archive-assistant.sqlite`.
- Schema foundation for Plex libraries and media, archive items, sources, download and processing jobs, queue items, file records, assistant conversations and messages, system events, and settings.
- Persistent settings and Plex configuration storage through the local API.
- System health overview with honest status labels.
- Dependency detection for Node.js, SQLite, FFmpeg, and yt-dlp without running arbitrary shell commands.
- Mock mode, local logging, and server-side secret handling.
- Windows launch files: `install.ps1`, `start.ps1`, and `start.bat`.

### Placeholder / not yet implemented

- AI assistant responses and provider connections.
- Plex synchronization or library browsing.
- Media extraction or downloading through yt-dlp.
- FFmpeg processing and hardware-accelerated transcodes.
- Filesystem monitoring, duplicate detection, archive actions, and real job execution.

The UI intentionally shows these as placeholders instead of claiming they are connected.

## Run on Windows

1. Install Node.js 22 or newer.
2. Enable pnpm if needed: `corepack enable`.
3. Run `.\install.ps1` from PowerShell.
4. Run `.\start.ps1`, or double-click `start.bat`.
5. Open `http://localhost:3000`.

The API runs on port 5000 and the SQLite database path can be overridden with `ARCHIVE_DB_PATH`. The local start script sets it to the project `data` folder.

## Architecture

The application is split into a React/Vite interface and a small Express API. The API owns SQLite access, dependency checks, settings, and secret-bearing configuration. Future integrations should implement the service boundaries for AI providers, Plex, media extraction, downloading, FFmpeg processing, and archive management rather than giving the assistant arbitrary shell access.

All user-configured filesystem paths should be validated against configured directories before future file operations are enabled. Tokens and API keys must stay server-side.