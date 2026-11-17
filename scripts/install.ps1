[CmdletBinding()]
param(
    [string]$Source,
    [string]$Version,
    [string]$InstallDir,
    [switch]$Help,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArguments
)

$ErrorActionPreference = 'Stop'

function Show-Usage {
    @'
Usage: install.ps1 [-Source URL] [-Version VERSION] [-InstallDir PATH] [-Help]

Install the per-user Windows x64 polakapi release using its verified NSIS installer.
Without -Source, the installer resolves the latest stable release. -Source points to
a complete release directory containing manifest.tsv and release-version.txt.
'@ | Write-Output
}

function Assert-Version([string]$Value, [string]$Label) {
    if ($Value -notmatch '^\d+\.\d+\.\d+$') {
        throw "$Label must be a numeric x.y.z version."
    }
}

function Assert-DownloadUri([string]$Value, [bool]$ExplicitSource) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
        throw 'Source must be an absolute HTTPS URL.'
    }
    if ($uri.Scheme -eq 'https') {
        return $uri
    }
    $loopbackHost = $uri.Host -eq 'localhost' -or $uri.Host -eq '127.0.0.1' -or $uri.Host -eq '::1'
    if ($ExplicitSource -and $uri.Scheme -eq 'http' -and $loopbackHost) {
        return $uri
    }
    throw 'Downloads must use HTTPS; HTTP is allowed only for an explicit loopback source.'
}

function Assert-AllowedUri([Uri]$Uri, [bool]$AllowLoopbackHttp) {
    if ($Uri.Scheme -eq 'https') {
        return
    }
    $loopbackHost = $Uri.Host -eq 'localhost' -or $Uri.Host -eq '127.0.0.1' -or $Uri.Host -eq '::1'
    if ($AllowLoopbackHttp -and $Uri.Scheme -eq 'http' -and $loopbackHost) {
        return
    }
    throw 'Downloads and redirects must use HTTPS; HTTP is allowed only for an explicit loopback source.'
}

function Join-ReleaseUri([Uri]$BaseUri, [string]$Name) {
    return [Uri]::new($BaseUri, $Name)
}

function Get-Download([Uri]$Uri, [string]$Destination, [bool]$AllowLoopbackHttp) {
    $currentUri = $Uri
    for ($redirect = 0; $redirect -le 5; $redirect++) {
        Assert-AllowedUri $currentUri $AllowLoopbackHttp
        $request = [Net.HttpWebRequest]::Create($currentUri)
        $request.AllowAutoRedirect = $false
        $request.Timeout = 15000
        $request.ReadWriteTimeout = 15000
        $response = $null
        try {
            $response = $request.GetResponse()
        } catch [Net.WebException] {
            if ($_.Exception.Response) {
                $response = $_.Exception.Response
            } else {
                throw
            }
        }
        try {
            $statusCode = [int]$response.StatusCode
            if ($statusCode -ge 300 -and $statusCode -lt 400) {
                $location = $response.Headers['Location']
                if (-not $location) {
                    throw 'Download redirect is missing its destination.'
                }
                if ($redirect -eq 5) {
                    throw 'Download exceeded the maximum of five redirects.'
                }
                $currentUri = [Uri]::new($currentUri, $location)
                continue
            }
            if ($statusCode -lt 200 -or $statusCode -ge 300) {
                throw "Download failed with HTTP status $statusCode."
            }
            $inputStream = $response.GetResponseStream()
            $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                $inputStream.CopyTo($outputStream)
            } finally {
                $outputStream.Dispose()
                $inputStream.Dispose()
            }
            return
        } finally {
            if ($response) {
                $response.Dispose()
            }
        }
    }
    throw 'Download redirect loop was not completed.'
}

function Get-ReleaseFile([Uri]$BaseUri, [string]$Name, [string]$Destination, [bool]$AllowLoopbackHttp) {
    $fileUri = Join-ReleaseUri $BaseUri $Name
    Get-Download $fileUri $Destination $AllowLoopbackHttp
}

