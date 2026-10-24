!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef BUILD_UNINSTALLER
  Var PasswordInput

  Page custom PasswordPage PasswordPageLeave

  Function PasswordPage
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 12u "This installer is password protected. Enter the password to continue:"
    ${NSD_CreatePassword} 0 20u 100% 12u ""
    Pop $PasswordInput
    nsDialogs::Show
  FunctionEnd

  Function PasswordPageLeave
    ${NSD_GetText} $PasswordInput $0
    ${If} $0 != "211980"
      MessageBox MB_ICONSTOP "Incorrect password."
      Abort
    ${EndIf}
  FunctionEnd
!endif
