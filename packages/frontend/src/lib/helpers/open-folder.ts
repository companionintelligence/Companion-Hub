import i18next from 'i18next';
import toast from 'react-hot-toast';
import { getTauriInvoke } from './tauri-invoke';

/**
 * Low-level: run an "open folder" Tauri command with uniform desktop-gating and
 * error handling. No-op in a plain browser (no Tauri runtime). On failure, logs
 * to the console and shows an error toast. Shared by every "open folder" button
 * so they all behave identically — only the command/path differs.
 */
async function runOpenFolder(cmd: string, args?: Record<string, unknown>): Promise<void> {
  const invoke = getTauriInvoke();
  if (!invoke) {
    return;
  }
  try {
    await invoke(cmd, args);
  } catch (error) {
    console.error(`Failed to open folder via "${cmd}":`, error);
    toast.error(i18next.t('OPEN_FOLDER_ERROR'));
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
