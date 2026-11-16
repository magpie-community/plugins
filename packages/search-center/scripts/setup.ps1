param([string]$Python = 'py')
$ErrorActionPreference = 'Stop'
$dataDir = if ($env:SEARCH_CENTER_DATA_DIR) { [IO.Path]::GetFullPath($env:SEARCH_CENTER_DATA_DIR) } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.magpie-search-center' }
$venvDir = Join-Path $dataDir 'venv'
$pythonArgs = if ([IO.Path]::GetFileNameWithoutExtension($Python) -eq 'py') { @('-3') } else { @() }
& $Python @pythonArgs -c 'import sys; assert sys.version_info >= (3, 12), "Python 3.12 or newer is required"'
if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12+ or pass -Python with its executable path.' }
if (-not (Test-Path -LiteralPath (Join-Path $venvDir 'Scripts/python.exe'))) {
  & $Python @pythonArgs -m venv $venvDir
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create the isolated Python environment.' }
}
$runtimePython = Join-Path $venvDir 'Scripts/python.exe'
& $runtimePython -m pip install --quiet --disable-pip-version-check -r (Join-Path $PSScriptRoot '../requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed. Check network access and retry.' }
& $runtimePython -c 'import fastmcp,httpx,mcp,pydantic,tenacity; print("Search Center Python dependencies are ready")'
if ($LASTEXITCODE -ne 0) { throw 'Python dependency check failed.' }
Write-Output "Runtime: $runtimePython"
