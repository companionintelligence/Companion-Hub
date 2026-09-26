import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveBlobAsFile, splitSavedPath } from './save-file';

const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe('saveBlobAsFile', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('clicks a download link in a browser and revokes its URL only after the click', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      events.push(`click ${this.download} ${this.href}`);
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:config');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {
      events.push('revoke');
    });

    const savedPath = await saveBlobAsFile('app-install-config.json', new Blob(['{}']));

    expect(savedPath).toBeNull();
    expect(events).toEqual(['click app-install-config.json blob:config']);
    expect(document.querySelector('a[download]')).toBeNull();

    await vi.runAllTimersAsync();
    expect(events).toEqual(['click app-install-config.json blob:config', 'revoke']);
  });

  it('writes the bytes through the desktop app and returns the saved path', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke: vi.fn() }, configurable: true });
    mockInvoke.mockResolvedValue('/home/user/Downloads/app-install-config.json');
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const blob = { arrayBuffer: async () => new TextEncoder().encode('{"a":1}').buffer } as Blob;

    const savedPath = await saveBlobAsFile('app-install-config.json', blob);

    expect(savedPath).toBe('/home/user/Downloads/app-install-config.json');
    expect(mockInvoke).toHaveBeenCalledWith('save_download_command', {
      filename: 'app-install-config.json',
      contents: Array.from(new TextEncoder().encode('{"a":1}')),
    });
    expect(clickSpy).not.toHaveBeenCalled();
  });
});

describe('splitSavedPath', () => {
  it('splits POSIX and Windows paths into folder and file name', () => {
    expect(splitSavedPath('/home/user/Downloads/app-install-config-2.json')).toEqual({
      folder: '/home/user/Downloads',
      file: 'app-install-config-2.json',
    });
    expect(splitSavedPath('C:\\Users\\user\\Downloads\\app-install-config.json')).toEqual({
      folder: 'C:\\Users\\user\\Downloads',
      file: 'app-install-config.json',
    });
  });

  it('keeps the root folder and tolerates a bare file name', () => {
    expect(splitSavedPath('/app-install-config.json')).toEqual({ folder: '/', file: 'app-install-config.json' });
    expect(splitSavedPath('app-install-config.json')).toEqual({ folder: '', file: 'app-install-config.json' });
  });
});
