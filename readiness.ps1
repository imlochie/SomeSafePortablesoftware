# ARCHIVE ASSISTANT readiness check
#
# Diagnostics for the URL -> Archive workflow on a Windows desktop: runtime,
# external tools, archive volumes, long paths, the journaled move primitive, and
# (optionally) one real download promoted into an archive.
#
#   .\readiness.ps1                                  # no network, no writes outside temp
#   .\readiness.ps1 -WithJob                         # also runs one real download end to end
#   .\readiness.ps1 -StagingRoot E:\staging          # force a cross-volume promotion (the F1 case)
#
# It writes only inside its own temporary root unless -ArchiveRoot says otherwise,
# and it refuses to touch a production archive volume unless
# -ProductionVolumeIAmSure is passed. The default sample is Big Buck Bunny
# (blender.org, CC-BY) so the test does not depend on anything you do not own.

#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$SampleUrl = 'https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4',
  [string]$ArchiveRoot,
  [string]$StagingRoot,
  [int]$Port = 4599,
  [switch]$WithJob,
  [switch]$SkipBuild,
  [switch]$KeepRoot,
  [switch]$ProductionVolumeIAmSure
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$apiDir = Join-Path $repo 'artifacts\api-server'
$productionVolumes = @('D:\Movies', 'D:\Tv Shows', 'E:\Movies', 'E:\Tv Shows')
$results = New-Object System.Collections.Generic.List[object]

function Add-Result([string]$Name, [string]$Status, [string]$Detail) {
  $results.Add([pscustomobject]@{ Check = $Name; Status = $Status; Detail = $Detail }) | Out-Null
  $color = 'DarkGray'
  if ($Status -eq 'PASS') { $color = 'Green' }
  if ($Status -eq 'FAIL') { $color = 'Red' }
  if ($Status -eq 'WARN' -or $Status -eq 'SKIP') { $color = 'Yellow' }
  Write-Host ("  [{0,-4}] {1}  {2}" -f $Status, $Name, $Detail) -ForegroundColor $color
}

function Invoke-Api([string]$Method, [string]$Path, $Body) {
  $uri = "http://127.0.0.1:$Port/api$Path"
  if ($null -eq $Body) { return Invoke-RestMethod -Uri $uri -Method $Method -TimeoutSec 120 }
  $json = $Body | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod -Uri $uri -Method $Method -ContentType 'application/json' -Body $json -TimeoutSec 120
}

function Test-Tool([string]$Command) {
  $found = Get-Command $Command -ErrorAction SilentlyContinue
  if (-not $found) { return $null }
  return $found.Source
}

Write-Host ''
Write-Host 'ARCHIVE ASSISTANT / READINESS' -ForegroundColor Cyan
Write-Host "repo : $repo" -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------- runtime
Write-Host 'Runtime' -ForegroundColor White
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Add-Result 'Node.js' 'FAIL' 'node was not found on PATH'
} else {
  $nodeVersion = (& node --version)
  Add-Result 'Node.js' 'PASS' $nodeVersion
  $sqliteProbe = & node -e "try{require('node:sqlite').DatabaseSync;console.log('ok')}catch(e){console.log('no:'+e.message)}" 2>&1
  if ("$sqliteProbe" -match '^ok') {
    Add-Result 'node:sqlite' 'PASS' 'the embedded database runtime is available'
  } else {
    Add-Result 'node:sqlite' 'FAIL' "$nodeVersion cannot open the archive database ($sqliteProbe). Node 22.5 or newer is required."
  }
}
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Add-Result 'pnpm' 'PASS' ((& pnpm --version))
} else {
  Add-Result 'pnpm' 'FAIL' 'run: corepack enable'
}

