---
name: Plex sync safety
description: Consistency and network-boundary rules for real Plex inventory synchronization.
---

Fetch and validate the complete Plex library snapshot before reconciling SQLite in one transaction. A failed library request must leave the prior inventory intact, and pagination must follow Plex's declared total rather than assuming the requested page size is honored.

**Why:** Plex may cap result pages or fail partway through multiple libraries. Incremental pruning can otherwise produce a mixed or incomplete inventory while the overall sync reports an error.

**How to apply:** Stage every discovered library and item first. Only after all requests succeed should item and library upserts and stale-record pruning commit together.

Plex requests must enforce the configured network mode and connect to the exact DNS address that passed validation, while retaining the original Host header and TLS server name.

**Why:** Checking one DNS resolution and then fetching by hostname leaves a DNS-rebinding path to blocked addresses. Offline mode must also guarantee that no request is attempted.

**How to apply:** Block unsafe address classes and offline operations before opening a socket, reject redirects, and pin each operation to a validated address.