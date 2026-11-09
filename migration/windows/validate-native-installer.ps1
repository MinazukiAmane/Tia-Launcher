param(
    [Parameter(Mandatory=$true)][string]$Installer,
    [string]$LegacyInstaller,
    [ValidateSet('Fresh','CheckFresh','Upgrade','Cleanup')][string]$Phase = 'Fresh',
    [string]$Lab = 'C:\Tia-Release-Validation-Lab'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$testGuid = '4d6c4dce-8498-543d-b9ba-7708982fb33a'
$productionGuid = '9740b805-18aa-59a9-80e6-10324b8f739e'
$Lab = [IO.Path]::GetFullPath($Lab)
if ($Lab -ne 'C:\Tia-Release-Validation-Lab') { throw 'Use the isolated release validation directory.' }
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($Installer).ProductName -ne 'Tia Migration Test') { throw 'Refusing an installer with the production identity.' }
New-Item -ItemType Directory -Force $Lab | Out-Null

function Registrations([string]$guid) {
    foreach ($hive in @('HKCU','HKLM')) {
        foreach ($view in @('SOFTWARE','SOFTWARE\WOW6432Node')) {
            $root = "${hive}:\$view\Microsoft\Windows\CurrentVersion\Uninstall"
            foreach ($key in @(Get-ChildItem $root -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName.Trim('{}') -eq $guid })) {
                $entry = Get-ItemProperty $key.PSPath
                $location = (Get-ItemProperty "${hive}:\$view\$guid" -ErrorAction SilentlyContinue).InstallLocation
                [pscustomobject]@{ Scope=$hive; Key=$key.PSPath; Directory=$location; Version=$entry.DisplayVersion; Publisher=$entry.Publisher; Uninstall=$entry.UninstallString }
            }
        }
    }
}
function ProductionSnapshot {
    $files = @()
    $profile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'tia-launcher-bootstrap'
    foreach ($name in @('launcher.db','launcher.key','launcher.tauri.key','Local State')) {
        $path = Join-Path $profile $name
        if (Test-Path $path) { $files += [pscustomobject]@{Name=$name;Hash=(Get-FileHash $path -Algorithm SHA256).Hash} }
    }
    $registrations = @(Registrations $productionGuid)
    foreach ($entry in $registrations) { $entry.Directory=$null }
    [pscustomobject]@{ Registrations=$registrations; Files=$files } | ConvertTo-Json -Depth 5 -Compress
}
function RunInstaller([string]$path,[string]$arguments) {
    $process = Start-Process -FilePath $path -ArgumentList $arguments -PassThru
    if (-not $process.WaitForExit(180000)) { throw 'The test installer did not finish within three minutes.' }
    if ($process.ExitCode -ne 0) { throw "Test installer failed with exit code $($process.ExitCode)." }
}
function CheckInstalled([string]$scope,[string]$directory) {
    $entries = @(Registrations $testGuid)
    if ($entries.Count -ne 1 -or $entries[0].Scope -ne $scope) { throw 'The test installation has the wrong scope or duplicate registrations.' }
    if ($entries[0].Directory.TrimEnd('\') -ne $directory.TrimEnd('\')) { throw 'The custom installation directory changed.' }
    if ($entries[0].Publisher -ne 'Serenetia') { throw 'The installer publisher metadata is missing.' }
    $executable = Join-Path $directory 'Tia Migration Test.exe'
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
    if ($version.ProductVersion -notmatch '^2\.0\.0(?:\.|$)' -or $version.CompanyName -ne 'Serenetia') { throw 'The native binary version or company metadata is incorrect.' }
    $bytes = [IO.File]::ReadAllBytes($executable)
    $pe = [BitConverter]::ToInt32($bytes,0x3c)
    if ([BitConverter]::ToUInt16($bytes,$pe+92) -ne 2) { throw 'The native launcher has a console subsystem.' }
    foreach ($name in @('WebView2Loader.dll','client-runtime\csore-start-x86.exe','client-runtime\csore-start-x64.exe','game-runtime\cedar-start-x64.exe')) {
        if (-not (Test-Path (Join-Path $directory $name))) { throw "Missing packaged runtime: $name" }
    }
    $entries[0]
}
function RemoveTest([string]$directory) {
    $entries = @(Registrations $testGuid)
    if ($entries.Count -ne 1 -or $entries[0].Directory.TrimEnd('\') -ne $directory.TrimEnd('\')) { throw 'Refusing to uninstall a different installation.' }
    RunInstaller (Join-Path $directory 'Uninstall Tia Migration Test.exe') '/S'
    for ($attempt=0; $attempt -lt 100; $attempt++) {
        if (@(Registrations $testGuid).Count -eq 0 -and -not (Test-Path (Join-Path $directory 'Tia Migration Test.exe'))) { return }
        Start-Sleep -Milliseconds 100
    }
    throw 'The test uninstaller did not finish removing its registration.'
}

$beforeFile = Join-Path $Lab 'production-before.json'
if ($Phase -eq 'Cleanup') {
    RemoveTest (Join-Path $Lab 'Fresh All Users Custom')
    if ((Get-Content $beforeFile -Raw).Trim() -ne (ProductionSnapshot)) { throw 'Production changed during cleanup.' }
    Write-Output 'Isolated test installation removed; production unchanged.'
    exit 0
}
if ($Phase -eq 'Fresh') {
    if (@(Registrations $testGuid).Count) { throw 'An existing test installation must be reviewed before running this validation.' }
    ProductionSnapshot | Set-Content $beforeFile
    $directory = Join-Path $Lab 'Fresh All Users Custom'
    RunInstaller $Installer "/S /D=$directory"
}
if ($Phase -in @('Fresh','CheckFresh')) {
    $entry = CheckInstalled 'HKLM' (Join-Path $Lab 'Fresh All Users Custom')
    $unchanged = (Get-Content $beforeFile -Raw).Trim() -eq (ProductionSnapshot)
    if (-not $unchanged) { throw 'Production metadata or profile files changed during the test.' }
    [pscustomobject]@{ FreshDefaultsToAllUsers=$true; CustomDirectoryPreserved=$true; Publisher=$entry.Publisher; NativeVersion=$entry.Version; ProductionUnchanged=$unchanged } | ConvertTo-Json | Set-Content (Join-Path $Lab 'fresh-results.json')
} else {
    if (-not $LegacyInstaller -or [Diagnostics.FileVersionInfo]::GetVersionInfo($LegacyInstaller).ProductName -ne 'Tia Migration Test') { throw 'A legacy installer with the isolated test identity is required.' }
    RemoveTest (Join-Path $Lab 'Fresh All Users Custom')
    $directory = Join-Path $Lab 'Existing Per User Custom'
    RunInstaller $LegacyInstaller "/S /currentuser /D=$directory"
    $legacy = @(Registrations $testGuid)
    if ($legacy.Count -ne 1 -or $legacy[0].Scope -ne 'HKCU') { throw 'The legacy per-user fixture did not install correctly.' }
    $marker = Join-Path $Lab 'unrelated-game-file.txt'
    'Unrelated game data must survive the launcher update and uninstall.' | Set-Content $marker
    $hash = (Get-FileHash $marker -Algorithm SHA256).Hash
    RunInstaller $Installer "/S /currentuser /D=$directory"
    $entry = CheckInstalled 'HKCU' $directory
    RemoveTest $directory
    if ((Get-FileHash $marker -Algorithm SHA256).Hash -ne $hash) { throw 'Unrelated game data changed.' }
    $unchanged = (Get-Content $beforeFile -Raw).Trim() -eq (ProductionSnapshot)
    if (-not $unchanged) { throw 'Production metadata or profile files changed during the test.' }
    [pscustomobject]@{ ExistingPerUserScopePreserved=$true; CustomDirectoryPreserved=$true; DuplicateInstallation=$false; Publisher=$entry.Publisher; UnrelatedDataPreserved=$true; TestUninstallSucceeded=$true; ProductionUnchanged=$unchanged } | ConvertTo-Json | Set-Content (Join-Path $Lab 'upgrade-results.json')
}
