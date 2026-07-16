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
    // Default to a running provider so the existing status/connect expectations
    // exercise the "ready" path; individual tests override for not-ready cases.
    getProviderRuntimeStatus: vi.fn().mockResolvedValue('ready'),
    getAppPublicUrl: vi.fn().mockResolvedValue('https://app.example.org'),
    isConsumerApp: vi.fn().mockResolvedValue(true),
    getAppName: vi.fn().mockResolvedValue('OpenClaw'),
  };
  const exchange = {
    exchange: vi.fn(),
    revoke: vi.fn().mockResolvedValue(true),
    rotate: vi.fn(),
    isKeyValid: vi.fn().mockResolvedValue(true),
  };
  const connections = {
    getState: vi.fn(),
    getRow: vi.fn(),
    storeConnected: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    getInjectableCreds: vi.fn().mockResolvedValue({ url: 'http://gateway:8642', token: 'tok' }),
    credsFromRow: vi.fn().mockReturnValue({ url: 'http://gateway:8642', token: 'tok' }),
    listConnected: vi.fn().mockResolvedValue([]),
  };
  const pending = { create: vi.fn().mockReturnValue('state-nonce'), consume: vi.fn() };
  const deviceRegistration = { getFirstDeviceRegistration: vi.fn().mockResolvedValue({ hubSubdomain: 'core2-x' }) };
  const config = { getConfig: vi.fn().mockReturnValue({ domain: 'example.org' }) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const lifecycle = {
    restartAppAndWait: vi.fn().mockResolvedValue(true),
    regenerateAppEnv: vi.fn().mockResolvedValue(true),
  };
  // applyAndRestart only restarts an app that is actually up — a stopped app must
  // not be started by a rotation sweep or a status poll. Default to running so the
  // existing expectations exercise the restart path.
  const appsRepository = { getAppByUrn: vi.fn().mockResolvedValue({ status: 'running' }) };
  const moduleRef = { get: vi.fn().mockReturnValue(lifecycle) };

  const service = new MemoryConnectService(
    resolver as never,
    exchange as never,
    connections as never,
    pending as never,
    deviceRegistration as never,
    config as never,
    logger as never,
    appsRepository as never,
    moduleRef as never,
  );

  return { service, resolver, exchange, connections, pending, lifecycle, appsRepository, logger };
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

    const url = new URL(await service.startConnect('ci-openclaw:local', 'https://app.example.org/', 'user-1'));

    expect(url.origin).toBe('https://ci-memory.example.org');
    expect(url.pathname).toBe('/api/connect');
    expect(url.searchParams.get('app')).toBe('ci-openclaw:local');
    expect(url.searchParams.get('state')).toBe('state-nonce');
    expect(url.searchParams.get('return')).toBe('https://core2-x.example.org/api/memory-connect/callback');
    expect(url.searchParams.get('app_name')).toBe('OpenClaw');
    expect(pending.create).toHaveBeenCalledWith('ci-openclaw:local', 'https://app.example.org/', 'user-1');
  });

  it('rejects an off-origin `next` (open-redirect guard) and falls back to the app URL', async () => {
    const { service, resolver, pending } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    resolver.getAppPublicUrl.mockResolvedValue('https://app.example.org');

    await service.startConnect('ci-openclaw:local', 'https://evil.example.com/phish', 'user-1');

    // The attacker-supplied next is discarded; the stored destination is the app's own URL.
    expect(pending.create).toHaveBeenCalledWith('ci-openclaw:local', 'https://app.example.org', 'user-1');
  });

  it('throws when Companion Memory is not installed', async () => {
    const { service, resolver } = makeService();
    resolver.findProvider.mockResolvedValue(null);

    await expect(service.startConnect('ci-openclaw:local', '/', 'user-1')).rejects.toThrow(/not installed/);
  });

  it('throws when the provider has no resolvable public URL yet', async () => {
    const { service, resolver } = makeService();
    resolver.findProvider.mockResolvedValue({ ...PROVIDER, publicUrl: undefined });

    await expect(service.startConnect('ci-openclaw:local', '/', 'user-1')).rejects.toThrow(/not reachable/);
  });
});

