# ARCHIVE ASSISTANT

Windows-first local media archive control system. Phase 1 provides the shell, local SQLite foundation, honest system readouts, persistent settings, and extension points for future media integrations.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Local API storage uses the embedded Node.js `node:sqlite` runtime. `ARCHIVE_DB_PATH` can override the SQLite file location.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + Wouter + TanStack Query

## Where things live

- `artifacts/archive-assistant` — React/Vite application and the Phase 1 UI.
- `artifacts/api-server/src/lib/archive-db.ts` — SQLite initialization, schema foundation, settings, and event storage.
- `artifacts/api-server/src/routes/` — health, system diagnostics, settings, Plex configuration, and integration status APIs.
- `artifacts/api-server/src/integrations/` — abstract media capabilities, adapter registry, Plex wiring, and explicit disconnected adapters for future integrations.
- `artifacts/api-server/src/services/acquisition-jobs.ts` — durable provider-backed acquisition lifecycle and transition history; it does not replace the local download engine or mutate archive files automatically.
- `artifacts/api-server/src/services/media-acquisition.ts` — owner-scoped registry orchestration for media lookup, missing-media discovery, and archive-context acquisition requests.
- `lib/api-spec/openapi.yaml` — API contract source of truth.
- `install.ps1`, `start.ps1`, `start.bat`, `README.md` — Windows local setup and launch.

## Architecture decisions

- SQLite is initialized through Node's embedded `node:sqlite` runtime so a separate database service is not required for the Windows-first product.
- The API never returns Plex tokens; configuration endpoints expose only safe status fields.
- Intelligence/control-plane code must use abstract integration capabilities through the registry; adapters may report disconnected and must not return mocked external data.
- Sonarr, Radarr, Prowlarr, and qBittorrent use environment configuration only; API keys, passwords, and session cookies stay server-side and are never included in status responses or logs.
- The control plane uses durable local persistence; external providers remain explicit, replaceable adapters with honest disconnected/error states.
- Optional dependency detection uses direct process execution without a shell and never accepts arbitrary commands from the UI.

## Product

The app gives a personal media archivist a local control room for archive state, downloads, review decisions, approved acquisitions and filesystem operations, Plex synchronization, naming proposals, system events, sources, and history.

## User preferences

- Keep the product local-first and Windows-first.
- Do not claim Plex, AI, yt-dlp, FFmpeg, downloading, processing, or archive workflows are implemented until they are actually wired.

## Gotchas

- Node.js 22+ is required for the embedded `node:sqlite` runtime.
- The local launcher starts the API on port 8080 and the Vite UI on port 3000.
- `YT_DLP_PATH`, `FFMPEG_PATH`, and `FFPROBE_PATH` can provide Windows executable defaults; the same paths are editable in System Settings.
- External integration configuration uses `SONARR_URL`/`SONARR_API_KEY`, `RADARR_URL`/`RADARR_API_KEY`, `PROWLARR_URL`/`PROWLARR_API_KEY`, and `QBITTORRENT_URL`/`QBITTORRENT_USERNAME`/`QBITTORRENT_PASSWORD`. Sonarr/Radarr requests may also use their `*_ROOT_FOLDER` and `*_QUALITY_PROFILE_ID` defaults. Signed Sonarr/Radarr acquisition webhooks use `SONARR_WEBHOOK_SECRET` and `RADARR_WEBHOOK_SECRET` at `/api/acquisition-webhooks/{provider}`.
- Acquisition jobs are owner-scoped and expose their provider references plus transition history through `/api/acquisition-jobs`. Provider refreshes may advance the external portion of a job; processing, verification, importing, and completion remain explicit control-plane transitions.
- Archive acquisition requests use `/api/archive/media-lookup`, `/api/archive/missing-media`, and `/api/archive/acquisitions`; archive identity and policy context are persisted as request metadata before provider calls.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
