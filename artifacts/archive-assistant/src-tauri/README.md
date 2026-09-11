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
includes it with the frontend and API bundle, so the installed app does not
require a system Node installation. `ARCHIVE_NODE_PATH` remains an explicit
diagnostic override. Media tools are intentionally not bundled.

The existing web workflow, Clerk mode, SQLite schema, database location policy,
media engine, and API ownership boundary are unchanged.