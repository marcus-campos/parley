# parley installer for Windows PowerShell
# https://github.com/marcus-campos/parley
#
#   irm https://raw.githubusercontent.com/marcus-campos/parley/main/install.ps1 | iex
#
# Environment overrides:
#   $env:PARLEY_VERSION      tag to install (default: latest)
#   $env:PARLEY_INSTALL_DIR  where to put the binary (default: %LOCALAPPDATA%\parley\bin)

$ErrorActionPreference = "Stop"

$Repo    = "marcus-campos/parley"
$Version = if ($env:PARLEY_VERSION) { $env:PARLEY_VERSION } else { "latest" }

# Bun cannot cross-compile to Windows arm64 yet, so there is one asset here.
$arch = (Get-CimInstance Win32_Processor).Architecture
if ($arch -eq 12) {
  Write-Error "Windows on arm64 has no prebuilt binary yet. Build from source, or run the x64 build under emulation: https://github.com/$Repo#build-from-source"
}

$Asset = "parley-windows-x64.exe"
$Base  = if ($Version -eq "latest") {
  "https://github.com/$Repo/releases/latest/download"
} else {
  "https://github.com/$Repo/releases/download/$Version"
}

$Dir = if ($env:PARLEY_INSTALL_DIR) { $env:PARLEY_INSTALL_DIR } else { "$env:LOCALAPPDATA\parley\bin" }
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

$Tmp    = Join-Path ([System.IO.Path]::GetTempPath()) ("parley-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
$TmpBin = Join-Path $Tmp $Asset

try {
  Write-Host "parley: downloading $Asset ($Version)"
  Invoke-WebRequest -Uri "$Base/$Asset" -OutFile $TmpBin -UseBasicParsing

  # Catches a truncated or corrupted download. Fetched over the same channel as
  # the binary, so it is not a security boundary.
  try {
    $TmpSum = "$TmpBin.sha256"
    Invoke-WebRequest -Uri "$Base/$Asset.sha256" -OutFile $TmpSum -UseBasicParsing
    $expected = ((Get-Content $TmpSum -Raw) -split '\s+')[0].Trim().ToLower()
    $actual   = (Get-FileHash -Algorithm SHA256 -Path $TmpBin).Hash.ToLower()
    if ($expected -ne $actual) {
      Write-Error "checksum mismatch - refusing to install a corrupted binary"
    }
    Write-Host "parley: checksum ok"
  } catch [System.Net.WebException] {
    Write-Host "parley: no published checksum for this asset, skipping verification"
  }

  $Target = Join-Path $Dir "parley.exe"
  Move-Item -Force -Path $TmpBin -Destination $Target
  Write-Host "parley: installed to $Target"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$Dir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$Dir", "User")
    Write-Host ""
    Write-Host "parley: added $Dir to your user PATH."
    Write-Host "        Open a new terminal for it to take effect."
    Write-Host ""
  }

  & $Target --help | Out-Null
  Write-Host "parley: ready. Run 'parley doctor' inside a git repository to verify."
}
finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
