; Companion Hub — NSIS installer hooks
; Wired via `bundle.windows.nsis.installerHooks` in tauri.conf.json.
;
; The NSIS `-setup.exe` (and WinGet, whose CI-Hub manifest installs that exe) previously
; had no uninstall-time cleanup, so uninstalling the packaged build left every Hub /
; marketplace-app Docker container, volume and image running and all %APPDATA% /
; %LOCALAPPDATA% state on disk. This hook closes that gap by invoking the same shared
; cleanup script the Chocolatey/Scoop and Linux channels use.
;
; NOTE: this only covers the NSIS target. The WiX `.msi` bundle runs the same script
; via a custom action — see windows/cleanup-on-uninstall.wxs.
;
; Runs in NSIS_HOOK_PREUNINSTALL — *before* Tauri deletes $INSTDIR — so the bundled
; script is still present on disk when we call it. Best-effort and non-interactive:
; failures never block the uninstall. See distribution/scripts/uninstall-cleanup.ps1.

!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  Push $1
  DetailPrint "Companion Hub: running uninstall cleanup (Docker resources + app data)..."
  ; Tauri resource bundling can place the script nested (resources\) or flat, so check
  ; both layouts — mirrors the dual-path lookup in hub_manager.rs — and run whichever
  ; exists, preferring the nested (explicitly mapped) path. The +2 skips below jump over
  ; one StrCpy each; the only plugin call (nsExec) is reached via a label, never a counted
  ; offset (nsExec compiles to a Push plus the call, so counting over it is fragile).
  StrCpy $0 ""
  IfFileExists "$INSTDIR\uninstall-cleanup.ps1" 0 +2
    StrCpy $0 "$INSTDIR\uninstall-cleanup.ps1"
  IfFileExists "$INSTDIR\resources\uninstall-cleanup.ps1" 0 +2
    StrCpy $0 "$INSTDIR\resources\uninstall-cleanup.ps1"
  StrCmp $0 "" ci_hub_skip_cleanup 0
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$0"'
    Pop $1
  ci_hub_skip_cleanup:
  Pop $1
  Pop $0
!macroend
