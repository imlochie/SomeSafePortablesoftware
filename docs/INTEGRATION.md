# Integration Report — Milestone Assembly + URL → Archive Vertical Slice

**Branch:** `arena/01a08edf-somesafeportablesoftware` (created from `main` @ `a948215`; never merged into or pushed to `main`)
**Date:** 2026-09-10

---

## 1. Branch / Commit Graph

```
* 8a4c926 feat: URL → Archive vertical slice — canonical AcquisitionPlan
* c09e480 test: temporary-environment integration smoke suite
*   1dc406c integrate: acquisition intelligence (0f52c46)
|\
| * 0f52c46 Durably publish acquisition intelligence implementation   ← ACQUISITION (branch arena/01a08ba1)
| * d8a40da Add acquisition intelligence layer
* |   7b3d242 integrate: quality intelligence (5f4e402)
|\ \
| * | 5f4e402 fix(mockup-sandbox): vite build without dev-server env   ← QUALITY (branch arena/01a08ba0)
| * | 14aa4c6 fix(downloads): inherit configured temporary directory
| * | e553470 feat(archive-assistant): per-record quality review
| * | 595d742 feat(archive): quality intelligence layer
* | |   cfb8e08 integrate: integration adapter foundation (2b46626)
|\ \ \
| |_|/
|/| |
| * | 2b46626 feat: restore integration adapter foundation            ← FOUNDATION (branch arena/01a08b9e)
* | |   18796ca integrate: safe archive mutation (608f7ff)
|\| |
| * | 608f7ff Safe archive mutation foundation                        ← MUTATION (branch arena/01a08afc)
| |/
* | | a948215 feat: add archive naming proposals                      ← main (base)
```

- Merge order: **Mutation (608f7ff) → Foundation (2b46626) → Quality (5f4e402) → Acquisition (0f52c46)**, as specified.
- All four source branches are intact on the remote and untouched.
- **Branch-name collision note:** the names `01a08ba0`/`01a08ba1` were reused across parallel Arena sessions. Identity was resolved by commit *content*: `01a08ba1` = Acquisition (`d8a40da` implementation + empty publish anchor `0f52c46`); `01a08ba0` = Quality (`595d742`… `5f4e402`).
- **Environment note:** the sandbox was re-cloned mid-run; the merge history above was rebuilt on this branch from the same four milestone commits with the same conflict resolutions, and the final tree was verified byte-identical to the validated state before the final gates were re-run.

## 2. Conflict-Resolution Summary

| Merge | Conflicts | Resolution |
|---|---|---|
| 1. Mutation | none | clean fast-forward content merge (single-commit branch off `a948215`) |
| 2. Foundation | none | both branches touched disjoint regions (route index anchored differently) |
| 3. Quality | 9 files | see below |
| 4. Acquisition | 9 files | see below |

**Merge 3 (Quality):**
- `services/archive.ts` — the deepest conflict. Quality's branch had already absorbed mutation's scan-root/checksum/`lastInsertRowid` fixes (verified line-by-line) *and* replaced the internal quality model with the richer `TechnicalQuality` pipeline. Kept quality's implementation wholesale; grafted back mutation's exported primitives (`archiveVolumeId`, `upsertLocalIdentity` with the id-re-selection fix, `localIdentityForPath`) that `archive-operations.ts` imports. Added a completeness gate to the unchanged fast path: rows lacking derived metadata (legacy pre-schema rows) get a full re-inspection instead of a checksum-only backfill, so legacy rows are fully repaired (restores mutation's repair guarantee).
- `services/media.ts` — kept quality's multi-root `configuredDirectoryRoots` refactor and temp-directory fallback; layered mutation's explicit "not configured" error contract on top.
- `test-runner.mjs` — quality's multi-suite runner + foundation's CJS banner and `AUTH_MODE=local`.
- `ownership.test.ts` — union of both sides' tests; dropped the `import "./integrations.test"` side-effect (the multi-suite runner now discovers it directly).
- generated clients — regenerated from the auto-merged spec (output matched the textual merge).

**Merge 4 (Acquisition):**
- `openapi.yaml` — exact structural union (41 paths, 83 schemas) built textually and verified programmatically (every path/schema from both parents present; all `$ref`s resolve; no duplicate operationIds). HEAD supersedes 4 shared schemas (`ArchiveNamingProposal`, `ArchiveNamingProposalSummary`, `ArchiveInventoryRecord`, `LocalMediaInspection`) and the shared `/archive/naming-proposals` path where HEAD is a strict superset. Clients regenerated from the merged spec.
- `archive.ts` — dropped acquisition's inline identity upsert and in-try checksum in favor of the integrated `upsertLocalIdentity` and quality's probe-independent `computeChecksum` (identical semantics, single implementation).
- `scanRoots` — restored mutation's nested-root containment guard on quality's staging scan. Acquisition's branch had changed its test to nest the download dir inside the archive root, which quality's unguarded append double-walked (9 files scanned instead of 6). The guard keeps single-walk semantics while preserving staging-dir scanning; acquisition's stricter test is retained.
- `reconciliation.ts` — `qualityRank` import moved to the acquisition engine's own flat-model ranking (archive's `QualityShape` scoring no longer exists as of the quality milestone; the algorithms are identical).
- `archive-db.ts` — union of all additive tables (naming decisions, operation journal, acquisition need/source-option/finding).

