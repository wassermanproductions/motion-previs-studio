$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Release = Join-Path $Root 'release'
$Unpacked = Join-Path $Release 'win-unpacked'
$Resources = Join-Path $Unpacked 'resources'
$SpecialRoot = Join-Path $env:RUNNER_TEMP "OneDrive - Studio\Director's Cut\José"
$ConfigDir = Join-Path $SpecialRoot 'control config'
$UserData = Join-Path $SpecialRoot 'user data'
$Manifest = Get-Content (Join-Path $Root 'ASSET_MANIFEST.json') -Raw | ConvertFrom-Json
$Package = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$ShortcutName = if ($env:MOTION_PREVIS_SHORTCUT_NAME) { $env:MOTION_PREVIS_SHORTCUT_NAME } else { $Package.build.nsis.shortcutName }
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) "$ShortcutName.lnk"
$StartMenuShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) "$ShortcutName.lnk"

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Test-AppLaunch([string]$Exe, [string]$Label) {
  Remove-Item (Join-Path $ConfigDir 'control.json') -Force -ErrorAction SilentlyContinue
  $oldPath = $env:PATH
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
  $env:MOTION_PREVIS_CONFIG_DIR = $ConfigDir
  $env:MOTION_PREVIS_USER_DATA_DIR = $UserData
  try {
    $started = Start-Process -FilePath $Exe -PassThru
    $descriptorPath = Join-Path $ConfigDir 'control.json'
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $descriptorPath)) { Start-Sleep -Milliseconds 500 }
    Assert-True (Test-Path $descriptorPath) "$Label did not create a control descriptor."
    $descriptor = Get-Content $descriptorPath -Raw | ConvertFrom-Json
    Assert-True ($descriptor.protocolVersion -eq 1) "$Label descriptor is not protocol v1."
    Assert-True ($descriptor.app -eq 'motion-previs-studio') "$Label descriptor app identity is wrong."
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($descriptor.port)/health" -TimeoutSec 5
    Assert-True ($health.ok -and $health.protocolVersion -eq 1) "$Label health check failed."
    & taskkill.exe /PID $descriptor.pid /T /F | Out-Null
    if ($started -and -not $started.HasExited) { $started.WaitForExit(10000) | Out-Null }
  } finally {
    $env:PATH = $oldPath
  }
}

function Test-DefaultDistributionLaunch([string]$Exe, [string]$ConfigDir, [string]$UserDataDir, [string]$Label) {
  Remove-Item (Join-Path $ConfigDir 'control.json') -Force -ErrorAction SilentlyContinue
  $oldConfig = $env:MOTION_PREVIS_CONFIG_DIR
  $oldUserData = $env:MOTION_PREVIS_USER_DATA_DIR
  Remove-Item Env:MOTION_PREVIS_CONFIG_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:MOTION_PREVIS_USER_DATA_DIR -ErrorAction SilentlyContinue
  try {
    $started = Start-Process -FilePath $Exe -PassThru
    $descriptorPath = Join-Path $ConfigDir 'control.json'
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $descriptorPath)) { Start-Sleep -Milliseconds 500 }
    Assert-True (Test-Path $descriptorPath) "$Label did not create its descriptor in the expected distribution config root."
    $descriptor = Get-Content $descriptorPath -Raw | ConvertFrom-Json
    Assert-True ($descriptor.protocolVersion -eq 1 -and $descriptor.app -eq 'motion-previs-studio') "$Label default descriptor identity is wrong."
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($descriptor.port)/health" -TimeoutSec 5
    Assert-True ($health.ok) "$Label default health check failed."
    Assert-True (Test-Path $UserDataDir) "$Label did not use the isolated distribution user-data root."
    & taskkill.exe /PID $descriptor.pid /T /F | Out-Null
    if ($started -and -not $started.HasExited) { $started.WaitForExit(10000) | Out-Null }
  } finally {
    $env:MOTION_PREVIS_CONFIG_DIR = $oldConfig
    $env:MOTION_PREVIS_USER_DATA_DIR = $oldUserData
  }
}

