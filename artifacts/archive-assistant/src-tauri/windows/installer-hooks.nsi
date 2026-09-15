; Archive Assistant keeps a bundled Node sidecar alive while the window is
; hidden in the tray. NSIS cannot overwrite runtime\node.exe while that child
; process is still running, so stop this app's process tree before extracting
; an update. Do not kill node.exe globally: other Node applications may be
; running on the same machine.
!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill.exe /IM "archive-assistant-desktop.exe" /T /F'
  Pop $0
  Sleep 1000
!macroend