**Never regressed:** checksums are always computed (never `null`), `lastInsertRowid` identity fix, FFprobe numeric-string parsing, temp-directory settings fallback + unsafe-path rejection, download-directory scanning, real Plex behavior, provider-neutral integration layer, no duplicate media-inspection pipelines, no arbitrary filesystem mutation endpoints, tests only strengthened.

## 3. Final Architecture Map

```
ADAPTERS PROVIDE FACTS
  yt-dlp inspection (single + playlist) · integrations registry (plex + placeholders:
  sonarr/radarr/prowlarr/qbittorrent/mpilot/telegram) · archive scanner (volumes +
  staging) · FFprobe/FFmpeg · filesystem
        ↓
INTELLIGENCE INTERPRETS FACTS
  archive identity (local_media_identity) · media-quality (TechnicalQuality model,
  encode dominance) · archive-quality (findings, review evidence keys) ·
  naming-intelligence (proposals, durable decisions) · reconciliation (normalized
  states) · acquisition-engine (needs, ranking, storage impact)
        ↓
POLICY DECIDES WHAT IS ACCEPTABLE
  source trust: trusted / user_approved / untrusted / unsupported / blocked
  (loopback + private hosts rejected BEFORE any fetch; untrusted sources are
  planned read-only and require a recorded approval) · naming decision gates ·
  quality review workflow · owner isolation everywhere
        ↓
OPERATIONS EXECUTE APPROVED PLANS
  AcquisitionPlan (canonical, provider-neutral) → bounded batch → real download
  engine (yt-dlp → FFmpeg → FFprobe verify → move) · archive-operations (journaled
  rename/move/restructure, dry-run, check, rollback) → archive refresh
```

**Vertical slice (new):** `services/acquisition-plan.ts` owns the canonical `AcquisitionPlan` object — request, supplied source, trust, discovered candidates, archive state, missing/present, quality comparison, storage impact, approval state, execution strategy, destination plan, per-item execution state, final results. Sources may be arbitrary URLs today; Sonarr/Radarr/Prowlarr/MPilot/local media enter through integration candidates later — nothing site-specific is hard-coded.

## 4. Test / Build Results (final gates, run on the rebuilt branch)

| Gate | Result |
|---|---|
| `pnpm run typecheck` | **PASS** (workspace libs + api-server + archive-assistant + mockup-sandbox + scripts) |
| `pnpm --filter @workspace/api-server run test` | **49/49 PASS** — acquisition-plan 4, acquisition 8, integrations 6, ownership 11, quality 20; 0 fail |
| `pnpm --filter @workspace/archive-assistant run build` | **PASS** (vite production build) |
| `pnpm --filter @workspace/api-server run build` | **PASS** (esbuild bundle) |

The previously known `temporaryDirectory` failure is **resolved**: the mutation milestone's fix is integrated and covered by `prepare download falls back to the configured temporary directory and still rejects unsafe explicit paths`.

## 5. Vertical-Slice / Smoke Results

