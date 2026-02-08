param(
  [Parameter(Mandatory=$true)][string]$InputFolder,
  [Parameter(Mandatory=$true)][string]$OutputFolder,
  [Parameter(Mandatory=$true)][string]$ModelFile,
  [string]$WhisperExe = "whisper-cli.exe",
  [string]$FfmpegExe = "ffmpeg.exe",
  [switch]$Force,
  [switch]$NoRecursive,
  [int]$Limit = 0,
  [string]$BeforeDate = "",
  [int]$Threads = 0,
  [switch]$FastScan,
  [switch]$KeepAudio,
  [string]$PauseFlagFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Wait-IfPaused {
  param(
    [string]$PauseFlagPath,
    [string]$Context = ""
  )

  if ([string]::IsNullOrWhiteSpace($PauseFlagPath)) { return }

  $announced = $false
  while (Test-Path -LiteralPath $PauseFlagPath) {
    if (-not $announced) {
      $msg = "[pause] Pause requested. Waiting to resume"
      if (-not [string]::IsNullOrWhiteSpace($Context)) {
        $msg += " ($Context)"
      }
      Write-Host $msg
      Write-Host "[pause] Remove pause flag to continue: $PauseFlagPath"
      $announced = $true
    }
    Start-Sleep -Seconds 2
  }

  if ($announced) {
    Write-Host "[pause] Resume detected. Continuing..."
  }
}

function Emit-Progress {
  param(
    [int]$Done,
    [int]$Total,
    [string]$Status = "",
    [string]$Source = ""
  )

  $line = "[progress] done=$Done total=$Total"
  if (-not [string]::IsNullOrWhiteSpace($Status)) {
    $line += " status=$Status"
  }
  if (-not [string]::IsNullOrWhiteSpace($Source)) {
    $line += " source=$Source"
  }

  Write-Host $line
}

function Get-Slug {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return "service" }

  $s = $Text.ToLowerInvariant()
  $s = [regex]::Replace($s, "[^a-z0-9]+", "-")
  $s = [regex]::Replace($s, "-+", "-")
  $s = $s.Trim("-")

  if ([string]::IsNullOrWhiteSpace($s)) { $s = "service" }
  if ($s.Length -gt 96) { $s = $s.Substring(0, 96).Trim("-") }
  return $s
}

function Get-DateBucket {
  param([System.IO.FileInfo]$File)

  $name = $File.BaseName

  $m1 = [regex]::Match($name, "(20\d{2})[-_](\d{2})[-_](\d{2})")
  if ($m1.Success) {
    return "{0}-{1}-{2}" -f $m1.Groups[1].Value, $m1.Groups[2].Value, $m1.Groups[3].Value
  }

  $m2 = [regex]::Match($name, "(20\d{2})(\d{2})(\d{2})")
  if ($m2.Success) {
    return "{0}-{1}-{2}" -f $m2.Groups[1].Value, $m2.Groups[2].Value, $m2.Groups[3].Value
  }

  return $File.LastWriteTime.ToString("yyyy-MM-dd")
}

