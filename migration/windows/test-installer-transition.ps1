param([Parameter(Mandatory=$true)][string]$Lab)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$plan=Get-Content (Join-Path $Lab 'test-plan.json') -Raw | ConvertFrom-Json
$guid=$plan.guid
if($plan.appId -ne 'com.serenetia.tia-launcher.migration-test'){throw 'Only test installers are allowed'}
$productionGuid='9740b805-18aa-59a9-80e6-10324b8f739e'
function ProductionState {
    @('HKCU','HKLM') | ForEach-Object {
        $item=Get-ItemProperty -LiteralPath "${_}:\Software\$productionGuid" -ErrorAction SilentlyContinue
        [pscustomobject]@{Root=$_;Location=$item.InstallLocation}
    } | ConvertTo-Json -Compress
}
$beforeProduction=ProductionState
function Wait-Version([string]$Root,[string]$Expected) {
    for($attempt=0;$attempt -lt 120;$attempt++) {
        $item=Get-ItemProperty -LiteralPath "${Root}:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid" -ErrorAction SilentlyContinue
        if($item.DisplayVersion -eq $Expected){return}
        Start-Sleep -Milliseconds 500
    }
    throw "Installer did not register version $Expected"
}
function Run-Program([string]$Executable,[string[]]$Parameters,[string]$Name,[int]$Timeout=90000) {
    $stdout=Join-Path $Lab "$Name.stdout.log"
    $stderr=Join-Path $Lab "$Name.stderr.log"
    $process=Start-Process -FilePath $Executable -ArgumentList $Parameters -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    $null=$process.Handle
    if(-not $process.WaitForExit($Timeout)){Stop-Process -Id $process.Id -ErrorAction SilentlyContinue;throw "$Name timed out"}
    $process.Refresh()
    if($null -ne $process.ExitCode -and $process.ExitCode -ne 0){throw "$Name failed with exit $($process.ExitCode): $(Get-Content $stderr -Raw)"}
    return Get-Content $stdout -Raw
}
$results=@()
foreach($scope in @('current','all')) {
    foreach($root in @('HKCU','HKLM')) {
        if(Test-Path "${root}:\Software\$guid"){throw 'A previous test installation remains. Clean it explicitly first.'}
    }
    $root=if($scope -eq 'current'){'HKCU'}else{'HKLM'}
    $flag=if($scope -eq 'current'){'/currentuser'}else{'/allusers'}
    $directory=if($scope -eq 'current'){Join-Path $env:LOCALAPPDATA 'TiaMigrationLab\Custom Launcher'}else{Join-Path $env:ProgramFiles 'TiaMigrationLab\Custom Launcher'}
    $profile=Join-Path $env:APPDATA "tia-bridge-$scope"
    if(Test-Path $directory){throw 'Test installation directory already exists'}
    if(Test-Path $profile){throw 'Test profile already exists'}
    Write-Output "Installing Electron bridge ($scope)"
    $installer=Start-Process -FilePath (Join-Path $Lab 'bridge.exe') -ArgumentList @('/S',$flag,"/D=$directory") -PassThru
    if(-not $installer.WaitForExit(300000)){throw 'Bridge installer timed out'}
    Wait-Version $root $plan.bridgeVersion
    $executable=Join-Path $directory 'Tia Migration Test.exe'
    $prepared=Run-Program $executable @('--prepare-only','--profile',$profile) "$scope-prepare"
    if($prepared -notmatch 'Legacy fixture prepared'){throw "Legacy profile preparation failed: $prepared"}
    $desktop=if($scope -eq 'current'){[Environment]::GetFolderPath('DesktopDirectory')}else{[Environment]::GetFolderPath('CommonDesktopDirectory')}
    $shortcut=Join-Path $desktop 'Tia Migration Test.lnk'
    if(-not(Test-Path $shortcut)){throw 'Bridge desktop shortcut is missing'}
    $database=Join-Path $profile 'launcher.db'
    $game=Join-Path $profile 'GameFixture\Bin\test-client.txt'
    $databaseHash=(Get-FileHash $database -Algorithm SHA256).Hash
    $gameHash=(Get-FileHash $game -Algorithm SHA256).Hash
    Write-Output "Downloading and applying native update ($scope)"
    $update=Run-Program $executable @('--bridge-install','--profile',$profile) "$scope-update" 120000
    if($update -notmatch 'installer-dispatched'){throw "Bridge did not approve the installer: $update"}
    Wait-Version $root $plan.targetVersion
    $registration=Get-ItemProperty -LiteralPath "${root}:\Software\$guid"
    if($registration.InstallLocation.TrimEnd('\') -ne $directory){throw 'Update changed the custom installation directory'}
    $shell=New-Object -ComObject WScript.Shell
    if(-not(Test-Path $shortcut) -or $shell.CreateShortcut($shortcut).TargetPath -ne $executable){throw 'Update changed the desktop shortcut target'}
    $other=if($root -eq 'HKCU'){'HKLM'}else{'HKCU'}
    if(Test-Path "${other}:\Software\$guid"){throw 'Update created a duplicate installation scope'}
    if((Get-FileHash $database -Algorithm SHA256).Hash -ne $databaseHash){throw 'Update changed the source database'}
    if((Get-FileHash $game -Algorithm SHA256).Hash -ne $gameHash){throw 'Update changed the game fixture'}
    if(-not(Test-Path (Join-Path $profile 'launcher.key'))){throw 'Original rollback key was removed'}
    if(-not(Test-Path (Join-Path $profile 'launcher.tauri.key'))){throw 'Native key handoff did not complete'}
    $probeText=Run-Program $executable @('--migration-check','--profile',$profile) "$scope-native-probe"
    $probe=$probeText | ConvertFrom-Json
    if($probe.version -ne $plan.targetVersion -or $probe.recordsVerified -ne 4 -or $probe.settings.lang -ne 'na_id' -or $probe.settings.fpsLimit -ne 144 -or $probe.preferences.backgroundMode -ne 'image' -or $probe.installation.installDir -ne (Join-Path $profile 'GameFixture')){throw 'Native launcher did not retain the migrated settings'}
    $uninstall=Start-Process -FilePath (Join-Path $directory 'Uninstall Tia Migration Test.exe') -ArgumentList @('/S',$flag,"_?=$directory") -PassThru
    $null=$uninstall.Handle
    if(-not $uninstall.WaitForExit(300000)){throw 'Test uninstaller timed out'}
    for($attempt=0;$attempt -lt 60 -and (Test-Path "${root}:\Software\$guid");$attempt++){Start-Sleep -Milliseconds 500}
    if(Test-Path "${root}:\Software\$guid"){throw 'Test uninstall registration remains'}
    if(-not(Test-Path $database) -or (Get-FileHash $game -Algorithm SHA256).Hash -ne $gameHash){throw 'Uninstall removed retained game/profile data'}
    $results+=[pscustomobject]@{Scope=$scope;CustomPathPreserved=$true;DuplicateInstallation=$false;DatabaseUnchanged=$true;GameUnchanged=$true;NativeSettingsVerified=$true;ShortcutTargetPreserved=$true;UninstallKeepsData=$true}
    Remove-Item -LiteralPath $profile -Recurse -Force
    if(Test-Path $directory){Remove-Item -LiteralPath $directory -Recurse -Force}
}
if((ProductionState) -ne $beforeProduction){throw 'Production launcher registration changed'}
$results | ConvertTo-Json | Set-Content (Join-Path $Lab 'results.json') -Encoding UTF8
Write-Output 'Both installer migration scenarios passed; production registration unchanged.'
