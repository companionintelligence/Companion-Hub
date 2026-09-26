import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatPublicWebStatusTable,
  PUBLIC_WEB_REPAIR_FAIL_PREFIX,
  PUBLIC_WEB_REPAIR_OK_PREFIX,
  publicWebRepairHasFailures,
  readHubApiKeySource,
  resolveHubApiBase,
} from '../public-web-cli';

describe('publicWebRepairHasFailures', () => {
  it('detects failed repair lines by the ✗ prefix', () => {
    expect(publicWebRepairHasFailures([`${PUBLIC_WEB_REPAIR_OK_PREFIX} app:store \u2192 host.example.com`])).toBe(false);
    expect(publicWebRepairHasFailures([`${PUBLIC_WEB_REPAIR_FAIL_PREFIX} app:store: repair failed`])).toBe(true);
  });

  it('does not treat unrelated lines starting with ? as failures', () => {
    expect(publicWebRepairHasFailures(['? corrupted prefix line'])).toBe(false);
  });
});

describe('formatPublicWebStatusTable', () => {
  it('renders table rows for diagnostics', () => {
    const lines = formatPublicWebStatusTable({
      mismatchCount: 1,
      apps: [
        {
          appUrn: 'nextcloud:store',
          appName: 'nextcloud',
          status: 'running',
          dbPublicDomain: 'example.com',
          computedHostname: 'nextcloud-dev1-myorg.example.com',
          computedPublicUrl: 'https://nextcloud-dev1-myorg.example.com',
          envHostname: 'nextcloud-wrong.example.com',
          envMismatch: true,
          action: 'repair',
        },
      ],
    });

    expect(lines.some((line) => line.includes('nextcloud'))).toBe(true);
    expect(lines.some((line) => line.includes('mismatch'))).toBe(true);
    expect(lines.some((line) => line.includes('need repair'))).toBe(true);
  });

  it('returns empty message when no apps', () => {
    const lines = formatPublicWebStatusTable({ apps: [], mismatchCount: 0 });
    expect(lines).toEqual(['No cloudflare-exposed apps found.']);
  });
});

describe('resolveHubApiBase', () => {
  const tmpRoot = join(process.cwd(), '.tmp-public-web-cli-test');

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.API_PORT;
  });

  it('prefers API_PORT from the env file over process.env', () => {
    mkdirSync(tmpRoot, { recursive: true });
    const envFile = join(tmpRoot, '.env.dev');
    writeFileSync(envFile, 'API_PORT=5002\n');
    process.env.API_PORT = '9999';

    expect(resolveHubApiBase(envFile)).toBe('http://127.0.0.1:5002');
  });
});

/**
 * The key is read from one file, but which file depends on the install layout. Checking a
 * single path turned "I did not find it where I looked" into "this Hub is not paired" —
 * printed, with a `cihub register` prompt, on a node routing inference to three peers.
 */
describe('readHubApiKeySource', () => {
  let tmp: string;
  const originalDataDir = process.env.CI_HUB_DATA_DIR;
  const originalRoot = process.env.ROOT_FOLDER_HOST;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.CI_HUB_DATA_DIR;
    else process.env.CI_HUB_DATA_DIR = originalDataDir;
    if (originalRoot === undefined) delete process.env.ROOT_FOLDER_HOST;
    else process.env.ROOT_FOLDER_HOST = originalRoot;
  });

  function seedKey(dir: string, key: string) {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'settings.json'), JSON.stringify({ ciHubApiKey: key }));
  }

  it('finds the key in the canonical data dir when ROOT_FOLDER_HOST holds none', () => {
    tmp = mkdtempSync(join(tmpdir(), 'hubkey-'));
    const rootFolder = join(tmp, 'checkout', '.internal');
    const canonical = join(tmp, 'canonical');
    mkdirSync(join(rootFolder, 'state'), { recursive: true });
    seedKey(canonical, 'device-key-from-canonical');
    process.env.ROOT_FOLDER_HOST = rootFolder;
    process.env.CI_HUB_DATA_DIR = canonical;

    const source = readHubApiKeySource(join(tmp, 'missing.env'));

    expect(source.key).toBe('device-key-from-canonical');
    expect(source.found).toBe(join(canonical, 'state', 'settings.json'));
  });

  it('prefers the host-local key over the Portal device key in the same file', () => {
    // The Hub accepts the host-local key from the box; the device key only until Portal holds the
    // push key. A settings.json written by a current Hub carries both.
    const tmp = mkdtempSync(join(tmpdir(), 'cihub-key-'));
    const dir = join(tmp, 'root');
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'settings.json'), JSON.stringify({ ciHubApiKey: 'device-key', hubLocalKey: 'local-key' }));
    writeFileSync(join(tmp, 'hub.env'), `ROOT_FOLDER_HOST=${dir}\n`);

    expect(readHubApiKeySource(join(tmp, 'hub.env')).key).toBe('local-key');
  });

  it('prefers ROOT_FOLDER_HOST when it does hold a key', () => {
    tmp = mkdtempSync(join(tmpdir(), 'hubkey-'));
    const rootFolder = join(tmp, 'checkout', '.internal');
    const canonical = join(tmp, 'canonical');
    seedKey(rootFolder, 'device-key-from-root-folder');
    seedKey(canonical, 'device-key-from-canonical');
    process.env.ROOT_FOLDER_HOST = rootFolder;
    process.env.CI_HUB_DATA_DIR = canonical;

    expect(readHubApiKeySource(join(tmp, 'missing.env')).key).toBe('device-key-from-root-folder');
  });

  // The report has to name what was searched — a caller that only learns "no key" is the
  // caller that concluded the Hub was unpaired.
  it('reports every path it checked when no key is found', () => {
    tmp = mkdtempSync(join(tmpdir(), 'hubkey-'));
    const rootFolder = join(tmp, 'checkout', '.internal');
    const canonical = join(tmp, 'canonical');
    process.env.ROOT_FOLDER_HOST = rootFolder;
    process.env.CI_HUB_DATA_DIR = canonical;

    const source = readHubApiKeySource(join(tmp, 'missing.env'));

    expect(source.key).toBeUndefined();
    expect(source.found).toBeUndefined();
    expect(source.checked).toEqual([join(rootFolder, 'state', 'settings.json'), join(canonical, 'state', 'settings.json')]);
  });

  it('keeps looking past a settings.json that is malformed or has no key', () => {
    tmp = mkdtempSync(join(tmpdir(), 'hubkey-'));
    const rootFolder = join(tmp, 'checkout', '.internal');
    const canonical = join(tmp, 'canonical');
    mkdirSync(join(rootFolder, 'state'), { recursive: true });
    writeFileSync(join(rootFolder, 'state', 'settings.json'), '{ not json');
    seedKey(canonical, 'device-key-from-canonical');
    process.env.ROOT_FOLDER_HOST = rootFolder;
    process.env.CI_HUB_DATA_DIR = canonical;

    expect(readHubApiKeySource(join(tmp, 'missing.env')).key).toBe('device-key-from-canonical');
  });
});
