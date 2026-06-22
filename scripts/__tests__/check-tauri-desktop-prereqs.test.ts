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

import { buildTauriProcessEnv, checkTauriDesktopPrereqs, isHeadlessOnlyFailure, resolveLinuxGuiEnvironment } from '../check-tauri-desktop-prereqs';

describe('resolveLinuxGuiEnvironment', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    execSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
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

describe('buildTauriProcessEnv', () => {
  const originalPlatform = process.platform;
  const originalGtkPath = process.env.GTK_PATH;
  const originalGtkImModuleFile = process.env.GTK_IM_MODULE_FILE;
  const originalXdgDataDirs = process.env.XDG_DATA_DIRS;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;
  const originalLdLibraryPath = process.env.LD_LIBRARY_PATH;
  const originalGioModuleDir = process.env.GIO_MODULE_DIR;
  const originalGSettingsSchemaDir = process.env.GSETTINGS_SCHEMA_DIR;
  const originalLocPath = process.env.LOCPATH;
  const originalSnap = process.env.SNAP;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.GTK_PATH = '/snap/code/232/usr/lib/x86_64-linux-gnu/gtk-3.0';
    process.env.GTK_IM_MODULE_FILE = '/home/ci/snap/code/common/.cache/immodules/immodules.cache';
    process.env.GIO_MODULE_DIR = '/home/ci/snap/code/common/.cache/gio-modules';
    process.env.GSETTINGS_SCHEMA_DIR = '/home/ci/snap/code/232/.local/share/glib-2.0/schemas';
    process.env.LOCPATH = '/snap/code/232/usr/lib/locale';
    process.env.XDG_DATA_DIRS = '/home/ci/snap/code/232/.local/share:/snap/code/232/usr/share:/usr/share/ubuntu:/usr/share';
    process.env.XDG_DATA_HOME = '/home/ci/snap/code/232/.local/share';
    process.env.LD_LIBRARY_PATH = '/snap/core20/current/lib/x86_64-linux-gnu:/usr/local/lib';
    process.env.SNAP = '/snap/code/232';
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalGtkPath === undefined) delete process.env.GTK_PATH;
    else process.env.GTK_PATH = originalGtkPath;
    if (originalGtkImModuleFile === undefined) delete process.env.GTK_IM_MODULE_FILE;
    else process.env.GTK_IM_MODULE_FILE = originalGtkImModuleFile;
    if (originalXdgDataDirs === undefined) delete process.env.XDG_DATA_DIRS;
    else process.env.XDG_DATA_DIRS = originalXdgDataDirs;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalLdLibraryPath === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = originalLdLibraryPath;
    if (originalGioModuleDir === undefined) delete process.env.GIO_MODULE_DIR;
    else process.env.GIO_MODULE_DIR = originalGioModuleDir;
    if (originalGSettingsSchemaDir === undefined) delete process.env.GSETTINGS_SCHEMA_DIR;
    else process.env.GSETTINGS_SCHEMA_DIR = originalGSettingsSchemaDir;
    if (originalLocPath === undefined) delete process.env.LOCPATH;
    else process.env.LOCPATH = originalLocPath;
    if (originalSnap === undefined) delete process.env.SNAP;
    else process.env.SNAP = originalSnap;
  });

  it('strips snap-injected runtime paths from Linux desktop launches', () => {
    const env = buildTauriProcessEnv(null);
    expect(env.GTK_PATH).toBeUndefined();
    expect(env.GTK_IM_MODULE_FILE).toBeUndefined();
    expect(env.GIO_MODULE_DIR).toBeUndefined();
    expect(env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
    expect(env.LOCPATH).toBeUndefined();
    expect(env.SNAP).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBe('/usr/local/lib');
    expect(env.XDG_DATA_DIRS).toBe('/usr/share/ubuntu:/usr/share');
    expect(env.XDG_DATA_HOME).toBeUndefined();
  });
});
