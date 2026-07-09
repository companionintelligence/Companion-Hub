import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo } from '@ci-hub/common/schemas';
import { MemoryProviderResolver } from '../memory-provider.resolver';

/**
 * Unit tests for provider/consumer resolution from `hub_integration.memory`
 * declarations and the shared-network internal-address construction.
 */
function info(partial: Partial<AppInfo> & { id: string; urn: string }): AppInfo {
  return partial as AppInfo;
}

function makeResolver(installed: Array<{ info: AppInfo }>) {
  const appsService = {
    getInstalledApps: vi.fn().mockResolvedValue(installed),
    getInstalledAppsLite: vi.fn().mockResolvedValue([]),
    checkAppAvailability: vi.fn().mockResolvedValue({ available: true, appUrl: 'https://ci-memory.example.com' }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    resolver: new MemoryProviderResolver(appsService as never, logger as never),
    appsService,
  };
}

describe('MemoryProviderResolver.consumerEnv', () => {
  const { resolver } = makeResolver([]);

  it('classifies an app declaring both url_env and token_env as a consumer', () => {
    const app = info({
      id: 'ci-openclaw',
      urn: 'ci-openclaw:local',
      hub_integration: { memory: { url_env: 'CI_SERVER_URL', token_env: 'CI_SERVER_TOKEN' } },
    } as never);

    expect(resolver.isConsumer(app)).toBe(true);
    expect(resolver.consumerEnv(app)).toEqual({ urlEnv: 'CI_SERVER_URL', tokenEnv: 'CI_SERVER_TOKEN' });
  });

  it('does not classify an app missing token_env as a consumer', () => {
    const app = info({ id: 'x', urn: 'x:local', hub_integration: { memory: { url_env: 'CI_SERVER_URL' } } } as never);

    expect(resolver.isConsumer(app)).toBe(false);
    expect(resolver.consumerEnv(app)).toBeNull();
  });

  it('does not classify an app without a memory block', () => {
    expect(resolver.isConsumer(info({ id: 'x', urn: 'x:local' }))).toBe(false);
  });
});

describe('MemoryProviderResolver.isProviderInstalled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is true for an official-store ci-memory row via the DB-only lite check (no availability/full probe)', async () => {
    const { resolver, appsService } = makeResolver([]);
    appsService.getInstalledAppsLite.mockResolvedValue([
      { appName: 'ci-openclaw', appStoreSlug: 'ci-marketplace' },
      { appName: 'ci-memory', appStoreSlug: 'ci-marketplace' },
    ]);

    expect(await resolver.isProviderInstalled()).toBe(true);
    expect(appsService.checkAppAvailability).not.toHaveBeenCalled();
    expect(appsService.getInstalledApps).not.toHaveBeenCalled();
  });

  it('is false for a ci-memory row from a non-official store (no id-squat)', async () => {
    const { resolver, appsService } = makeResolver([]);
    appsService.getInstalledAppsLite.mockResolvedValue([{ appName: 'ci-memory', appStoreSlug: 'third-party' }]);

    expect(await resolver.isProviderInstalled()).toBe(false);
  });

  it('is false when ci-memory is not installed', async () => {
    const { resolver, appsService } = makeResolver([]);
    appsService.getInstalledAppsLite.mockResolvedValue([{ appName: 'ci-openclaw', appStoreSlug: 'ci-marketplace' }]);

    expect(await resolver.isProviderInstalled()).toBe(false);
  });
});

describe('MemoryProviderResolver.findProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when ci-memory is not installed', async () => {
    const { resolver } = makeResolver([{ info: info({ id: 'ci-openclaw', urn: 'ci-openclaw:local' }) }]);

    expect(await resolver.findProvider()).toBeNull();
  });

  it('does NOT treat an app that self-declares a provider role (but is not ci-memory) as the provider', async () => {
    // Trust is pinned to the reserved id; a manifest-declared provider role must
    // not make an arbitrary app the exchange target / forward-auth-secret holder.
    const { resolver } = makeResolver([
      {
        info: info({
          id: 'evil-app',
          urn: 'evil-app:third-party',
          hub_integration: { memory: { provider: { service: 'evil', port: 9999 } } },
        } as never),
      },
    ]);

    expect(await resolver.findProvider()).toBeNull();
  });

  it('does NOT trust an id-squatting app installed from a non-official store', async () => {
    // The exact escalation the provenance check defends against: a malicious
    // third-party-store app declares id 'ci-memory' in its config.json, but its
    // Hub-derived urn carries the (non-official) store it actually came from, so
    // it must never be selected as the provider / handed the forward-auth secret.
    const { resolver } = makeResolver([
      {
        info: info({
          id: 'ci-memory',
          urn: 'ci-memory:third-party',
          hub_integration: { memory: { provider: { service: 'evil', port: 9999 } } },
        } as never),
      },
    ]);

    expect(await resolver.findProvider()).toBeNull();
  });

  it('detects ci-memory by official-store install provenance and builds internal + public URLs from the provider descriptor', async () => {
    const { resolver } = makeResolver([
      {
        info: info({
          id: 'ci-memory',
          urn: 'ci-memory:ci-marketplace',
          port: 8642,
          hub_integration: { memory: { provider: { service: 'gateway', port: 8642 } } },
        } as never),
      },
    ]);

    const provider = await resolver.findProvider({ withPublicUrl: true });

    expect(provider).toEqual({
      appUrn: 'ci-memory:ci-marketplace',
      internalUrl: 'http://gateway:8642',
      publicUrl: 'https://ci-memory.example.com',
    });
  });

  it('skips the (heavy) public-URL availability probe by default', async () => {
    const { resolver, appsService } = makeResolver([{ info: info({ id: 'ci-memory', urn: 'ci-memory:ci-marketplace' }) }]);

    const provider = await resolver.findProvider();

    expect(provider?.internalUrl).toBe('http://gateway:8642');
    expect(provider?.publicUrl).toBeUndefined();
    expect(appsService.checkAppAvailability).not.toHaveBeenCalled();
  });

  it('falls back to gateway:8642 when the provider descriptor is absent', async () => {
    const { resolver } = makeResolver([{ info: info({ id: 'ci-memory', urn: 'ci-memory:ci-marketplace' }) }]);

    const provider = await resolver.findProvider();

    expect(provider?.internalUrl).toBe('http://gateway:8642');
  });

  it('still returns a provider (without publicUrl) when availability resolution fails', async () => {
    const { resolver, appsService } = makeResolver([{ info: info({ id: 'ci-memory', urn: 'ci-memory:ci-marketplace' }) }]);
    appsService.checkAppAvailability.mockRejectedValue(new Error('not running'));

    const provider = await resolver.findProvider({ withPublicUrl: true });

    expect(provider?.appUrn).toBe('ci-memory:ci-marketplace');
    expect(provider?.publicUrl).toBeUndefined();
  });
});
