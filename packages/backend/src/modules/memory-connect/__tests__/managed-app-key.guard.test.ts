import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ApiKeyStoreUnavailableError } from '@/modules/api-keys/api-key.errors';
import { ManagedAppKeyGuard } from '../managed-app-key.guard';

/**
 * Unit tests for ManagedAppKeyGuard: a wrapper->Hub call is authorized only by
 * the calling app's own managed key, bound to the :urn in the route. The guard
 * accepts both the 'app' scope (canonical) and the legacy 'mcp' scope — scope
 * membership itself is enforced inside ApiKeyService; here we assert the guard
 * asks for exactly that scope set.
 */
function ctx(headers: Record<string, string>, urn: string): ExecutionContext {
  const req = { headers, params: { urn }, get: (n: string) => headers[n.toLowerCase()] };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('ManagedAppKeyGuard', () => {
  let apiKeys: { resolveManagedAppUrn: ReturnType<typeof vi.fn> };
  let logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let guard: ManagedAppKeyGuard;

  beforeEach(() => {
    apiKeys = { resolveManagedAppUrn: vi.fn() };
    logger = { warn: vi.fn(), error: vi.fn() };
    guard = new ManagedAppKeyGuard(apiKeys as never, logger as never);
  });

  it('allows when the bearer key resolves to the same app as the route', async () => {
    apiKeys.resolveManagedAppUrn.mockResolvedValue('ci-openclaw:local');
    await expect(guard.canActivate(ctx({ authorization: 'Bearer good-key' }, 'ci-openclaw:local'))).resolves.toBe(true);
  });

  it("resolves against both the 'app' and legacy 'mcp' scopes", async () => {
    apiKeys.resolveManagedAppUrn.mockResolvedValue('ci-openclaw:local');
    await guard.canActivate(ctx({ authorization: 'Bearer good-key' }, 'ci-openclaw:local'));
    expect(apiKeys.resolveManagedAppUrn).toHaveBeenCalledWith('good-key', ['app', 'mcp']);
  });

  it('rejects a key that belongs to a DIFFERENT app', async () => {
    apiKeys.resolveManagedAppUrn.mockResolvedValue('ci-hermes:local');
    await expect(guard.canActivate(ctx({ authorization: 'Bearer other-key' }, 'ci-openclaw:local'))).rejects.toThrow(UnauthorizedException);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('rejects when the key is not a valid managed key', async () => {
    apiKeys.resolveManagedAppUrn.mockResolvedValue(null);
    await expect(guard.canActivate(ctx({ authorization: 'Bearer bad' }, 'ci-openclaw:local'))).rejects.toThrow(UnauthorizedException);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('matches the url-encoded :urn param', async () => {
    apiKeys.resolveManagedAppUrn.mockResolvedValue('ci-openclaw:local');
    await expect(guard.canActivate(ctx({ authorization: 'Bearer good' }, encodeURIComponent('ci-openclaw:local')))).resolves.toBe(true);
  });

  it('answers 503 (not 401) when the key store is unreachable (#933)', async () => {
    apiKeys.resolveManagedAppUrn.mockRejectedValue(new ApiKeyStoreUnavailableError(new Error('getaddrinfo EAI_AGAIN ci-hub-db')));
    await expect(guard.canActivate(ctx({ authorization: 'Bearer good' }, 'ci-openclaw:local'))).rejects.toThrow(ServiceUnavailableException);
    expect(logger.error).toHaveBeenCalled();
  });
});
