param(
  [string]$Repo = "christopheraaronhogg/church-transcriber-tauri",
  [switch]$Silent,
  [switch]$SkipDependencies,
  [string]$WhisperDir = "C:\ai\whisper",
  [string]$ModelDir = "C:\ai\whisper-models",
  [string]$ModelName = "ggml-small.en.bin",
  [switch]$NoLaunch
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

function Write-WarnStep {
  param([string]$Message)
  Write-Host "[church-transcriber-install] $Message" -ForegroundColor Yellow
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

function Ensure-Winget {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  return $null -ne $winget
}

function Ensure-Ffmpeg {
  $ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($ffmpeg) {
    Write-Step "ffmpeg already available: $($ffmpeg.Source)"
    return
  }

  if (-not (Ensure-Winget)) {
    throw "winget not found, cannot auto-install ffmpeg. Install FFmpeg manually and re-run."
  }

  Write-Step "Installing ffmpeg via winget (Gyan.FFmpeg)..."
  $args = @(
    'install',
    '--id', 'Gyan.FFmpeg',
    '--exact',
    '--silent',
    '--accept-package-agreements',
    '--accept-source-agreements'
  )

  $proc = Start-Process -FilePath 'winget' -ArgumentList $args -PassThru -Wait
  if ($proc.ExitCode -ne 0) {
    throw "winget ffmpeg install failed with exit code $($proc.ExitCode)."
  }

  $ffmpegAfter = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($ffmpegAfter) {
    Write-Step "ffmpeg installed: $($ffmpegAfter.Source)"
  } else {
    Write-WarnStep "ffmpeg installed but not yet on this session PATH. New terminal/session may be required."
  }
}

function Ensure-WhisperCli {
  param([string]$TargetDir)

  New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

  $existing = Get-ChildItem -Path $TargetDir -Recurse -File -Filter 'whisper-cli.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing) {
    Write-Step "whisper-cli already present: $($existing.FullName)"
    return $existing.FullName
  }

  $downloadDir = Join-Path $env:TEMP 'church-transcriber-whisper'
  New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null

  $zipPath = Join-Path $downloadDir 'whisper-bin-x64.zip'
  $extractPath = Join-Path $downloadDir 'extract'
  if (Test-Path -LiteralPath $extractPath) {
    Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Path $extractPath -Force | Out-Null

  $binUrl = 'https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip'
  Write-Step "Downloading whisper.cpp binary package..."
  Invoke-WebRequest -Uri $binUrl -OutFile $zipPath -UseBasicParsing

  Write-Step "Extracting whisper.cpp binaries..."
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

  $cliCandidate = Get-ChildItem -Path $extractPath -Recurse -File -Filter 'whisper-cli.exe' | Select-Object -First 1
  if (-not $cliCandidate) {
    throw "Could not locate whisper-cli.exe in downloaded whisper.cpp package."
  }

  $cliDir = Split-Path -Parent $cliCandidate.FullName
  Write-Step "Installing whisper runtime files to $TargetDir"
  Copy-Item -Path (Join-Path $cliDir '*') -Destination $TargetDir -Recurse -Force

  $installed = Get-ChildItem -Path $TargetDir -Recurse -File -Filter 'whisper-cli.exe' | Select-Object -First 1
  if (-not $installed) {
    throw "whisper-cli install failed: executable not found in $TargetDir after copy."
  }

  return $installed.FullName
}

function Ensure-Model {
  param(
    [string]$TargetDir,
    [string]$FileName
  )

  New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

  $targetPath = Join-Path $TargetDir $FileName
  if (Test-Path -LiteralPath $targetPath) {
    Write-Step "Model already present: $targetPath"
    return $targetPath
  }

  $url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$FileName"
  Write-Step "Downloading whisper model ($FileName)..."
  Invoke-WebRequest -Uri $url -OutFile $targetPath -UseBasicParsing

  if (-not (Test-Path -LiteralPath $targetPath)) {
    throw "Model download failed: $targetPath not found after download."
  }

  return $targetPath
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

Write-Step "Installing app..."
Install-Asset -Path $installerPath -SilentInstall:$Silent

$whisperCliPath = Join-Path $WhisperDir 'whisper-cli.exe'
$modelPath = Join-Path $ModelDir $ModelName

if (-not $SkipDependencies) {
  Write-Step "Installing dependencies (ffmpeg + whisper.cpp + model)..."

  Ensure-Ffmpeg
  $whisperCliPath = Ensure-WhisperCli -TargetDir $WhisperDir
  $modelPath = Ensure-Model -TargetDir $ModelDir -FileName $ModelName
} else {
  Write-WarnStep "Skipping dependency install because -SkipDependencies was provided."
}

$candidateExePaths = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Church Transcriber\Church Transcriber.exe'),
  (Join-Path $env:ProgramFiles 'Church Transcriber\Church Transcriber.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Church Transcriber\Church Transcriber.exe')
)

$installedExe = $candidateExePaths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($installedExe -and -not $NoLaunch) {
  Write-Step "Launching app..."
  Start-Process -FilePath $installedExe | Out-Null
}

Write-Host ""
Write-Host "✅ Church Transcriber installed from release $($release.tag_name)." -ForegroundColor Green
Write-Host "Repo: https://github.com/$Repo" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Recommended app paths:" -ForegroundColor Cyan
Write-Host "- Whisper executable: $whisperCliPath"
Write-Host "- Model file:        $modelPath"
Write-Host ""
if (-not $installedExe) {
  Write-Host "Launch from Start Menu: Church Transcriber" -ForegroundColor Yellow
}
