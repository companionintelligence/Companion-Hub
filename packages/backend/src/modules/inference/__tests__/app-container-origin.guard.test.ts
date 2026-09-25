import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContainerOriginGuard } from '../app-container-origin.guard';

function createContext(request: {
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[]>;
  params?: Record<string, string>;
  method?: string;
  originalUrl?: string;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, method: 'GET', originalUrl: '/api/inference/apps/openclaw/bootstrap.env', ...request }),
    }),
  } as ExecutionContext;
}

/*
 * The bootstrap handout can carry the operator's cloud provider key. Origin
 * alone admitted every installed app container, every LAN device and every
 * tailnet peer (2026-09-24 audit); this binds the request to a running
 * container of the app the slug names.
 */
describe('AppContainerOriginGuard', () => {
  const logger = { warn: vi.fn() };
  let addresses: ReturnType<typeof vi.fn>;
  let guard: AppContainerOriginGuard;

  beforeEach(() => {
    logger.warn.mockClear();
    addresses = vi.fn(async (names: readonly string[]) =>
      names.includes('ci-openclaw') ? new Set(['172.19.0.9', '10.128.12.3']) : new Set<string>(),
    );
    guard = new AppContainerOriginGuard(logger as never, { runningContainerAddressesForApps: addresses } as never);
  });

  it("admits the slug's own container, from any of its networks", async () => {
    await expect(guard.canActivate(createContext({ ip: '172.19.0.9', params: { slug: 'openclaw' } }))).resolves.toBe(true);
    await expect(guard.canActivate(createContext({ ip: '10.128.12.3', params: { slug: 'openclaw' } }))).resolves.toBe(true);
    expect(addresses).toHaveBeenCalledWith(['openclaw', 'ci-openclaw']);
  });

  it('admits an IPv6-mapped socket address the same way', async () => {
    await expect(guard.canActivate(createContext({ ip: '::ffff:172.19.0.9', params: { slug: 'openclaw' } }))).resolves.toBe(true);
  });

  it('SECURITY: refuses a neighbouring container on the same Docker network', async () => {
    await expect(guard.canActivate(createContext({ ip: '172.19.0.10', params: { slug: 'openclaw' } }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('172.19.0.10 is not a running container of openclaw'));
  });

  it('SECURITY: refuses a LAN host and a tailnet peer, which the origin check alone admitted', async () => {
    await expect(guard.canActivate(createContext({ ip: '192.168.1.20', params: { slug: 'openclaw' } }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(createContext({ ip: '100.64.0.7', params: { slug: 'openclaw' } }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses the other agent's container: the slug names the app, not 'any agent'", async () => {
    // hermes has no running containers in this fixture; openclaw's address must not do.
    await expect(guard.canActivate(createContext({ ip: '172.19.0.9', params: { slug: 'hermes-agent' } }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(addresses).toHaveBeenCalledWith(['hermes-agent', 'ci-hermes']);
  });

  it('refuses an unknown slug without asking Docker for anything', async () => {
    await expect(guard.canActivate(createContext({ ip: '172.19.0.9', params: { slug: 'not-an-agent' } }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(addresses).toHaveBeenCalledWith([]);
  });

  it('keeps the origin check as the outer layer: proxy provenance is refused before Docker is consulted', async () => {
    await expect(
      guard.canActivate(createContext({ ip: '172.19.0.9', params: { slug: 'openclaw' }, headers: { 'cf-connecting-ip': '203.0.113.5' } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(createContext({ ip: '203.0.113.5', params: { slug: 'openclaw' } }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(addresses).not.toHaveBeenCalled();
  });

  it('caches one slug briefly, so a crash-looping agent does not become a Docker listing per request', async () => {
    await guard.canActivate(createContext({ ip: '172.19.0.9', params: { slug: 'openclaw' } }));
    await guard.canActivate(createContext({ ip: '172.19.0.9', params: { slug: 'openclaw' } }));
    expect(addresses).toHaveBeenCalledTimes(1);
  });

  it('refuses when Docker cannot be read (empty set), rather than falling open', async () => {
    addresses.mockResolvedValue(new Set());
    await expect(guard.canActivate(createContext({ ip: '172.19.0.9', params: { slug: 'openclaw' } }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
