import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@ci-hub/common/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import type { ConfigurationService } from '@/core/config/configuration.service';
import type { AppStatus } from '@/core/database/drizzle/types';
import type { LoggerService } from '@/core/logger/logger.service';
import { ForwardAuthSecretResolver } from '@/modules/auth/forward-auth-secret.resolver';
import type { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import type { AppFilesManager } from '../app-files-manager';
import { AppStartingPageService } from '../app-starting-page.service';
import type { AppsRepository } from '../apps.repository';

const HUB_STARTED = Date.parse('2026-10-01T08:00:00Z');
const NOW = Date.parse('2026-10-01T12:00:00Z');
const HERMES = 'ci-hermes:ci-marketplace' as AppUrn;
const HERMES_HOST = 'ci-hermes-hub1-acme.ci.lan';

/** Postgres's zoneless form of a UTC instant, as `getAppStatusByUrn` returns `updated_at`. */
const pgTimestamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

describe('AppStartingPageService', () => {
  let apps: MockProxy<AppsRepository>;
  let files: MockProxy<AppFilesManager>;
  let registrations: MockProxy<DeviceRegistrationRepository>;
  let resolver: MockProxy<ForwardAuthSecretResolver>;
  let moduleRef: MockProxy<ModuleRef>;
  let service: AppStartingPageService;

  const row = (status: AppStatus, updatedAtMs = NOW - 60 * 60_000) => ({ status, updatedAt: pgTimestamp(updatedAtMs) });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(HUB_STARTED);

    apps = mock<AppsRepository>();
    files = mock<AppFilesManager>();
    registrations = mock<DeviceRegistrationRepository>();
    resolver = mock<ForwardAuthSecretResolver>();
    moduleRef = mock<ModuleRef>();
    const config = mock<ConfigurationService>();

    moduleRef.get.mockImplementation(((token: unknown) => {
      if (token === ForwardAuthSecretResolver) return resolver;
      throw new Error(`unexpected token ${String(token)}`);
    }) as never);
    resolver.resolveAppUrnForHost.mockImplementation(async (host) => (host === HERMES_HOST ? HERMES : null));
    apps.getAppStatusByUrn.mockResolvedValue(row('running'));
    files.getInstalledAppInfo.mockResolvedValue({ name: 'Hermes' } as never);
    registrations.getFirstDeviceRegistration.mockResolvedValue({ hubSubdomain: 'hub1-acme', slug: 'acme' } as never);
    config.getConfig.mockReturnValue({ domain: 'ci0.pw', userSettings: {} } as never);

    // Constructed at "boot", four hours before the requests below.
    service = new AppStartingPageService(apps, files, registrations, config, moduleRef, mock<LoggerService>());
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks the app up by the Host Traefik passes through, and links to its page in the Hub', async () => {
    apps.getAppStatusByUrn.mockResolvedValue(row('starting'));

    await expect(service.describe(HERMES_HOST)).resolves.toEqual({
      state: 'starting',
      appName: 'Hermes',
      hubUrl: 'https://hub1-acme.ci0.pw/apps/ci-marketplace/ci-hermes',
    });
    expect(resolver.resolveAppUrnForHost).toHaveBeenCalledWith(HERMES_HOST);
    expect(apps.getAppStatusByUrn).toHaveBeenCalledWith(HERMES);
  });

  it('says a running app that was started a minute ago is starting', async () => {
    apps.getAppStatusByUrn.mockResolvedValue(row('running', NOW - 60_000));

    await expect(service.describe(HERMES_HOST)).resolves.toMatchObject({ state: 'starting', appName: 'Hermes' });
  });

  it("says a running app that was started an hour ago isn't responding", async () => {
    await expect(service.describe(HERMES_HOST)).resolves.toMatchObject({ state: 'not_responding', appName: 'Hermes' });
  });

  it('says a stopped app is stopped', async () => {
    apps.getAppStatusByUrn.mockResolvedValue(row('stopped'));

    await expect(service.describe(HERMES_HOST)).resolves.toMatchObject({ state: 'stopped', appName: 'Hermes' });
  });

  it('reads every running app as starting in the first minutes after the Hub itself starts', async () => {
    vi.setSystemTime(HUB_STARTED + 30_000);

    await expect(service.describe(HERMES_HOST)).resolves.toMatchObject({ state: 'starting' });
  });

  it('never calls a port-expose app "starting": the Hub does not start it', async () => {
    const mine = 'my-service:_user' as AppUrn;
    resolver.resolveAppUrnForHost.mockResolvedValue(mine);
    apps.getAppStatusByUrn.mockResolvedValue(row('running', NOW - 10_000));
    files.getInstalledAppInfo.mockResolvedValue({ name: 'My service', kind: 'port-expose' } as never);

    await expect(service.describe('my-service-hub1-acme.ci.lan')).resolves.toEqual({
      state: 'not_responding',
      appName: 'My service',
      // Custom apps live at /apps/<name> in the Hub's frontend.
      hubUrl: 'https://hub1-acme.ci0.pw/apps/my-service',
    });
  });

  it('gives a host that matches no app the generic page, linked to the Hub itself', async () => {
    await expect(service.describe('nothing-here.ci.lan')).resolves.toEqual({ state: 'unknown', hubUrl: 'https://hub1-acme.ci0.pw' });
    await expect(service.describe(undefined)).resolves.toEqual({ state: 'unknown', hubUrl: 'https://hub1-acme.ci0.pw' });
    expect(apps.getAppStatusByUrn).not.toHaveBeenCalled();
  });

  it('gives an app whose row is gone the generic page', async () => {
    apps.getAppStatusByUrn.mockResolvedValue(null);

    await expect(service.describe(HERMES_HOST)).resolves.toEqual({ state: 'unknown', hubUrl: 'https://hub1-acme.ci0.pw' });
  });

  it('names an app whose files cannot be read by its id', async () => {
    files.getInstalledAppInfo.mockResolvedValue(null);

    await expect(service.describe(HERMES_HOST)).resolves.toMatchObject({ appName: 'ci-hermes' });
  });

  it('links nowhere on a Hub with no public address', async () => {
    registrations.getFirstDeviceRegistration.mockResolvedValue(null);

    await expect(service.describe(HERMES_HOST)).resolves.toEqual({ state: 'not_responding', appName: 'Hermes', hubUrl: null });
  });

  it('falls back to the generic page rather than failing when the app lookup throws', async () => {
    apps.getAppStatusByUrn.mockRejectedValue(new Error('connection terminated'));

    await expect(service.describe(HERMES_HOST)).resolves.toEqual({ state: 'unknown', hubUrl: 'https://hub1-acme.ci0.pw' });

    resolver.resolveAppUrnForHost.mockRejectedValue(new Error('host map unavailable'));
    await expect(service.describe(HERMES_HOST)).resolves.toEqual({ state: 'unknown', hubUrl: 'https://hub1-acme.ci0.pw' });
  });

  it('loses only the button when the Hub address cannot be read', async () => {
    registrations.getFirstDeviceRegistration.mockRejectedValue(new Error('connection terminated'));
    apps.getAppStatusByUrn.mockResolvedValue(row('stopped'));

    await expect(service.describe(HERMES_HOST)).resolves.toEqual({ state: 'stopped', appName: 'Hermes', hubUrl: null });
  });

  it('reads the status on every request, but the name and the Hub address once a minute', async () => {
    await service.describe(HERMES_HOST);
    apps.getAppStatusByUrn.mockResolvedValue(row('stopped'));
    await expect(service.describe(HERMES_HOST)).resolves.toMatchObject({ state: 'stopped' });

    expect(apps.getAppStatusByUrn).toHaveBeenCalledTimes(2);
    expect(files.getInstalledAppInfo).toHaveBeenCalledTimes(1);
    expect(registrations.getFirstDeviceRegistration).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 61_000);
    await service.describe(HERMES_HOST);
    expect(files.getInstalledAppInfo).toHaveBeenCalledTimes(2);
    expect(registrations.getFirstDeviceRegistration).toHaveBeenCalledTimes(2);
  });
});
