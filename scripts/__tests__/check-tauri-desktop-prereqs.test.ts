import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (target: string) => existsSyncMock(target),
    readdirSync: (target: string) => {
      if (target === '/tmp/.X11-unix') return [];
      return actual.readdirSync(target);
    },
  };
});

import { checkTauriDesktopPrereqs, isHeadlessOnlyFailure, resolveLinuxGuiEnvironment } from '../check-tauri-desktop-prereqs';

describe('resolveLinuxGuiEnvironment', () => {
  beforeEach(() => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    execSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  it('returns existing DISPLAY unchanged', () => {
    process.env.DISPLAY = ':1';
    expect(resolveLinuxGuiEnvironment()).toEqual({ env: {}, source: 'existing session environment' });
  });
});

describe('checkTauriDesktopPrereqs', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    execSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('passes when display and libraries are available', () => {
    process.env.DISPLAY = ':0';
    execSyncMock.mockReturnValue('libgtk-3.so.0\nlibwebkit2gtk-4.1.so.0');

    const result = checkTauriDesktopPrereqs();
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('reports missing display as headless-only failure', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (String(cmd).includes('ldconfig')) {
        return 'libgtk-3.so.0\nlibwebkit2gtk-4.1.so.0';
      }
      throw new Error('no session');
    });

    const result = checkTauriDesktopPrereqs();
    expect(result.ok).toBe(false);
    expect(isHeadlessOnlyFailure(result)).toBe(true);
    expect(result.issues[0]?.code).toBe('missing-display');
  });

  it('reports missing GTK/WebKit libraries', () => {
    process.env.DISPLAY = ':0';
    execSyncMock.mockReturnValue('');

    const result = checkTauriDesktopPrereqs();
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === 'missing-library')).toBe(true);
    expect(isHeadlessOnlyFailure(result)).toBe(false);
  });
});
