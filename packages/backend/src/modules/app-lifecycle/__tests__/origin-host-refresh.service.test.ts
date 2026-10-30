import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import type { AppFilesManager } from '@/modules/apps/app-files-manager';
import type { AppsRepository } from '@/modules/apps/apps.repository';
import type { RegistrationService } from '@/modules/registration/registration.service';
import type { AppLifecycleService } from '../app-lifecycle.service';
import { OriginHostRefreshService } from '../origin-host-refresh.service';

type AppRow = Awaited<ReturnType<AppsRepository['getApps']>>[number];

/** A Public Web app as the install form stores it. */
const publicApp = (appName: string, status = 'running', extra: Partial<AppRow> = {}) =>
  ({
    appName,
    appStoreSlug: 'ci-marketplace',
    status,
    localSubdomain: null,
    config: { exposureMode: 'cloudflare', exposedLocal: true },
    ...extra,
  }) as unknown as AppRow;

const composeFor = (host: string) => `services:\n  app:\n    labels:\n      traefik.http.routers.app.rule: Host(\`${host}\`)\n`;

describe('OriginHostRefreshService', () => {
  let registration: MockProxy<RegistrationService>;
  let apps: MockProxy<AppsRepository>;
  let files: MockProxy<AppFilesManager>;
  let lifecycle: MockProxy<AppLifecycleService>;
  let composes: Record<string, string | null>;
  let service: OriginHostRefreshService;

  beforeEach(() => {
    registration = mock<RegistrationService>();
    registration.getDeviceRegistrationInfo.mockResolvedValue({ hubSubdomain: 'office-acme', slug: 'acme' } as never);
    apps = mock<AppsRepository>();
    files = mock<AppFilesManager>();
    composes = {};
    files.getDockerComposeYaml.mockImplementation((async (appUrn: string) => ({ path: '', content: composes[appUrn] ?? null })) as never);
    lifecycle = mock<AppLifecycleService>();
    lifecycle.restartApp.mockResolvedValue({ requestId: 'r' } as never);
    service = new OriginHostRefreshService(mock<LoggerService>(), registration, apps, files, lifecycle);
  });

  it('restarts a running Public Web app whose router still names the old device', async () => {
    apps.getApps.mockResolvedValue([publicApp('wordpress')]);
    composes['wordpress:ci-marketplace'] = composeFor('wordpress-ci-marketplace-laptop-acme.localhost');

    await expect(service.refreshStaleOriginHosts()).resolves.toEqual(['wordpress:ci-marketplace']);

    expect(lifecycle.restartApp).toHaveBeenCalledWith({
      appUrn: 'wordpress:ci-marketplace',
      skipPull: true,
      actor: { kind: 'system', reason: 'origin-host-refresh' },
    });
  });

  it('leaves an app whose router already names the current device', async () => {
    apps.getApps.mockResolvedValue([publicApp('wordpress')]);
    composes['wordpress:ci-marketplace'] = composeFor('wordpress-ci-marketplace-office-acme.localhost');

    await expect(service.refreshStaleOriginHosts()).resolves.toEqual([]);
    expect(lifecycle.restartApp).not.toHaveBeenCalled();
  });

  it('leaves an app routed under the current device on another local domain, which a restart would not change', async () => {
    // The compose file takes its local domain from the app's env first, so it can differ from the Hub setting.
    apps.getApps.mockResolvedValue([publicApp('wordpress')]);
    composes['wordpress:ci-marketplace'] = composeFor('wordpress-ci-marketplace-office-acme.ci.lan');

    await expect(service.refreshStaleOriginHosts()).resolves.toEqual([]);
    expect(lifecycle.restartApp).not.toHaveBeenCalled();
  });

  it('restarts an app whose rule only starts with the current name', async () => {
    apps.getApps.mockResolvedValue([publicApp('wordpress')]);
    composes['wordpress:ci-marketplace'] = composeFor('wordpress-ci-marketplace-office-acme2.localhost');
    registration.getDeviceRegistrationInfo.mockResolvedValue({ hubSubdomain: 'office-acme', slug: 'acme' } as never);

    await expect(service.refreshStaleOriginHosts()).resolves.toEqual(['wordpress:ci-marketplace']);
  });

  it('leaves stopped apps, apps without a public route, apps just restarted for another reason and apps with no compose file', async () => {
    apps.getApps.mockResolvedValue([
      publicApp('stopped', 'stopped'),
      publicApp('local-only', 'running', { config: { exposureMode: 'local', exposedLocal: true } } as never),
      publicApp('ci-memory'),
      publicApp('no-compose'),
    ]);
    for (const name of ['stopped', 'local-only', 'ci-memory']) {
      composes[`${name}:ci-marketplace`] = composeFor(`${name}-ci-marketplace-laptop-acme.localhost`);
    }

    await expect(service.refreshStaleOriginHosts(['ci-memory:ci-marketplace' as never])).resolves.toEqual([]);
    expect(lifecycle.restartApp).not.toHaveBeenCalled();
  });

  it('restarts an app once per name, and tries again when the restart could not be queued', async () => {
    apps.getApps.mockResolvedValue([publicApp('wordpress')]);
    composes['wordpress:ci-marketplace'] = composeFor('wordpress-ci-marketplace-laptop-acme.localhost');
    lifecycle.restartApp.mockRejectedValueOnce(new Error('busy'));

    await expect(service.refreshStaleOriginHosts()).resolves.toEqual([]);
    await expect(service.refreshStaleOriginHosts()).resolves.toEqual(['wordpress:ci-marketplace']);
    // Queued now, and its compose file still reads stale until the restart runs: not queued twice.
    await expect(service.refreshStaleOriginHosts()).resolves.toEqual([]);
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(2);
  });

  it('moves an app again when the Hub returns to a name it had earlier', async () => {
    apps.getApps.mockResolvedValue([publicApp('wordpress')]);
    const pairAs = async (device: string, routedAs: string) => {
      registration.getDeviceRegistrationInfo.mockResolvedValue({ hubSubdomain: `${device}-acme`, slug: 'acme' } as never);
      composes['wordpress:ci-marketplace'] = composeFor(`wordpress-ci-marketplace-${routedAs}-acme.localhost`);
      return service.refreshStaleOriginHosts();
    };

    await expect(pairAs('office', 'laptop')).resolves.toEqual(['wordpress:ci-marketplace']);
    await expect(pairAs('laptop', 'office')).resolves.toEqual(['wordpress:ci-marketplace']);
    await expect(pairAs('office', 'laptop')).resolves.toEqual(['wordpress:ci-marketplace']);
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(3);
  });

  it('leaves exposed ports, which the file provider routes, and apps whose compose file has no router', async () => {
    apps.getApps.mockResolvedValue([
      publicApp('my-port', 'running', { config: { kind: 'port-expose', exposureMode: 'cloudflare', exposedLocal: true } } as never),
      publicApp('no-port'),
    ]);
    composes['my-port:ci-marketplace'] = '{"schemaVersion":2,"services":[]}';
    composes['no-port:ci-marketplace'] = 'services:\n  app:\n    image: example\n';

    await expect(service.refreshStaleOriginHosts()).resolves.toEqual([]);
    expect(lifecycle.restartApp).not.toHaveBeenCalled();
  });

  it('runs one pass at a time, so two callers do not restart the same app twice', async () => {
    apps.getApps.mockResolvedValue([publicApp('wordpress')]);
    composes['wordpress:ci-marketplace'] = composeFor('wordpress-ci-marketplace-laptop-acme.localhost');

    const [first, second] = await Promise.all([service.refreshStaleOriginHosts(), service.refreshStaleOriginHosts()]);

    expect([first, second]).toEqual([['wordpress:ci-marketplace'], []]);
    expect(lifecycle.restartApp).toHaveBeenCalledTimes(1);
  });

  it('remembers a refused restart for a later pass, which looks only at refused apps, and gives up after a few tries', async () => {
    apps.getApps.mockResolvedValue([publicApp('wordpress'), publicApp('ghost')]);
    composes['wordpress:ci-marketplace'] = composeFor('wordpress-ci-marketplace-laptop-acme.localhost');
    composes['ghost:ci-marketplace'] = composeFor('ghost-ci-marketplace-laptop-acme.localhost');
    lifecycle.restartApp.mockImplementation((async ({ appUrn }: { appUrn: string }) => {
      if (appUrn === 'wordpress:ci-marketplace') {
        throw new Error('restart still under way');
      }
      return { requestId: 'r' };
    }) as never);

    await expect(service.refreshStaleOriginHosts()).resolves.toEqual(['ghost:ci-marketplace']);
    expect(service.hasRefusedRestarts()).toBe(true);

    for (let pass = 2; pass < OriginHostRefreshService.MAX_ATTEMPTS; pass += 1) {
      await service.refreshStaleOriginHosts([], { onlyRefused: true });
      expect(service.hasRefusedRestarts()).toBe(true);
    }
    await service.refreshStaleOriginHosts([], { onlyRefused: true });
    expect(service.hasRefusedRestarts()).toBe(false);

    const tried = lifecycle.restartApp.mock.calls.map(([params]) => params.appUrn);
    expect(tried.filter((urn) => urn === 'wordpress:ci-marketplace')).toHaveLength(OriginHostRefreshService.MAX_ATTEMPTS);
    expect(tried.filter((urn) => urn === 'ghost:ci-marketplace')).toHaveLength(1);
  });

  it('does nothing on a Hub that is not paired', async () => {
    registration.getDeviceRegistrationInfo.mockResolvedValue(null as never);
    apps.getApps.mockResolvedValue([publicApp('wordpress')]);

    await expect(service.refreshStaleOriginHosts()).resolves.toEqual([]);
    expect(apps.getApps).not.toHaveBeenCalled();
  });
});
