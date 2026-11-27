param(
  [string]$AuthPath = (Join-Path (Join-Path $env:APPDATA 'qianfan-desktop-app') 'auth.json'),
  [string]$KeyPath = (Join-Path (Join-Path $env:APPDATA 'qianfan-desktop-app') '.cookie-key'),
  [string]$OutDir = (Join-Path (Get-Location) 'dumate-import')
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$authText = Get-Content -LiteralPath $AuthPath -Raw -Encoding UTF8
$keyBytes = [System.IO.File]::ReadAllBytes($KeyPath)
$keyText = [System.Convert]::ToBase64String($keyBytes)

$utf8 = New-Object System.Text.UTF8Encoding $false
$authOut = Join-Path $OutDir 'auth.json'
$keyOut = Join-Path $OutDir 'cookie-key.txt'
$bundleOut = Join-Path $OutDir 'dumate-import.json'

[System.IO.File]::WriteAllText($authOut, $authText, $utf8)
[System.IO.File]::WriteAllText($keyOut, $keyText, $utf8)
$bundle = [ordered]@{
  authJson = $authText
  cookieKey = $keyText
}
$json = $bundle | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($bundleOut, $json + "`n", $utf8)

Write-Output "AUTH_FILE=$authOut"
Write-Output "KEY_FILE=$keyOut"
Write-Output "BUNDLE_FILE=$bundleOut"
Write-Output "In Magpie choose auth.json + cookie-key.txt, or dumate-import.json."
