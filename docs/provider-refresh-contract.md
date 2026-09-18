# Provider Refresh Contract

Provider refresh is an explicit, owner-scoped observation action. It never runs as an implicit side effect of filesystem mutation.

## Invariants

- [x] Owner-scoped request, state, events, credentials, and inventory.
- [x] Explicit operator confirmation is required after a verified archive operation.
- [x] One refresh at a time per provider and owner.
- [x] `syncing` is persisted before remote work begins.
- [x] Successful refresh exits `syncing` and records a successful timestamp.
- [x] Failed refresh exits `syncing` and records a public error.
- [x] A failed or incomplete refresh does not prune the previous complete inventory.
- [x] Retry is possible after failure.
- [x] Provider status remains visible while reconciliation is pending.
- [x] Frontend polling is bounded and surfaces a timeout without claiming success.
- [x] Plex and Jellyfin refresh locks are independent.

## Lifecycle

```text
not_configured / idle
        |
        | explicit refresh confirmation
        v
     syncing
      /    \
     /      \
 synced   sync_error
              |
              | explicit retry
              +------> syncing
```

A request that exceeds the bounded client polling window is reported as **not yet reconciled**. Polling timeout is not treated as provider success; the persisted provider status remains authoritative.

## Evidence rules

A provider sync may only replace an inventory after a complete remote snapshot has been fetched. Library-level failures preserve the previous inventory and remain warnings or errors in provider state. No provider response is allowed to manufacture archive identity or authorize a filesystem operation.

## Test coverage

The backend covers owner isolation, single-flight Jellyfin refreshes, failed refresh recovery, complete-fetch preservation, and retry. The UI covers bounded status polling and timeout disclosure. Live Plex/Jellyfin credentials and production archive mutation remain operational validation work rather than automated test fixtures.
