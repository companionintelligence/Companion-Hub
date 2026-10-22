import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `cihub up` / `cihub restart` do to the env file before compose reads it.
 *
 * On a desktop install that file is the desktop app's: it writes DOCKER_GID and
 * CI_HUB_CONTAINER_UID/GID on every launch. `cihub restart prod` used to delete the app's
 * CI_HUB_CONTAINER_UID/GID (they equal the CLI user's uid and gid, which the checkout path reads as
 * its own stale pin) and append ENV_FILE. In a checkout that unpinning is still wanted.
 */
const docker = vi.hoisted(() => ({ socketRootOnly: false as boolean | null }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn(() => 'docker:x:981:someone\n') };
});
vi.mock('../heal-hub-bind-mounts', () => ({
  dockerSocketIsRootOnlyInsideContainers: () => docker.socketRootOnly,
  ensureHubBindMountsWritable: () => ({ uid: 1000, gid: 1000, source: 'test' }),
  isDockerAvailable: () => false,
  likelyDockerDesktop: () => false,
  logBindMountHeal: vi.fn(),
  resolveHostDockerSocketPath: () => '/var/run/docker.sock',
}));

const { initHubDataDirs } = await import('../init-hub-data-dirs');

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

let dir: string;
let previousEnvFile: string | undefined;
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'init-hub-env-'));
  previousEnvFile = process.env.ENV_FILE;
  docker.socketRootOnly = false;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (previousEnvFile === undefined) delete process.env.ENV_FILE;
  else process.env.ENV_FILE = previousEnvFile;
  warn.mockRestore();
  log.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function writeEnv(name: string, content: string, mode = 0o664): string {
  const envPath = path.join(dir, name);
  writeFileSync(envPath, content);
  chmodSync(envPath, mode);
  process.env.ENV_FILE = envPath;
  return envPath;
}

const desktopEnv = (root: string) =>
  [
    '# Preserved (kept once set, survive upgrades)',
    `ROOT_FOLDER_HOST=${root}`,
    'JWT_SECRET=jwt',
    'POSTGRES_PASSWORD=pg',
    'RABBITMQ_PASSWORD=mq',
    '',
    '# Derived (recomputed every launch from the current binary)',
    'DOCKER_GID=981',
    `CI_HUB_CONTAINER_UID=${uid}`,
    `CI_HUB_CONTAINER_GID=${gid}`,
    'HTTP_PORT=8880',
    '',
  ].join('\n');

const modeOf = (p: string) => statSync(p).mode & 0o777;

describe('initHubDataDirs on an appliance env file', () => {
  it('keeps every key the desktop app wrote and adds no ENV_FILE', () => {
    const original = desktopEnv(dir);
    const envPath = writeEnv('.env.dev', original);

    initHubDataDirs({ appliance: true });

    expect(readFileSync(envPath, 'utf-8')).toBe(original);
  });

  it.skipIf(process.platform === 'win32')('restricts it to 0600: it holds the Hub secrets', () => {
    const envPath = writeEnv('.env.dev', desktopEnv(dir));

    initHubDataDirs({ appliance: true });

    expect(modeOf(envPath)).toBe(0o600);
  });

  it('adds DOCKER_GID when a CLI-seeded file has none and changes nothing else', () => {
    const seeded = `ROOT_FOLDER_HOST=${dir}\nPOSTGRES_PASSWORD=pg\nENV_FILE=.env.dev\n`;
    const envPath = writeEnv('.env.dev', seeded);

    initHubDataDirs({ appliance: true });

    expect(readFileSync(envPath, 'utf-8')).toBe(`${seeded}DOCKER_GID=981\n`);
  });

  it('keeps a uid the desktop app pinned when the socket is root-only and pins 0:0 only where none is set', () => {
    // A non-zero uid, so overwriting it with the 0 this branch would pin cannot pass as keeping it.
    docker.socketRootOnly = true;
    const envPath = writeEnv('.env.dev', `ROOT_FOLDER_HOST=${dir}\nCI_HUB_CONTAINER_UID=501\n`);

    initHubDataDirs({ appliance: true });

    expect(readFileSync(envPath, 'utf-8')).toBe(`ROOT_FOLDER_HOST=${dir}\nCI_HUB_CONTAINER_UID=501\nCI_HUB_CONTAINER_GID=0\n`);
  });
});

describe('initHubDataDirs in a checkout', () => {
  it('still unpins a uid and gid equal to the current user and records ENV_FILE', () => {
    const envPath = writeEnv('.env.prod', `ROOT_FOLDER_HOST=${dir}\nDOCKER_GID=981\nCI_HUB_CONTAINER_UID=${uid}\nCI_HUB_CONTAINER_GID=${gid}\n`);

    initHubDataDirs();

    expect(readFileSync(envPath, 'utf-8')).toBe(`ROOT_FOLDER_HOST=${dir}\nDOCKER_GID=981\nENV_FILE=${envPath}\n`);
  });

  it.skipIf(process.platform === 'win32')('restricts the checkout env file to 0600 as well', () => {
    const envPath = writeEnv('.env.prod', `ROOT_FOLDER_HOST=${dir}\nPOSTGRES_PASSWORD=pg\n`, 0o644);

    initHubDataDirs();

    expect(modeOf(envPath)).toBe(0o600);
  });
});
