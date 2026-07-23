import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { type MockProxy, mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { EnvUtils } from '@/modules/env/env.utils';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { ForwardAuthSecretResolver } from '../forward-auth-secret.resolver';

/**
 * Per-app forward-auth signing resolution (CI-Engineering#74): /traefik must sign with the
 * secret the TARGET app's own app.env holds, resolved from X-Forwarded-Host, falling back
 * to the Hub-global secret for unknown hosts or unprovisioned apps.
 */
describe('ForwardAuthSecretResolver', () => {
  let resolver: ForwardAuthSecretResolver;
  let appsRepository: MockProxy<AppsRepository>;
  let appFilesManager: MockProxy<AppFilesManager>;
  let deviceRegistration: MockProxy<DeviceRegistrationRepository>;
  let config: MockProxy<ConfigurationService>;
  let logger: MockProxy<LoggerService>;
  let envUtils: EnvUtils;

  const appRow = (over: Record<string, unknown> = {}) =>
    fromPartial<Awaited<ReturnType<AppsRepository['getApps']>>[number]>({
      appName: 'importer',
      appStoreSlug: 'ci-marketplace',
      localSubdomain: null,
      publicDomain: null,
      domain: null,
      ...over,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    appsRepository = mock<AppsRepository>();
    appFilesManager = mock<AppFilesManager>();
    deviceRegistration = mock<DeviceRegistrationRepository>();
    config = mock<ConfigurationService>();
    logger = mock<LoggerService>();
    envUtils = new EnvUtils(); // real parser — the resolver only uses envStringToMap

    config.get.mockImplementation((key: string) => (key === 'forwardAuthSecret' ? 'global-secret' : undefined) as never);
    config.getConfig.mockReturnValue(fromPartial({ localDomain: 'ci.lan', domain: 'example.com', userSettings: {} }));
    deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(fromPartial({ hubSubdomain: 'dev-org', slug: 'org' }));
    appsRepository.getApps.mockResolvedValue([appRow()]);
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: 'CI_HUB_FORWARD_AUTH_SECRET=per-app-secret\n' });

    resolver = new ForwardAuthSecretResolver(appsRepository, appFilesManager, deviceRegistration, envUtils, config, logger);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Default fixture origin server name: appSubdomain 'importer-ci-marketplace', org slug 'org',
  // hubSubdomain 'dev-org' → fqdn 'importer-ci-marketplace-dev-org' … actual value asserted loosely
  // via a helper that just resolves and checks the source.
  const resolveVia = async (host: string) => resolver.resolveForHost(host);

  it("resolves a matched app's secret from its own app.env (rewritten .ci.lan origin host)", async () => {
    // The cloudflare tunnel rewrites Host to the origin server name under localDomain —
    // this is the host Traefik matches and forwards (#75 caveat: it identifies the app,
    // never the caller's locality).
    const result = await resolveVia('importer-ci-marketplace-dev-org.ci.lan');
    expect(result).toEqual({ secret: 'per-app-secret', appUrn: 'importer:ci-marketplace', source: 'app-env' });
  });

  it('matches case-insensitively and strips a port', async () => {
    const result = await resolveVia('Importer-CI-Marketplace-dev-org.CI.LAN:8443');
    expect(result.source).toBe('app-env');
  });

  it('matches the public identity hostname as well', async () => {
    const result = await resolveVia('importer-ci-marketplace-dev-org.example.com');
    expect(result.source).toBe('app-env');
  });

  it('matches an operator-entered custom domain', async () => {
    appsRepository.getApps.mockResolvedValue([appRow({ domain: 'files.example.net' })]);
    const result = await resolveVia('files.example.net');
    expect(result.source).toBe('app-env');
  });

  it('honors a custom localSubdomain over the default <app>-<store> shape', async () => {
    appsRepository.getApps.mockResolvedValue([appRow({ localSubdomain: 'files' })]);
    const result = await resolveVia('files-dev-org.ci.lan');
    expect(result.source).toBe('app-env');
  });

  it('falls back to the global secret for an unknown host and for a missing host', async () => {
    expect(await resolveVia('unknown.example.com')).toEqual({ secret: 'global-secret', source: 'global' });
    expect(await resolver.resolveForHost(undefined)).toEqual({ secret: 'global-secret', source: 'global' });
  });

  it('falls back to the global secret (warning once, not per request) for a matched app with no provisioned secret', async () => {
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: '' });
    const host = 'importer-ci-marketplace-dev-org.ci.lan';

    const first = await resolveVia(host);
    expect(first).toEqual({ secret: 'global-secret', appUrn: 'importer:ci-marketplace', source: 'global' });
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Second resolution (cache expired so the lookup re-runs) must not warn again.
    vi.advanceTimersByTime(31_000);
    await resolveVia(host);
    // One rebuild clears the warned set, so at most one additional warn per rebuild —
    // never one per request. (Same tick ⇒ same rebuild ⇒ deduped.)
    const warns = logger.warn.mock.calls.filter(([msg]) => String(msg).includes('no forward-auth secret'));
    expect(warns.length).toBeLessThanOrEqual(2);
  });

  it('does not cache the unmatched-host fallback, so a newly installed app resolves at the next map rebuild', async () => {
    const host = 'importer-ci-marketplace-dev-org.ci.lan';
    appsRepository.getApps.mockResolvedValue([]); // app not installed yet
    expect(await resolveVia(host)).toEqual({ secret: 'global-secret', source: 'global' });

    // The app lands. Once the host map's TTL lapses the rebuild picks it up — the earlier
    // global fallback must not be pinned for a second TTL on top of the map's.
    appsRepository.getApps.mockResolvedValue([appRow()]);
    vi.advanceTimersByTime(31_000);
    expect(await resolveVia(host)).toEqual({ secret: 'per-app-secret', appUrn: 'importer:ci-marketplace', source: 'app-env' });
  });

  it('caches resolutions for the TTL window (no repo re-query per request)', async () => {
    const host = 'importer-ci-marketplace-dev-org.ci.lan';
    await resolveVia(host);
    await resolveVia(host);
    await resolveVia(host);
    expect(appsRepository.getApps).toHaveBeenCalledTimes(1);
    expect(appFilesManager.getAppEnv).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31_000);
    await resolveVia(host);
    expect(appsRepository.getApps).toHaveBeenCalledTimes(2);
  });

  it('never throws: a repository failure degrades to the global secret', async () => {
    appsRepository.getApps.mockRejectedValue(new Error('db down'));
    const result = await resolveVia('importer-ci-marketplace-dev-org.ci.lan');
    expect(result).toEqual({ secret: 'global-secret', source: 'global' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('handles an org-less appliance (no registration): <sub>.<localDomain> hosts', async () => {
    deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(undefined as never);
    const result = await resolveVia('importer-ci-marketplace.ci.lan');
    expect(result.source).toBe('app-env');
  });
});
