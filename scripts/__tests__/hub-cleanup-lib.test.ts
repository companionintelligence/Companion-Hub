import { describe, expect, it } from 'vitest';
import { getHubStateDirs, isRelatedVolume, isWithinPath, parseNames, runHubCleanup } from '../hub-cleanup-lib';

describe('hub-cleanup-lib', () => {
  it('isWithinPath handles trailing separators on basePath and targetPath', () => {
    // basePath with trailing slash must not produce a // double-separator mismatch
    expect(isWithinPath('/home/user/work', '/home/user/', 'linux')).toBe(true);
    expect(isWithinPath('/home/user/', '/home/user/', 'linux')).toBe(true);
    expect(isWithinPath('/home/user', '/home/user/', 'linux')).toBe(true);
    expect(isWithinPath('/home/user/work', '/home/user', 'linux')).toBe(true);
    // unrelated path must still return false
    expect(isWithinPath('/tmp/other', '/home/user/', 'linux')).toBe(false);
  });

  it('matches known Hub volume naming patterns', () => {
    expect(isRelatedVolume('ci_hub_pgdata')).toBe(true);
    expect(isRelatedVolume('ci_hub_app_data')).toBe(true);
    expect(isRelatedVolume('hub_tailscale_state')).toBe(true);
    expect(isRelatedVolume('ci-os-hub_test_data')).toBe(true);
    expect(isRelatedVolume('runtipi_media')).toBe(true);
    expect(isRelatedVolume('postgres_data')).toBe(false);
  });

  it('parses newline-delimited names', () => {
    expect(parseNames('one\n\n two \n')).toEqual(['one', 'two']);
  });

  it('resolves Linux state directories and includes repo-local paths', () => {
    const prevDataHome = process.env.XDG_DATA_HOME;
    const prevConfigHome = process.env.XDG_CONFIG_HOME;
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_DATA_HOME = '/home/tester/.local/share';
    process.env.XDG_CONFIG_HOME = '/home/tester/.config';
    process.env.XDG_CACHE_HOME = '/home/tester/.cache';

    const dirs = getHubStateDirs({
      cwd: '/tmp/ci-hub',
      homeDir: '/home/tester',
      platform: 'linux',
    });

    try {
      expect(dirs.some((dir) => dir.path === '/tmp/ci-hub/.local')).toBe(true);
      expect(dirs.some((dir) => dir.path.includes('/home/tester/.config'))).toBe(true);
      expect(dirs.some((dir) => dir.path.endsWith('computer.ci.app.hub'))).toBe(true);
    } finally {
      if (prevDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = prevDataHome;
      }
      if (prevConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prevConfigHome;
      }
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
    }
  });

  it('resolves Windows state directories and includes AppData names', () => {
    const prevAppData = process.env.APPDATA;
    const prevLocalAppData = process.env.LOCALAPPDATA;
    process.env.APPDATA = 'C:\\Users\\dev\\AppData\\Roaming';
    process.env.LOCALAPPDATA = 'C:\\Users\\dev\\AppData\\Local';

    try {
      const dirs = getHubStateDirs({
        cwd: 'C:\\repo',
        homeDir: 'C:\\Users\\dev',
        platform: 'win32',
      });

      expect(dirs.some((dir) => dir.path.includes('AppData\\Roaming\\Companion Hub'))).toBe(true);
      expect(dirs.some((dir) => dir.path.includes('AppData\\Local\\companion-hub'))).toBe(true);
      expect(dirs.some((dir) => dir.path === 'C:\\repo\\.config')).toBe(true);
      expect(dirs.some((dir) => dir.path.includes('AppData\\Roaming\\computer.ci.app.hub'))).toBe(true);
    } finally {
      if (prevAppData === undefined) {
        delete process.env.APPDATA;
      } else {
        process.env.APPDATA = prevAppData;
      }
      if (prevLocalAppData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = prevLocalAppData;
      }
    }
  });

  it('supports dry-run without deleting files while still reporting planned work', () => {
    const prevDataHome = process.env.XDG_DATA_HOME;
    const prevConfigHome = process.env.XDG_CONFIG_HOME;
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_DATA_HOME = '/home/dev/.local/share';
    process.env.XDG_CONFIG_HOME = '/home/dev/.config';
    process.env.XDG_CACHE_HOME = '/home/dev/.cache';

    const commands: string[] = [];
    const removed: string[] = [];

    try {
      const summary = runHubCleanup({
        cwd: '/tmp/ci-hub',
        homeDir: '/home/dev',
        platform: 'linux',
        dryRun: true,
        execCommand: (command) => {
          commands.push(command);
          if (command.includes('docker volume ls')) {
            return { ok: true, stdout: 'ci_hub_pgdata\npostgres_data' };
          }
          if (command.includes('docker network ls')) {
            return { ok: true, stdout: 'bridge\ne2e-network' };
          }
          return { ok: true, stdout: '' };
        },
        exists: (targetPath) => targetPath.endsWith('.internal') || targetPath.endsWith('computer.ci.app.hub'),
        removeDir: (targetPath) => {
          removed.push(targetPath);
        },
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      });

      expect(summary.dryRun).toBe(true);
      expect(summary.removedDirs).toBeGreaterThan(0);
      expect(removed).toEqual([]);
      expect(summary.attemptedCommands).toBeGreaterThan(5);
      expect(commands.some((command) => command.includes('docker volume ls'))).toBe(false);
      expect(commands.some((command) => command.includes('docker network ls'))).toBe(false);
    } finally {
      if (prevDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = prevDataHome;
      }
      if (prevConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prevConfigHome;
      }
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
    }
  });

  it('completes with no directory failures when cwd is within the user home', () => {
    const prevDataHome = process.env.XDG_DATA_HOME;
    const prevConfigHome = process.env.XDG_CONFIG_HOME;
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_DATA_HOME = '/home/dev/.local/share';
    process.env.XDG_CONFIG_HOME = '/home/dev/.config';
    process.env.XDG_CACHE_HOME = '/home/dev/.cache';

    const errors: string[] = [];

    try {
      const summary = runHubCleanup({
        cwd: '/home/dev/repo',
        homeDir: '/home/dev',
        platform: 'linux',
        dryRun: false,
        execCommand: () => ({ ok: true, stdout: '' }),
        exists: () => true,
        removeDir: () => {},
        logger: {
          info: () => {},
          warn: () => {},
          error: (message) => {
            errors.push(message);
          },
        },
      });

      expect(summary.failedDirs).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      if (prevDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = prevDataHome;
      }
      if (prevConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prevConfigHome;
      }
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
    }
  });

  it('blocks repo-local deletions when cwd is outside the user home', () => {
    const prevDataHome = process.env.XDG_DATA_HOME;
    const prevConfigHome = process.env.XDG_CONFIG_HOME;
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_DATA_HOME = '/home/dev/.local/share';
    process.env.XDG_CONFIG_HOME = '/home/dev/.config';
    process.env.XDG_CACHE_HOME = '/home/dev/.cache';

    const errors: string[] = [];

    try {
      const summary = runHubCleanup({
        cwd: '/repo',
        homeDir: '/home/dev',
        platform: 'linux',
        dryRun: false,
        execCommand: () => ({ ok: true, stdout: '' }),
        exists: () => true,
        removeDir: () => {},
        logger: {
          info: () => {},
          warn: () => {},
          error: (message) => {
            errors.push(message);
          },
        },
      });

      expect(summary.failedDirs).toBeGreaterThan(0);
      expect(errors.some((message) => message.includes('Blocked unsafe path'))).toBe(true);
    } finally {
      if (prevDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = prevDataHome;
      }
      if (prevConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = prevConfigHome;
      }
      if (prevCacheHome === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = prevCacheHome;
      }
    }
  });
});
