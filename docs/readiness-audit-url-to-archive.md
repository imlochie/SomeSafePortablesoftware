# Readiness audit — `6704ed0` (URL → Archive)

Audited on 2026-09-11, against `6704ed0` on `arena/01a08ba0-somesafeportablesoftware`.
Scope: can this build run the real workflow — a weird source URL in, a Plex-safe
episode or movie in `D:\Tv Shows` / `D:\Movies` out — on a Windows desktop?

**Nothing was merged to `main` and no pull request was opened.** This is a readiness
audit, not a release.

## What this audit could and could not do

The audit was performed in a Linux container. Windows binaries cannot be executed
there, so items marked *harness* are verified by `readiness.ps1` on the target
machine, and items marked *code* were verified by reading and by tests that exercise
the same OS-level primitives (`stat.dev`, `rename`, `copyFile`, filename grammar).

| # | Requested check | Status | Evidence / how to verify |
|---|---|---|---|
| 1 | Real Windows runtime | **harness** | `.\readiness.ps1` — Node ≥ 22.5 for `node:sqlite`, pnpm, build output, ports, drive layout |
| 2 | Actual `yt-dlp.exe` | **harness** | `readiness.ps1` resolves it, prints the version, and detects `.cmd`/`.bat` shims (see F5) |
| 3 | Actual FFmpeg / FFprobe | **harness** | same, plus `GET /api/system/dependencies`, which is what the UI shows |
| 4 | Configured archive volumes | **code + harness** | `getArchiveVolumes` already ships `D:\Movies`, `D:\Tv Shows`, `E:\Movies`, `E:\Tv Shows` as Windows defaults (`storage.ts:17-41`); harness prints which exist, are writable, and on which device |
| 5 | Scan → inventory | **code (verified here)** | live run against a temp DB/filesystem: 3 records, normalized quality, checksums (`6704ed0` gates) |
| 6 | URL intake | **code (verified here)** | `GET /archive/intake` → dispositions `promotable` / `blocked` / `already_in_archive` / `not_inventoried` / `file_missing` |
| 7 | Playlist / episode discovery | **NOT IMPLEMENTED** | the engine hard-codes `--no-playlist` (`download-engine.ts:181`); one URL = one file. Deferred, not faked |
| 8 | Existing-episode suppression | **partial** | season completeness + `fully_present`/`partial` exist in reconciliation (`reconciliation.ts:490-580`) and acquisition refuses a recommendation when nothing better is available (`acquisition-engine.ts:264`); there is no *per-episode expansion* to suppress because of #7 |
| 9 | Acquisition plan | **code (verified here)** | `POST /api/acquisition/refresh` → `findingCount=3` on the live smoke; needs, source options, blockers all owner-scoped |
| 10 | Real download job | **harness** | `.\readiness.ps1 -SampleUrl <url>` runs a real `yt-dlp` job end to end |
| 11 | Verification | **code + harness** | FFprobe stream verification is required before a file is accepted (`download-engine.ts:122-125`); harness checks the tool itself |
| 12 | Safe move into `D:\Tv Shows` / `D:\Movies` | **fixed here (was broken)** | F1 below — every move into a second drive failed before this audit |
| 13 | Inventory refresh | **code (verified here)** | `executeOperation` → `relocateArchiveRecord` + `invalidateArchiveInventoryCache`; verified by reading the record back at its new path |
| 14 | Plex reconciliation | **code + harness** | adapter + cached-inventory routes exist and are owner-scoped; a real Plex server needs the target machine |

## Findings

### F1 — every promotion to a second drive failed (critical, fixed)

Three places moved media with a bare `fs.rename`:
`download-engine.ts` (staged → archive), and `archive-operations.ts` apply *and*
rollback. `rename()` cannot cross a device boundary. The default layout makes that
the normal case: staging defaults to `~/ARCHIVE/tmp` (the system drive) while the
archive volumes live on `D:`. Windows fails with `EPERM`, POSIX with `EXDEV`.

```
$ node -e "fs.renameSync('/home/user/…/f','/dev/shm/f')"
EXDEV: cross-device link not permitted
```

**Fix.** `moveFileIntoPlace()` in `storage.ts`: try `rename` (atomic, no
duplication); if it fails with `EXDEV`/`EPERM`/`EACCES` — or with `ENOENT` while the
source still exists, which is what a not-yet-created destination directory on the
other volume reports — **and** `stat().dev` proves the paths are on different
devices, copy to `<target>.move-part`, compare byte
counts, re-check that nothing appeared at the destination, rename into place, then
remove the original. A same-device `EPERM` — Plex holding the file open, for
example — is still an error, because turning that into a copy would silently create
a second master. If the original cannot be deleted after a good copy, the error says
so and the next scan reports it as an exact duplicate instead of destroying the only
good copy.

Verified live, 6 MiB across devices, through the HTTP API:

```
devices   : library dev=65024 staging dev=21 (rename cannot cross)
intake    : promotable
apply     : op=succeeded error=none
bytes moved across devices : true      staged original removed : true
archive record followed    : true height=1080 checksum=c43aa178f3…
rollback across devices    : rolled_back restored=true
```