function Get-ManifestRows([string]$ManifestPath) {
    $content = [IO.File]::ReadAllText($ManifestPath, [Text.Encoding]::UTF8)
    $lines = $content -split "`r?`n"
    if ($lines.Count -lt 2 -or $lines[0].TrimStart([char]0xFEFF) -cne "version`tplatform`tarch`tfile`tsha256") {
        throw 'Release manifest has an invalid header or no asset rows.'
    }

    $rows = @()
    $seen = @{}
    $releaseVersion = $null
    for ($index = 1; $index -lt $lines.Count; $index++) {
        if ($lines[$index].Length -eq 0 -and $index -eq $lines.Count - 1) {
            continue
        }
        $fields = $lines[$index].Split([char]9, [StringSplitOptions]::None)
        if ($fields.Count -ne 5) {
            throw "Release manifest row $($index + 1) must contain exactly five tab-separated fields."
        }
        $rowVersion, $platform, $arch, $file, $sha256 = $fields
        Assert-Version $rowVersion "Manifest version on row $($index + 1)"
        if ($platform -cnotin @('macos', 'linux', 'windows')) {
            throw "Release manifest row $($index + 1) has an unsupported platform."
        }
        if ($arch -cnotin @('universal', 'arm64', 'x64', 'any')) {
            throw "Release manifest row $($index + 1) has an unsupported architecture."
        }
        if ($file -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $file -in @('.', '..')) {
            throw "Release manifest row $($index + 1) has an unsafe file name."
        }
        if ($sha256 -cnotmatch '^[a-f0-9]{64}$') {
            throw "Release manifest row $($index + 1) has an invalid SHA-256 value."
        }
        if ($platform -ceq 'windows' -and $arch -ceq 'any' -and $file -ceq 'install.ps1') {
            $key = "$platform/$arch"
        } elseif ($arch -ceq 'any') {
            throw "Release manifest row $($index + 1) uses 'any' for a platform asset."
        } else {
            $key = "$platform/$arch"
        }
        if ($seen.ContainsKey($key)) {
            throw "Release manifest contains duplicate platform/architecture row '$key'."
        }
        $seen[$key] = $true
        if ($null -eq $releaseVersion) {
            $releaseVersion = $rowVersion
        } elseif ($releaseVersion -cne $rowVersion) {
            throw 'Release manifest contains more than one version.'
        }
        $rows += [pscustomobject]@{
            Version = $rowVersion
            Platform = $platform
            Arch = $arch
            File = $file
            Sha256 = $sha256
        }
    }
    if (-not ($rows | Where-Object { $_.Platform -ceq 'windows' -and $_.Arch -ceq 'any' -and $_.File -ceq 'install.ps1' })) {
        throw "Release manifest is missing the Windows 'any' installer-script row."
    }
    return $rows
}

if ($Help) {
    Show-Usage
    exit 0
}

if ($RemainingArguments.Count -gt 0) {
    throw "Unexpected argument: $($RemainingArguments[0])"
}
if ($Version) {
    Assert-Version $Version 'Version'
}
if ($Source) {
    $sourceUri = Assert-DownloadUri $Source $true
    if ($sourceUri.Query -or $sourceUri.Fragment) {
        throw 'Source must identify a release directory without a query or fragment.'
    }
}
if ($InstallDir -and -not [IO.Path]::IsPathRooted($InstallDir)) {
    throw 'InstallDir must be an absolute path.'
}
if ($InstallDir -match '["\r\n]') {
    throw 'InstallDir cannot contain quotation marks or line breaks.'
}

$platformId = [Environment]::OSVersion.Platform
if ($platformId -ne [PlatformID]::Win32NT) {
    throw 'The Windows installer can run only on native Windows. On Git Bash, launch PowerShell outside WSL.'
}
$processorArchitecture = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Architecture
if ($processorArchitecture -ne 9) {
    throw 'The Windows installer supports x64 only; ARM and 32-bit systems are not supported.'
}

