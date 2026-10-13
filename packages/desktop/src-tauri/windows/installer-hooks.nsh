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
; script is still present on disk when we call it. Best-effort: a failed cleanup never
; blocks the uninstall. The one prompt is the running-app check below, and its Cancel stops
; the uninstall before anything is removed. See distribution/scripts/uninstall-cleanup.ps1.
;
; Tauri's NSIS template inserts this hook at the top of `Section Uninstall`, before any
; update-mode check: an uninstaller launched with /UPDATE (un.onInit turns that flag into
; $UpdateMode, which the template only uses to keep shortcuts, the autostart entry and app
; data) would still run it. The cleanup removes the Hub's containers and images, and with
; "Delete the application data" ticked its data, so skip it entirely in update mode.
;
; That box is on the template's confirm page, and the template itself deletes only its own
; app-data folders when it's ticked. The hook passes it on as -DeleteAppData, so the cleanup
; also deletes the Hub's data folder, tunnel token and Docker volumes. Unticked (the default)
; they stay, and a reinstall comes back paired with its apps and data. A silent (/S) or
; passive (/P) uninstall skips the confirm page and its state stays empty: the data stays.
;
; The template checks for a running app only after this hook. Left to that order, the
; cleanup ran with the app still open: its tray probe created hub_tailscale_state again
; seconds after the cleanup removed it, it wrote its log and window settings back into the
; folders just deleted, and cancelling the "is running" prompt stopped the uninstall after
; the data was gone. So the hook runs the template's own check first. It asks to close the
; app (or closes it when silent), Cancel ends the uninstall before anything is removed, and
; the template's check that follows finds nothing running.

!macro NSIS_HOOK_PREUNINSTALL
  Push $0
  Push $1
  StrCmp $UpdateMode "1" ci_hub_skip_cleanup 0
  ; Overwrites $0-$3 and $R0-$R3, so it comes before the script lookup below sets $0.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  DetailPrint "Companion Hub: running uninstall cleanup..."
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
    ; -DeleteAppData only when "Delete the application data" is ticked (see above).
    StrCpy $1 ""
    StrCmp $DeleteAppDataCheckboxState "1" 0 +2
      StrCpy $1 " -DeleteAppData"
    ; Absolute path to system PowerShell ($SYSDIR resolves to System32, or SysWOW64 under
    ; WOW64 — both have powershell.exe) to avoid PATH/CWD hijacking during uninstall.
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$0"$1'
    Pop $1
  ci_hub_skip_cleanup:
  Pop $1
  Pop $0
!macroend
