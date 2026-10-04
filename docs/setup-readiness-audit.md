# Archive Assistant setup readiness audit

**Audit date:** 2026-10-04  
**Audited branch:** `arena/01a107b3-somesafeportablesoftware`  
**Observed head:** `3530dfe` (the requested `c6c7aef` is its parent; no files were reset or discarded)

This is an implementation audit. It does not claim that the values below have been applied or validated on the real Windows laptop. A value is **implemented** when the code has a source of truth and behavior; it is **not ready** until the operator supplies it and the real machine verifies it.

## Readiness vocabulary

- **NOT SET UP:** required input or first-run action is absent.
- **CONFIGURED:** a value is persisted or supplied, but the system has not proved it works.
- **VERIFIED:** an explicit test/read has proved the value or connection at a point in time.
- **READY:** verified and sufficient for the dependent capability.
- **DEGRADED:** usable with a known limitation, stale snapshot, partial metadata, or reduced capability.
- **UNAVAILABLE:** the capability cannot currently be used because a dependency, path, provider, or runtime is inaccessible.
- **OPTIONAL:** not needed for local archive inspection and core stewardship.
- **BLOCKING:** prevents a named product capability; it does not necessarily prevent the entire app from launching.

`healthy` is not used as a setup state. API health, storage health, archive understanding, provider status, and readiness are separate concerns.

## Executive finding

The release baseline can launch, but it cannot yet be called **archive-aware and ready to operate as the primary archive system** without real-machine validation of:

1. At least one real, readable, writable archive root.
2. A completed archive scan with the expected file count.
3. FFprobe available and successfully inspecting representative files.
4. A meaningful identity/matching result, with unresolved items explicitly understood.
5. Mock mode disabled for real evaluation.
6. Storage and temp/download paths verified on the intended volumes.

Plex configuration is useful as an interoperability/reference-inventory test, but it is not a prerequisite for local archive understanding. Jellyfin, Sonarr, Radarr, Prowlarr, and qBittorrent must not be treated as setup failures. They are optional compatibility sources or delegated execution adapters while Archive Assistant builds native capability.

The correct question is not “How many integrations are configured?” It is:

> Which archive capabilities does Archive Assistant own, which are currently delegated, and which are compatibility bridges that can eventually be removed?

The current product has no dedicated setup-readiness read model. Settings, diagnostics, provider statuses, scan status, and dependency status are separate surfaces. That is the central product gap.

## Capability ownership model

Setup Readiness must report capability ownership before it reports integrations.

| Product capability | Archive Assistant owns now | Currently delegated/borrowed | Destination |
|---|---|---|---|
| Understand local archive | **YES** — scan, persisted file records, metadata, integrity classifications, archive inventory | FFprobe/FFmpeg/yt-dlp are executable dependencies, not product authorities | AA remains the source of local archive truth. |
| Inspect media | **YES, with tool dependencies** — local inspection and persisted results | FFprobe/FFmpeg/yt-dlp binaries | Replaceable local tools behind AA-owned policy and evidence. |
| Identify media | **YES, conservatively** — local identity, provider comparison, identity audit, review | Plex/Jellyfin can provide reference candidates | AA owns the conclusion and uncertainty; providers are evidence sources. |
| Compare quality/integrity | **YES** — archive comparison, integrity classification, review | Plex/Jellyfin metadata can be comparison input | AA owns the finding and decision. |
| Name and organize | **YES, supervised** — naming proposals, collision-safe plans, approval-gated operations | None required for the core flow | AA owns proposals, review, preflight, and filesystem policy. |
| Review and decide | **YES** — review items, notes, approval boundaries, operation planning | None | AA owns the decision record. |
| Discover missing media | **PARTIAL** — deterministic acquisition recommendations exist | Sonarr/Radarr/Prowlarr may supply lookup/indexer/provider evidence | AA should progressively own discovery policy and recommendation truth. |
| Acquire/download | **PARTIAL** — local download/processing engine and durable jobs exist | Sonarr/Radarr/qBittorrent can provide provider-backed execution | AA should own the queue and lifecycle; external tools become adapters. |
| Verify acquired media | **YES/PARTIAL** — local processing verification and archive scan evidence exist | Provider completion/status can be an external signal, never final archive truth | AA must own final local verification and import completion. |
| Preserve/history | **YES** — SQLite state, events, archive operations, review history | None required for local preservation | AA owns durable archive truth and audit history. |

### Integration roles

