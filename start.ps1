$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:ARCHIVE_DB_PATH = Join-Path $root "data\archive-assistant.sqlite"

Write-Host "Starting ARCHIVE ASSISTANT..." -ForegroundColor Cyan
Write-Host "SQLite data: $env:ARCHIVE_DB_PATH" -ForegroundColor DarkGray
Write-Host "Open http://localhost:3000 when the browser is ready." -ForegroundColor DarkGray

$api = Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "`$env:PORT='8080'; `$env:ARCHIVE_DB_PATH='$env:ARCHIVE_DB_PATH'; Set-Location '$root'; pnpm --filter @workspace/api-server run dev"
) -PassThru

try {
  $env:PORT = "3000"
  $env:BASE_PATH = "/"
  pnpm --filter @workspace/archive-assistant run dev
}
finally {
  if ($api -and -not $api.HasExited) {
    Stop-Process -Id $api.Id -Force
  }
}