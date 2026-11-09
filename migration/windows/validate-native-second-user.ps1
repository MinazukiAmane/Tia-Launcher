$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$lab = 'C:\Tia-Release-Validation-Lab'
$name = 'TiaReleaseQA'
$taskName = 'Tia-Release-Second-User-Smoke'
$credentialFile = Join-Path $lab 'qa-credential.xml'
$scriptFile = Join-Path $lab 'second-user-ui.ps1'
$resultFile = Join-Path $lab 'second-user-results.json'
if (Get-LocalUser $name -ErrorAction SilentlyContinue) { throw 'The validation account already exists; refusing to change it.' }
if (Get-ScheduledTask $taskName -ErrorAction SilentlyContinue) { throw 'The validation task already exists.' }
if (-not (Test-Path (Join-Path $lab 'fresh-results.json'))) { throw 'Validate the fresh isolated installer first.' }
Remove-Item $resultFile -Force -ErrorAction SilentlyContinue
& quser.exe 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Sign in to the Windows desktop before running the interactive UI test.' }
$created = $false
$registered = $false
$sid = $null
try {
    $random = New-Object byte[] 24
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    $generator.GetBytes($random)
    $password = ConvertTo-SecureString (([Convert]::ToBase64String($random)) + 'aA1!') -AsPlainText -Force
    $generator.Dispose()
    [Array]::Clear($random,0,$random.Length)
    $user = New-LocalUser -Name $name -Password $password -AccountNeverExpires -PasswordNeverExpires
    $created = $true
    $sid = $user.SID.Value
    $users = Get-LocalGroup -SID 'S-1-5-32-545'
    if (-not @(Get-LocalGroupMember $users.Name | Where-Object { $_.SID.Value -eq $sid }).Count) { Add-LocalGroupMember -Group $users.Name -Member $name }
    $credential = [Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$name",$password)
    $credential | Export-Clixml $credentialFile
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    & icacls $credentialFile /inheritance:r /grant:r "*${currentSid}:F" '*S-1-5-18:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the temporary credential file.' }
    @'
$ErrorActionPreference = 'Stop'
$lab = 'C:\Tia-Release-Validation-Lab'
$process = $null
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Drawing
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TiaReleaseCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
}
"@
    $credential = Import-Clixml (Join-Path $lab 'qa-credential.xml')
    $directory = Join-Path $lab 'Fresh All Users Custom'
    $process = Start-Process -FilePath (Join-Path $directory 'Tia Migration Test.exe') -WorkingDirectory $directory -Credential $credential -LoadUserProfile -PassThru
    $deadline = (Get-Date).AddSeconds(120)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($process.HasExited) { throw "The native client exited before UI initialization: $($process.ExitCode)." }
        $process.Refresh()
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            try {
                $window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
                $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
                $names = @($elements | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
                if (($names -join ' ') -match 'Install|Play|Settings|Library|CSO|Silver') { $ready=$true; break }
            } catch { }
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw 'The native WebView did not expose the launcher interface.' }
    $owner = Invoke-CimMethod (Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)") -MethodName GetOwnerSid
    $user = Get-LocalUser TiaReleaseQA
    if ($owner.Sid -ne $user.SID.Value) { throw 'The native UI ran as the wrong Windows account.' }
    $profile = (Get-CimInstance Win32_UserProfile | Where-Object SID -eq $user.SID.Value).LocalPath
    $database = Join-Path $profile 'AppData\Roaming\tia-launcher-bootstrap\launcher.db'
    $keyFile = Join-Path $profile 'AppData\Roaming\tia-launcher-bootstrap\launcher.tauri.key'
    if (-not (Test-Path $database) -or -not (Test-Path $keyFile)) { throw 'The new Windows account did not receive its own launcher profile.' }
    $key = Get-Content $keyFile -Raw | ConvertFrom-Json
    if ($key.mode -ne 'dpapi') { throw 'The second-user root key is not protected by Windows.' }
    $rect = New-Object TiaReleaseCapture+Rect
    [void][TiaReleaseCapture]::GetWindowRect($process.MainWindowHandle,[ref]$rect)
    $bitmap = [Drawing.Bitmap]::new(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $dc = $graphics.GetHdc()
    try { [void][TiaReleaseCapture]::PrintWindow($process.MainWindowHandle,$dc,2) } finally { $graphics.ReleaseHdc($dc) }
    $bitmap.Save((Join-Path $lab 'native-second-user.png'),[Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
    [pscustomobject]@{ Ok=$true; NativeUiReady=$true; DifferentWindowsAccount=$true; SeparateProfile=$true; KeyProtection=$key.mode } | ConvertTo-Json | Set-Content (Join-Path $lab 'second-user-results.json')
} catch {
    [pscustomobject]@{ Ok=$false; Error=$_.Exception.Message } | ConvertTo-Json | Set-Content (Join-Path $lab 'second-user-results.json')
    exit 1
} finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    if ($process) { $process.Dispose() }
    Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -eq "$env:COMPUTERNAME\TiaReleaseQA" | Stop-Process -Force -ErrorAction SilentlyContinue
}
'@ | Set-Content $scriptFile
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Highest
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptFile`""
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    $registered = $true
    Start-ScheduledTask $taskName
    $deadline = (Get-Date).AddMinutes(4)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path $resultFile) -and (Get-ScheduledTask $taskName).State -ne 'Running') { break }
        Start-Sleep -Seconds 1
    }
    if (-not (Test-Path $resultFile)) { throw 'The interactive second-user test did not finish.' }
    $result = Get-Content $resultFile -Raw | ConvertFrom-Json
    if (-not $result.Ok) { throw $result.Error }
    $result | ConvertTo-Json
} finally {
    if ($registered) {
        Stop-ScheduledTask $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    if ($created) {
        Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -eq "$env:COMPUTERNAME\$name" | Stop-Process -Force -ErrorAction SilentlyContinue
        for ($attempt=0; $attempt -lt 30; $attempt++) {
            $profile = Get-CimInstance Win32_UserProfile | Where-Object SID -eq $sid
            if (-not $profile -or -not $profile.Loaded) { break }
            Start-Sleep -Seconds 1
        }
        if ($profile -and $profile.Loaded) { throw 'The isolated Windows profile is still loaded and needs cleanup.' }
        if ($profile) { $profile | Remove-CimInstance }
        if ((Get-LocalUser $name).SID.Value -eq $sid) { Remove-LocalUser $name }
    }
    Remove-Item $credentialFile -Force -ErrorAction SilentlyContinue
}