function Build-CleanMarkdown {
  param(
    [string]$Title,
    [string]$SourceFile,
    [string]$RawText
  )

  $flat = [regex]::Replace(($RawText ?? ""), "\s+", " ").Trim()
  $sentences = [regex]::Split($flat, "(?<=[.!?])\s+")

  $paragraphs = New-Object System.Collections.Generic.List[string]
  $buffer = ""

  foreach ($s in $sentences) {
    if ([string]::IsNullOrWhiteSpace($s)) { continue }

    if ([string]::IsNullOrWhiteSpace($buffer)) {
      $buffer = $s.Trim()
    } else {
      $buffer = "$buffer $($s.Trim())"
    }

    if ($buffer.Length -ge 700) {
      $paragraphs.Add($buffer.Trim())
      $buffer = ""
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($buffer)) {
    $paragraphs.Add($buffer.Trim())
  }

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("# $Title")
  $lines.Add("")
  $lines.Add("**Source file:** `$SourceFile`")
  $lines.Add("")
  $lines.Add("_Cleaned for punctuation/format only (no paraphrasing)._")
  $lines.Add("")

  foreach ($p in $paragraphs) {
    $lines.Add($p)
    $lines.Add("")
  }

  return ($lines -join "`r`n")
}

function Build-SummaryMarkdown {
  param(
    [string]$Title,
    [string]$SourceFile,
    [string]$RawText
  )

  $flat = [regex]::Replace(($RawText ?? ""), "\s+", " ").Trim()
  if ($flat.Length -gt 520) {
    $flat = $flat.Substring(0, 520).Trim() + "…"
  }

  $overview = $flat
  if ([string]::IsNullOrWhiteSpace($overview)) {
    $overview = "(No transcript text extracted)"
  }

  $lines = @(
    "# Summary — $Title",
    "",
    "- **Source file:** `$SourceFile`",
    "",
    "## Brief overview",
    $overview,
    "",
    "## Notes",
    "- Auto-generated with local Whisper (whisper.cpp).",
    "- Review names/terms/Bible references before publishing.",
    ""
  )

  return ($lines -join "`r`n")
}

if (-not (Test-Path -LiteralPath $InputFolder)) {
  throw "Input folder not found: $InputFolder"
}

$inputResolved = (Resolve-Path -LiteralPath $InputFolder).Path
if (-not (Test-Path -LiteralPath $OutputFolder)) {
  New-Item -ItemType Directory -Path $OutputFolder -Force | Out-Null
}
$outputResolved = (Resolve-Path -LiteralPath $OutputFolder).Path

if (-not (Get-Command $FfmpegExe -ErrorAction SilentlyContinue)) {
  throw "ffmpeg not found on PATH. Set -FfmpegExe or install ffmpeg."
}

if (-not (Get-Command $WhisperExe -ErrorAction SilentlyContinue)) {
  throw "whisper executable not found: $WhisperExe"
}

if (-not (Test-Path -LiteralPath $ModelFile)) {
  throw "Model file not found: $ModelFile"
}

if (-not [string]::IsNullOrWhiteSpace($BeforeDate)) {
  if (-not [regex]::IsMatch($BeforeDate, '^20\d{2}-\d{2}-\d{2}$')) {
    throw "BeforeDate must be YYYY-MM-DD (example: 2024-12-31)"
  }
}

if (-not [string]::IsNullOrWhiteSpace($PauseFlagFile)) {
  $pauseResolvedDir = Split-Path -Parent $PauseFlagFile
  if (-not [string]::IsNullOrWhiteSpace($pauseResolvedDir) -and -not (Test-Path -LiteralPath $pauseResolvedDir)) {
    New-Item -ItemType Directory -Path $pauseResolvedDir -Force | Out-Null
  }
  Write-Host "Pause flag file: $PauseFlagFile"
}

$mediaExts = @(
  ".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm",
  ".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".wma"
)

$scanMode = if ($NoRecursive) { "non-recursive" } else { "recursive" }
Write-Host "Scanning $scanMode in: $inputResolved"

$allFiles = if ($NoRecursive) {
  Get-ChildItem -LiteralPath $inputResolved -File
} else {
  Get-ChildItem -LiteralPath $inputResolved -File -Recurse
}

$mediaFiles = $allFiles | Where-Object { $mediaExts -contains $_.Extension.ToLowerInvariant() } | Sort-Object FullName
if ($Limit -gt 0) {
  $mediaFiles = $mediaFiles | Select-Object -First $Limit
}

if (-not $mediaFiles -or $mediaFiles.Count -eq 0) {
  Write-Host "No media files found."
  Emit-Progress -Done 0 -Total 0 -Status "empty"
  exit 0
}

$totalFiles = [int]$mediaFiles.Count
$processed = 0

Write-Host "Found $totalFiles media files"
Emit-Progress -Done 0 -Total $totalFiles -Status "start"

if (-not [string]::IsNullOrWhiteSpace($BeforeDate)) {
  Write-Host "Date filter: only files with inferred date <= $BeforeDate"
}
if ($Threads -gt 0) {
  Write-Host "Whisper threads per job: $Threads"
}
if ($FastScan) {
  Write-Host "FastScan: skipping clean.md and summary.md generation"
}

$results = New-Object System.Collections.Generic.List[object]

foreach ($file in $mediaFiles) {
  Wait-IfPaused -PauseFlagPath $PauseFlagFile -Context "before next file"

  Write-Host ""
  Write-Host "=== $($file.FullName) ==="

  $dateBucket = Get-DateBucket -File $file
  if (-not [string]::IsNullOrWhiteSpace($BeforeDate) -and $dateBucket -gt $BeforeDate) {
    Write-Host "[skip] date $dateBucket is after cutoff $BeforeDate"
    $results.Add([pscustomobject]@{ Status = "skipped-date"; Source = $file.FullName; Output = "" })
    $processed += 1
    Emit-Progress -Done $processed -Total $totalFiles -Status "skipped-date" -Source $file.FullName
    continue
  }

  $slug = Get-Slug -Text $file.BaseName

  $dateDir = Join-Path $outputResolved $dateBucket
  if (-not (Test-Path -LiteralPath $dateDir)) {
    New-Item -ItemType Directory -Path $dateDir -Force | Out-Null
  }

  $serviceDir = Join-Path $dateDir $slug
  if (-not (Test-Path -LiteralPath $serviceDir)) {
    New-Item -ItemType Directory -Path $serviceDir -Force | Out-Null
  }

  $rawPath = Join-Path $serviceDir "raw.txt"
  $cleanPath = Join-Path $serviceDir "clean.md"
  $summaryPath = Join-Path $serviceDir "summary.md"
  $timestampsPath = Join-Path $serviceDir "timestamps.json"
  $metadataPath = Join-Path $serviceDir "metadata.json"

  if ((Test-Path -LiteralPath $rawPath) -and (-not $Force)) {
    Write-Host "[skip] raw.txt exists"
    $results.Add([pscustomobject]@{ Status = "skipped"; Source = $file.FullName; Output = $serviceDir })
    $processed += 1
    Emit-Progress -Done $processed -Total $totalFiles -Status "skipped" -Source $file.FullName
    continue
  }

  $audioPath = Join-Path $serviceDir "audio-source.wav"
  $baseOut = Join-Path $serviceDir "audio-source"

  Wait-IfPaused -PauseFlagPath $PauseFlagFile -Context "before ffmpeg"
  & $FfmpegExe -y -loglevel error -i $file.FullName -vn -ac 1 -ar 16000 $audioPath
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "ffmpeg failed: $($file.FullName)"
    $results.Add([pscustomobject]@{ Status = "error"; Source = $file.FullName; Output = $serviceDir; Reason = "ffmpeg" })
    $processed += 1
    Emit-Progress -Done $processed -Total $totalFiles -Status "error-ffmpeg" -Source $file.FullName
    continue
  }

  $whisperArgs = @("-m", $ModelFile, "-f", $audioPath, "-of", $baseOut, "-otxt", "-oj")
  if ($Threads -gt 0) {
    $whisperArgs += @("-t", "$Threads")
  }

  Wait-IfPaused -PauseFlagPath $PauseFlagFile -Context "before whisper"
  & $WhisperExe @whisperArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "whisper failed: $($file.FullName)"
    $results.Add([pscustomobject]@{ Status = "error"; Source = $file.FullName; Output = $serviceDir; Reason = "whisper" })
    $processed += 1
    Emit-Progress -Done $processed -Total $totalFiles -Status "error-whisper" -Source $file.FullName
    continue
  }

  $rawCandidate = "$baseOut.txt"
  $jsonCandidate = "$baseOut.json"

  if (Test-Path -LiteralPath $rawCandidate) {
    Move-Item -LiteralPath $rawCandidate -Destination $rawPath -Force
  }
  if (Test-Path -LiteralPath $jsonCandidate) {
    Move-Item -LiteralPath $jsonCandidate -Destination $timestampsPath -Force
  }

  $rawText = ""
  if (Test-Path -LiteralPath $rawPath) {
    $rawText = Get-Content -LiteralPath $rawPath -Raw -Encoding UTF8
  }

  $title = ($file.BaseName -replace "[_-]", " ").Trim()
  if ([string]::IsNullOrWhiteSpace($title)) { $title = $file.Name }

  if (-not $FastScan) {
    $cleanMd = Build-CleanMarkdown -Title $title -SourceFile $file.FullName -RawText $rawText
    Set-Content -LiteralPath $cleanPath -Value $cleanMd -Encoding UTF8

    $summaryMd = Build-SummaryMarkdown -Title $title -SourceFile $file.FullName -RawText $rawText
    Set-Content -LiteralPath $summaryPath -Value $summaryMd -Encoding UTF8
  }

  $meta = [ordered]@{
    sourceFile = $file.FullName
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    dateBucket = $dateBucket
    modelFile = (Resolve-Path -LiteralPath $ModelFile).Path
    whisperExe = $WhisperExe
    ffmpegExe = $FfmpegExe
    outputDir = $serviceDir
    threads = $Threads
    fastScan = [bool]$FastScan
    beforeDate = $BeforeDate
    pauseFlagFile = $PauseFlagFile
  }
  ($meta | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $metadataPath -Encoding UTF8

  if (-not $KeepAudio -and (Test-Path -LiteralPath $audioPath)) {
    Remove-Item -LiteralPath $audioPath -Force -ErrorAction SilentlyContinue
  }

  $results.Add([pscustomobject]@{ Status = "ok"; Source = $file.FullName; Output = $serviceDir })
  $processed += 1
  Emit-Progress -Done $processed -Total $totalFiles -Status "ok" -Source $file.FullName
}

$indexPath = Join-Path $outputResolved "INDEX.md"
$indexLines = New-Object System.Collections.Generic.List[string]
$indexLines.Add("# Transcript Index")
$indexLines.Add("")
$indexLines.Add("Generated: $((Get-Date).ToUniversalTime().ToString('o'))")
$indexLines.Add("")
$indexLines.Add("| Status | Source | Transcript Folder |")
$indexLines.Add("|---|---|---|")

foreach ($r in $results) {
  $indexLines.Add("| $($r.Status) | `$($r.Source)` | `$($r.Output)` |")
}

Set-Content -LiteralPath $indexPath -Value ($indexLines -join "`r`n") -Encoding UTF8

$ok = ($results | Where-Object { $_.Status -eq "ok" }).Count
$err = ($results | Where-Object { $_.Status -eq "error" }).Count
$sk = ($results | Where-Object { $_.Status -eq "skipped" }).Count

Write-Host ""
Emit-Progress -Done $processed -Total $totalFiles -Status "complete"
Write-Host "Done. ok=$ok error=$err skipped=$sk"
Write-Host "Index: $indexPath"

if ($err -gt 0) { exit 1 } else { exit 0 }