`artifacts/api-server/smoke/` — temporary SQLite DB, throwaway fixtures, stub `yt-dlp`/`ffmpeg`/`ffprobe`; no production archive, no real Plex/source credentials. **6/6 PASS:**

- A archive scan · B identity creation · C checksum creation · D exact duplicate detection · E quality comparison
- F acquisition finding creation (+ review) · G integration capability discovery (provider-neutral, no credential leakage)
- H naming proposal generation · I proposal approval · J dry-run mutation (zero writes) · K safe rename/move (journaled) · L rollback
- M download temporary-directory fallback (+ unsafe-path rejection, real yt-dlp inspection path against the stub)
- N ownership isolation (inventory, proposals, findings, journal, cross-owner decisions/mutations refused)

**End-to-end vertical slice** (`test/acquisition-plan.test.ts`, 4 tests): playlist URL → inspection (3 entries) → candidates normalized to season/episode identities → 1 already present / 2 missing → untrusted trust state → approval gate (reject path + approve path) → bounded execution → real pipeline (yt-dlp download → FFmpeg remux → FFprobe verification) → files placed in the TV volume with Plex-safe names → archive re-scan re-resolves identity → naming intelligence sees the new files. Blocked (loopback) and unsupported (ftp) sources are rejected pre-fetch and can never be approved.

## 6. Files Changed (vs `a948215`)

**177 files, +21,158 / −884.** Non-generated highlights:
- New services: `acquisition-plan.ts`, `acquisition-engine.ts`, `acquisition-intelligence.ts`, `archive-operations.ts`, `archive-quality.ts`, `media-quality.ts`, `integrations/*` (contracts, registry, service, adapters), `smoke/*`
- Modified: `archive.ts`, `archive-db.ts`, `media.ts`, `reconciliation.ts`, `naming-intelligence.ts`, `download-engine.ts`, `storage.ts`, `routes/*`, `test-runner.mjs`, `App.tsx`, `openapi.yaml`, README, `docs/integration-adapters.md`
- Generated (regenerated via `pnpm --filter @workspace/api-spec run codegen`, never hand-patched): `lib/api-zod/src/generated/**`, `lib/api-client-react/src/generated/**` (~130 files)

## 7. Unresolved Limitations

1. **Parallel session work on the quality branch.** After integration, `origin/arena/01a08ba0` advanced to `6704ed0` containing *another* session's independent integration pass (merges of the same four milestones, plus `2a66b98` "duration mismatch / one quality verdict per pair" and `6704ed0` "URL → Archive intake slice" with `services/archive-intake.ts`). This branch deliberately integrates the four audited milestone commits (`608f7ff`, `2b46626`, `5f4e402`, `0f52c46`) and not the competing assembly. Reconciling the two vertical-slice designs (`AcquisitionPlan` vs. intake) and porting `2a66b98`'s quality fix is a follow-up decision for the owner.
2. Plans store their snapshot (`plan_json`) at build time; archive state changes between build and execute are not re-validated per item at queue time (the engine's own destination checks still run).
3. `integrationAlternatives` reports discovered capabilities as facts only; no adapter yet implements `search_source`, so alternative-source comparison is currently an empty set in practice.
4. Plan execution requires the operator (or a supervisor) to trigger the archive re-scan afterward for identity re-resolution; it is not auto-triggered on job completion.
5. Sandbox re-clone mid-run required rebuilding the merge history; final tree verified identical and gates re-run, but merge-commit timestamps are from the rebuild.

## 8. Explicitly Deferred Functionality

- Full LLM assistant / natural-language request parsing (the plan accepts a note; parsing stays deterministic and UI/API-driven for now)
- Automatic web-scraping infrastructure; new torrent client; Sonarr/Radarr/Prowlarr replacements
- Perceptual duplicate analysis (Czkawka-class); background filesystem watchers
- Real integration adapters beyond Plex (placeholders advertise planned capabilities only)
- Automatic placement of downloaded media via the mutation engine (current placement is the download engine's verified move; naming proposals + journaled mutation remain the operator-driven path)
- Season/show-level planning beyond what playlist entries expose (season completeness across sources)
- Approval workflow UI polish (bulk approve, audit trail view)