- **Plex:** optional reference/integration test. It is already synced and should remain valuable for reconciliation and interoperability validation, but local Archive Assistant readiness must not depend on it.
- **Jellyfin:** optional compatibility source. Do not configure it merely to complete a checklist.
- **Sonarr/Radarr:** delegated acquisition adapters during the transition; their absence is not a setup failure.
- **Prowlarr:** delegated discovery/indexer compatibility adapter; its absence is not a setup failure.
- **qBittorrent:** delegated execution backend while AA's native acquisition engine matures; report it as `COMPATIBILITY ONLY`, not as a missing core dependency.
- **Native acquisition:** currently incomplete. This is a product capability gap, not a machine setup defect.

A readiness report should therefore be able to say:

```text
Archive understanding: READY
Plex integration: VERIFIED / OPTIONAL
Jellyfin: OPTIONAL / NOT CONFIGURED
Sonarr: OPTIONAL / DELEGATED ACQUISITION ADAPTER
Radarr: OPTIONAL / DELEGATED ACQUISITION ADAPTER
Prowlarr: OPTIONAL / DELEGATED DISCOVERY ADAPTER
qBittorrent: COMPATIBILITY ONLY
Native acquisition: NOT YET COMPLETE
```

### Core local setup

| Capability | Current source of truth | Current implementation state | Blocks | Operator meaning / resolving action |
|---|---|---|---|---|
| SQLite database | `ARCHIVE_DB_PATH`; Tauri defaults to app-local data `archive-assistant.sqlite`; settings table is SQLite-backed | **IMPLEMENTED / CONFIGURED by runtime, not machine-validated** | Persistence, all durable state | Confirm the displayed database path is the intended persistent database, not a working-directory fallback. Do not manually invent or commit a path. |
| Data directory | `ARCHIVE_DATA_PATH`; desktop default is `%USERPROFILE%\\ARCHIVE\\data` | **IMPLEMENTED / CONFIGURED by default** | Source-monitoring JSON, integration config, local side stores | Supply/confirm the operator's data location and ensure it exists and is writable. |
| Archive directory/roots | persisted `archiveDirectory`; on Windows the database default is hard-coded to `D:\Movies`, `D:\Tv Shows`, `E:\Movies`, `E:\Tv Shows`; `getArchiveVolumes()` validates existence/writability | **IMPLEMENTED / NOT SET UP until real roots are confirmed** | Archive scan, archive inventory, identity, naming, integrity, archive operations | The operator must replace the Windows defaults with the actual movie/TV roots. A configured-but-inaccessible root is **BLOCKING**, not healthy. |
| Download directory | `downloadDirectory`, desktop default `%USERPROFILE%\\ARCHIVE\\downloads` | **IMPLEMENTED / CONFIGURED by default, not verified** | New download jobs and acquisition import flow | Confirm the destination and writable volume. |
| Temporary directory | `temporaryDirectory`, desktop default `%USERPROFILE%\\ARCHIVE\\tmp` | **IMPLEMENTED / CONFIGURED by default, not verified** | Download processing, FFmpeg merge, transient work | Confirm free space and write access; a missing temp path blocks processing even if the archive is readable. |
| Log level | persisted `logLevel`, default `info` | **IMPLEMENTED as stored setting; PARTIALLY IMPLEMENTED operationally** | None at default; diagnostics quality | Choose `info` for normal use, `debug` only during troubleshooting. The audit found the setting surface, but not a complete readiness proof that every logger consumes it. |
| Start with Windows | persisted `startWithWindows`; Tauri autostart plugin; native `set_start_with_windows` command | **IMPLEMENTED / CONFIGURED separately from readiness** | None; convenience only | Enable only after first-run validation. Confirm Windows startup entry and tray launch on the laptop. Default is disabled. |
| Mock mode | persisted `mockMode`; desktop sidecar forces `ARCHIVE_MOCK_MODE=false`; system overview reports placeholder when enabled | **IMPLEMENTED / BLOCKING for real evaluation if true** | Trustworthy source inspection and real assistant conclusions | Must be `false` for real archive evaluation. Demo data must be visibly excluded from readiness. |
| Network mode | persisted `networkMode`; network-target guard distinguishes `offline`, `local_only`, `allow_network` | **IMPLEMENTED / CONFIGURED, but no readiness interpretation** | Remote Plex/Jellyfin/ARR/source access depending on mode | Choose deliberately. `local_only` permits local-network targets but blocks non-local targets; `offline` blocks network work. Verify against actual provider topology. |

### Media engine

