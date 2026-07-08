import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryConnectService } from '../memory-connect.service';

/**
 * Unit tests for the connect orchestration: consent-URL construction, the
 * state/app-mismatch guards on callback, and the revoke/restart side effects of
 * disconnect + uninstall.
 */
function makeService() {
  const resolver = {
    findProvider: vi.fn(),
    getAppPublicUrl: vi.fn().mockResolvedValue('https://app.example.org'),
    isConsumerApp: vi.fn().mockResolvedValue(true),
  };
  const exchange = {
    exchange: vi.fn(),
    revoke: vi.fn().mockResolvedValue(undefined),
    rotate: vi.fn(),
    isKeyValid: vi.fn().mockResolvedValue(true),
  };
  const connections = {
    getState: vi.fn(),
    storeConnected: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    getInjectableCreds: vi.fn().mockResolvedValue({ url: 'http://gateway:8642', token: 'tok' }),
  };
  const pending = { create: vi.fn().mockReturnValue('state-nonce'), consume: vi.fn() };
  const deviceRegistration = { getFirstDeviceRegistration: vi.fn().mockResolvedValue({ hubSubdomain: 'core2-x' }) };
  const config = { getConfig: vi.fn().mockReturnValue({ domain: 'example.org' }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const lifecycle = { restartApp: vi.fn().mockResolvedValue(undefined) };
  const moduleRef = { get: vi.fn().mockReturnValue(lifecycle) };

  const service = new MemoryConnectService(
    resolver as never,
    exchange as never,
    connections as never,
    pending as never,
    deviceRegistration as never,
    config as never,
    logger as never,
    moduleRef as never,
  );

  return { service, resolver, exchange, connections, pending, lifecycle };
}

const PROVIDER = {
  appUrn: 'ci-memory:local',
  internalUrl: 'http://gateway:8642',
  publicUrl: 'https://ci-memory.example.org',
};

describe('MemoryConnectService.startConnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds the ci-memory consent URL with app, state, and the Hub callback as return', async () => {
    const { service, resolver, pending } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);

    const url = new URL(await service.startConnect('ci-openclaw:local', 'https://app.example.org/'));

    expect(url.origin).toBe('https://ci-memory.example.org');
    expect(url.pathname).toBe('/api/connect');
    expect(url.searchParams.get('app')).toBe('ci-openclaw:local');
    expect(url.searchParams.get('state')).toBe('state-nonce');
    expect(url.searchParams.get('return')).toBe('https://core2-x.example.org/api/memory-connect/callback');
    expect(pending.create).toHaveBeenCalledWith('ci-openclaw:local', 'https://app.example.org/');
  });

  it('rejects an off-origin `next` (open-redirect guard) and falls back to the app URL', async () => {
    const { service, resolver, pending } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    resolver.getAppPublicUrl.mockResolvedValue('https://app.example.org');

    await service.startConnect('ci-openclaw:local', 'https://evil.example.com/phish');

    // The attacker-supplied next is discarded; the stored destination is the app's own URL.
    expect(pending.create).toHaveBeenCalledWith('ci-openclaw:local', 'https://app.example.org');
  });

  it('throws when Companion Memory is not installed', async () => {
    const { service, resolver } = makeService();
    resolver.findProvider.mockResolvedValue(null);

    await expect(service.startConnect('ci-openclaw:local', '/')).rejects.toThrow(/not installed/);
  });

  it('throws when the provider has no resolvable public URL yet', async () => {
    const { service, resolver } = makeService();
    resolver.findProvider.mockResolvedValue({ ...PROVIDER, publicUrl: undefined });

    await expect(service.startConnect('ci-openclaw:local', '/')).rejects.toThrow(/not reachable/);
  });
});

describe('MemoryConnectService.handleCallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exchanges the code, stores the key (internal URL), restarts, and returns next', async () => {
    const { service, resolver, exchange, connections, pending, lifecycle } = makeService();
    pending.consume.mockReturnValue({ appUrn: 'ci-openclaw:local', next: 'https://app.example.org/' });
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'raw-key' });

    const result = await service.handleCallback('the-code', 'state-nonce');

    expect(exchange.exchange).toHaveBeenCalledWith('http://gateway:8642', 'the-code');
    expect(connections.storeConnected).toHaveBeenCalledWith('ci-openclaw:local', 'http://gateway:8642', 'raw-key');
    expect(lifecycle.restartApp).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
    expect(result).toEqual({ next: 'https://app.example.org/' });
  });

  it('rejects an invalid/expired state without exchanging', async () => {
    const { service, pending, exchange } = makeService();
    pending.consume.mockReturnValue(null);

    await expect(service.handleCallback('the-code', 'bad-state')).rejects.toThrow(/Invalid or expired/);
    expect(exchange.exchange).not.toHaveBeenCalled();
  });

  it('rejects when the exchanged app does not match the attempt (code/app mismatch)', async () => {
    const { service, resolver, exchange, connections, pending } = makeService();
    pending.consume.mockReturnValue({ appUrn: 'ci-openclaw:local', next: '/' });
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-hermes:local', key: 'raw-key' });

    await expect(service.handleCallback('the-code', 'state-nonce')).rejects.toThrow(/did not match/);
    expect(connections.storeConnected).not.toHaveBeenCalled();
  });
});

describe('MemoryConnectService side effects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skip marks the app skipped', async () => {
    const { service, connections } = makeService();
    await service.skip('ci-openclaw:local');
    expect(connections.markSkipped).toHaveBeenCalledWith('ci-openclaw:local');
  });

  it('disconnect revokes on ci-memory, clears state, and restarts', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);

    await service.disconnect('ci-openclaw:local');

    expect(exchange.revoke).toHaveBeenCalledWith('http://gateway:8642', 'ci-openclaw:local');
    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local');
    expect(lifecycle.restartApp).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
  });

  it('handleUninstall revokes and removes state without restarting', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);

    await service.handleUninstall('ci-openclaw:local');

    expect(exchange.revoke).toHaveBeenCalledWith('http://gateway:8642', 'ci-openclaw:local');
    expect(connections.remove).toHaveBeenCalledWith('ci-openclaw:local');
    expect(lifecycle.restartApp).not.toHaveBeenCalled();
  });

  it('getUiStatus clears a stale connection when ci-memory rejects the stored key', async () => {
    const { service, resolver, exchange, connections } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.getState.mockResolvedValue('connected');
    exchange.isKeyValid.mockResolvedValue(false); // ci-memory reset → key dead

    const status = await service.getUiStatus('ci-openclaw:local');

    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local');
    expect(status.state).toBe('unconfigured');
  });

  it('getUiStatus keeps a connected state when the stored key is still valid', async () => {
    const { service, resolver, exchange, connections } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.getState.mockResolvedValue('connected');
    exchange.isKeyValid.mockResolvedValue(true);

    const status = await service.getUiStatus('ci-openclaw:local');

    expect(connections.clear).not.toHaveBeenCalled();
    expect(status.state).toBe('connected');
  });

  it('getStatus returns the state and a launcher URL built from the Hub origin', async () => {
    const { service, connections } = makeService();
    connections.getState.mockResolvedValue('unconfigured');

    const status = await service.getStatus('ci-openclaw:local');

    expect(status.state).toBe('unconfigured');
    expect(status.connectUrl).toBe('https://core2-x.example.org/api/memory-connect/start?app=ci-openclaw%3Alocal');
  });
});
