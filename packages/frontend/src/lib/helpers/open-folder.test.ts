import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLogsFolder, openPathInFileExplorer } from './open-folder';

const mockInvoke = vi.fn();
const mockToastError = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: { error: (...args: unknown[]) => mockToastError(...args) },
}));

vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
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
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  it('no-ops outside the Tauri runtime', async () => {
    await openPathInFileExplorer('/srv/hub/app-data');
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('invokes open_path_command with the path inside Tauri', async () => {
    enterTauri();
    mockInvoke.mockResolvedValue(undefined);

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

  it('shows an error toast when the command rejects', async () => {
    enterTauri();
    mockInvoke.mockRejectedValue(new Error('path does not exist'));

    await openPathInFileExplorer('/bad/path');

    expect(mockToastError).toHaveBeenCalledWith('OPEN_FOLDER_ERROR');
  });

  it('openLogsFolder invokes open_logs_dir_command with no args', async () => {
    enterTauri();
    mockInvoke.mockResolvedValue(undefined);

    await openLogsFolder();

    expect(mockInvoke).toHaveBeenCalledWith('open_logs_dir_command', undefined);
  });
});