| Capability | Source of truth | Current state | Blocks | Resolving action |
|---|---|---|---|---|
| yt-dlp | `ARCHIVE_MEDIA_TOOLS_DIR` managed bundle, `YT_DLP_PATH` override, settings path, dependency detection | **IMPLEMENTED / can be READY, DEGRADED, or UNAVAILABLE** | URL/source inspection and some acquisition flows; not local archive scan | Confirm dependency status and source is `bundled`, `override`, or `system`; run a real inspection if source acquisition is required. |
| FFmpeg | same managed/override path resolution | **IMPLEMENTED / can be READY, DEGRADED, or UNAVAILABLE** | Processing, merge, conversion, download completion | Confirm executable version and a representative processing test. |
| FFprobe | same managed/override path resolution | **IMPLEMENTED / BLOCKING for media integrity and complete metadata** | Integrity classification and reliable technical metadata | Confirm `available`, then scan representative files and verify FFprobe metadata is persisted. |
| Bundled versus override | runtime manifest plus `toolOverrides`; dependency response reports source | **IMPLEMENTED** | None unless wrong architecture/path is selected | Prefer the verified bundled tools. Use overrides only intentionally and record why. |
| Dependency detection | `/api/system/dependencies`; executes version commands and FFmpeg `-hwaccels` | **IMPLEMENTED / not a complete readiness model** | Tool-dependent capabilities | Review version, command, source, and capabilities on the real install. SQLite is embedded even when CLI SQLite is absent. |
| Hardware acceleration | persisted `hardwareAcceleration`, `hardwareAccelerationMode`; UI offers `auto` and `disabled` | **PARTIALLY IMPLEMENTED** | Performance only; not archive understanding | Treat as optional optimization. Validate actual FFmpeg behavior before calling it ready; the setting is not evidence that a hardware encoder is usable. |
| Hardware acceleration mode | persisted mode, currently `auto`/`disabled` | **PARTIALLY IMPLEMENTED** | Performance only | Do not supply a vendor-specific mode; current UI does not expose one. |
| Output container | persisted `outputContainer`, default `mp4`; download processing supports mp4/mkv/webm | **IMPLEMENTED / CONFIGURED** | Download output compatibility only | Choose based on playback/archive policy. It does not affect scan understanding. |
| Inspection cache | in-memory `inspectionCache`, TTL from `inspectionCacheMinutes`, default 15 minutes | **IMPLEMENTED / DEGRADED across restart** | None; may cause repeat inspection after restart | Treat as performance behavior, not persisted evidence. |

### Storage policy

| Capability | Source of truth | Current state | Blocks | Resolving action |
|---|---|---|---|---|
| Warning threshold | persisted `warningFreePercent`, default 15 | **IMPLEMENTED / CONFIGURED** | Warning/acquisition policy when crossed | Confirm the threshold matches the operator's storage policy. |
| Critical threshold | persisted `criticalFreePercent`, default 5 | **IMPLEMENTED / CONFIGURED** | Can block/reduce acquisition decisions; does not by itself repair storage | Confirm the threshold and leave room for temp/processing overhead. |
| Archive path validity | `getArchiveVolumes()` checks exists, writable, free bytes | **IMPLEMENTED / not surfaced as a unified readiness state** | Scan and archive operations | Validate every configured root on the laptop. |
| Download/temp validity | settings and filesystem consumers; no equivalent unified path readiness endpoint | **PARTIALLY IMPLEMENTED / BLOCKING when invalid** | Download/process/import | Manually test existence, read/write/delete, and cross-volume behavior on target paths. |
| Read/write state | filesystem checks in storage/scan/operation services | **IMPLEMENTED in individual flows** | Depends on operation | Setup readiness must aggregate these checks rather than infer them from settings being saved. |

### Archive understanding

