---
name: Local runtime boundary
description: The approved runtime placement and executable-path policy for the local-first archive engine
---

The existing Express API and its media services are the local engine for Windows deployments. Do not introduce a second worker service or replace the current API seam unless this decision is explicitly revisited.

**Why:** The product is local-first, and yt-dlp, FFmpeg, FFprobe, SQLite, and archive filesystem access must execute on the operator’s Windows machine rather than in browser code or an assumed hosted worker.

**How to apply:** Keep browser code limited to control-plane requests. Resolve yt-dlp, FFmpeg, and FFprobe from persisted settings, with environment-variable defaults and executable-name fallback; never embed a specific operator’s machine path in source.