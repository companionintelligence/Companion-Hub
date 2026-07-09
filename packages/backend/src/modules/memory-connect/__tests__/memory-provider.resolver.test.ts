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

  it('detects ci-memory by id and builds internal + public URLs from the provider descriptor', async () => {
    const { resolver } = makeResolver([
      {
        info: info({
          id: 'ci-memory',
          urn: 'ci-memory:local',
          port: 8642,
          hub_integration: { memory: { provider: { service: 'gateway', port: 8642 } } },
        } as never),
      },
    ]);

    const provider = await resolver.findProvider();

    expect(provider).toEqual({
      appUrn: 'ci-memory:local',
      internalUrl: 'http://gateway:8642',
      publicUrl: 'https://ci-memory.example.com',
    });
  });

  it('falls back to gateway:8642 when the provider descriptor is absent', async () => {
    const { resolver } = makeResolver([{ info: info({ id: 'ci-memory', urn: 'ci-memory:local' }) }]);

    const provider = await resolver.findProvider();

    expect(provider?.internalUrl).toBe('http://gateway:8642');
  });

  it('still returns a provider (without publicUrl) when availability resolution fails', async () => {
    const { resolver, appsService } = makeResolver([{ info: info({ id: 'ci-memory', urn: 'ci-memory:local' }) }]);
    appsService.checkAppAvailability.mockRejectedValue(new Error('not running'));

    const provider = await resolver.findProvider();

    expect(provider?.appUrn).toBe('ci-memory:local');
    expect(provider?.publicUrl).toBeUndefined();
  });
});
