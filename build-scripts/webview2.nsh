!macro tiaWebViewVersion
  StrCpy $R7 ""
  ReadRegStr $R7 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $R7 == ""
  ${OrIf} $R7 == "0.0.0.0"
    ReadRegStr $R7 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
!macroend

!macro tiaEnsureWebView2
  !ifdef TIA_WEBVIEW2_SETUP
    !insertmacro tiaWebViewVersion
    ${If} $R7 == ""
    ${OrIf} $R7 == "0.0.0.0"
      InitPluginsDir
      File /oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe "${TIA_WEBVIEW2_SETUP}"
      DetailPrint "Installing Microsoft WebView2 Runtime..."
      ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $R6
      !insertmacro tiaWebViewVersion
      ${If} $R7 == ""
      ${OrIf} $R7 == "0.0.0.0"
        ${IfNot} ${Silent}
          MessageBox MB_OK|MB_ICONEXCLAMATION "Microsoft WebView2 could not be installed. Check your connection and run this installer again. Your game files have been kept."
        ${EndIf}
        SetErrorLevel 1
        Abort
      ${EndIf}
    ${EndIf}
  !endif
!macroend
