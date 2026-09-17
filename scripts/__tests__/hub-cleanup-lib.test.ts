import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getDesktopTunnelDir,
  getHubStateDirs,
  isCloudflaredTunnelToken,
  isRelatedVolume,
  isWithinPath,
  parseNames,
  runHubCleanup,
} from '../hub-cleanup-lib';

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
    expect(isRelatedVolume('ci_os_hub-prod_db_data')).toBe(true);
    expect(isRelatedVolume('runcihub_media_data')).toBe(true);
    expect(isRelatedVolume('runcihub_media')).toBe(true);
    expect(isRelatedVolume('postgres_data')).toBe(false);
    expect(isRelatedVolume('anotherstack_prod_data')).toBe(false);
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

  it('tears down marketplace app projects discovered via the ci-os-hub.managed label', () => {
    const prevDataHome = process.env.XDG_DATA_HOME;
    const prevConfigHome = process.env.XDG_CONFIG_HOME;
    const prevCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_DATA_HOME = '/home/dev/.local/share';
    process.env.XDG_CONFIG_HOME = '/home/dev/.config';
    process.env.XDG_CACHE_HOME = '/home/dev/.cache';

    const commands: string[] = [];

    try {
      runHubCleanup({
        cwd: '/home/dev/ci-hub',
        homeDir: '/home/dev',
        platform: 'linux',
        execCommand: (command) => {
          commands.push(command);
          if (command.includes('label=ci-os-hub.managed=true')) {
            // `--format "{{.Labels}}"` returns a comma-joined key=value list per container.
            // Includes a Hub-stack project (ci-os-hub) — which also carries this label in
            // docker-compose.prod.yml — to prove the app loop excludes it.
            return {
              ok: true,
              stdout:
                'ci-os-hub.managed=true,com.docker.compose.project=ci-hermes_ci-marketplace,foo=bar\ncom.docker.compose.project=foo_ci-marketplace,ci-os-hub.managed=true\nci-os-hub.managed=true,com.docker.compose.project=ci-os-hub',
            };
          }
          // Image snapshot: container IDs for the app project (note the `-q` form).
          if (command.includes('docker ps -a --filter label=com.docker.compose.project=ci-hermes_ci-marketplace -q')) {
            return { ok: true, stdout: 'cid-hermes' };
          }
          if (command.includes(`docker inspect --format "{{.Image}}" cid-hermes`)) {
            return { ok: true, stdout: 'sha256:appimage' };
          }
          if (command.includes('label=com.docker.compose.project=ci-hermes_ci-marketplace --format "{{.ID}}"')) {
            return { ok: true, stdout: 'abc123' };
          }
          if (command.includes('docker network ls --filter label=com.docker.compose.project=ci-hermes_ci-marketplace')) {
            // Includes the shared hub network to prove the app loop skips it.
            return { ok: true, stdout: 'ci-hermes_ci-marketplace_network\nci-os-hub_network' };
          }
          if (command.includes('docker volume ls --filter label=com.docker.compose.project=ci-hermes_ci-marketplace')) {
            return { ok: true, stdout: 'ci-hermes_ci-marketplace_data' };
          }
          return { ok: true, stdout: '' };
        },
        exists: () => false,
        removeDir: () => {},
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });

      // Discovered app projects via the managed label and iterated each one.
      expect(commands.some((command) => command.includes('label=ci-os-hub.managed=true'))).toBe(true);
      expect(commands.some((command) => command.includes('label=com.docker.compose.project=foo_ci-marketplace'))).toBe(true);
      // Removed the app's container (by id), its own network, its volume, and its image.
      expect(commands).toContain('docker rm -f abc123');
      expect(commands).toContain('docker network rm ci-hermes_ci-marketplace_network');
      expect(commands).toContain('docker volume rm ci-hermes_ci-marketplace_data');
      expect(commands).toContain('docker image rm -f sha256:appimage');
      // The Hub-stack project is excluded from the marketplace loop (handled by Hub teardown).
      expect(commands).not.toContain('docker ps -a --filter label=com.docker.compose.project=ci-os-hub --format "{{.ID}}"');
    } finally {
      if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevDataHome;
      if (prevConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevConfigHome;
      if (prevCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prevCacheHome;
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

/** base64 of {"a": account tag, "t": tunnel id, "s": secret}, the format cloudflared reads; padded so tests can strip the padding. */
const CLOUDFLARED_TOKEN = (() => {
  for (let secretBytes = 32; secretBytes < 40; secretBytes++) {
    const payload = {
      a: '0123456789abcdef0123456789abcdef',
      t: '6ff42ae2-765d-4adf-8112-31c55c1551ef',
      s: Buffer.alloc(secretBytes, 7).toString('base64'),
    };
    const token = Buffer.from(JSON.stringify(payload)).toString('base64');
    if (token.endsWith('=')) return token;
  }
  throw new Error('could not build a padded token');
})();

describe('isCloudflaredTunnelToken', () => {
  it('accepts a cloudflared token, with or without base64 padding and surrounding whitespace', () => {
    expect(CLOUDFLARED_TOKEN.endsWith('=')).toBe(true);
    expect(isCloudflaredTunnelToken(CLOUDFLARED_TOKEN)).toBe(true);
    expect(isCloudflaredTunnelToken(`${CLOUDFLARED_TOKEN.replace(/=+$/, '')}\r\n`)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['plain text', 'hello world'],
    ['base64 of JSON without the token keys', Buffer.from('{"id":"x","name":"y"}').toString('base64')],
    ['base64 of a JSON array', Buffer.from('["a","t","s"]').toString('base64')],
    ['a token with characters that are not base64', `${CLOUDFLARED_TOKEN}!`],
  ])('rejects %s', (_label, content) => {
    expect(isCloudflaredTunnelToken(content)).toBe(false);
  });
});

describe('getDesktopTunnelDir', () => {
  it('is the tunnel folder beside the desktop data folder', () => {
    const saved = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, APPDATA: process.env.APPDATA };
    try {
      process.env.XDG_DATA_HOME = '/home/dev/.local/share';
      process.env.APPDATA = 'C:\\Users\\dev\\AppData\\Roaming';
      expect(getDesktopTunnelDir({ homeDir: '/home/dev', platform: 'linux' })).toBe('/home/dev/.local/share/tunnel');
      expect(getDesktopTunnelDir({ homeDir: 'C:\\Users\\dev', platform: 'win32' })).toBe('C:\\Users\\dev\\AppData\\Roaming\\tunnel');
      delete process.env.XDG_DATA_HOME;
      expect(getDesktopTunnelDir({ homeDir: '/home/dev', platform: 'linux' })).toBe('/home/dev/.local/share/tunnel');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe.skipIf(process.platform === 'win32')('runHubCleanup tunnel files', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(dir);
    return dir;
  }

  const listDir = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null);

  type TunnelFiles = { token?: string; registration?: string; extraFiles?: string[]; certsFiles?: string[] };

  /** A tunnel folder the way a paired Hub leaves it, with per-test overrides. */
  function writeTunnelDir(tunnel: string, files: TunnelFiles = {}) {
    fs.mkdirSync(path.join(tunnel, 'certs'), { recursive: true });
    fs.writeFileSync(path.join(tunnel, 'token'), files.token ?? CLOUDFLARED_TOKEN);
    fs.writeFileSync(
      path.join(tunnel, 'registration.json'),
      files.registration ?? '{"tunnelId":"6ff42ae2","writtenAt":"2026-09-17T00:00:00.000Z"}\n',
    );
    fs.writeFileSync(path.join(tunnel, 'leftover.json'), '{"tunnelId":null,"foundAt":"2026-09-17T00:00:00.000Z"}\n');
    fs.writeFileSync(path.join(tunnel, '.user-cleared-token'), '1');
    for (const name of files.certsFiles ?? []) fs.writeFileSync(path.join(tunnel, 'certs', name), 'PEM');
    for (const name of files.extraFiles ?? []) fs.writeFileSync(path.join(tunnel, name), 'not the Hub');
  }

  /** A home holding a repo checkout and the desktop's data folder, each with its tunnel folder. */
  function makeHome(desktopTunnel: TunnelFiles = {}) {
    const home = tempDir('ci-hub-cleanup-home-');
    const share = path.join(home, '.local', 'share');
    fs.mkdirSync(path.join(share, 'companion-hub', 'state'), { recursive: true });
    fs.mkdirSync(path.join(share, 'other-app'), { recursive: true });
    fs.writeFileSync(path.join(share, 'other-app', 'data'), 'keep');
    writeTunnelDir(path.join(share, 'tunnel'), desktopTunnel);
    const repo = path.join(home, 'ci-hub');
    writeTunnelDir(path.join(repo, 'tunnel'), { token: 'dev-token', extraFiles: ['README.md'] });
    return { home, share, repo, desktopTunnel: path.join(share, 'tunnel'), repoTunnel: path.join(repo, 'tunnel') };
  }

  function cleanup(home: string, repo: string, dryRun = false) {
    const saved = {
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    };
    process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.XDG_CACHE_HOME = path.join(home, '.cache');
    try {
      return runHubCleanup({
        cwd: repo,
        homeDir: home,
        platform: 'linux',
        dryRun,
        // Nothing reaches a shell or Docker, and nothing outside the temp home is deleted.
        execCommand: () => ({ ok: true, stdout: '' }),
        removeDir: (target) => {
          if (!isWithinPath(target, home, 'linux')) throw new Error(`refusing to remove ${target}`);
          fs.rmSync(target, { recursive: true, force: true });
        },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('removes the token and the backend markers from the repo tunnel folder', () => {
    const { home, repo, repoTunnel } = makeHome();
    const summary = cleanup(home, repo);
    expect(summary.failedDirs).toBe(0);
    expect(listDir(repoTunnel)).toEqual(['README.md']);
  });

  it('removes the Hub files beside the desktop data folder, then the empty folder', () => {
    const { home, share, repo, desktopTunnel } = makeHome();
    const summary = cleanup(home, repo);
    expect(summary.failedDirs).toBe(0);
    expect(fs.existsSync(path.join(share, 'companion-hub'))).toBe(false);
    expect(fs.existsSync(desktopTunnel)).toBe(false);
    expect(listDir(path.join(share, 'other-app'))).toEqual(['data']);
  });

  it('keeps a desktop tunnel folder whose files are not the Hub files', () => {
    const { home, repo, desktopTunnel } = makeHome({
      token: 'hello world',
      registration: '{"id":1}',
      extraFiles: ['notes.txt'],
      certsFiles: ['custom-ca.pem'],
    });
    cleanup(home, repo);
    expect(listDir(desktopTunnel)).toEqual(['certs', 'notes.txt', 'registration.json', 'token']);
    expect(listDir(path.join(desktopTunnel, 'certs'))).toEqual(['custom-ca.pem']);
  });

  it('does not follow a symlinked desktop tunnel folder', () => {
    const { home, repo, desktopTunnel } = makeHome();
    fs.rmSync(desktopTunnel, { recursive: true });
    const target = path.join(tempDir('ci-hub-cleanup-elsewhere-'), 'tunnel');
    writeTunnelDir(target);
    fs.symlinkSync(target, desktopTunnel);
    cleanup(home, repo);
    expect(listDir(target)).toEqual(['.user-cleared-token', 'certs', 'leftover.json', 'registration.json', 'token']);
  });

  it('leaves the desktop tunnel files in place on a dry run', () => {
    const { home, repo, desktopTunnel } = makeHome();
    cleanup(home, repo, true);
    expect(listDir(desktopTunnel)).toEqual(['.user-cleared-token', 'certs', 'leftover.json', 'registration.json', 'token']);
  });
});
