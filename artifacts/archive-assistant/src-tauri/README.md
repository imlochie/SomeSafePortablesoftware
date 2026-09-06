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

Set `ARCHIVE_NODE_PATH` when the `node` executable is not on `PATH`. Existing
runtime variables such as `ARCHIVE_DB_PATH`, archive directories, and tool paths
are forwarded to the sidecar. The desktop shell always overrides `AUTH_MODE` to
`local`, `API_HOST` to `127.0.0.1`, and chooses its own loopback port.

## Production build

```text
pnpm --filter @workspace/archive-assistant exec tauri build
```

The build includes the existing frontend output and API bundle as resources.
The proof of concept does not bundle a Windows Node runtime. A packaged Windows
build therefore still needs `ARCHIVE_NODE_PATH` to point to a compatible
`node.exe`, or a later packaging phase must add a portable Node runtime to the
application resources. Media tools are also intentionally not bundled.

The existing web workflow, Clerk mode, SQLite schema, database location policy,
media engine, and API ownership boundary are unchanged.