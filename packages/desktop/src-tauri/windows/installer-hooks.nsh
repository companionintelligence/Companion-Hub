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
  DetailPrint "Companion Hub: running uninstall cleanup (Docker resources + app data)..."
  ; Use a label (not a relative +N jump): `nsExec::ExecToLog` compiles to a Push plus
  ; the plugin call, so a counted offset over it is fragile.
  IfFileExists "$INSTDIR\resources\uninstall-cleanup.ps1" 0 ci_hub_skip_cleanup
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\uninstall-cleanup.ps1"'
    Pop $0
  ci_hub_skip_cleanup:
!macroend
