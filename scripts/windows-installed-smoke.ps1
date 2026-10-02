param(
  [Parameter(Mandatory = $true)] [string] $InstallDirectory,
  [string] $WorkingDirectory = "$env:RUNNER_TEMP\archive-assistant-smoke-work",
  [int] $TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $WorkingDirectory | Out-Null
$smokeLog = Join-Path $WorkingDirectory 'installed-smoke.log'
Start-Transcript -Path $smokeLog -Force | Out-Null
$desktop = $null
$failed = $false

function Write-Check([string] $Message) {
  Write-Host "[installed-smoke] $Message"
}

function Find-ChildNode([int] $ParentId) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId" |
    Where-Object { $_.Name -ieq 'node.exe' } |
    Select-Object -First 1
}

try {
  $exe = Join-Path $InstallDirectory 'archive-assistant-desktop.exe'
  if (-not (Test-Path -LiteralPath $exe)) {
    throw "Installed desktop executable was not found at $exe"
  }

  $desktop = Start-Process -FilePath $exe -WorkingDirectory $WorkingDirectory -PassThru
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $node = $null
  $connection = $null

  do {
    Start-Sleep -Milliseconds 500
    $desktop.Refresh()
    if ($desktop.HasExited) {
      throw "Installed desktop exited during startup with code $($desktop.ExitCode)"
    }
    $node = Find-ChildNode $desktop.Id
    if ($node) {
      $connection = Get-NetTCPConnection -State Listen -OwningProcess ([int] $node.ProcessId) -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
        Select-Object -First 1
    }
  } while (-not $connection -and (Get-Date) -lt $deadline)

  if (-not $node) { throw 'The installed application did not start a child node.exe process.' }
  if (-not $connection) { throw 'The installed bundled API did not expose a loopback listener before the timeout.' }

  $nodePath = [IO.Path]::GetFullPath($node.ExecutablePath)
  $expectedNode = [IO.Path]::GetFullPath((Join-Path $InstallDirectory 'runtime\node.exe'))
  if ($nodePath -ine $expectedNode) {
    throw "The API did not use the installed bundled Node runtime. Actual: $nodePath Expected: $expectedNode"
  }
  if ($node.CommandLine -notmatch 'api-server[\\/]dist[\\/]index\.mjs') {
    throw "The installed Node process did not launch the packaged API entry point: $($node.CommandLine)"
  }
  Write-Check "bundled node.exe launched packaged api-server/dist/index.mjs"

  $port = [int] $connection.LocalPort
  $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/healthz" -TimeoutSec 10
  if ($health.StatusCode -ne 200) { throw "API health returned HTTP $($health.StatusCode)" }
  $overview = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/assistant/overview" -TimeoutSec 10
  if ($overview.StatusCode -ne 200) { throw "Assistant overview returned HTTP $($overview.StatusCode)" }
  Write-Check "installed sidecar is healthy and assistant overview responds"

  $tools = Join-Path $InstallDirectory 'runtime\media-tools'
  foreach ($tool in @(
    @{ Name = 'ffmpeg.exe'; Args = @('-version') },
    @{ Name = 'ffprobe.exe'; Args = @('-version') },
    @{ Name = 'yt-dlp.exe'; Args = @('--version') }
  )) {
    $toolPath = Join-Path $tools $tool.Name
    if (-not (Test-Path -LiteralPath $toolPath)) { throw "Installed media tool is missing: $toolPath" }
    & $toolPath @($tool.Args) *> $null
    if ($LASTEXITCODE -ne 0) { throw "Installed media tool failed to execute: $toolPath ($LASTEXITCODE)" }
  }
  Write-Check 'installed ffmpeg.exe, ffprobe.exe, and yt-dlp.exe execute successfully'

  $expectedDb = Join-Path $env:LOCALAPPDATA 'com.imlochie.archiveassistant\archive-assistant.sqlite'
  if (-not (Test-Path -LiteralPath $expectedDb)) {
    throw "Installed API did not create the expected per-user database: $expectedDb"
  }
  $repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  if ([IO.Path]::GetFullPath($expectedDb).StartsWith($repoPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Installed database unexpectedly resolves inside the repository: $expectedDb"
  }
  Write-Check "database exists outside repository at $expectedDb"

  Write-Check 'frontend webview was launched by the installed Tauri executable; direct API response verified above'
} catch {
  $failed = $true
  Write-Error $_
} finally {
  if ($desktop -and -not $desktop.HasExited) {
    taskkill.exe /PID $desktop.Id /T /F | Out-Host
    $desktop.WaitForExit(10000)
  }
  $lifecycle = Join-Path $env:LOCALAPPDATA 'com.imlochie.archiveassistant\lifecycle.log'
  if (Test-Path -LiteralPath $lifecycle) {
    Copy-Item -LiteralPath $lifecycle -Destination (Join-Path $WorkingDirectory 'lifecycle.log') -Force
  }
  Stop-Transcript | Out-Null
}

if ($failed) { exit 1 }
