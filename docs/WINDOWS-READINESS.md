# Windows Runtime Readiness Audit — `54f5848` (+ this commit)

**Scope:** static audit of every filesystem, path, and process touchpoint in `artifacts/api-server` (and the UI build), against Windows failure modes. **No architectural changes were made.** The frozen three-concept separation — AcquisitionPlan (what to acquire) / Intake (what to do with what was acquired) / Mutation (how to safely change the filesystem) — is untouched.

**Verdict: READY for a real-Windows validation run, after the five compatibility fixes in this commit.** The core safety machinery was already Windows-aware; the audit found five concrete hazards, all fixed and tested here on Linux (including a genuine cross-device EXDEV test), plus documented caveats that need no code.

---

## 1. What was already Windows-safe (verified, unchanged)

| Area | Evidence |
|---|---|
| Path containment guards | `isPathWithin` (media.ts), `isArchivePathWithin` (storage.ts), `validateSafeDirectory`: all resolve, then compare case-insensitively on `win32` with `path.sep`-aware prefixes — no string-prefix tricks |
| Volume free-space probes | `statfsSync` call sites (storage.ts, system.ts) are individually try/catch-guarded; `node:fs.statfs` is unavailable on Windows, so free space degrades to `null` / `unknown`, never a crash |
| Filename sanitizing (core) | `sanitizeFilename` strips `<>:"/\|?*`, control chars, trailing dots/spaces |
| Configured directory lists | `configuredDirectoryRoots` accepts JSON, newline, **and semicolon** separators; tolerates CRLF |
| Process spawning | `spawn(..., { windowsHide: true })` — no console-window flash; argument arrays (no shell string building, no injection surface) |
| Default settings | Windows defaults ship real volume layouts (`D:\Movies`, `D:\Tv Shows`, `E:\…`) in `archive-db.ts` |
| Scanner resilience | Per-file try/catch: a file locked open by Plex/another process increments `failedFiles` with a warning; the scan continues |
| Database | **`node:sqlite`** (`DatabaseSync`) — Node's built-in SQLite. **Zero native third-party modules to compile or match prebuilds on Windows.** Database path defaults to `<cwd>/data/…` (portable-friendly; no APPDATA dependency) |
| Progress parsing | All progress regexes are unanchored and `Number()`/`parseBytes()` tolerate trailing CR; `--newline` output parsed per chunk |
| Staging visibility | The download directory is scanned as a staging root with overlap containment (`isArchivePathWithin` both ways) — works identically on Windows |

## 2. Hazards found and FIXED in this commit

| # | Severity | Hazard | Windows failure mode | Fix |
|---|---|---|---|---|
| F1 | **HIGH** | Plain `fs.rename` at all three move sites (download-engine `verifyAndMove`; archive-operations `executeOperation` + `rollbackOperation`) | Temp on `C:` + archive volume on `D:` (the default Windows layout) → every download's final move and every journaled promotion/rollback fails `EXDEV` **after** the download, FFmpeg, and FFprobe work already succeeded | New `src/lib/fs-move.ts` `moveFile()`: rename; on `EXDEV` (and `EPERM` on win32) fall back to `COPYFILE_EXCL` copy + size verification + source removal — the fallback **preserves the overwrite ban** (exclusive copy refuses an existing target instead of clobbering). Wired into all three sites |
| F2 | MEDIUM | `expandPath` used `process.env.HOME` (media.ts, storage.ts) | `HOME` is usually unset on Windows → default `~/ARCHIVE/...` settings silently resolved against the working directory instead of the user profile | Both now use `os.homedir()` (correct on both platforms; `USERPROFILE` on Windows) |
| F3 | MEDIUM | Scan missing-mark pass compared paths case-sensitively (archive.ts) | Changing `D:\Movies` → `d:\movies` in settings makes every previously-scanned row fail the root match → mass false `missing` | Platform-aware comparison: lowercase both sides on `win32`, for both root containment and the found-set |
| F4 | MEDIUM | No Windows reserved-device-name handling in `sanitizeFilename` or `plexSafeDestination` | A title like `Con`, `Nul`, `Aux`, `COM1` produces a filename in the device namespace → creation fails or hangs | `windowsSafeStem()` (exported from media.ts) prefixes reserved stems with `_`; `plexSafeDestination` additionally gained control-char and trailing dot/space stripping to match `sanitizeFilename` |
| F5 | LOW | `handleProgress` matched the first regex hit per multi-line chunk | Progress could lag within a chunk; CRLF endings are tolerated but the first-match behavior wastes them | Per-line parsing (`split(/\r?\n/)`), last match wins — more accurate on every platform, CRLF-proof on Windows |

