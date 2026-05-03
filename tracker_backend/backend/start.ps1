$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path $envFile)) {
  Write-Host '.env not found. Copy .env.example to .env first.'
  exit 1
}

uvicorn app.main:app --host 0.0.0.0 --port 8000
