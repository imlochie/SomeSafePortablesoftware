---
name: Integration adapter boundary
description: The control-plane integration seam and status rules for external media systems.
---

The intelligence/control plane must depend on capability contracts and the adapter registry, not on Sonarr, Radarr, Prowlarr, qBittorrent, MPilot, Telegram, or any other external tool directly. External systems are replaceable providers, while Archive Assistant remains the source of truth for archive identity, quality, decisions, and Plex state.

**Why:** Acquisition and ingestion tools have different ownership and availability. Direct tool coupling would make an unavailable service look authoritative or force the intelligence layer to change whenever a provider changes.

**How to apply:** Add new behavior as an abstract capability first. Resolve it through the registry, require an operational adapter before execution, and have unimplemented or unconfigured adapters report disconnected and fail explicitly rather than returning placeholder data. Plex adapters must wrap the existing Plex service. HTTP adapters must keep credentials server-side, use bounded timeouts, classify auth/transport/malformed-response failures, and never log raw response bodies.