**Tests:** new suite `test/windows-compat.test.ts` (7 tests): same-volume move preserves bytes; **real cross-device EXDEV move** (`/dev/shm` tmpfs → root filesystem, the same error class as `C:` → `D:`) falls back to verified copy; the fallback **refuses to overwrite** an existing target and leaves the source intact; reserved names (`Con`/`nul`/`COM1`/`Aux`) are prefixed while `Console`/`Comedy Central Special` are untouched; plan destinations are structurally Windows-safe; `~` expands against the real home directory.

## 3. Documented caveats (no code change required)

1. **Tool resolution — `.exe` yes, `.cmd` no.** `spawn`/`execFile` with bare names resolve `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe` from PATH (pip `Scripts\`, winget, and scoop shims all provide `.exe`). Node deliberately refuses `.bat`/`.cmd` without `shell: true` (CVE-2024-27980). If a tool is only reachable via a `.cmd` shim, set the full path to the real executable in settings.
2. **MAX_PATH (260 chars).** Deep staging + `Show/Season NN/Show S01E02.mkv` structures can exceed it on drives without long-path enablement. Node handles long paths on Windows 10/11 with `LongPathsEnabled`; otherwise keep archive roots shallow (they usually are).
3. **UNC archive roots** (`\\server\share`) resolve correctly, but free-space reporting is unavailable (`statfs`); prefer mapped drives if storage-impact matters.
4. **Exact-path lookups are case-sensitive in the DB** (intake's `findStagedRecord`, duplicate-path checks). Paths recorded by a scan and paths built by the engine both derive from the same configured root string, so they agree; only changing volume case in settings between scans can leave an intake item `not_inventoried` until the next scan (F3 prevents the destructive mass-missing variant of this).
5. **Test infrastructure is POSIX-bound.** The stub binaries are shebang `.mjs` scripts made executable with `chmod` — they cannot run under `execFile` on Windows. Running the automated suites on Windows therefore requires real `yt-dlp.exe`/`ffmpeg.exe`/`ffprobe.exe` in settings (which is exactly what the Windows-reality run wants anyway) or `.exe` shims. `mkdtemp`/`tmpdir`/`readdir` usage is otherwise portable.
6. **`ARCHIVE_MOCK_MODE` defaults to true** — the Windows reality run must set it false (runbook below).
7. **`node:sqlite` requires Node ≥ 22.13** (first 22.x release where the module ships without the experimental flag; this branch is developed on 22.22).

## 4. Windows reality runbook

The exact sequence to answer "prototype or tool" on real Windows:

1. **Prerequisites:** Windows 10/11; Node.js ≥ 22.13 (LTS 22.x); `yt-dlp.exe`, `ffmpeg.exe`, `ffprobe.exe` on PATH (or full paths recorded in settings); a real archive volume (e.g. `D:\Tv Shows`, `D:\Movies`) and a staging/temp pair.
2. **Install & configure:** `pnpm install --frozen-lockfile`; start the API server with `ARCHIVE_MOCK_MODE=false` (local auth mode); in settings set archive/download/temporary directories and the tool paths; run one archive scan.
3. **Gates:** `pnpm run typecheck`; `pnpm --filter @workspace/api-server run test` (expect 65/65 — stub-dependent suites need the real binaries reachable, see caveat 5); both builds.
4. **Acceptance flow (the 11 steps, for real):** in the UI (Discovery → URL → Archive planner) submit a real playlist URL with a request note → review the plan (present/missing, quality, storage, destinations) → approve the untrusted source → execute → watch items go `queued → downloading → staged` (yt-dlp/FFmpeg/FFprobe real) → intake panel shows the staged items with real checksums and quality verdicts → PLAN → APPLY (journaled promotion into `Show/Season NN/`) → verify files on disk → rescan → reconciliation page shows the identities.
5. **Windows-specific evidence to capture:** a cross-volume run (temp on `C:`, volume on `D:`) exercising the F1 fallback; a plan whose titles include reserved-word-adjacent names; a promotion + rollback round trip; the intake view while Plex is playing a different file (scanner resilience).

## 5. Validation after this audit's fixes

| Gate | Result |
|---|---|
| `pnpm run typecheck` | **PASS** |
| `pnpm --filter @workspace/api-server run test` | **65/65 PASS** — plan 4, acquisition 8, intake 6, integrations 6, ownership 11, quality 23, windows-compat 7 |
| `pnpm --filter @workspace/archive-assistant run build` | **PASS** |
| `pnpm --filter @workspace/api-server run build` | **PASS** |
| Temporary-environment smoke (A–N) | **6/6 PASS** |

**Not verifiable in this environment:** actual Windows kernel/filesystem behavior (this audit ran on Linux, with the cross-device case reproduced via tmpfs). The runbook above is the remaining step; nothing in it requires further code changes unless a real-Windows run surfaces new facts.