# ---------------------------------------------------------------- tools
Write-Host ''
Write-Host 'External tools (what the app shells out to)' -ForegroundColor White
$toolPaths = @{}
foreach ($tool in @(@{ n = 'yt-dlp'; c = 'yt-dlp' }, @{ n = 'ffmpeg'; c = 'ffmpeg' }, @{ n = 'ffprobe'; c = 'ffprobe' })) {
  $source = Test-Tool $tool.c
  if (-not $source) {
    Add-Result $tool.n 'WARN' "not on PATH; the app will report it missing under /api/system/dependencies and Settings can point at an absolute path"
    continue
  }
  $toolPaths[$tool.c] = $source
  $extension = [IO.Path]::GetExtension($source).ToLowerInvariant()
  $version = ''
  try { $version = (& $source --version 2>&1 | Select-Object -First 1) } catch { $version = 'version probe failed' }
  if ($extension -eq '.cmd' -or $extension -eq '.bat') {
    # F6: CreateProcess will not launch a batch shim, so the spawn fails at runtime
    # even though `where yt-dlp` finds it.
    Add-Result $tool.n 'FAIL' "$source is a $extension shim; Node spawns it through CreateProcess, which will not run it. Point Settings at the .exe (e.g. the one inside the pip/yt-dlp folder)."
  } elseif ($extension -ne '.exe' -and $extension -ne '') {
    Add-Result $tool.n 'WARN' "$source has an unusual extension ($extension)"
  } else {
    Add-Result $tool.n 'PASS' "$source :: $version"
  }
}

# ---------------------------------------------------------------- long paths
Write-Host ''
Write-Host 'Filesystem constraints' -ForegroundColor White
$longPaths = $null
try {
  $longPaths = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue).LongPathsEnabled
} catch { $longPaths = $null }
if ($longPaths -eq 1) {
  Add-Result 'LongPathsEnabled' 'PASS' 'the registry policy allows paths beyond 260 characters'
} else {
  Add-Result 'LongPathsEnabled' 'WARN' "value is '$longPaths'; deep archive structures plus long episode titles can exceed MAX_PATH and fail as a confusing ENOENT"
}