describe('MemoryConnectService.handleCallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exchanges the code, stores the key (internal URL), restarts, and returns next', async () => {
    const { service, resolver, exchange, connections, pending, lifecycle } = makeService();
    pending.consume.mockReturnValue({ appUrn: 'ci-openclaw:local', next: 'https://app.example.org/', userId: 'user-1' });
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'raw-key', expiresAt: '2026-10-07T00:00:00.000Z' });

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    expect(exchange.exchange).toHaveBeenCalledWith('http://gateway:8642', 'the-code');
    expect(connections.storeConnected).toHaveBeenCalledWith('ci-openclaw:local', 'http://gateway:8642', 'raw-key', '2026-10-07T00:00:00.000Z');
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
    expect(result).toEqual({ next: 'https://app.example.org/' });
  });

  it('rejects an invalid/expired state without exchanging', async () => {
    const { service, pending, exchange } = makeService();
    pending.consume.mockReturnValue(null);

    await expect(service.handleCallback('the-code', 'bad-state', 'user-1')).rejects.toThrow(/Invalid or expired/);
    expect(exchange.exchange).not.toHaveBeenCalled();
  });

  it('returns the app URL with error on app mismatch (does not store), so the user lands back on the app', async () => {
    const { service, resolver, exchange, connections, pending } = makeService();
    pending.consume.mockReturnValue({ appUrn: 'ci-openclaw:local', next: 'https://app.example.org/', userId: 'user-1' });
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-hermes:local', key: 'raw-key' });

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(result).toEqual({ next: 'https://app.example.org/', error: true });
  });

  it('returns error without exchanging when the callback user differs from the initiator (login-CSRF guard)', async () => {
    const { service, exchange, connections, pending } = makeService();
    pending.consume.mockReturnValue({ appUrn: 'ci-openclaw:local', next: 'https://app.example.org/', userId: 'user-1' });

    // A different Hub user completes the callback than the one who started the flow.
    const result = await service.handleCallback('the-code', 'state-nonce', 'user-2');

    expect(exchange.exchange).not.toHaveBeenCalled();
    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(result).toEqual({ next: 'https://app.example.org/', error: true });
  });

  it('returns the app URL with error when the exchange throws (no dead-end on the dashboard)', async () => {
    const { service, resolver, exchange, connections, pending } = makeService();
    pending.consume.mockReturnValue({ appUrn: 'ci-openclaw:local', next: 'https://app.example.org/', userId: 'user-1' });
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockRejectedValue(new Error('ci-memory unreachable'));

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(result).toEqual({ next: 'https://app.example.org/', error: true });
  });
});

