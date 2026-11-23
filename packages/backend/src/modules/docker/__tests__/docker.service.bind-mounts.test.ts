import os from 'node:os';
import path from 'node:path';
import type { BindMountRef } from '@ci-hub/common/schemas';
import type { AppUrn } from '@ci-hub/common/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real folders and links, which the check walks with lstat.
vi.unmock('node:fs');
vi.unmock('fs');

const fs = (await import('node:fs')).default;
const { DockerService } = await import('../docker.service');
type DockerService = InstanceType<typeof DockerService>;

const HOST = '/host/hub/app-data/ci-marketplace/web';
const APP = 'web:ci-marketplace' as AppUrn;

/**
 * `assertBindMountsSafe` with only what it reads stood in: the mounts Compose resolves per app, where
 * the app's data folder is on the host and in the Hub, and the installed apps.
 */
function guardFor(mountsByApp: Record<string, BindMountRef[]>, appDataDir: string, installed: { appName: string; appStoreSlug: string }[] = []) {
  const service = Object.create(DockerService.prototype) as DockerService & Record<string, unknown>;
  service.appFilesManager = { getAppPaths: () => ({ appDataDir, appInstalledDir: '/unused' }) };
  service.appsRepository = { getApps: vi.fn().mockResolvedValue(installed) };
  vi.spyOn(service, 'readAppBindMounts').mockImplementation(async (urn: AppUrn) => {
    const mounts = mountsByApp[urn];
    if (!mounts) {
      throw new Error(`no compose for ${urn}`);
    }
    return mounts;
  });
  (service as unknown as { hostAppDataDirOf: () => string }).hostAppDataDirOf = () => HOST;
  return service;
}

const rw = (service: string, source: string): BindMountRef => ({ service, source, readOnly: false });
const ro = (service: string, source: string): BindMountRef => ({ service, source, readOnly: true });

describe('DockerService.assertBindMountsSafe', () => {
  let appDataDir: string;
  beforeEach(() => {
    appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bind-mounts-'));
  });
  afterEach(() => {
    fs.rmSync(appDataDir, { recursive: true, force: true });
  });

  it('starts an app whose mounts sit side by side', async () => {
    fs.mkdirSync(path.join(appDataDir, 'data', 'app'), { recursive: true });
    const guard = guardFor({ [APP]: [rw('web', `${HOST}/data/app`), rw('db', `${HOST}/data/db`), ro('web', '/etc/localtime')] }, appDataDir);
    await expect(guard.assertBindMountsSafe(APP)).resolves.toBeUndefined();
  });

  it('refuses a folder inside another the app can write to, as Compose resolved it', async () => {
    const guard = guardFor({ [APP]: [rw('web', `${HOST}/data`), rw('db', `${HOST}/data/db`)] }, appDataDir);
    await expect(guard.assertBindMountsSafe(APP)).rejects.toThrow(
      /"web" mounts a folder inside another folder it can write to: ".*\/data\/db" \(db\) is inside/,
    );
  });

  it('refuses a mount that runs through a link in the data folder, and names it', async () => {
    fs.mkdirSync(path.join(appDataDir, 'data'));
    fs.symlinkSync('/', path.join(appDataDir, 'data', 'db'));
    const guard = guardFor({ [APP]: [rw('db', `${HOST}/data/db`)] }, appDataDir);
    await expect(guard.assertBindMountsSafe(APP)).rejects.toThrow(/"data\/db" in its data folder is a symbolic link/);
  });

  it('refuses an operator folder inside one another app can write to, either way round', async () => {
    const installed = [
      { appName: 'web', appStoreSlug: 'ci-marketplace' },
      { appName: 'sonarr', appStoreSlug: '_user' },
    ];
    const inner = guardFor({ [APP]: [ro('web', '/srv/media/tv')], 'sonarr:_user': [rw('sonarr', '/srv/media')] }, appDataDir, installed);
    await expect(inner.assertBindMountsSafe(APP)).rejects.toThrow(
      /overlaps one another app can write to: "\/srv\/media\/tv" \(web\/web\) is inside "\/srv\/media", which sonarr\/sonarr/,
    );

    const outer = guardFor({ [APP]: [rw('web', '/srv/media')], 'sonarr:_user': [ro('sonarr', '/srv/media/tv')] }, appDataDir, installed);
    await expect(outer.assertBindMountsSafe(APP)).rejects.toThrow(/overlaps one another app can write to/);
  });

  it('lets two apps share the same folder, and leaves other apps alone when the app has no operator folders', async () => {
    const installed = [{ appName: 'sonarr', appStoreSlug: '_user' }];
    const shared = guardFor({ [APP]: [rw('web', '/srv/media')], 'sonarr:_user': [rw('sonarr', '/srv/media')] }, appDataDir, installed);
    await expect(shared.assertBindMountsSafe(APP)).resolves.toBeUndefined();

    const own = guardFor({ [APP]: [rw('web', `${HOST}/data`)] }, appDataDir, installed);
    await expect(own.assertBindMountsSafe(APP)).resolves.toBeUndefined();
    expect(own.readAppBindMounts).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than skips when another app's mounts can't be read", async () => {
    const guard = guardFor({ [APP]: [rw('web', '/srv/media')] }, appDataDir, [{ appName: 'broken', appStoreSlug: '_user' }]);
    await expect(guard.assertBindMountsSafe(APP)).rejects.toThrow(/mounts of "broken" could not be read/);
  });
});
