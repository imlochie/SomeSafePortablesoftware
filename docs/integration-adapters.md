# Integration adapter foundation

## Architecture map

```text
Authenticated /api routes (local owner or Clerk user ID)
  -> IntegrationService (owner scope, configuration, discovery, safe dispatch)
    -> IntegrationRegistry (immutable provider definitions; no owner state)
      -> IntegrationAdapter (provider-neutral contracts)
        -> Plex adapter -> existing Plex service -> validated HTTP / SQLite cache
        -> unavailable catalog entries (no transport, credentials, or execution)
```

Before this change there was no general integration adapter implementation.
`services/plex.ts` already owns real connection testing, URL/target validation,
token headers, pagination, synchronization, and owner-scoped persistence. The
adapter wraps that service rather than rewriting or duplicating it. Existing
`/plex/*` endpoints, synchronization, UI, and archive/reconciliation/naming
queries continue unchanged. Those legacy direct Plex table consumers are **not**
migrated by this foundation; new control-plane consumers should use the adapter
service rather than introducing new provider-specific dependencies.

The existing download engine owns local tool execution, job lifecycle, recovery,
and owner-filtered notifications. It is not replaced or connected to remote
acquisition. `source_record` is owner-scoped source metadata, not an integration
instance or registry. No source scraping or downloader is added.

## Contracts and discovery

`src/integrations/contracts.ts` defines owner context, connection status,
configuration, capability vocabulary, normalized media identities and payloads,
and adapter/handler interfaces. IDs in normalized inventory are opaque and
integration-local. They must not be interpreted as provider API identifiers.
The boundary does not expose tokens, URLs, transport errors, rating keys, Plex
metadata, or raw provider payloads.

The registry rejects duplicate/invalid IDs and invalid handlers, snapshots its
definitions, and discovers capabilities from actual handlers rather than claims.
It stores no credentials or owner-specific state. New adapters register in the
composition root `src/integrations/index.ts`; the generic service and routes need
no provider-specific branches.

Discovery separates:

- `capabilities`: implemented handlers, even if currently disabled.
- `plannedCapabilities`: design intent only, never advertised as available.
- `availableCapabilities`: implemented and enabled with sufficient configuration.
  Disconnected Plex can still provide its explicitly cached inventory.

| Integration | Implemented | Planned / reserved |
| --- | --- | --- |
| Plex | media host inventory (cached) | — |
| Sonarr | none | availability lookup, acquisition request |
| Radarr | none | availability lookup, acquisition request |
| Prowlarr | none | search source |
| qBittorrent | none | download status, completed-item notification |
| MPilot | none | unspecified pending a verified product/API contract |
| Telegram | none | request ingestion |

Only cached inventory is executable in the production registry. The other
payload types are extension vocabulary, **not complete executable search,
acquisition, subscription, or ingestion protocols**. Before implementing those,
add capability-specific input, pagination, idempotency, authorization and
subscription lifecycle contracts as appropriate. No generic command/shell
endpoint or acquisition execution endpoint exists.

## Owner-scoped configuration and compatibility

The existing `user_setting(owner_id, key)` JSON settings architecture stores
`integration.<id>.enabled` as a boolean. There is no schema migration or new
database. `IntegrationConfiguration` is deliberately limited to enablement;
unsupported providers do not collect unusable credentials.

An explicit setting takes precedence. When absent, a configured adapter defaults
to enabled, preserving existing configured Plex installations; unconfigured
integrations are disabled. Enablement gates **only the new adapter boundary**.
Existing `/plex/*` endpoints retain their previous behavior, including direct
sync/test operations. It is not a global shutdown switch for legacy Plex routes.

Plex URL/token configuration stays on `/api/plex/config`, backed by the same
owner-scoped settings and existing validation. No credential copies are created.
The existing storage is not encrypted by this change. Future credential-bearing
adapters must provide validated, write-only secret handling and redacted reads,
not arbitrary settings blobs or globally stored secrets.

Owner IDs are derived server-side from the existing authentication middleware;
configuration requests reject extra fields, including `ownerId` and secrets.
All service operations require owner context. Integration definitions are shared;
configuration, status, connection checks, and inventory are scoped per call.

## Connection and offline semantics

States are `not_configured`, `configured` (not yet verified), `connected`,
`disconnected`, and `unavailable`. Status reports persisted observations, **not**
a live health probe. Disabled status is expressed separately by `enabled: false`.
Listing integrations or reading inventory never probes a network.

Only an explicit connection-test request can invoke existing Plex transport.
Disabled, unconfigured, and placeholder adapters do no network work. Placeholders
always report unavailable, even if enabled; they never simulate success.
Handler/connection exceptions become a generic `unavailable` error rather than
leaking provider diagnostics. Legacy Plex diagnostics remain on legacy endpoints.

Plex inventory uses the current owner/server cache and is explicitly marked
`cached: true`, with a nullable last-successful-sync timestamp. A failed connection
does not delete the cache or imply that cached media is currently reachable.
A configured installation that has never synced can return an empty cache with
no successful timestamp. Disabled/unconfigured inventory dispatch fails safely.

## API and generated consumers

All endpoints sit behind the existing `/api` authentication boundary:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/integrations` | Owner-scoped config/status/capability catalog |
| PATCH | `/api/integrations/{integrationId}/config` | Strict `{ "enabled": boolean }` |
| POST | `/api/integrations/{integrationId}/test-connection` | Explicit connection check or safe no-op status |
| GET | `/api/integrations/{integrationId}/inventory` | Normalized cached media inventory |

Unknown integrations return 404. Invalid configuration returns 400. Disabled,
unsupported, or unconfigured dispatch returns 409. Operational adapter failure
returns 503. Connection failures normally return 200 with `state: disconnected`,
matching the existing Plex connection-test convention. Authentication failures
are handled centrally (401 in Clerk mode; local-first mode needs no credentials).

`lib/api-spec/openapi.yaml` is the source of truth. Regenerate React Query clients,
TypeScript models, and Zod schemas with:

```sh
pnpm --filter @workspace/api-spec run codegen
```

## Validation and scope

`test/integrations.test.ts` is imported by the existing ownership test entrypoint,
so the existing test command runs both suites against the runner's temporary
SQLite database. It tests registry validation, capability discovery, owner
isolation, disabled/unconfigured behavior, placeholders, normalized dispatch,
redaction, error handling, and real Express routes using a loopback test server.
The existing test-only Plex HTTP server also exercises the adapter's connection
check and normalized inventory alongside the original real transport/sync tests.
No Plex credentials or real external services are needed.

Production archives/databases, `start.ps1`, local tools, download behavior, and
legacy Plex implementation are unchanged. No UI, assistant/LLM, new downloader,
torrent infrastructure, external ingestion, or acquisition executor is included.

### Validation results (2026-09-10)

- `pnpm run typecheck`: passed.
- `pnpm --filter @workspace/api-server run test`: **10 passed, 2 failed**.
  All six new integration tests and the expanded Plex regression passed.
  Existing download ownership test fails with `Temporary directory is required.`
  Existing archive scan test expects six scanned files but receives three.
  Running the original `main` ownership test and runner reproduced both failures
  (four passed, two failed), without the integration tests. These unrelated
  failures have not been hidden, skipped, or fixed by changing production logic.
- `pnpm --filter @workspace/archive-assistant run build`: passed, with Vite's
  sourcemap warning for `src/components/ui/tooltip.tsx`.
- `pnpm --filter @workspace/api-server run build`: passed.
- OpenAPI/Orval code generation: passed.
