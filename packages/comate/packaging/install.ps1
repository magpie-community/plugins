#Requires -Version 5.1
[CmdletBinding()]
param(
    [string] $MagpiePath,
    [switch] $Login,
    [switch] $DryRun,
    [switch] $Help
)

$ErrorActionPreference = 'Stop'

function Fail([string] $Message) {
    throw "Comate installer: $Message"
}

function Get-RegularFile([string] $Path, [string] $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Fail "$Label is missing"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Fail "$Label must be a regular file, not a link or directory"
    }
    return $item
}

function Resolve-Magpie([string] $RequestedPath) {
    if ([string]::IsNullOrWhiteSpace($RequestedPath)) {
        $candidate = Get-Command -Name 'magpie' -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $candidate) {
            $RequestedPath = $candidate.Source
        } else {
            $RequestedPath = Read-Host 'Path to Magpie executable (blank to cancel)'
        }
    }
    if ([string]::IsNullOrWhiteSpace($RequestedPath)) {
        Fail 'Magpie executable path is required'
    }

    $containsPathSeparator = $RequestedPath.Contains([IO.Path]::DirectorySeparatorChar) -or
        $RequestedPath.Contains([IO.Path]::AltDirectorySeparatorChar)
    if ([IO.Path]::IsPathRooted($RequestedPath) -or $containsPathSeparator) {
        try {
            $resolved = [IO.Path]::GetFullPath($RequestedPath)
        } catch {
            Fail 'Magpie executable path is invalid'
        }
        $item = Get-RegularFile $resolved 'Magpie executable'
        return $item.FullName
    }

    $command = Get-Command -Name $RequestedPath -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) {
        Fail 'Magpie executable was not found; pass -MagpiePath with its full path'
    }
    $item = Get-RegularFile $command.Source 'Magpie executable'
    return $item.FullName
}

function Show-Usage {
    @'
Usage: powershell -NoProfile -File .\install.ps1 [-MagpiePath PATH] [-Login] [-DryRun]

Extract the complete ZIP into a persistent folder before running this installer.
The payload remains in that folder because Magpie registers its absolute path.
Sign-in is opt-in through -Login. -DryRun verifies files and prints commands
without writing files or invoking Magpie.
'@ | Write-Host
}

try {
    if ($Help) {
        Show-Usage
        exit 0
    }

    $scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
    $payloadPath = Join-Path $scriptRoot 'payload'
    if (-not (Test-Path -LiteralPath $payloadPath -PathType Container)) {
        Fail 'payload folder is missing beside this installer'
    }
    $payloadItem = Get-Item -LiteralPath $payloadPath -Force
    if (-not $payloadItem.PSIsContainer -or (($payloadItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Fail 'payload must be a real folder beside this installer'
    }

    $manifestPath = Join-Path $scriptRoot 'SHA256SUMS.txt'
    [void](Get-RegularFile $manifestPath 'SHA256SUMS.txt')
    $expectedPaths = @(
        'INSTALL.md',
        'install.ps1',
        'payload/LICENSE',
        'payload/README.md',
        'payload/discovery.mjs',
        'payload/index.mjs',
        'payload/package.json',
        'payload/protocol.mjs'
    )
    $expectedSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($path in $expectedPaths) { [void]$expectedSet.Add($path) }

    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $manifestLines = Get-Content -LiteralPath $manifestPath -Encoding UTF8
    foreach ($line in $manifestLines) {
        if ($line -notmatch '^(?<hash>[A-Fa-f0-9]{64})  (?<path>[A-Za-z0-9._/-]+)$') {
            Fail 'checksum manifest has an invalid row'
        }
        $relativePath = $Matches.path
        $expectedHash = $Matches.hash.ToLowerInvariant()
        if ($relativePath.StartsWith('/') -or $relativePath.Contains('\') -or
            ($relativePath.Split('/') -contains '..') -or -not $expectedSet.Contains($relativePath)) {
            Fail 'checksum manifest contains an unexpected or unsafe path'
        }
        if (-not $seen.Add($relativePath)) {
            Fail 'checksum manifest has a duplicate path'
        }

        $platformRelativePath = $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $filePath = Join-Path $scriptRoot $platformRelativePath
        [void](Get-RegularFile $filePath $relativePath)
        $actualHash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            Fail "checksum mismatch: $relativePath"
        }
    }
    if ($seen.Count -ne $expectedPaths.Count) {
        Fail 'checksum manifest has the wrong number of files'
    }
    foreach ($path in $expectedPaths) {
        if (-not $seen.Contains($path)) {
            Fail "checksum manifest is missing: $path"
        }
    }

    $resolvedMagpie = Resolve-Magpie $MagpiePath
    $absolutePayload = [IO.Path]::GetFullPath($payloadPath)
    if ($DryRun) {
        Write-Host 'Dry run: no files will be created and Magpie will not be invoked.'
        Write-Host ('Would run: & "{0}" plugin add "{1}"' -f $resolvedMagpie, $absolutePayload)
        if ($Login) {
            Write-Host ('Would run after a successful add: & "{0}" plugin login comate' -f $resolvedMagpie)
        } else {
            Write-Host ('Sign-in is skipped. To start it later: & "{0}" plugin login comate' -f $resolvedMagpie)
        }
        exit 0
    }

    Write-Host "Using the extracted payload at: $absolutePayload"
    Write-Host 'The payload folder will remain here; keep it in place while Magpie uses the plugin.'
    & $resolvedMagpie plugin add $absolutePayload
    $addStatus = $LASTEXITCODE
    if ($addStatus -ne 0) {
        Fail "magpie plugin add failed with exit code $addStatus"
    }

    if ($Login) {
        & $resolvedMagpie plugin login comate
        $loginStatus = $LASTEXITCODE
        if ($loginStatus -ne 0) {
            Fail "plugin was added, but magpie plugin login comate failed with exit code $loginStatus"
        }
        Write-Host 'Comate plugin added and sign-in completed.'
    } else {
        Write-Host 'Comate plugin added. No sign-in was started.'
        Write-Host ('Start sign-in when ready with: & "{0}" plugin login comate' -f $resolvedMagpie)
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
