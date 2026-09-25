import { afterEach, describe, expect, it, vi } from 'vitest';
import { canOpenFolderInFileExplorer, openLogsFolder, openPathInFileExplorer } from './open-folder';

const mockInvoke = vi.fn();
const mockToastError = vi.fn();
const mobile = vi.hoisted(() => ({ isMobile: false }));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
}));

vi.mock('@/lib/mobile-connection', () => ({
  isTauriMobileSync: () => mobile.isMobile,
}));

type TauriWindow = Window & { __TAURI_INTERNALS__?: { invoke: unknown } };

function enterTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    value: { invoke: (...args: unknown[]) => mockInvoke(...args) },
    configurable: true,
  });
}

describe('open-folder', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mobile.isMobile = false;
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  it('no-ops outside the Tauri runtime', async () => {
    expect(canOpenFolderInFileExplorer()).toBe(false);
    await openPathInFileExplorer('/srv/hub/app-data');
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('no-ops in the phone app even when Tauri invoke exists', async () => {
    enterTauri();
    mobile.isMobile = true;
    expect(canOpenFolderInFileExplorer()).toBe(false);
    await openPathInFileExplorer('/srv/hub/app-data');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('invokes open_path_command with the path inside desktop Tauri', async () => {
    enterTauri();
    mockInvoke.mockResolvedValue(undefined);
    expect(canOpenFolderInFileExplorer()).toBe(true);

    await openPathInFileExplorer('/srv/hub/app-data/store/app');

    expect(mockInvoke).toHaveBeenCalledWith('open_path_command', { path: '/srv/hub/app-data/store/app' });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty path (does not invoke)', async () => {
    enterTauri();
    await openPathInFileExplorer('');
    await openPathInFileExplorer(null);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('toasts the host-machine message when the path is missing', async () => {
    enterTauri();
    mockInvoke.mockRejectedValue(new Error('Path does not exist: /bad/path'));

    await openPathInFileExplorer('/bad/path');

    expect(mockToastError).toHaveBeenCalledWith('OPEN_FOLDER_NOT_ON_THIS_MACHINE');
  });

  it('toasts the generic error when the file manager fails for another reason', async () => {
    enterTauri();
    mockInvoke.mockRejectedValue(new Error('xdg-open: no such file'));

    await openPathInFileExplorer('/srv/hub/app-data');

    expect(mockToastError).toHaveBeenCalledWith('OPEN_FOLDER_ERROR');
  });

  it('toasts the ACL message when Tauri rejects the command', async () => {
    enterTauri();
    mockInvoke.mockRejectedValue(new Error('Command open_path_command not allowed by ACL'));

    await openPathInFileExplorer('/srv/hub/app-data/store/app');

    expect(mockToastError).toHaveBeenCalledWith('OPEN_FOLDER_ACL_DENIED');
  });

  it('openLogsFolder invokes open_logs_dir_command with no args', async () => {
    enterTauri();
    mockInvoke.mockResolvedValue(undefined);

    await openLogsFolder();

    expect(mockInvoke).toHaveBeenCalledWith('open_logs_dir_command', undefined);
  });
});