| Capability | Source of truth | Current state | Blocks | Resolving action |
|---|---|---|---|---|
| Configured archive roots | `settings.archiveDirectory` and `getArchiveVolumes()` | **IMPLEMENTED / NOT SET UP until confirmed** | All archive understanding | Supply actual roots and confirm each maps to the intended media type. |
| Scan state | persisted archive scan record; `/api/archive/scan`; live scan events | **IMPLEMENTED / NOT READY before first completed scan** | Inventory-aware assistant conclusions | Run a complete scan and verify it completes rather than stopping/interruption. |
| Last completed scan | scan `completedAt`, surfaced in system/assistant overview | **IMPLEMENTED** | Freshness interpretation | Confirm timestamp and expected scope after the scan. |
| Metadata completeness | persisted FFprobe fields, scan summaries, file records | **PARTIALLY IMPLEMENTED** | Quality comparisons and some identity confidence | Sample movies, episodes, containers, audio/subtitle cases; record missing metadata rate. |
| Integrity inspection | persisted integrity classification and FFprobe error handling | **IMPLEMENTED if FFprobe works; otherwise UNAVAILABLE** | Integrity-aware stewardship | Verify both a valid file and an intentionally unreadable/malformed case are classified honestly. |
| Identity readiness | local identity, Plex/Jellyfin comparison, identity audit | **PARTIALLY IMPLEMENTED / depends on scan and provider inventory** | Reliable match-dependent assistant findings | First validate local title/season/episode identity from the scan; then configure/sync a provider if external matching is desired. Unresolved identity must remain review, not failure. |
| Naming readiness | naming intelligence and proposals | **PARTIALLY IMPLEMENTED / depends on identity evidence and roots** | Safe naming proposals only | Run after scan and identity data exist; review collisions and uncertain proposals. |

### Provider connections

Provider statuses have separate fields for configured, reachable, operational, capabilities, detail, and last checked. They are not equivalent to “synced.”

| Provider | Configuration / verification source | Current readiness model | Capability after setup |
|---|---|---|---|
| Plex | owner-scoped URL/token; `getPlexConfig`, test connection, sync, persisted Plex inventory/provider refresh | **IMPLEMENTED but setup state is fragmented**: configured → connection verified → inventory synced → fresh | Archive/provider reconciliation, Plex-only and missing-media findings, quality comparison, media context, archive search. A connected but unsynced Plex is **CONFIGURED/VERIFIED**, not synced-ready. |
| Jellyfin | owner-scoped server URL/API key; test connection, sync, persisted Jellyfin inventory/provider refresh | **IMPLEMENTED but setup state is fragmented** | Same class of provider inventory/reconciliation capabilities when selected/used. A configured server without sync is not inventory-ready. |
| Sources / monitors | persisted `dataDirectory/source-monitoring.json`; source monitor routes; network mode applies | **PARTIALLY IMPLEMENTED** | Optional monitored RSS/Atom/JSON/HTML/Telegram source signals and discovery. Does not block local scan or local archive understanding. |
| Sonarr | endpoint/API key in protected local integration config; adapter status; capabilities | **OPTIONAL / IMPLEMENTED adapter, not required for local understanding** | TV lookup, missing-media discovery, source inspection, provider acquisition lifecycle. |
| Radarr | endpoint/API key in protected local integration config; adapter status; capabilities | **OPTIONAL / IMPLEMENTED adapter, not required for local understanding** | Movie lookup, missing-media discovery, source inspection, provider acquisition lifecycle. |
| Prowlarr | endpoint/API key in protected local integration config | **OPTIONAL / IMPLEMENTED adapter boundary** | Search/indexer capability for acquisition routes where operational. |
| qBittorrent | endpoint, username, password in protected local integration config | **OPTIONAL / IMPLEMENTED adapter boundary** | Provider download tracking/status for acquisition jobs. |
| mPilot / Telegram | configuration surfaces/adapter boundary | **OPTIONAL / not a prerequisite for archive understanding** | Notifications or future integration capabilities only where operational. |

### Webhooks and external automation

| Capability | Source of truth | Current state | What configuration enables |
|---|---|---|---|
| Sonarr webhook secret | stored/rotated secret or `SONARR_WEBHOOK_SECRET`; `/api/integrations/webhooks` status | **OPTIONAL / IMPLEMENTED** | Authenticated Sonarr lifecycle callbacks can update matching owner-scoped acquisition jobs. It does not perform the initial archive scan. |
| Radarr webhook secret | stored/rotated secret or `RADARR_WEBHOOK_SECRET`; status endpoint | **OPTIONAL / IMPLEMENTED** | Authenticated Radarr lifecycle callbacks can update matching acquisition jobs. |
| Secret rotation | replace endpoint, overlap/cutover semantics, security audit events | **IMPLEMENTED / must be operationally validated** | Safe secret replacement with bounded overlap; verify old secret expiry and new secret acceptance. |
| Webhook diagnostics | persisted 24-hour counters plus delivery history | **IMPLEMENTED** | Diagnose accepted/rejected/unavailable/malformed/duplicate deliveries. No secret is shown. |
| External automation overall | acquisition jobs, provider adapters, webhooks | **OPTIONAL for core archive understanding** | Improves acquisition lifecycle truth; it does not make a local archive scan more accurate. |

