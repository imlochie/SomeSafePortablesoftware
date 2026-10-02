param(
  [Parameter(Mandatory = $false)]
  [string] $ProjectDirectory = (Join-Path $PSScriptRoot '..\artifacts\archive-assistant')
)

$ErrorActionPreference = 'Stop'

# Local mirror of the CI workflow's "Verify the packaged resource layout"
# step, which cannot run while GitHub Actions is unavailable. Run this on
# Windows after `pnpm run desktop:build` and before installing the NSIS
# package.
#
# Two trees are verified so a missing file is attributed to the right half
# of the build:
#   - the staged source tree (src-tauri/runtime), written by the staging
#     scripts during beforeBuildCommand, and
#   - the packaged tree (src-tauri/target/release), which is the resource
#     root the installed application reads: on Windows resource_dir() is the
#     directory containing the exe, with no "resources" segment.
#
# A file missing from the staged tree was removed between staging and
# packaging (antivirus quarantine is the usual suspect for a freshly copied
# unsigned node.exe during a long first Rust build). A file missing only
# from the packaged tree was dropped by the bundler. The Tauri CLI does not
# consult .gitignore when collecting bundle resources, so ignore rules are
# not a factor either way.

# Paths are relative to their tree's root: the staged tree root IS
# src-tauri/runtime, so its entries do not repeat the "runtime/" prefix.
$requiredStagedPaths = @(
  'node.exe',
  'README.txt',
  'THIRD-PARTY-NOTICES.txt',
  'media-tools/ffmpeg.exe',
  'media-tools/ffprobe.exe',
  'media-tools/yt-dlp.exe'
)

$requiredPackagedPaths = @(
  'api-server/dist/index.mjs',
  'runtime/node.exe',
  'runtime/media-tools/ffmpeg.exe',
  'runtime/media-tools/ffprobe.exe',
  'runtime/media-tools/yt-dlp.exe'
)

function Assert-RequiredTree {
  param(
    [string] $Root,
    [string[]] $RequiredPaths,
    [string] $Label
  )
  foreach ($relative in $RequiredPaths) {
    $candidate = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $candidate)) {
      Write-Host "${Label} tree (two levels):"
      Get-ChildItem -LiteralPath $Root -Recurse -Depth 2 -File -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "  $($_.FullName)" }
      throw "${Label} resource missing: $relative (root: $Root)"
    }
    Write-Host "ok  ${Label}: $relative"
  }
}

$srcTauriDirectory = Join-Path $ProjectDirectory 'src-tauri'

Assert-RequiredTree `
  -Root (Join-Path $srcTauriDirectory 'runtime') `
  -RequiredPaths $requiredStagedPaths `
  -Label 'Staged'

Assert-RequiredTree `
  -Root (Join-Path $srcTauriDirectory 'target\release') `
  -RequiredPaths $requiredPackagedPaths `
  -Label 'Packaged'
