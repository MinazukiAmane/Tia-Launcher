param([string]$Output = (Join-Path $PSScriptRoot '../../build/webview2/MicrosoftEdgeWebview2Setup.exe'))
$ErrorActionPreference = 'Stop'
$Output = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force (Split-Path $Output) | Out-Null
Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $Output
$Signature = Get-AuthenticodeSignature -FilePath $Output
if ($Signature.Status -ne 'Valid' -or $Signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
  Remove-Item -LiteralPath $Output -Force
  throw 'The Microsoft WebView2 bootstrapper signature could not be verified.'
}
Write-Output ('Verified Microsoft WebView2 bootstrapper: ' + (Get-FileHash -Algorithm SHA256 -LiteralPath $Output).Hash)
