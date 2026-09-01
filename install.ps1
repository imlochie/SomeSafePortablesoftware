$ErrorActionPreference = "Stop"

Write-Host "Installing ARCHIVE ASSISTANT..." -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer is required. Install Node.js, then run this script again."
}

$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required because ARCHIVE uses the embedded node:sqlite runtime."
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm is required. Enable it with 'corepack enable', then run this script again."
}

pnpm install
Write-Host "ARCHIVE ASSISTANT is installed." -ForegroundColor Green
Write-Host "Run .\start.ps1 to launch the local app." -ForegroundColor DarkGray