### Desktop environment

| Capability | Source of truth | Current state | Readiness meaning |
|---|---|---|---|
| Bundled Node | Tauri resource `runtime/node.exe`; `ARCHIVE_NODE_PATH` diagnostic override | **IMPLEMENTED / release packaging must be validated on laptop** | Required to launch packaged API without system Node. |
| Packaged media tools | Tauri `runtime/media-tools` and manifest; dependency endpoint | **IMPLEMENTED / release packaging must be validated on laptop** | Required for self-contained FFmpeg/FFprobe/yt-dlp behavior. |
| Windows startup | autostart plugin plus native command | **IMPLEMENTED / default disabled** | Convenience only; verify after core setup. |
| Update channel | Tauri updater endpoint points to GitHub latest release metadata | **IMPLEMENTED configuration, NOT VALIDATED as product readiness** | Requires a real signed release artifact and reachable endpoint. |
| Signed updater readiness | updater public key and `createUpdaterArtifacts` are configured | **PARTIALLY IMPLEMENTED / release credential/signing validation required** | Do not call ready until a real signed update check/install has been tested. Never commit signing secrets. |
| Tray/lifecycle | Tauri tray menu, hidden-on-close behavior, sidecar shutdown on exit | **IMPLEMENTED / Windows validation required** | Closing hides to tray; Quit stops the sidecar. Verify no orphaned Node process and that tray actions work. |

## What is currently missing as a product layer

1. No server-owned **Setup Readiness** read model aggregates configuration, verification, freshness, capability, blocking scope, and resolution action.
2. Settings saving is not verification. A saved path is not a readable path; saved provider credentials are not a verified connection; a synced provider is not necessarily fresh.
3. The system has no single answer to “can this installation understand and operate on this archive?”
4. `readStorage()` checks configured archive volumes but not all download/temp paths in the same readiness response.
5. Provider status exposes operational reachability, while sync freshness lives in provider-specific records; the UI does not combine them.
6. Hardware acceleration, log level, output container, cache TTL, and startup are configuration/optimization controls, not archive-understanding gates.
7. Desktop updater and Windows startup have implementation seams but need real-machine validation; they must not be represented as archive readiness.

## Recommended readiness result

The top-level state should be computed from locally owned capabilities, not integration count:

- **Archive understanding: READY** when the configured local roots are readable, a completed scan exists, FFprobe/media inspection is available, and the resulting inventory is usable. Identity ambiguity can remain visible as `DEGRADED` or `NEEDS REVIEW`; it must not be hidden as healthy.
- **Archive understanding: BLOCKED** when no valid archive root exists, the roots cannot be accessed, no completed scan exists, or the required local inspection dependency is unavailable.
- **Archive operations: READY/DEGRADED** separately, based on writable destinations, free space, and approval-gated operation checks.
- **Provider reconciliation: OPTIONAL** unless the operator explicitly chooses Plex or Jellyfin as a reference source.
- **Acquisition: PARTIALLY READY** while AA can recommend and process work but delegates discovery/provider execution. External adapters can improve this capability without becoming setup blockers.
- **Native acquisition: NOT YET COMPLETE** until AA owns discovery, queue, provider selection, execution lifecycle, and final archive import without requiring an external orchestrator.

This keeps “missing integration” separate from “missing capability.” A missing Sonarr instance should never make local archive understanding report `NOT SET UP`.

## Product recommendation

Use a combination, not a settings dashboard:

1. **Dedicated first-run/setup experience:** a short, sequential setup path for first launch only, focused on minimum blockers: real archive roots, writable temp/download paths, FFprobe/media tools, mock mode off, and first scan. It should ask for values and run verification after each step.
2. **Persistent Setup Readiness panel on Home:** a compact, scoped readout answering “Archive understanding: READY / NEEDS SETUP / DEGRADED,” with only the blocking and meaningful optional items. It should link to the relevant configuration or verification action, but not duplicate all settings.
3. **Detailed readiness page:** a separate `Setup Readiness` surface for the complete state map, evidence, timestamps, capability impact, and resolve action. This is not Settings and should remain read-only except for deliberate verification actions.
4. **Settings remains configuration:** paths, thresholds, provider credentials, webhooks, and preferences continue to live in Settings/provider pages. Setup Readiness translates those values into human meaning.

Home is the right persistent summary because the north star is “what is happening, what is missing, and what should happen next.” Settings alone hides blockers until users know where to look. A first-run experience prevents the assistant from presenting conclusions before its evidence base exists.

