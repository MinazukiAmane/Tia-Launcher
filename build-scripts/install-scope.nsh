!addincludedir "${__FILEDIR__}"
!include "webview2.nsh"

!macro tiaSelectInstallScope
  ReadRegStr $R8 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ReadRegStr $R9 HKLM "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R8 == ""
  ${AndIf} $R9 == ""
    StrCpy $isForceMachineInstall "1"
  ${ElseIf} $R8 != ""
  ${AndIf} $R9 == ""
    StrCpy $isForceCurrentInstall "1"
  ${ElseIf} $R8 == ""
  ${AndIf} $R9 != ""
    StrCpy $isForceMachineInstall "1"
  ${EndIf}
!macroend

!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    !insertmacro tiaSelectInstallScope
  !endif
!macroend

!macro customInit
  !ifndef BUILD_UNINSTALLER
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/P" $R1
    ${IfNot} ${Errors}
      SetSilent silent
    ${EndIf}
    ${If} ${UAC_IsInnerInstance}
      !insertmacro setInstallModePerAllUsers
    ${Else}
      StrCpy $isForceMachineInstall "0"
      StrCpy $isForceCurrentInstall "0"
      !insertmacro tiaSelectInstallScope
      ${If} $isForceMachineInstall == "1"
        ${If} ${Silent}
        ${AndIfNot} ${UAC_IsAdmin}
          !insertmacro UAC_RunElevated
          Quit
        ${EndIf}
        !insertmacro setInstallModePerAllUsers
      ${ElseIf} $isForceCurrentInstall == "1"
        !insertmacro setInstallModePerUser
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!ifdef BUILD_UNINSTALLER
  !if "${APP_ID}" == "com.serenetia.tia-launcher"
    !define TIA_PROFILE_DIR "tia-launcher-bootstrap"
  !else if "${APP_ID}" == "com.serenetia.tia-launcher.migration-test"
    !define TIA_PROFILE_DIR "tia-launcher-uninstall-test"
  !endif
  !ifdef TIA_PROFILE_DIR
    Function un.tiaRemoveLauncherData
      SetShellVarContext current
      StrCpy $R1 "0"
      IfFileExists "$APPDATA\${TIA_PROFILE_DIR}\launcher.tauri.key" 0 tiaDataDone
      ExecWait '"$INSTDIR\${PRODUCT_FILENAME}.exe" --cleanup-launcher-data "$APPDATA\${TIA_PROFILE_DIR}"' $R1
      tiaDataDone:
    FunctionEnd
  !endif
!endif

!macro customUnInstall
  !ifdef TIA_PROFILE_DIR
    ${IfNot} ${isUpdated}
      ${GetParameters} $R0
      ClearErrors
      ${GetOptions} $R0 "--tia-delete-launcher-data" $R1
      ${IfNot} ${Errors}
        ${If} ${UAC_IsInnerInstance}
          !insertmacro UAC_AsUser_Call Function un.tiaRemoveLauncherData ${UAC_SYNCREGISTERS}|${UAC_SYNCINSTDIR}
        ${Else}
          Call un.tiaRemoveLauncherData
        ${EndIf}
        ${If} $R1 != "0"
          ${IfNot} ${Silent}
            MessageBox MB_OK|MB_ICONINFORMATION "The launcher will be removed, but saved data was kept because it could not be safely cleared."
          ${EndIf}
        ${EndIf}
        ${If} $installMode == "all"
          SetShellVarContext all
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customInstall
  !insertmacro tiaEnsureWebView2
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/R" $R1
  ${IfNot} ${Errors}
    ${IfNot} ${isForceRun}
      HideWindow
      ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${PRODUCT_FILENAME}.exe" "open" "--updated"
    ${EndIf}
  ${EndIf}
!macroend
