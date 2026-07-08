import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ManagedAppKeyGuard } from '../managed-app-key.guard';

/**
 * Unit tests for ManagedAppKeyGuard: a wrapper->Hub call is authorized only by
 * the calling app's own managed key, bound to the :urn in the route.
 */
function ctx(headers: Record<string, string>, urn: string): ExecutionContext {
  const req = { headers, params: { urn }, get: (n: string) => headers[n.toLowerCase()] };
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('ManagedAppKeyGuard', () => {
  let mcp: { resolveManagedAppUrn: ReturnType<typeof vi.fn> };
  let guard: ManagedAppKeyGuard;

  beforeEach(() => {
    mcp = { resolveManagedAppUrn: vi.fn() };
    guard = new ManagedAppKeyGuard(mcp as never);
  });

  it('allows when the bearer key resolves to the same app as the route', async () => {
    mcp.resolveManagedAppUrn.mockResolvedValue('ci-openclaw:local');
    await expect(guard.canActivate(ctx({ authorization: 'Bearer good-key' }, 'ci-openclaw:local'))).resolves.toBe(true);
  });

  it('rejects a key that belongs to a DIFFERENT app', async () => {
    mcp.resolveManagedAppUrn.mockResolvedValue('ci-hermes:local');
    await expect(guard.canActivate(ctx({ authorization: 'Bearer other-key' }, 'ci-openclaw:local'))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when the key is not a valid managed key', async () => {
    mcp.resolveManagedAppUrn.mockResolvedValue(null);
    await expect(guard.canActivate(ctx({ authorization: 'Bearer bad' }, 'ci-openclaw:local'))).rejects.toThrow(UnauthorizedException);
  });

  it('matches the url-encoded :urn param', async () => {
    mcp.resolveManagedAppUrn.mockResolvedValue('ci-openclaw:local');
    await expect(guard.canActivate(ctx({ authorization: 'Bearer good' }, encodeURIComponent('ci-openclaw:local')))).resolves.toBe(true);
  });
});
