import i18next from 'i18next';
import toast from 'react-hot-toast';
import { isTauriDesktopApp } from '@/lib/hub-runtime-mode';
import { getTauriInvoke } from './tauri-invoke';

/**
 * Native Finder / Explorer / file-manager open. Only the desktop Tauri shell
 * on the Hub host can do this — a browser tab and the phone app are not that
 * machine, even when they know the host path.
 */
export function canOpenFolderInFileExplorer(): boolean {
  return isTauriDesktopApp();
}

/**
 * Low-level: run an "open folder" Tauri command with uniform desktop-gating and
 * error handling. No-op in a plain browser or the phone app. On failure, logs
 * to the console and shows an error toast. Shared by every "open folder" button
 * so they all behave identically — only the command/path differs.
 */
async function runOpenFolder(cmd: string, args?: Record<string, unknown>): Promise<void> {
  if (!canOpenFolderInFileExplorer()) {
    return;
  }
  const invoke = getTauriInvoke();
  if (!invoke) {
    return;
  }
  try {
    await invoke(cmd, args);
  } catch (error) {
    console.error(`Failed to open folder via "${cmd}":`, error);
    const detail = error instanceof Error ? error.message : String(error);
    const missingOnThisMachine = /does not exist|not on this (machine|computer)|not absolute/i.test(detail);
    // Surface ACL denials distinctly — they look like a generic failure but mean
    // the desktop shell never received the capability grant for this command.
    const aclDenied = /not allowed by ACL/i.test(detail);
    toast.error(i18next.t(missingOnThisMachine ? 'OPEN_FOLDER_NOT_ON_THIS_MACHINE' : aclDenied ? 'OPEN_FOLDER_ACL_DENIED' : 'OPEN_FOLDER_ERROR'));
  }
}

/**
 * Open an absolute host path (an app's data folder or the root app-data folder)
 * in the OS default file explorer. No-op when the path is missing/empty or when
 * not running in the desktop app.
 */
export function openPathInFileExplorer(path: string | null | undefined): Promise<void> {
  if (!path) {
    return Promise.resolve();
  }
  return runOpenFolder('open_path_command', { path });
}

/**
 * Open the desktop logs folder in the OS default file explorer. The path is
 * resolved on the Rust side, so no argument is needed.
 */
export function openLogsFolder(): Promise<void> {
  return runOpenFolder('open_logs_dir_command');
}