### F2 — `~` resolved to the repository on Windows (high, fixed)

Three copies of `expandPath` used `process.env.HOME ?? process.cwd()`. A plain
PowerShell has `USERPROFILE` and no `HOME`, so `~/ARCHIVE/...` defaults landed inside
whatever directory `pnpm --filter` started the server from — the repo — which also
guaranteed F1's cross-drive case.

**Fix.** One exported `expandUserPath()` in `storage.ts` using `os.homedir()`,
accepting `~/` and `~\`; `archive.ts` and `media.ts` now import it instead of keeping
their own copies.

### F3 — reserved Windows device names (medium, fixed)

`sanitizeFilename` stripped illegal characters and trailing dots/spaces (already
correct) but a title of `Con`, `Nul`, `Com1` produced a file Windows refuses to
create. Now such stems get a `_` suffix.

### F4 — a fragment could be promoted as the finished encode (medium, fixed)

When the expected output name was missing, the engine accepted *"the first file that
starts like the title and is not `.part`"*. Real yt-dlp runs leave `Title.f140.mkv`
(audio-only) and `Title.mp4.ytdl` merge residue in exactly that shape. Now only the
expected name, or a same-stem/same-container file, is accepted; ambiguity is refused
with the staging directory named in the error. Extracted as
`findFinishedDownloadFile()` so it is testable.

### F5 — dependency probe timeout was shorter than a Windows cold start (low, fixed)

`/api/system/dependencies` ran each tool with a 1.2 s budget. PATH resolution plus a
first-run Defender scan routinely exceeds that, so the UI reported an installed
yt-dlp as missing. Budget is now 8 s.

### F6 — `.cmd`/`.bat` shims will not launch (open, harness checks it)

`spawn("yt-dlp", …)` works for `yt-dlp.exe`; a pip/`choco`-style `yt-dlp.cmd` shim
will not start without a shell. `readiness.ps1` reports the exact extension it found
and tells you to put the `.exe` (or an absolute path) in Settings.

### F7 — the remux step always runs (open, by design for now)

`processWithFfmpeg` is invoked for every completed job even when the container
already matches, so a machine without FFmpeg fails at verification despite a
downloaded file. Not changed here: it is FFmpeg's contract, not a bug, and skipping
it is a feature decision. Flagged because it is the second most likely reason a
first real run fails.

### F8 — long paths (open, harness probes it)

Archive layout can build `D:\Tv Shows\Show (2011)\Season 03\Show - S03E07 - ….mkv`
past 260 characters. Node does not add the `\\?\` prefix itself, so without
`LongPathsEnabled` the write fails confusingly. `readiness.ps1` probes both the
registry setting and an actual deep path.

### Explicitly deferred, not substituted

- **Playlist / whole-season discovery.** `--no-playlist` is hard-coded and there is
  no "expand into N jobs, skip what the archive already has" step. This is the next
  real feature; it needs the acquisition need + reconciliation counts, not a new
  downloader.
- **Per-episode suppression** during that expansion depends on the above.
- **Symlinked or junctioned library folders** are *skipped* by the scanner (it only
  follows `Dirent.isFile()`/`isDirectory()`), which is the safe choice but means a
  library built from junctions looks empty. Worth knowing before anyone debugs it.

## What this audit could not execute

`readiness.ps1` was written for the target machine but **not run here** - this
container has no PowerShell, so its logic is reviewed, not executed. Everything it
prints comes from APIs and OS calls that *are* implemented and tested here, and it
fails loudly rather than silently if a call does not exist. Treat its first run on
the Windows box as the first real run of the script too.

## Tests added

`artifacts/api-server/test/windows-path-safety.test.ts` (8 tests): `~` expansion with
`HOME` deleted; containment judged on resolved paths; reserved device names; fragment
rejection; same-device move stays an atomic rename; **real** cross-device move and
cross-device collision refusal (both skip themselves if the machine has no second
filesystem, rather than asserting against a mocked `rename`); intake containment.

Suite totals after the fixes: **69 tests, 0 failures** — acquisition 8, intake 6,
integrations 6, ownership 17, quality 24, windows-path-safety 8. Typecheck clean in
all four workspaces; `archive-assistant` and `api-server` builds pass; the root build
passes with `PORT` and `BASE_PATH` unset.

## Running it on the Windows machine

```powershell
.\install.ps1                  # existing entry point, unchanged
.\readiness.ps1                # diagnostics only: tools, drives, volumes, long paths
.\readiness.ps1 -WithJob       # also runs one real download -> intake -> promote -> rollback
.\readiness.ps1 -ArchiveRoot D:\ArchiveReadinessTest -SampleUrl <a URL you have rights to>
```

`readiness.ps1` writes only inside its own temp root by default. Pointing it at a
production volume is refused unless `-ProductionVolumeIAmSure` is passed, and the
default sample is Big Buck Bunny (`blender.org`, CC-BY) precisely so the test does not
depend on, or touch, anything you do not own.
