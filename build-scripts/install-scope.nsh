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