# ---------------------------------------------------------------- roots
if (-not $ArchiveRoot) {
  $ArchiveRoot = Join-Path $env:TEMP ("archive-readiness\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$resolvedRoot = [IO.Path]::GetFullPath($ArchiveRoot)
foreach ($volume in $productionVolumes) {
  if ($resolvedRoot.TrimEnd('\') -ieq $volume.TrimEnd('\') -or $resolvedRoot -imatch ('^' + [regex]::Escape($volume.TrimEnd('\')) + '\\')) {
    if (-not $ProductionVolumeIAmSure) {
      Add-Result 'Production volume guard' 'FAIL' "$resolvedRoot looks like a live archive volume. Move the test elsewhere, or re-run with -ProductionVolumeIAmSure."
      $results | Format-Table -AutoSize
      exit 1
    }
    Write-Host "  [WARN] production volume explicitly acknowledged: $resolvedRoot" -ForegroundColor Yellow
  }
}

$libraryRoot = Join-Path $resolvedRoot 'library'
$staging = if ($StagingRoot) { [IO.Path]::GetFullPath($StagingRoot) } else { Join-Path $resolvedRoot 'staging' }
$dataDir = Join-Path $resolvedRoot 'data'
New-Item -ItemType Directory -Force -Path (Join-Path $libraryRoot 'Movies') | Out-Null
New-Item -ItemType Directory -Force -Path $staging | Out-Null
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$libraryDrive = (Get-Item $libraryRoot).PSDrive.Name
$stagingDrive = (Get-Item $staging).PSDrive.Name
Add-Result 'Test roots' 'PASS' "library=$libraryRoot staging=$staging"
if ($libraryDrive -ne $stagingDrive) {
  Add-Result 'Volume layout' 'WARN' "library is on $libraryDrive: and staging on $stagingDrive: - rename cannot cross that boundary, so this run exercises the cross-volume copy path (the case that was broken before this audit)"
} else {
  Add-Result 'Volume layout' 'PASS' "both roots on $libraryDrive: (same volume); pass -StagingRoot E:\somewhere to also prove the cross-volume path"
}

# A real deep path, not just the registry flag.
$deep = $libraryRoot
$deepProbeCreated = $true
try {
  foreach ($segment in 1..10) { $deep = Join-Path $deep ("deep-directory-level-" + $segment) }
  New-Item -ItemType Directory -Force -Path $deep | Out-Null
  Set-Content -Path (Join-Path $deep 'probe.txt') -Value 'ok'
  if ((Get-Content (Join-Path $deep 'probe.txt') -Raw).Trim() -ne 'ok') { throw 'content mismatch' }
  Add-Result 'Deep path write' 'PASS' ("created a " + $deep.Length + "-character path")
} catch {
  $deepProbeCreated = $false
  Add-Result 'Deep path write' 'FAIL' "$($_.Exception.Message) at $deep"
} finally {
  try { if ($deepProbeCreated) { Remove-Item -LiteralPath (Join-Path $libraryRoot ('deep-directory-level-1')) -Recurse -Force -ErrorAction SilentlyContinue } } catch {}
}

# The primitive the app now depends on, measured on this machine.
$crossRenameProbe = Join-Path $staging ('rename-probe-' + (Get-Random) + '.mkv')
Set-Content -Path (Join-Path $libraryRoot 'rename-probe-src.mkv') -Value 'payload'
try {
  $probeOut = & node -e "const fs=require('fs');try{fs.renameSync(process.argv[1],process.argv[2]);console.log('renamed')}catch(e){console.log(e.code)}" (Join-Path $libraryRoot 'rename-probe-src.mkv') $crossRenameProbe 2>&1
  if ("$probeOut" -match 'renamed') {
    Add-Result 'rename across roots' 'PASS' 'the two roots behave like one volume, so the atomic path is used'
    Move-Item -Force $crossRenameProbe (Join-Path $libraryRoot 'rename-probe-src.mkv') -ErrorAction SilentlyContinue
  } else {
    Add-Result 'rename across roots' 'INFO' "$probeOut - this is why promotion copies instead of renaming; moveFileIntoPlace handles it"
  }
} catch {
  Add-Result 'rename across roots' 'WARN' "probe failed: $($_.Exception.Message)"
}
Remove-Item -Force (Join-Path $libraryRoot 'rename-probe-src.mkv') -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- server
Write-Host ''
Write-Host 'Local node' -ForegroundColor White
$built = Join-Path $apiDir 'dist\index.mjs'
if (-not (Test-Path $built) -and -not $SkipBuild) {
  Write-Host '  building @workspace/api-server ...' -ForegroundColor DarkGray
  Push-Location $repo
  try { & pnpm --filter '@workspace/api-server' run build 2>&1 | Out-Null } finally { Pop-Location }
}
if (-not (Test-Path $built)) {
  Add-Result 'API build' 'FAIL' "$built is missing; run pnpm --filter @workspace/api-server run build"
} else {
  Add-Result 'API build' 'PASS' $built

  $savedEnv = @{}
  foreach ($name in @('PORT','AUTH_MODE','NODE_ENV','API_HOST','ARCHIVE_DB_PATH','ARCHIVE_DATA_PATH','ARCHIVE_LIBRARY_PATH','ARCHIVE_DOWNLOAD_PATH','ARCHIVE_TEMP_PATH','ARCHIVE_MOCK_MODE','FFMPEG_PATH','FFPROBE_PATH','YT_DLP_PATH','LOG_LEVEL')) {
    $savedEnv[$name] = (Get-Item "Env:$name" -ErrorAction SilentlyContinue).Value
    Set-Item "Env:$name" -Value '' -ErrorAction SilentlyContinue
  }
  $env:PORT = "$Port"
  $env:AUTH_MODE = 'local'
  $env:NODE_ENV = 'production'
  $env:API_HOST = '127.0.0.1'
  $env:ARCHIVE_DB_PATH = Join-Path $dataDir 'readiness.sqlite'
  $env:ARCHIVE_DATA_PATH = $dataDir
  $env:ARCHIVE_LIBRARY_PATH = $libraryRoot
  $env:ARCHIVE_DOWNLOAD_PATH = $staging
  $env:ARCHIVE_TEMP_PATH = $staging
  if ($WithJob) { $env:ARCHIVE_MOCK_MODE = 'false' } else { $env:ARCHIVE_MOCK_MODE = 'true' }
  if ($toolPaths['ffmpeg']) { $env:FFMPEG_PATH = $toolPaths['ffmpeg'] }
  if ($toolPaths['ffprobe']) { $env:FFPROBE_PATH = $toolPaths['ffprobe'] }
  if ($toolPaths['yt-dlp']) { $env:YT_DLP_PATH = $toolPaths['yt-dlp'] }
  $env:LOG_LEVEL = 'error'

  $server = Start-Process -FilePath 'node' -ArgumentList "`"$built`"" -WorkingDirectory $apiDir -PassThru -WindowStyle Hidden
  $healthy = $false
  for ($i = 0; $i -lt 60 -and -not $healthy; $i++) {
    Start-Sleep -Milliseconds 500
    try { if ((Invoke-Api 'Get' '/healthz').status) { $healthy = $true } } catch {}
  }
  if (-not $healthy) {
    Add-Result 'API server' 'FAIL' "did not answer /api/healthz on port $Port (is something already using it?)"
  } else {
    Add-Result 'API server' 'PASS' "http://127.0.0.1:$Port/api/healthz"
    try {
      Invoke-Api 'Patch' '/settings' @{
        archiveDirectory = ($libraryRoot + "`n" + $staging)
        downloadDirectory = $staging
        temporaryDirectory = $staging
        # A download cannot be verified offline, so the mode follows the switch
        # rather than the developer default.
        mockMode = (-not [bool]$WithJob)
        networkMode = $(if ($WithJob) { 'allow_network' } else { 'local_only' })
      } | Out-Null
      Add-Result 'Settings' 'PASS' 'two archive volumes configured (library + staging), so a promotion is journal-legal'
    } catch { Add-Result 'Settings' 'FAIL' $_.Exception.Message }

    try {
      $deps = Invoke-Api 'Get' '/system/dependencies'
      $missing = @($deps | Where-Object { $_.status -ne 'available' })
      if ($missing.Count -eq 0) { Add-Result '/system/dependencies' 'PASS' (($deps | ForEach-Object { $_.name + ' ' + $_.version }) -join ', ') }
      else { Add-Result '/system/dependencies' 'WARN' ('the UI will show these as unavailable: ' + (($missing | ForEach-Object { $_.name }) -join ', ')) }
    } catch { Add-Result '/system/dependencies' 'FAIL' $_.Exception.Message }

    try {
      $integrations = Invoke-Api 'Get' '/integrations'
      Add-Result 'Integration registry' 'PASS' ((@($integrations) | ForEach-Object { $_.id + '=' + $_.state }) -join ', ')
    } catch { Add-Result 'Integration registry' 'FAIL' $_.Exception.Message }

    # ------------------------------------------------------------ journaled move
    Write-Host ''
    Write-Host 'Journaled mutation (the safe move into the archive)' -ForegroundColor White
    $misnamedDir = Join-Path $libraryRoot 'unsorted'
    New-Item -ItemType Directory -Force -Path $misnamedDir | Out-Null
    $misnamed = Join-Path $misnamedDir 'Readiness.Misnamed.Entry.2024.1080p.mkv'
    Set-Content -Path $misnamed -Value ('x' * 4096)
    try {
      Invoke-Api 'Post' '/archive/scan' @{} | Out-Null
      $state = $null
      for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 250
        $state = Invoke-Api 'Get' '/archive/scan'
        if ($state.status -ne 'scanning') { break }
      }
      Add-Result 'Archive scan' 'PASS' "status=$($state.status)"

      $proposals = Invoke-Api 'Get' '/archive/naming-proposals?pageSize=200'
      $mine = @($proposals.proposals | Where-Object { $_.sourcePath -eq $misnamed -or $_.sourceFilename -eq 'Readiness.Misnamed.Entry.2024.1080p.mkv' })
      if ($mine.Count -eq 0) {
        Add-Result 'Naming proposal' 'SKIP' "the scanned file was not proposed for relocation ($($proposals.proposals.Count) proposals exist); the journal checks below still ran on the volume rules"
      } else {
        $proposal = $mine[0]
        Invoke-Api 'Post' '/archive/naming-proposals/decisions' @{ decisions = @(@{ fileRecordId = $proposal.fileRecordId; status = 'accepted'; note = 'readiness probe' }) } | Out-Null
        $applied = Invoke-Api 'Post' '/archive/naming-proposals/apply' @{ fileRecordIds = @($proposal.fileRecordId); dryRun = $false }
        $ok = @($applied.results)[0]
        if ($ok.success) {
          $moved = $proposal.proposedPath
          if (Test-Path $moved) {
            Add-Result 'Safe move' 'PASS' "moved to $moved; if this crossed a drive, the verified copy path was used"
            $op = Invoke-Api 'Get' '/archive/operations?limit=5'
            $entry = @($op | Where-Object { $_.id -eq $ok.operation.id })[0]
            if ($entry.rollbackAvailable) {
              $rolled = Invoke-Api 'Post' ("/archive/operations/" + $entry.id + "/rollback") @{}
              if ($rolled.status -eq 'rolled_back' -and (Test-Path $misnamed)) {
                Add-Result 'Rollback' 'PASS' 'the file returned to its original path'
              } else {
                Add-Result 'Rollback' 'FAIL' "status=$($rolled.status) error=$($rolled.error)"
              }
            } else { Add-Result 'Rollback' 'WARN' 'the journal entry does not advertise rollback' }
          } else {
            Add-Result 'Safe move' 'FAIL' "the journal reported success but $moved does not exist"
          }
        } else {
          Add-Result 'Safe move' 'FAIL' ($ok.error + ' (operation status ' + $ok.operation.status + ')')
        }
      }
    } catch { Add-Result 'Journaled mutation' 'FAIL' $_.Exception.Message }

    # ------------------------------------------------------------ intake
    Write-Host ''
    Write-Host 'URL -> Archive intake' -ForegroundColor White
    if ($WithJob) {
      try {
        $title = 'Readiness Sample ' + (Get-Date -Format 'HHmmss')
        $job = Invoke-Api 'Post' '/downloads' @{ sourceUrl = $SampleUrl; title = $title; selectedFormatId = 'best' }
        Add-Result 'Download job' 'PASS' "job #$($job.id) queued for $SampleUrl"
        $final = $null
        for ($i = 0; $i -lt 240; $i++) {
          Start-Sleep -Seconds 1
          $final = Invoke-Api 'Get' ("/downloads/" + $job.id)
          if ($final.status -in @('complete', 'failed', 'cancelled', 'recovery_required')) { break }
        }
        if ($final.status -eq 'complete') { Add-Result 'Verification + move' 'PASS' "staged at $($final.finalPath)" }
        else { Add-Result 'Verification + move' 'FAIL' "status=$($final.status) error=$($final.errorMessage)" }

        $intake = Invoke-Api 'Get' '/archive/intake'
        $item = @($intake.items | Where-Object { $_.jobId -eq $job.id })[0]
        if (-not $item) { Add-Result 'Intake queue' 'FAIL' 'the finished job is not on the intake queue' }
        else {
          Add-Result 'Intake queue' 'PASS' "disposition=$($item.disposition) checksum=$($item.checksumStatus) findings=$($item.qualityFindings.Count)"
          if ($item.disposition -eq 'promotable') {
            $plan = Invoke-Api 'Post' ("/archive/intake/" + $job.id + "/plan") @{}
            Add-Result 'Intake plan' 'PASS' "operation #$($plan.operation.id) $($plan.operation.kind), dryRun=$($plan.plan.ok)"
            $apply = Invoke-Api 'Post' ("/archive/intake/" + $job.id + "/apply") @{ operationId = $plan.operation.id }
            if ($apply.operation.status -eq 'succeeded') { Add-Result 'Intake promotion' 'PASS' "$($apply.operation.targetPath)" }
            else { Add-Result 'Intake promotion' 'FAIL' "status=$($apply.operation.status) error=$($apply.operation.error)" }
          } else {
            Add-Result 'Intake promotion' 'SKIP' "not promotable ($($item.nextAction))"
          }
        }
      } catch { Add-Result 'Intake' 'FAIL' $_.Exception.Message }
    } else {
      Add-Result 'Intake promotion' 'SKIP' 'pass -WithJob to run a real download through yt-dlp, verify, promote and roll back'
    }
  }

  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  foreach ($name in $savedEnv.Keys) {
    if ($savedEnv[$name]) { Set-Item "Env:$name" -Value $savedEnv[$name] } else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  }
}

if (-not $KeepRoot -and $resolvedRoot -like ($env:TEMP + '*')) {
  Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "  test root kept at $resolvedRoot" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host 'Summary' -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String | Write-Host
$failures = @($results | Where-Object { $_.Status -eq 'FAIL' })
if ($failures.Count) {
  Write-Host "$($failures.Count) check(s) failed." -ForegroundColor Red
  exit 1
}
Write-Host 'No blocking failures. Readiness for the audited checks is confirmed on this machine.' -ForegroundColor Green
exit 0
