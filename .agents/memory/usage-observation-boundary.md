---
name: Usage observation boundary
description: How watch/usage data enters the control plane, and what it is never allowed to do.
---

Archive Assistant never plays media, so it never directly observes a watch. Every watch record is a provider claim and must be stored as an owner-scoped observation with provenance (provider, collection time, upstream record identity), alongside `plex_item` rather than above it. Ingestion is append-only and deduplicated on a stable observation identity; collected observations are never re-derived from the provider. Sessions, aggregates, habits, and patterns are recomputable derivations carrying an evidence hash over their inputs, not remembered numbers.

**Why:** Upstream history is lossy and retention-limited. Plex retains no analytics-grade history and reports owner-scoped `viewCount`/`lastViewedAt` through the owner token; Jellyfin records nothing without the Playback Reporting plugin, which trims past 12 months by default. History trimmed upstream is unrecoverable, so the local copy is the only durable record — and a provider gap is indistinguishable from genuine inactivity unless coverage is recorded as a fact.

**How to apply:** Store explicit observation coverage windows so "watched nothing" is distinguishable from "observed nothing", and qualify every usage metric with its identity-resolution coverage denominator. Retain unresolved observations; never attribute them to a nearest match. Usage findings are advisory: they may contribute evidence to a recommendation but must never shorten the path from observation to file mutation, and a never-watched signal must carry its coverage qualification into any review record. Treat watch history and device/client identifiers as the most sensitive data in the product — owner-isolated, excluded from logs, and given an explicit retention class.
