# Provider refresh semantics

Provider refresh state is deliberately split across status, snapshot completeness, and authority. They must not be collapsed into one `last refresh` value.

| status | snapshot completeness | authoritative | meaning |
| --- | --- | --- | --- |
| `syncing` | `unknown` | `false` | an attempt is in progress |
| `synced` | `complete` | `true` | a complete observation was committed and may represent provider truth |
| `sync_error` | `partial` | `false` | the provider answered incompletely; the last authoritative snapshot remains truth |
| `sync_error` | `unknown` | `false` | the attempt failed before a trustworthy snapshot existed |

The following combinations are invalid:

- `synced` with `partial` or `unknown` completeness;
- `sync_error` with authoritative true;
- `authoritative` with partial or unknown completeness;
- `syncing` with authoritative true.

A partial or failed observation is never interpreted as an empty provider inventory. Only a committed `synced` and `complete` refresh can change reconciliation absence truth.

The API exposes three separate pointers:

- `lastAttemptedRefresh`: newest attempt regardless of outcome;
- `lastSuccessfulRefresh`: newest complete successful observation;
- `currentAuthoritativeRefresh`: the refresh whose snapshot backs current provider truth.
