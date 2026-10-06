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
 * keys the TARGET app's own app.env holds, resolved from X-Forwarded-Host. An unknown host or
 * an app with no key gets no keys at all: the Hub-wide secret never stands in.
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
    // The app's own key signs the triple and its bound assertion, which names the app's URN.
    expect(result).toEqual({
      secret: 'per-app-secret',
      assertion: { secret: 'per-app-secret', audience: 'importer:ci-marketplace' },
      appUrn: 'importer:ci-marketplace',
      source: 'app-env',
    });
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

  it('signs nothing for an unknown host or a missing host', async () => {
    expect(await resolveVia('unknown.example.com')).toEqual({ secret: null, source: 'none' });
    expect(await resolver.resolveForHost(undefined)).toEqual({ secret: null, source: 'none' });
  });

  it('signs nothing for a matched app with no key, and never with the Hub-wide secret', async () => {
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: '' });
    const host = 'importer-ci-marketplace-dev-org.ci.lan';

    expect(await resolveVia(host)).toEqual({ secret: null, appUrn: 'importer:ci-marketplace', source: 'none' });
    // Ordinary for a third-party app, so not a warning, and noted once per rebuild rather than per request.
    expect(logger.warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_500);
    await resolveVia(host);
    const notes = logger.debug.mock.calls.filter(([msg]) => String(msg).includes('no forward-auth key'));
    expect(notes).toHaveLength(1);
  });

  it("does not sign another app with the Hub-wide secret even when that app's env holds it", async () => {
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: 'CI_HUB_FORWARD_AUTH_SECRET=global-secret\n' });

    expect(await resolveVia('importer-ci-marketplace-dev-org.ci.lan')).toEqual({
      secret: null,
      appUrn: 'importer:ci-marketplace',
      source: 'none',
    });
  });

  describe('Companion Memory', () => {
    const MEMORY_HOST = 'ci-memory-ci-marketplace-dev-org.ci.lan';

    beforeEach(() => {
      appsRepository.getApps.mockResolvedValue([appRow({ appName: 'ci-memory' })]);
    });

    it('signs the triple with the Hub-wide secret it holds, and the bound assertion with its own key', async () => {
      appFilesManager.getAppEnv.mockResolvedValue({
        path: '/x',
        content:
          'CI_HUB_FORWARD_AUTH_SECRET=global-secret\nCI_HUB_FORWARD_AUTH_IDENTITY_SECRET=memory-own-secret\nCI_APP_URN=ci-memory:ci-marketplace\n',
      });

      expect(await resolveVia(MEMORY_HOST)).toEqual({
        secret: 'global-secret',
        assertion: { secret: 'memory-own-secret', audience: 'ci-memory:ci-marketplace' },
        appUrn: 'ci-memory:ci-marketplace',
        source: 'app-env',
      });
    });

    it('signs the assertion with the identity key whenever the env has one, whatever the triple is signed with', async () => {
      appFilesManager.getAppEnv.mockResolvedValue({
        path: '/x',
        content: 'CI_HUB_FORWARD_AUTH_SECRET=some-other-secret\nCI_HUB_FORWARD_AUTH_IDENTITY_SECRET=memory-own-secret\n',
      });

      expect(await resolveVia(MEMORY_HOST)).toMatchObject({
        secret: 'some-other-secret',
        assertion: { secret: 'memory-own-secret', audience: 'ci-memory:ci-marketplace' },
      });
    });

    it('keeps signing the triple alone until its env carries its own key (an install from before the key)', async () => {
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: 'CI_HUB_FORWARD_AUTH_SECRET=global-secret\n' });

      expect(await resolveVia(MEMORY_HOST)).toEqual({
        secret: 'global-secret',
        appUrn: 'ci-memory:ci-marketplace',
        source: 'app-env',
      });
    });

    it('is told apart by install provenance: a ci-memory from another store gets no Hub-wide signature', async () => {
      appsRepository.getApps.mockResolvedValue([appRow({ appName: 'ci-memory', appStoreSlug: 'other-store' })]);
      appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: 'CI_HUB_FORWARD_AUTH_SECRET=global-secret\n' });

      expect(await resolveVia('ci-memory-other-store-dev-org.ci.lan')).toMatchObject({ secret: null, source: 'none' });
    });
  });

  it('does not cache the unmatched-host answer, so a newly installed app resolves at the next map rebuild', async () => {
    const host = 'importer-ci-marketplace-dev-org.ci.lan';
    appsRepository.getApps.mockResolvedValue([]); // app not installed yet
    expect(await resolveVia(host)).toEqual({ secret: null, source: 'none' });

    // The app lands. Once the host map's TTL lapses the rebuild picks it up — the earlier
    // unsigned answer must not be pinned for a second TTL on top of the map's.
    appsRepository.getApps.mockResolvedValue([appRow()]);
    vi.advanceTimersByTime(31_000);
    expect(await resolveVia(host)).toEqual({
      secret: 'per-app-secret',
      assertion: { secret: 'per-app-secret', audience: 'importer:ci-marketplace' },
      appUrn: 'importer:ci-marketplace',
      source: 'app-env',
    });
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

  it('never throws: a repository failure degrades to signing nothing', async () => {
    appsRepository.getApps.mockRejectedValue(new Error('db down'));
    const result = await resolveVia('importer-ci-marketplace-dev-org.ci.lan');
    expect(result).toEqual({ secret: null, source: 'none' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('handles an org-less appliance (no registration): <sub>.<localDomain> hosts', async () => {
    deviceRegistration.getFirstDeviceRegistration.mockResolvedValue(undefined as never);
    const result = await resolveVia('importer-ci-marketplace.ci.lan');
    expect(result.source).toBe('app-env');
  });

  it('caches the matched-but-keyless answer only BRIEFLY, so a landing secret is picked up in seconds not a full TTL', async () => {
    const host = 'importer-ci-marketplace-dev-org.ci.lan';
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: '' }); // secret not written yet
    expect((await resolveVia(host)).source).toBe('none');
    // A burst within the short window is served from cache (one env read, not one per request).
    expect((await resolveVia(host)).source).toBe('none');
    expect(appFilesManager.getAppEnv).toHaveBeenCalledTimes(1);

    // The secret lands. Past the short secretless TTL (2s) — but well before the 30s definitive TTL —
    // the next request re-reads and resolves it. It is NOT pinned to the keyless answer for 30s.
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: 'CI_HUB_FORWARD_AUTH_SECRET=per-app-secret\n' });
    vi.advanceTimersByTime(2_500);
    expect(await resolveVia(host)).toEqual({
      secret: 'per-app-secret',
      assertion: { secret: 'per-app-secret', audience: 'importer:ci-marketplace' },
      appUrn: 'importer:ci-marketplace',
      source: 'app-env',
    });
  });

  it('does NOT cache a transient resolution error: a one-off app.env read failure does not pin the keyless answer', async () => {
    const host = 'importer-ci-marketplace-dev-org.ci.lan';
    appFilesManager.getAppEnv.mockRejectedValueOnce(new Error('disk hiccup'));
    expect((await resolveVia(host)).source).toBe('none');

    // Next request (env readable again) resolves the per-app secret immediately, not 30s later.
    expect((await resolveVia(host)).source).toBe('app-env');
  });

  it('invalidateApp drops the cached per-app secret so a rotated secret is served immediately', async () => {
    const host = 'importer-ci-marketplace-dev-org.ci.lan';
    expect((await resolveVia(host)).secret).toBe('per-app-secret');

    // Rotation: the app.env now holds a fresh secret and the cache is flushed for this app.
    appFilesManager.getAppEnv.mockResolvedValue({ path: '/x', content: 'CI_HUB_FORWARD_AUTH_SECRET=rotated-secret\n' });
    resolver.invalidateApp('importer:ci-marketplace' as never);
    // No timer advance — the flush alone forces a re-read within the same TTL window.
    expect((await resolveVia(host)).secret).toBe('rotated-secret');
  });

  it('single-flights the host-map rebuild: a burst past the TTL triggers one repo read, not one per request', async () => {
    await resolveVia('importer-ci-marketplace-dev-org.ci.lan'); // primes the map (1 read)
    vi.advanceTimersByTime(31_000); // TTL lapses

    // Three concurrent resolutions arriving together must share ONE rebuild.
    await Promise.all([
      resolveVia('a-ci-marketplace-dev-org.ci.lan'),
      resolveVia('b-ci-marketplace-dev-org.ci.lan'),
      resolveVia('c-ci-marketplace-dev-org.ci.lan'),
    ]);
    expect(appsRepository.getApps).toHaveBeenCalledTimes(2); // prime + one shared rebuild
  });

  it('backs off (does not hammer) when the host-map rebuild keeps failing', async () => {
    appsRepository.getApps.mockRejectedValue(new Error('db down'));
    await resolveVia('importer-ci-marketplace-dev-org.ci.lan');
    await resolveVia('importer-ci-marketplace-dev-org.ci.lan'); // within the backoff window
    // The second call must not re-issue the failing read — the short backoff suppresses it.
    expect(appsRepository.getApps).toHaveBeenCalledTimes(1);
  });

  // Edge-SSO lookups (CI-Engineering#77): the redirect must translate the tunnel-rewritten
  // `.ci.lan` host into the app's PUBLIC hostname — the only name a remote browser can reach —
  // and the mint endpoint uses host-map membership as its redirect-target allowlist.
  describe('edge-SSO host lookups', () => {
    it('maps the rewritten LAN origin host to the app public hostname', async () => {
      await expect(resolver.resolvePublicHostForHost('importer-ci-marketplace-dev-org.ci.lan')).resolves.toBe(
        'importer-ci-marketplace-dev-org.example.com',
      );
    });

    it('normalizes case and port before the lookup', async () => {
      await expect(resolver.resolvePublicHostForHost('Importer-CI-Marketplace-dev-org.CI.LAN:8443')).resolves.toBe(
        'importer-ci-marketplace-dev-org.example.com',
      );
    });

    it('returns null for a host no installed app claims, and for a missing host', async () => {
      await expect(resolver.resolvePublicHostForHost('unknown.example.com')).resolves.toBeNull();
      await expect(resolver.resolvePublicHostForHost(undefined)).resolves.toBeNull();
    });

    it('vouches for known app hosts and rejects strangers (the mint allowlist)', async () => {
      await expect(resolver.resolveAppUrnForHost('importer-ci-marketplace-dev-org.example.com')).resolves.toBe('importer:ci-marketplace');
      await expect(resolver.resolveAppUrnForHost('evil.attacker.example')).resolves.toBeNull();
    });
  });
});
