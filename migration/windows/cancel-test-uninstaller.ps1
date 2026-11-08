param([string]$Uninstaller,[string]$Profile,[string]$Report)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TiaCancelTest {
  public delegate bool Callback(IntPtr window, IntPtr argument);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr argument);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr argument);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int limit);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  public static string Text(IntPtr window) { var text=new StringBuilder(512); GetWindowText(window,text,512); return text.ToString(); }
  public static IntPtr Find() { IntPtr result=IntPtr.Zero; EnumWindows((window,arg)=>{ if(Text(window).Contains("Tia Migration Test")){result=window;return false;} return true;},IntPtr.Zero);return result; }
  public static void ConfirmCancel() { EnumWindows((window,arg)=>{if(Text(window).Contains("Tia Migration Test")){EnumChildWindows(window,(child,unused)=>{string text=Text(child).Replace("&","");if(text=="Yes"){SendMessage(child,0xF5,IntPtr.Zero,IntPtr.Zero);}return true;},IntPtr.Zero);}return true;},IntPtr.Zero); }
}
'@
try {
    Start-Process $Uninstaller -ArgumentList @('--tia-delete-launcher-data') | Out-Null
    $window=[IntPtr]::Zero
    for($n=0;$n -lt 300;$n++){$window=[TiaCancelTest]::Find();if($window -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100}
    if($window -eq [IntPtr]::Zero){throw 'The test uninstaller confirmation window was not found'}
    [TiaCancelTest]::PostMessage($window,0x111,[IntPtr]2,[IntPtr]::Zero) | Out-Null
    for($n=0;$n -lt 100;$n++){[TiaCancelTest]::ConfirmCancel();if([TiaCancelTest]::Find() -eq [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100}
    if([TiaCancelTest]::Find() -ne [IntPtr]::Zero){throw 'The test uninstaller did not close after Cancel'}
    if(-not(Test-Path (Join-Path $Profile 'launcher.db'))){throw 'Cancel removed saved launcher data'}
    if(-not(Test-Path $Uninstaller)){throw 'Cancel removed the installation'}
    @{ok=$true;canceled=$true;dataPreserved=$true} | ConvertTo-Json | Set-Content $Report -Encoding ASCII
}catch{
    @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content $Report -Encoding ASCII
    exit 1
}
