import { vol } from 'memfs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRehydrationPlan,
  buildRestoreInstallForm,
  defaultLocalSubdomain,
  filterLocalEntriesForPortalUrns,
  resolvePortalAppToUrn,
  scanLocalAppData,
  slugMatchesPortalApp,
  type PortalDeviceApplication,
} from '../app-rehydration';

describe('app-rehydration', () => {
  afterEach(() => {
    vol.reset();
  });

  it('scanLocalAppData discovers data and app.env folders', () => {
    vol.fromJSON({
      '/app-data/official/nextcloud/data/.keep': '',
      '/app-data/official/immich/app.env': 'DEVICE_ID=abc',
    });

    const entries = scanLocalAppData('/app-data');
    expect(entries).toHaveLength(2);

    const nextcloud = entries.find((entry) => entry.appName === 'nextcloud');
    expect(nextcloud).toMatchObject({ storeId: 'official', hasDataDir: true, hasAppEnv: false });

    const immich = entries.find((entry) => entry.appName === 'immich');
    expect(immich).toMatchObject({ storeId: 'official', hasDataDir: false, hasAppEnv: true });
  });

  it('slugMatchesPortalApp accepts bare name and store-suffixed subdomain', () => {
    expect(slugMatchesPortalApp('nextcloud', 'nextcloud', 'official')).toBe(true);
    expect(slugMatchesPortalApp('nextcloud-official', 'nextcloud', 'official')).toBe(true);
    expect(defaultLocalSubdomain('nextcloud', 'official')).toBe('nextcloud-official');
    expect(slugMatchesPortalApp('other', 'nextcloud', 'official')).toBe(false);
  });

  it('resolvePortalAppToUrn prefers store with existing data volume', () => {
    const portalApp: PortalDeviceApplication = {
      id: '1',
      name: 'nextcloud',
      slug: 'nextcloud-official',
      port: 8080,
      publicDomain: null,
    };
    const localEntries = [
      { storeId: 'community', appName: 'nextcloud', hasDataDir: false, hasAppEnv: false },
      { storeId: 'official', appName: 'nextcloud', hasDataDir: true, hasAppEnv: true },
    ];

    expect(resolvePortalAppToUrn(portalApp, ['community', 'official'], localEntries)).toBe('nextcloud:official');
  });

  it('returns null when slug and local data provide no store match', () => {
    expect(resolvePortalAppToUrn({ id: '1', name: 'foo', slug: 'foo-unknown', port: 8080, publicDomain: null }, ['official'], [])).toBeNull();
  });

  it('buildRestoreInstallForm maps cloudflare vs local exposure', () => {
    const localForm = buildRestoreInstallForm({
      id: '1',
      name: 'app',
      slug: 'app-official',
      port: 9000,
      publicDomain: null,
    });
    expect(localForm).toMatchObject({
      localSubdomain: 'app-official',
      exposureMode: 'local',
      exposedLocal: false,
      openPort: true,
    });

    const publicForm = buildRestoreInstallForm({
      id: '2',
      name: 'app',
      slug: 'app-official',
      port: 9000,
      publicDomain: 'app.example.com',
    });
    expect(publicForm).toMatchObject({
      publicDomain: 'app.example.com',
      exposureMode: 'cloudflare',
      exposedLocal: true,
      openPort: false,
    });
  });

  it('returns null when slug does not match even if local data exists', () => {
    const localEntries = [{ storeId: 'official', appName: 'nextcloud', hasDataDir: true, hasAppEnv: true }];

    expect(
      resolvePortalAppToUrn(
        { id: '1', name: 'nextcloud', slug: 'nextcloud-wrong-store', port: 8080, publicDomain: null },
        ['official'],
        localEntries,
      ),
    ).toBeNull();
  });

  it('filterLocalEntriesForPortalUrns keeps only Portal-listed app folders', () => {
    const localEntries = [
      { storeId: 'official', appName: 'plane', hasDataDir: true, hasAppEnv: false },
      { storeId: 'official', appName: 'immich', hasDataDir: true, hasAppEnv: false },
      { storeId: 'official', appName: 'nextcloud', hasDataDir: true, hasAppEnv: true },
    ];

    const filtered = filterLocalEntriesForPortalUrns(localEntries, new Set(['nextcloud:official']));

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.appName).toBe('nextcloud');
  });

  it('buildRehydrationPlan only queues Portal apps, not every local volume', () => {
    const portalApps: PortalDeviceApplication[] = [{ id: '1', name: 'plane', slug: 'plane-official', port: 8080, publicDomain: null }];

    const plan = buildRehydrationPlan({
      portalApps,
      storeSlugs: ['official'],
      localEntries: [
        { storeId: 'official', appName: 'plane', hasDataDir: true, hasAppEnv: false },
        { storeId: 'official', appName: 'immich', hasDataDir: true, hasAppEnv: false },
        { storeId: 'official', appName: 'nextcloud', hasDataDir: true, hasAppEnv: true },
        { storeId: 'community', appName: 'vaultwarden', hasDataDir: true, hasAppEnv: false },
      ],
      installedComposeUrns: new Set(),
      dbAppsByUrn: new Map(),
    });

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.portalApp.name).toBe('plane');
    expect(plan.items[0]?.action).toBe('install');
    expect(plan.localAppDataCount).toBe(1);
  });

  it('buildRehydrationPlan queues install, start, and skip actions', () => {
    const portalApps: PortalDeviceApplication[] = [
      { id: '1', name: 'fresh', slug: 'fresh-official', port: 8080, publicDomain: null },
      { id: '2', name: 'stopped', slug: 'stopped-official', port: 8081, publicDomain: null },
      { id: '3', name: 'running', slug: 'running-official', port: 8082, publicDomain: null },
      { id: '4', name: 'missing', slug: 'missing-wrong-store', port: 8083, publicDomain: null },
    ];

    const plan = buildRehydrationPlan({
      portalApps,
      storeSlugs: ['official'],
      localEntries: [{ storeId: 'official', appName: 'fresh', hasDataDir: true, hasAppEnv: false }],
      installedComposeUrns: new Set(['stopped:official']),
      dbAppsByUrn: new Map([
        ['stopped:official', { status: 'stopped' }],
        ['running:official', { status: 'running' }],
      ]),
    });

    const byName = Object.fromEntries(plan.items.map((item) => [item.portalApp.name, item.action]));
    expect(byName.fresh).toBe('install');
    expect(byName.stopped).toBe('start');
    expect(byName.running).toBe('skip_running');
    expect(byName.missing).toBe('skip_unresolved');
    expect(plan.items.find((item) => item.portalApp.name === 'fresh')?.hasExistingData).toBe(true);
  });
});