function Assert-Shortcut([string]$ShortcutPath, [string]$ExpectedTarget, [string]$Label) {
  Assert-True (Test-Path $ShortcutPath) "$Label shortcut was not created at $ShortcutPath."
  $shell = New-Object -ComObject WScript.Shell
  try {
    $shortcut = $shell.CreateShortcut($ShortcutPath)
    $target = [IO.Path]::GetFullPath($shortcut.TargetPath)
    $expected = [IO.Path]::GetFullPath($ExpectedTarget)
    Assert-True ($target -ieq $expected) "$Label shortcut targets '$target' instead of '$expected'."
  } finally {
    [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
  }
}

Assert-True (Test-Path (Join-Path $Resources 'app.asar')) 'win-unpacked app.asar is missing.'
Assert-True (Test-Path (Join-Path $Resources 'APP_METADATA.json')) 'installed MCP APP_METADATA.json is missing.'
foreach ($name in @('ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt', 'PROVENANCE.json')) {
  Assert-True (Test-Path (Join-Path $Resources "media\$name")) "Bundled media asset $name is missing."
}
Assert-True (-not (Test-Path (Join-Path $Resources 'app.asar.unpacked\node_modules\ffmpeg-static'))) 'ffmpeg-static leaked into win-unpacked.'
Assert-True (-not (Test-Path (Join-Path $Resources 'app.asar.unpacked\node_modules\@derhuerst\ffprobe-static'))) 'ffprobe-static leaked into win-unpacked.'

$ffmpegHash = (Get-FileHash (Join-Path $Resources 'media\ffmpeg.exe') -Algorithm SHA256).Hash.ToLower()
$ffprobeHash = (Get-FileHash (Join-Path $Resources 'media\ffprobe.exe') -Algorithm SHA256).Hash.ToLower()
Assert-True ($ffmpegHash -eq $Manifest.mediaTools.windows.ffmpegSha256) 'Bundled ffmpeg.exe hash mismatch.'
Assert-True ($ffprobeHash -eq $Manifest.mediaTools.windows.ffprobeSha256) 'Bundled ffprobe.exe hash mismatch.'
& (Join-Path $Resources 'media\ffmpeg.exe') -hide_banner -version | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'Bundled ffmpeg.exe did not run.'
& (Join-Path $Resources 'media\ffprobe.exe') -hide_banner -version | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'Bundled ffprobe.exe did not run.'

$UnpackedExe = Get-ChildItem $Unpacked -Filter '*.exe' | Where-Object Name -NotMatch 'uninstall' | Select-Object -First 1
Assert-True ($null -ne $UnpackedExe) 'win-unpacked executable is missing.'
Test-AppLaunch $UnpackedExe.FullName 'win-unpacked'

if ($env:MOTION_PREVIS_EXPECTED_APP_ID) {
  $appMetadata = Get-Content (Join-Path $Resources 'APP_METADATA.json') -Raw | ConvertFrom-Json
  Assert-True ($appMetadata.version -eq $Package.version) 'Installed MCP metadata version does not match package.json.'
  Assert-True ($appMetadata.distribution.appId -eq $env:MOTION_PREVIS_EXPECTED_APP_ID) 'Installed MCP metadata app ID is not the expected distribution ID.'
  Assert-True ($appMetadata.distribution.configFolder -eq $env:MOTION_PREVIS_EXPECTED_CONFIG_SUBDIR) 'Installed MCP metadata config folder is wrong.'
  $DefaultConfigDir = Join-Path $env:APPDATA $env:MOTION_PREVIS_EXPECTED_CONFIG_SUBDIR
  $DefaultUserDataDir = Join-Path $env:APPDATA $env:MOTION_PREVIS_EXPECTED_USER_DATA_SUBDIR
  Test-DefaultDistributionLaunch $UnpackedExe.FullName $DefaultConfigDir $DefaultUserDataDir 'win-unpacked community default'
}

$Installer = Get-ChildItem $Release -Filter '*.exe' | Where-Object FullName -NotLike "$Unpacked*" | Select-Object -First 1
Assert-True ($null -ne $Installer) 'NSIS installer is missing.'
$InstallDir = Join-Path $SpecialRoot 'Custom Install Directory'
$install = Start-Process -FilePath $Installer.FullName -ArgumentList "/S /D=`"$InstallDir`"" -PassThru -Wait
Assert-True ($install.ExitCode -eq 0) 'Silent per-user NSIS install failed.'
$InstalledExe = Get-ChildItem $InstallDir -Recurse -Filter '*.exe' | Where-Object Name -NotMatch 'uninstall' | Select-Object -First 1
Assert-True ($null -ne $InstalledExe) 'Installed application executable is missing.'
Assert-Shortcut $DesktopShortcut $InstalledExe.FullName 'Desktop'
Assert-Shortcut $StartMenuShortcut $InstalledExe.FullName 'Start Menu'
Test-AppLaunch $InstalledExe.FullName 'installed app'

$Uninstaller = Get-ChildItem $InstallDir -Recurse -Filter '*.exe' | Where-Object Name -Match 'uninstall|unins' | Select-Object -First 1
Assert-True ($null -ne $Uninstaller) 'NSIS uninstaller is missing.'
$uninstall = Start-Process -FilePath $Uninstaller.FullName -ArgumentList '/S' -PassThru -Wait
Assert-True ($uninstall.ExitCode -eq 0) 'Silent NSIS uninstall failed.'
Start-Sleep -Seconds 2
Assert-True (-not (Test-Path $InstalledExe.FullName)) 'Installed executable remains after uninstall.'
Assert-True (-not (Test-Path $DesktopShortcut)) 'Desktop shortcut remains after uninstall.'
Assert-True (-not (Test-Path $StartMenuShortcut)) 'Start Menu shortcut remains after uninstall.'
Assert-True (Test-Path $UserData) 'Machine-local user data should be retained after uninstall.'

if (Get-Command Start-MpScan -ErrorAction SilentlyContinue) {
  Start-MpScan -ScanType CustomScan -ScanPath $Release
  $activeThreats = @(Get-MpThreat -ErrorAction SilentlyContinue | Where-Object IsActive)
  Assert-True ($activeThreats.Count -eq 0) 'Microsoft Defender reported an active threat in release artifacts.'
  Write-Host '[windows-package] Defender custom scan completed.'
} else {
  Write-Warning 'Microsoft Defender cmdlets unavailable on this runner; manual VM scan remains required.'
}

Write-Host '[windows-package] unpacked launch, NSIS install/launch/uninstall, shortcut targets, resources, identity, and retained data: OK'