describe('MemoryConnectService.abandonConnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('consumes the pending state and returns the originating app URL', () => {
    const { service, pending } = makeService();
    pending.consume.mockReturnValue({ appUrn: 'ci-openclaw:local', next: 'https://app.example.org/', userId: 'user-1' });

    expect(service.abandonConnect('state-nonce')).toBe('https://app.example.org/');
    expect(pending.consume).toHaveBeenCalledWith('state-nonce');
  });

  it('falls back to the Hub root when the state is missing or unknown', () => {
    const { service, pending } = makeService();
    pending.consume.mockReturnValue(null);

    expect(service.abandonConnect(undefined)).toBe('/');
    expect(service.abandonConnect('gone')).toBe('/');
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
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
  });

  it('disconnect does not START an app the user had stopped, but DOES scrub its env', async () => {
    // A restart is compose down + up, so restarting a stopped app would silently bring
    // it back. Its env must still be rewritten though — deferring that too would leave
    // the revoked token sitting in app.env until the app happened to be started again.
    const { service, resolver, connections, lifecycle, appsRepository } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    appsRepository.getAppByUrn.mockResolvedValue({ status: 'stopped' });

    await service.disconnect('ci-openclaw:local');

    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local');
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
    expect(lifecycle.regenerateAppEnv).toHaveBeenCalledWith('ci-openclaw:local');
  });

  it.each([
    'backing_up',
    'restoring',
    'updating',
    'resetting',
  ] as const)('does not restart an app mid-%s (those stop it first, and restore its run-state after)', async (status) => {
    // Restarting here would race the maintenance op AND leave an app the user had
    // stopped running once it finished.
    const { service, resolver, connections, lifecycle, appsRepository } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    appsRepository.getAppByUrn.mockResolvedValue({ status });

    await service.disconnect('ci-openclaw:local');

    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local');
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
    expect(lifecycle.regenerateAppEnv).toHaveBeenCalledWith('ci-openclaw:local');
  });

  it('disconnect throws and keeps the connection (no clear/restart) when the revoke fails', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.revoke.mockResolvedValue(false); // CI-Server never confirmed revocation

    await expect(service.disconnect('ci-openclaw:local')).rejects.toThrow(/still connected/);

    // Must NOT falsely report disconnected while the key is still live server-side.
    expect(connections.clear).not.toHaveBeenCalled();
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
  });

  it('disconnect clears locally when the provider is unresolvable (nothing to revoke)', async () => {
    const { service, resolver, exchange, connections } = makeService();
    resolver.findProvider.mockResolvedValue(null);

    await service.disconnect('ci-openclaw:local');

    expect(exchange.revoke).not.toHaveBeenCalled();
    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local');
  });

  it('handleUninstall revokes and removes state without restarting', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);

    await service.handleUninstall('ci-openclaw:local');

    expect(exchange.revoke).toHaveBeenCalledWith('http://gateway:8642', 'ci-openclaw:local');
    expect(connections.remove).toHaveBeenCalledWith('ci-openclaw:local');
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
  });

  it('getUiStatus clears a stale connection AND restarts the app when ci-memory rejects the stored key', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.getRow.mockResolvedValue({ state: 'connected', keyExpiresAt: '2026-10-07T00:00:00.000Z' });
    exchange.isKeyValid.mockResolvedValue(false); // ci-memory reset → key dead

    const status = await service.getUiStatus('ci-openclaw:local');

    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local');
    // Must restart so the container drops the dead credential and re-prompts.
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
    expect(status.state).toBe('unconfigured');
    // The stale key's expiry is cleared alongside the connection.
    expect(status.keyExpiresAt).toBeNull();
  });

  it('getUiStatus short-circuits for a non-consumer app without probing the provider', async () => {
    const { service, resolver } = makeService();
    resolver.isConsumerApp.mockResolvedValue(false);

    const status = await service.getUiStatus('some-random-app:local');

    expect(status).toEqual({
      applicable: false,
      memoryInstalled: false,
      memoryReady: false,
      providerStatus: 'absent',
      state: 'unconfigured',
      connectUrl: null,
      keyExpiresAt: null,
    });
    expect(resolver.findProvider).not.toHaveBeenCalled();
  });

  it('getUiStatus reports the provider as installed-but-not-ready and withholds the connect URL while ci-memory is installing', async () => {
    const { service, resolver, connections } = makeService();
    resolver.getProviderRuntimeStatus.mockResolvedValue('starting');
    connections.getRow.mockResolvedValue({ state: 'unconfigured', keyExpiresAt: null });

    const status = await service.getUiStatus('ci-openclaw:local');

    expect(status.memoryInstalled).toBe(true);
    expect(status.memoryReady).toBe(false);
    expect(status.providerStatus).toBe('starting');
    // No launcher URL while it isn't running — the Connect button stays inert.
    expect(status.connectUrl).toBeNull();
    // Never probe key validity (nor restart) against a provider that isn't up.
    expect(resolver.findProvider).not.toHaveBeenCalled();
  });

  it('getUiStatus keeps a connected state when the stored key is still valid', async () => {
    const { service, resolver, exchange, connections } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.getRow.mockResolvedValue({ state: 'connected', keyExpiresAt: '2026-10-07T00:00:00.000Z' });
    exchange.isKeyValid.mockResolvedValue(true);

    const status = await service.getUiStatus('ci-openclaw:local');

    expect(connections.clear).not.toHaveBeenCalled();
    expect(status.state).toBe('connected');
    // A valid connection surfaces the key's expiry for the UI's renewal note.
    expect(status.keyExpiresAt).toBe('2026-10-07T00:00:00.000Z');
  });

  it('getUiStatus normalizes the Postgres timestamptz form into a canonical UTC ISO string', async () => {
    const { service, resolver, connections } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    // Postgres returns timestamptz as a space-separated, offset-qualified string
    // (not `…Z`); the UI must receive a browser-parseable ISO instant.
    connections.getRow.mockResolvedValue({ state: 'connected', keyExpiresAt: '2026-10-07 00:00:00+00' });

    const status = await service.getUiStatus('ci-openclaw:local');

    expect(status.keyExpiresAt).toBe('2026-10-07T00:00:00.000Z');
  });

  const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  it('rotateDueKeys rotates a key older than the threshold and restarts the app', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) }]);
    exchange.rotate.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'fresh-key', expiresAt: '2026-10-07T00:00:00.000Z' });

    await service.rotateDueKeys();

    expect(exchange.rotate).toHaveBeenCalledWith('http://gateway:8642', 'ci-openclaw:local');
    expect(connections.storeConnected).toHaveBeenCalledWith('ci-openclaw:local', 'http://gateway:8642', 'fresh-key', '2026-10-07T00:00:00.000Z');
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
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

  it('rotateDueKeys does NOT rotate a down app — retiring its key would strand it for 60 days', async () => {
    // Rotation retires the old key on CI-Server, and storeConnected bumps `updatedAt`,
    // which re-arms the age gate. Rotating an app we cannot restart would therefore
    // leave it 401ing and skipped by the next ~60 days of sweeps. Leave it entirely
    // alone: the first sweep after it comes back up picks it up.
    const { service, resolver, exchange, connections, lifecycle, appsRepository } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) }]);
    appsRepository.getAppByUrn.mockResolvedValue({ status: 'stopped' });

    await service.rotateDueKeys();

    expect(exchange.rotate).not.toHaveBeenCalled();
    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
  });

  it('rotateDueKeys retries once and reports failure when the restart does not take', async () => {
    // `restartApp` resolves as soon as the command is PUBLISHED, so the sweep awaits the
    // real outcome instead — otherwise a failed compose would be logged as a success and
    // the app would sit on the key CI-Server just retired.
    const { service, resolver, exchange, connections, lifecycle, logger } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) }]);
    exchange.rotate.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'fresh-key', expiresAt: '2026-10-07T00:00:00.000Z' });
    lifecycle.restartAppAndWait.mockResolvedValue(false);

    await service.rotateDueKeys();

    expect(lifecycle.restartAppAndWait).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not restart it'));
  });

  it('rotateDueKeys does not let a restart-induced stop masquerade as a benign deferral', async () => {
    // A failed restart marks the app `stopped`. The retry then sees a down app and would
    // report 'deferred' — logging the reassuring "applies on next start" line for an app
    // that was RUNNING and that the sweep itself just knocked over onto a retired key.
    const { service, resolver, exchange, connections, lifecycle, appsRepository, logger } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) }]);
    exchange.rotate.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'fresh-key', expiresAt: '2026-10-07T00:00:00.000Z' });
    // Running at rotation time; the failed restart then leaves it stopped.
    appsRepository.getAppByUrn
      .mockResolvedValueOnce({ status: 'running' }) // pre-rotation liveness check
      .mockResolvedValueOnce({ status: 'running' }) // first apply
      .mockResolvedValue({ status: 'stopped' }); // retry sees the wreckage
    lifecycle.restartAppAndWait.mockResolvedValue(false);

    await service.rotateDueKeys();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not restart it'));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('applies on next start'));
  });

  it('rotateDueKeys keeps going when one app fails to rotate', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([
      { appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) },
      { appUrn: 'ci-hermes:local', updatedAt: daysAgoIso(70) },
    ]);
    exchange.rotate
      .mockRejectedValueOnce(new Error('ci-memory down'))
      .mockResolvedValueOnce({ appUrn: 'ci-hermes:local', key: 'fresh-key', expiresAt: '2026-10-07T00:00:00.000Z' });

    await service.rotateDueKeys();

    // The second app still rotates despite the first throwing.
    expect(exchange.rotate).toHaveBeenCalledTimes(2);
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-hermes:local' });
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalledWith({ appUrn: 'ci-openclaw:local' });
  });

  it('getStatus returns the state and a launcher URL built from the Hub origin', async () => {
    const { service, connections, resolver } = makeService();
    connections.getState.mockResolvedValue('unconfigured');
    resolver.getProviderRuntimeStatus.mockResolvedValue('ready');

    const status = await service.getStatus('ci-openclaw:local');

    expect(status.state).toBe('unconfigured');
    expect(status.connectUrl).toBe('https://core2-x.example.org/api/memory-connect/start?app=ci-openclaw%3Alocal');
  });

  it('getStatus withholds the connectUrl when Companion Memory is not installed (no dead-end gate)', async () => {
    const { service, connections, resolver } = makeService();
    connections.getState.mockResolvedValue('unconfigured');
    resolver.getProviderRuntimeStatus.mockResolvedValue('absent');

    const status = await service.getStatus('ci-openclaw:local');

    // A null connectUrl makes the wrapper suppress the connect gate rather than
    // link to a startConnect that would 400 with "Companion Memory is not installed".
    expect(status.connectUrl).toBeNull();
  });

  it('getStatus withholds the connectUrl while Companion Memory is only installing (not reachable yet)', async () => {
    const { service, connections, resolver } = makeService();
    connections.getState.mockResolvedValue('unconfigured');
    resolver.getProviderRuntimeStatus.mockResolvedValue('starting');

    const status = await service.getStatus('ci-openclaw:local');

    // The wrapper gate stays suppressed until ci-memory is actually running,
    // rather than linking to a startConnect that 400s with "not reachable yet".
    expect(status.connectUrl).toBeNull();
  });

  it('getStatus still returns state (connectUrl null) when the provider lookup fails', async () => {
    const { service, connections, resolver } = makeService();
    connections.getState.mockResolvedValue('unconfigured');
    resolver.getProviderRuntimeStatus.mockRejectedValue(new Error('db blip'));

    const status = await service.getStatus('ci-openclaw:local');

    // Resilience: a transient provider-lookup failure must not 500 the poll.
    expect(status.state).toBe('unconfigured');
    expect(status.connectUrl).toBeNull();
  });

  it('handleUninstall of Companion Memory clears + restarts every connected consumer', async () => {
    const { service, resolver, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(null); // provider already gone from the install list
    connections.listConnected.mockResolvedValue([
      { appUrn: 'ci-memory:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
      { appUrn: 'ci-openclaw:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
      { appUrn: 'ci-hermes:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
    ]);

    await service.handleUninstall('ci-memory:ci-marketplace');

    // Each consumer is cleared + restarted; the provider row itself is skipped.
    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:ci-marketplace');
    expect(connections.clear).toHaveBeenCalledWith('ci-hermes:ci-marketplace');
    expect(connections.clear).not.toHaveBeenCalledWith('ci-memory:ci-marketplace');
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:ci-marketplace' });
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-hermes:ci-marketplace' });
  });

  it('handleUninstall of a regular consumer does NOT cascade to other apps', async () => {
    const { service, resolver, connections } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-hermes:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' }]);

    await service.handleUninstall('ci-openclaw:ci-marketplace');

    // Only the uninstalled app's row is removed; no consumer is cleared.
    expect(connections.remove).toHaveBeenCalledWith('ci-openclaw:ci-marketplace');
    expect(connections.clear).not.toHaveBeenCalled();
  });
});

describe('MemoryConnectService.listConnectedConsumers', () => {
  beforeEach(() => vi.clearAllMocks());

  it("excludes the provider's own connection row", async () => {
    const { service, connections } = makeService();
    connections.listConnected.mockResolvedValue([
      { appUrn: 'ci-memory:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
      { appUrn: 'ci-hermes:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
    ]);

    const consumers = await service.listConnectedConsumers();

    expect(consumers.map((c) => c.appUrn)).toEqual(['ci-hermes:ci-marketplace']);
  });

  it('excludes stale rows whose app is no longer installed', async () => {
    const { service, connections, appsRepository } = makeService();
    connections.listConnected.mockResolvedValue([
      { appUrn: 'ci-hermes:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
      { appUrn: 'ci-gone:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
    ]);
    appsRepository.getAppByUrn.mockImplementation(async (urn: string) => (urn === 'ci-gone:ci-marketplace' ? undefined : { status: 'running' }));

    const consumers = await service.listConnectedConsumers();

    expect(consumers.map((c) => c.appUrn)).toEqual(['ci-hermes:ci-marketplace']);
  });

  it('resolves the display name, falling back to the URN app-name half', async () => {
    const { service, connections, resolver } = makeService();
    connections.listConnected.mockResolvedValue([
      { appUrn: 'ci-hermes:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
      { appUrn: 'ci-openclaw:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
    ]);
    resolver.getAppName.mockImplementation(async (urn: string) => (urn === 'ci-hermes:ci-marketplace' ? 'Hermes' : undefined));

    const consumers = await service.listConnectedConsumers();

    expect(consumers).toEqual([
      { appUrn: 'ci-hermes:ci-marketplace', name: 'Hermes' },
      { appUrn: 'ci-openclaw:ci-marketplace', name: 'ci-openclaw' },
    ]);
  });

  it('skips a malformed connection row instead of throwing', async () => {
    const { service, connections, resolver } = makeService();
    connections.listConnected.mockResolvedValue([
      { appUrn: 'no-separator-here', updatedAt: '2026-07-09T00:00:00.000Z' },
      { appUrn: 'ci-hermes:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
    ]);
    // Force the name fallback (extractAppUrn) so the malformed URN throws inside the loop.
    resolver.getAppName.mockResolvedValue(undefined);

    const consumers = await service.listConnectedConsumers();

    expect(consumers).toEqual([{ appUrn: 'ci-hermes:ci-marketplace', name: 'ci-hermes' }]);
  });
});
