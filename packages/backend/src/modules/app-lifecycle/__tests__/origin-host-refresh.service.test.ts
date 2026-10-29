import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { ConfigurationService } from '@/core/config/configuration.service';
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
    const config = { getConfig: () => ({ localDomain: 'localhost' }) } as unknown as ConfigurationService;
    service = new OriginHostRefreshService(mock<LoggerService>(), config, registration, apps, files, lifecycle);
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

  it('does nothing on a Hub that is not paired', async () => {
    registration.getDeviceRegistrationInfo.mockResolvedValue(null as never);
    apps.getApps.mockResolvedValue([publicApp('wordpress')]);

    await expect(service.refreshStaleOriginHosts()).resolves.toEqual([]);
    expect(apps.getApps).not.toHaveBeenCalled();
  });
});