$allowLoopbackHttp = [bool]($Source -and $sourceUri.Scheme -eq 'http')

if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\polakapi'
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if (Test-Path -LiteralPath $InstallDir -PathType Leaf) {
    throw 'InstallDir points to a file, not a directory.'
}

$tempRoot = $null
try {
    if ($Source) {
        $releaseUri = [Uri]::new($sourceUri.AbsoluteUri.TrimEnd('/') + '/')
    } elseif ($Version) {
        $releaseUri = [Uri]::new("https://github.com/rafaelje/polakapi/releases/download/v$Version/")
    } else {
        $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('polakapi-install-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        $latestPath = Join-Path $tempRoot 'release-version.txt'
        $latestUri = [Uri]::new('https://github.com/rafaelje/polakapi/releases/latest/download/release-version.txt')
        Get-Download $latestUri $latestPath $false
        $Version = [IO.File]::ReadAllText($latestPath, [Text.Encoding]::UTF8).Trim()
        Assert-Version $Version 'Latest release version'
        $releaseUri = [Uri]::new("https://github.com/rafaelje/polakapi/releases/download/v$Version/")
    }
    if (-not $tempRoot) {
        $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('polakapi-install-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    }

    $manifestPath = Join-Path $tempRoot 'manifest.tsv'
    $releaseVersionPath = Join-Path $tempRoot 'release-version.txt'
    Get-ReleaseFile $releaseUri 'manifest.tsv' $manifestPath $allowLoopbackHttp
    Get-ReleaseFile $releaseUri 'release-version.txt' $releaseVersionPath $allowLoopbackHttp
    $releaseVersion = [IO.File]::ReadAllText($releaseVersionPath, [Text.Encoding]::UTF8).Trim()
    Assert-Version $releaseVersion 'Release version'
    $rows = @(Get-ManifestRows $manifestPath)
    if ($rows[0].Version -cne $releaseVersion) {
        throw 'Release version does not match the manifest version.'
    }
    if ($Version -and $Version -cne $releaseVersion) {
        throw 'Requested version does not match the release version.'
    }

    $scriptRow = $rows | Where-Object { $_.Platform -ceq 'windows' -and $_.Arch -ceq 'any' -and $_.File -ceq 'install.ps1' } | Select-Object -First 1
    $scriptPath = Join-Path $tempRoot 'release-install.ps1'
    Get-ReleaseFile $releaseUri $scriptRow.File $scriptPath $allowLoopbackHttp
    if ((Get-FileHash -LiteralPath $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $scriptRow.Sha256) {
        throw 'Windows installer script checksum verification failed.'
    }

    $asset = $rows | Where-Object { $_.Platform -ceq 'windows' -and $_.Arch -ceq 'x64' } | Select-Object -First 1
    if (-not $asset) {
        throw 'Release manifest does not contain a Windows x64 installer.'
    }
    $installerPath = Join-Path $tempRoot $asset.File
    Get-ReleaseFile $releaseUri $asset.File $installerPath $allowLoopbackHttp
    if ((Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $asset.Sha256) {
        throw 'Windows installer checksum verification failed.'
    }

    $runningApp = Get-Process -Name 'polakapi' -ErrorAction SilentlyContinue
    if ($runningApp) {
        throw 'Close polakapi before installing or upgrading it.'
    }

    $process = Start-Process -FilePath $installerPath -ArgumentList @("/D=$InstallDir") -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "NSIS installer failed with exit code $($process.ExitCode)."
    }
    Write-Output "Installed polakapi $releaseVersion to $InstallDir."
    exit 0
} catch {
    [Console]::Error.WriteLine("polakapi installer: $($_.Exception.Message)")
    exit 1
} finally {
    if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