## Minimum real-machine setup values to supply manually

No paths or credentials should be guessed or committed. The Windows operator must supply or confirm:

### Required for meaningful local archive understanding

- The actual archive root path(s), including which root contains movies and which contains TV/episodes if separate.
- The intended local data directory and database location, or confirmation that the packaged app-local defaults are acceptable.
- The intended download directory.
- The intended temporary/processing directory.
- Whether the selected paths are local disks, removable disks, mapped drives, or UNC paths.
- Whether the app account can read every archive root and create/delete a harmless temporary file in archive/download/temp locations.
- Warning and critical free-space thresholds appropriate to the available volumes.
- Mock mode explicitly set to off.
- Network mode: `offline`, `local_only`, or `allow_network`.
- Output container policy: `mp4`, `mkv`, or `webm` if downloads will be used.
- Whether hardware acceleration should remain `auto` or be disabled after a real FFmpeg test.
- Whether Windows startup should be enabled after first-run validation.

### Required only for provider-aware understanding

- Plex server URL and token, if Plex is the chosen provider.
- Jellyfin server URL and API token, if Jellyfin is the chosen provider.
- Which provider should be the archive reference inventory where the product policy requires one active provider.
- Provider library scope and expected library/item counts.
- Permission/network details needed for the Windows laptop to reach the provider.
- The operator's decision on whether provider inventory is required for this installation or local-only understanding is sufficient.

### Required only for acquisition automation

- Sonarr URL/API key and TV root/quality/language profile values if TV acquisition is wanted.
- Radarr URL/API key and movie root/quality profile values if movie acquisition is wanted.
- Prowlarr URL/API key if indexer search is wanted.
- qBittorrent URL/username/password if provider download tracking is wanted.
- Sonarr and/or Radarr webhook secrets, generated and entered manually, if callbacks are wanted.
- Webhook public/reachable URL arrangement and provider-side webhook configuration.
- A planned rotation/cutover procedure for replacing webhook secrets.

### Desktop release validation values/actions

- Confirm the installed package architecture matches the Windows laptop architecture.
- Confirm the bundled `node.exe`, FFmpeg, FFprobe, and yt-dlp exist in the installed resource tree.
- Confirm the API starts without system Node and reaches its health endpoint.
- Confirm the updater metadata endpoint and a signed update artifact are available before calling updater-ready.
- Confirm tray open/scan/Plex/settings/quit actions and verify no orphaned sidecar remains after Quit.
- Confirm Windows startup behavior if enabled.

## Real-machine validation sequence

1. Install the known-good Windows package without modifying repository files.
2. Record the installed version, Windows architecture, package path, and app-local data path outside Git.
3. Open Settings and record all current values without assuming defaults are correct.
4. Replace the Windows archive defaults if `D:\Movies`, `D:\Tv Shows`, `E:\Movies`, or `E:\Tv Shows` are not the real roots.
5. Confirm database/data/download/temp paths and read/write access.
6. Confirm dependency source/version for Node, yt-dlp, FFmpeg, and FFprobe; run one real FFprobe inspection.
7. Set mock mode off and choose network mode deliberately.
8. Complete an archive scan; compare discovered count and representative paths against Windows Explorer/operator knowledge.
9. Verify scan completion timestamp, metadata completeness, integrity classifications, and identity-review volume.
10. Optionally configure Plex or Jellyfin, test the connection, sync the complete inventory, and verify expected counts/freshness.
11. Only if acquisition is a product goal, configure ARR/qBittorrent and then webhooks; test a signed callback and inspect diagnostics/history.
12. Validate tray, startup, updater, and clean shutdown separately from archive understanding.
13. Record the final readiness result as a checklist with blockers and evidence timestamps. Do not call the app READY merely because Settings saved.

## Implementation order after the audit

1. Build the server-owned Setup Readiness read model with explicit state, scope, source, last verified time, blocker capability list, and resolution action.
2. Add focused readiness tests for local paths, tools, mock mode, scan, metadata/integrity, provider verification/sync, and optional automation.
3. Add a first-run setup experience for the minimum local gates only.
4. Add a persistent Home readiness summary and a detailed read-only Setup Readiness page.
5. Run the real Windows validation sequence and adjust defaults/copy based on evidence, not assumptions.
6. Only after the installation can explain its readiness state, continue with Decision Flow + Lineage.

**Not implemented by this audit:** setup wizard, readiness API, readiness UI, Settings redesign, evidence-detail changes, autonomous actions, or credentials/paths in the repository.
