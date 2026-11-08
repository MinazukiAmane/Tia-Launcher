param([Parameter(Mandatory=$true)][string]$Lab,[ValidateSet('all','current')][string]$Scope='all')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$guid='4d6c4dce-8498-543d-b9ba-7708982fb33a'
$productionGuid='9740b805-18aa-59a9-80e6-10324b8f739e'
$profile=Join-Path $env:APPDATA 'tia-launcher-uninstall-test'
$directory=if($Scope -eq 'all'){Join-Path $env:ProgramFiles 'TiaNativeUpdaterLab\Launcher'}else{Join-Path $env:LOCALAPPDATA 'TiaNativeUpdaterLab\Launcher'}
$registryRoot=if($Scope -eq 'all'){'HKLM'}else{'HKCU'}
$otherRoot=if($Scope -eq 'all'){'HKCU'}else{'HKLM'}
$scopeFlag=if($Scope -eq 'all'){'/allusers'}else{'/currentuser'}
$runLevel=if($Scope -eq 'all'){'Highest'}else{'Limited'}
$task='TiaNativeUpdaterLab'
function ProductionState {
    @('HKCU','HKLM') | ForEach-Object {
        $item=Get-ItemProperty "${_}:\Software\$productionGuid" -ErrorAction SilentlyContinue
        [pscustomobject]@{Root=$_;Location=$item.InstallLocation}
    } | ConvertTo-Json -Compress
}
function Run-Program([string]$File,[string[]]$Arguments,[string]$Name,[int]$Timeout=180000) {
    $stdout=Join-Path $Lab "$Name.stdout.log"; $stderr=Join-Path $Lab "$Name.stderr.log"
    $process=Start-Process $File -ArgumentList $Arguments -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null=$process.Handle
    if(-not $process.WaitForExit($Timeout)){Stop-Process $process.Id -ErrorAction SilentlyContinue; throw "$Name timed out"}
    if($process.ExitCode -ne 0){throw "$Name failed: $(Get-Content $stderr -Raw)"}
    Get-Content $stdout -Raw
}
function Run-Ui([string]$File,[string]$Arguments,[string]$Report) {
    if(Test-Path $Report){Remove-Item $Report}
    if(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue){throw 'The isolated test task already exists'}
    $action=New-ScheduledTaskAction -Execute $File -Argument $Arguments -WorkingDirectory (Split-Path $File)
    $principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel $runLevel
    Register-ScheduledTask -TaskName $task -Action $action -Principal $principal | Out-Null
    try {
        Start-ScheduledTask -TaskName $task
        for($n=0;$n -lt 900;$n++){
            if(Test-Path $Report){break}
            Start-Sleep -Milliseconds 200
        }
        if(-not(Test-Path $Report)){throw 'Native update UI did not write a report'}
        $result=Get-Content $Report -Raw | ConvertFrom-Json
        if(-not $result.ok){throw "Native update test failed: $(Get-Content $Report -Raw)"}
        for($n=0;$n -lt 150 -and (Get-ScheduledTask $task).State -eq 'Running';$n++){Start-Sleep -Milliseconds 200}
        if((Get-ScheduledTask $task).State -eq 'Running'){throw 'Native test launcher did not exit'}
        return $result
    } finally {
        if((Get-ScheduledTask $task).State -eq 'Running'){Stop-ScheduledTask $task}
        Unregister-ScheduledTask $task -Confirm:$false
    }
}
$before=ProductionState
foreach($root in @('HKCU','HKLM')) {if(Test-Path "${root}:\Software\$guid"){throw 'A previous isolated test installation remains'}}
if((Test-Path $profile) -or (Test-Path $directory)){throw 'An isolated test profile or folder already exists'}
$public=(Get-Content (Join-Path $Lab 'public-key.json') -Raw | ConvertFrom-Json).publicKey
if($Scope -eq 'current') {
    New-Item "HKCU:\Software\$guid" -Force | Out-Null
    New-ItemProperty "HKCU:\Software\$guid" -Name InstallLocation -Value $directory -PropertyType String -Force | Out-Null
}
Write-Output "Installing native baseline ($Scope) at a custom path"
Run-Program (Join-Path $Lab 'baseline.exe') @('/S',$scopeFlag,"/D=$directory") 'baseline-install' | Out-Null
$registration=Get-ItemProperty "${registryRoot}:\Software\$guid"
if($registration.InstallLocation.TrimEnd('\') -ne $directory){throw 'Baseline installation changed the custom path'}
$executable=Join-Path $directory 'Tia Migration Test.exe'
$inside=Run-Program $executable @('--prepare-uninstall-test','--inside-profile') 'prepare-inside' | ConvertFrom-Json
$process=Start-Process $executable -ArgumentList @('--cleanup-launcher-data',"`"$profile`"") -Wait -PassThru
if(-not(Test-Path (Join-Path $inside.game 'Bin\test-client.txt'))){throw 'Cleanup deleted a game inside the launcher profile'}
Write-Output 'PASS: cleanup refuses a game inside launcher data'
Remove-Item $profile -Recurse -Force
$fixture=Run-Program $executable @('--prepare-uninstall-test') 'prepare-outside' | ConvertFrom-Json
$gameHash=(Get-FileHash (Join-Path $fixture.game 'Bin\test-client.txt')).Hash
$results=@()
Write-Output 'Canceling the uninstaller while saved-data removal is requested'
$cancelReport=Join-Path $Lab 'cancel-result.json'
$cancelScript=Join-Path $Lab 'cancel-test-uninstaller.ps1'
$uninstaller=Join-Path $directory 'Uninstall Tia Migration Test.exe'
$cancel=Run-Ui "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File `"$cancelScript`" -Uninstaller `"$uninstaller`" -Profile `"$profile`" -Report `"$cancelReport`"" $cancelReport
$results += [pscustomobject]@{Scenario='cancel-uninstall';Passed=$cancel.ok;DataPreserved=$cancel.dataPreserved}
Write-Output 'PASS: cancel keeps launcher data and installation'
foreach($scenario in @('valid','tampered','mismatch')) {
    $expected=if($scenario -eq 'valid'){'download'}else{'reject'}
    $version=if($scenario -eq 'mismatch'){'2.0.0-alpha.3'}else{'2.0.0-alpha.2'}
    $report=Join-Path $Lab "$scenario-result.json"; $configuration=Join-Path $Lab "$scenario.json"
    @{configuration=@{enabled=$true;endpoints=@("http://127.0.0.1:18479/native-$scenario.json");publicKey=$public};report=$report;expect=$expected;version=$version} | ConvertTo-Json -Depth 8 | Set-Content $configuration -Encoding ASCII
    Write-Output "Testing native updater: $scenario"
    $result=Run-Ui $executable "--profile `"$profile`" --native-update-test `"$configuration`"" $report
    $results += [pscustomobject]@{Scenario=$scenario;Passed=$result.ok;Downloaded=$result.state.downloaded;Rejected=$result.rejected}
    Write-Output "PASS: $scenario"
}
$report=Join-Path $Lab 'install-result.json'; $configuration=Join-Path $Lab 'install.json'
@{configuration=@{enabled=$true;endpoints=@('http://127.0.0.1:18479/native-install.json');publicKey=$public};report=$report;expect='install';version='2.0.0-alpha.2'} | ConvertTo-Json -Depth 8 | Set-Content $configuration -Encoding ASCII
Write-Output 'Downloading, verifying, and installing the next native release'
$result=Run-Ui $executable "--profile `"$profile`" --native-update-test `"$configuration`"" $report
for($n=0;$n -lt 600;$n++) {
    $version=(Get-ItemProperty "${registryRoot}:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid" -ErrorAction SilentlyContinue).DisplayVersion
    if($version -eq '2.0.0-alpha.2'){break}
    Start-Sleep -Milliseconds 200
}
if($version -ne '2.0.0-alpha.2'){throw 'Native updater did not install the expected version'}
$registration=Get-ItemProperty "${registryRoot}:\Software\$guid"
if($registration.InstallLocation.TrimEnd('\') -ne $directory -or (Test-Path "${otherRoot}:\Software\$guid")){throw 'Native update changed path or created a duplicate installation'}
$probe=Run-Program $executable @('--migration-check','--profile',"`"$profile`"") 'after-native-update' | ConvertFrom-Json
if($probe.version -ne '2.0.0-alpha.2' -or $probe.settings.lang -ne 'na_id' -or $probe.settings.fpsLimit -ne 144 -or $probe.preferences.backgroundMode -ne 'image'){throw 'The native update lost the version or saved settings'}
if((Get-FileHash (Join-Path $fixture.game 'Bin\test-client.txt')).Hash -ne $gameHash){throw 'The native update changed the game fixture'}
Write-Output "PASS: native-to-native update keeps custom path, $Scope scope, settings, and game files"
Write-Output 'Uninstalling with saved-data removal after confirmation'
Run-Program (Join-Path $directory 'Uninstall Tia Migration Test.exe') @('/S',$scopeFlag,'--tia-delete-launcher-data',"_?=$directory") 'remove-data' | Out-Null
if(Test-Path $profile){throw 'Saved launcher data remains after confirmed uninstall'}
if((Get-FileHash (Join-Path $fixture.game 'Bin\test-client.txt')).Hash -ne $gameHash){throw 'The uninstaller changed game files'}
if(Test-Path "${registryRoot}:\Software\$guid"){throw 'Test uninstaller left its registration'}
if((ProductionState) -ne $before){throw 'Production installation registration changed'}
$results += [pscustomobject]@{Scenario='native-install-and-uninstall';Scope=$Scope;Passed=$true;CustomPathPreserved=$true;ScopePreserved=$true;SettingsPreserved=$true;GameUnchanged=$true;DataRemovedAfterUninstall=$true}
$results | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Lab 'results.json') -Encoding UTF8
Remove-Item $fixture.game -Recurse -Force
if(Test-Path $directory){Remove-Item $directory -Recurse -Force}
Write-Output 'PASS: test installation removed; production registration unchanged'
