param(
  [string]$Repo = "christopheraaronhogg/church-transcriber-tauri",
  [switch]$Silent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'This installer is intended for Windows only.'
}

# Improve TLS compatibility on older PowerShell hosts.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Write-Step {
  param([string]$Message)
  Write-Host "[church-transcriber-install] $Message" -ForegroundColor Cyan
}

function Get-LatestRelease {
  param([string]$Repository)

  $headers = @{
    'User-Agent' = 'church-transcriber-installer'
    'Accept'     = 'application/vnd.github+json'
  }

  $url = "https://api.github.com/repos/$Repository/releases/latest"
  try {
    return Invoke-RestMethod -Uri $url -Headers $headers
  }
  catch {
    throw "Failed to fetch latest release from $url. Ensure a release exists and internet access is available. Error: $($_.Exception.Message)"
  }
}

function Select-InstallerAsset {
  param($Release)

  if (-not $Release.assets -or $Release.assets.Count -eq 0) {
    throw "Latest release '$($Release.tag_name)' has no assets."
  }

  $candidates = $Release.assets | Where-Object {
    $_.name -match '(?i)\.(msi|exe)$' -and
    $_.name -notmatch '(?i)\.(sig|sha256|sha512|txt)$'
  }

  if (-not $candidates) {
    throw "No installer asset (.msi/.exe) found on release '$($Release.tag_name)'."
  }

  # Prefer x64 installers, then MSI, then anything else.
  $ranked = $candidates | Sort-Object `
    @{ Expression = { if ($_.name -match '(?i)(x64|amd64)') { 0 } else { 1 } } }, `
    @{ Expression = { if ($_.name -match '(?i)\.msi$') { 0 } else { 1 } } }, `
    @{ Expression = { $_.name } }

  return $ranked | Select-Object -First 1
}

function Install-Asset {
  param(
    [string]$Path,
    [switch]$SilentInstall
  )

  if ($Path -match '(?i)\.msi$') {
    $args = @('/i', "`"$Path`"")
    if ($SilentInstall) {
      $args += @('/qn', '/norestart')
    } else {
      $args += @('/passive', '/norestart')
    }

    $proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList $args -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
      throw "MSI install failed with exit code $($proc.ExitCode)."
    }
    return
  }

  if ($Path -match '(?i)\.exe$') {
    # NSIS supports /S for silent installs.
    $args = @()
    if ($SilentInstall) { $args += '/S' }

    $proc = Start-Process -FilePath $Path -ArgumentList $args -PassThru -Wait
    if ($proc.ExitCode -ne 0) {
      throw "EXE install failed with exit code $($proc.ExitCode)."
    }
    return
  }

  throw "Unsupported installer type: $Path"
}

Write-Step "Checking latest release for $Repo"
$release = Get-LatestRelease -Repository $Repo
$asset = Select-InstallerAsset -Release $release

Write-Step "Latest release: $($release.tag_name)"
Write-Step "Selected asset: $($asset.name)"

$downloadDir = Join-Path $env:TEMP 'church-transcriber-install'
New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
$installerPath = Join-Path $downloadDir $asset.name

Write-Step "Downloading installer..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installerPath -UseBasicParsing

Write-Step "Installing..."
Install-Asset -Path $installerPath -SilentInstall:$Silent

$candidateExePaths = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Church Transcriber\Church Transcriber.exe'),
  (Join-Path $env:ProgramFiles 'Church Transcriber\Church Transcriber.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Church Transcriber\Church Transcriber.exe')
)

$installedExe = $candidateExePaths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($installedExe) {
  Write-Step "Launching app..."
  Start-Process -FilePath $installedExe | Out-Null
}

Write-Host ""
Write-Host "✅ Church Transcriber installed from release $($release.tag_name)." -ForegroundColor Green
if (-not $installedExe) {
  Write-Host "Launch from Start Menu: Church Transcriber" -ForegroundColor Yellow
}
