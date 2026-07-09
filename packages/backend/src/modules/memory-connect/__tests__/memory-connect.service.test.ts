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
    getAppName: vi.fn().mockResolvedValue('OpenClaw'),
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
    listConnected: vi.fn().mockResolvedValue([]),
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
    expect(url.searchParams.get('app_name')).toBe('OpenClaw');
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

  it('getUiStatus clears a stale connection AND restarts the app when ci-memory rejects the stored key', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.getState.mockResolvedValue('connected');
    exchange.isKeyValid.mockResolvedValue(false); // ci-memory reset → key dead

    const status = await service.getUiStatus('ci-openclaw:local');

    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local');
    // Must restart so the container drops the dead credential and re-prompts.
    expect(lifecycle.restartApp).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
    expect(status.state).toBe('unconfigured');
  });

  it('getUiStatus short-circuits for a non-consumer app without probing the provider', async () => {
    const { service, resolver } = makeService();
    resolver.isConsumerApp.mockResolvedValue(false);

    const status = await service.getUiStatus('some-random-app:local');

    expect(status).toEqual({ applicable: false, memoryInstalled: false, state: 'unconfigured', connectUrl: null });
    expect(resolver.findProvider).not.toHaveBeenCalled();
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

  const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  it('rotateDueKeys rotates a key older than the threshold and restarts the app', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) }]);
    exchange.rotate.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'fresh-key' });

    await service.rotateDueKeys();

    expect(exchange.rotate).toHaveBeenCalledWith('http://gateway:8642', 'ci-openclaw:local');
    expect(connections.storeConnected).toHaveBeenCalledWith('ci-openclaw:local', 'http://gateway:8642', 'fresh-key');
    expect(lifecycle.restartApp).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
  });

  it('rotateDueKeys leaves a still-fresh key untouched', async () => {
    const { service, resolver, exchange, connections } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(3) }]);

    await service.rotateDueKeys();

    expect(exchange.rotate).not.toHaveBeenCalled();
    expect(connections.storeConnected).not.toHaveBeenCalled();
  });

  it('rotateDueKeys skips the sweep when Companion Memory is not resolvable', async () => {
    const { service, resolver, exchange, connections } = makeService();
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) }]);
    resolver.findProvider.mockResolvedValue(null);

    await service.rotateDueKeys();

    expect(exchange.rotate).not.toHaveBeenCalled();
  });

  it('rotateDueKeys keeps going when one app fails to rotate', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([
      { appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) },
      { appUrn: 'ci-hermes:local', updatedAt: daysAgoIso(70) },
    ]);
    exchange.rotate.mockRejectedValueOnce(new Error('ci-memory down')).mockResolvedValueOnce({ appUrn: 'ci-hermes:local', key: 'fresh-key' });

    await service.rotateDueKeys();

    // The second app still rotates despite the first throwing.
    expect(exchange.rotate).toHaveBeenCalledTimes(2);
    expect(lifecycle.restartApp).toHaveBeenCalledWith({ appUrn: 'ci-hermes:local' });
    expect(lifecycle.restartApp).not.toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
  });

  it('getStatus returns the state and a launcher URL built from the Hub origin', async () => {
    const { service, connections } = makeService();
    connections.getState.mockResolvedValue('unconfigured');

    const status = await service.getStatus('ci-openclaw:local');

    expect(status.state).toBe('unconfigured');
    expect(status.connectUrl).toBe('https://core2-x.example.org/api/memory-connect/start?app=ci-openclaw%3Alocal');
  });
});
