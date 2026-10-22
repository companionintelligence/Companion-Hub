import { HttpStatus } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslatableError } from '@/common/error/translatable-error';
import { RESTARTS_THAT_WAIT_FOR_THE_APP } from '@/modules/app-lifecycle/app-lifecycle.service';
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
    // Default: a publicly-exposed provider, so the provider_local_only guard is
    // inert unless a test opts into it.
    getProviderRuntimeInfo: vi.fn().mockResolvedValue({ status: 'ready', localOnly: false }),
    getAppPublicUrl: vi.fn().mockResolvedValue('https://app.example.org'),
    getAppAccessUrls: vi.fn().mockResolvedValue({ publicUrl: 'https://app.example.org', localUrl: 'http://192.168.1.9:8080' }),
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
    getActiveConnection: vi.fn().mockResolvedValue(undefined),
  };
  const pending = { create: vi.fn().mockReturnValue('state-nonce'), consume: vi.fn(), recordOutcome: vi.fn() };
  const deviceRegistration = { getFirstDeviceRegistration: vi.fn().mockResolvedValue({ hubSubdomain: 'core2-x' }) };
  const config = {
    getConfig: vi.fn().mockReturnValue({ domain: 'example.org', userSettings: { internalIp: '192.168.1.9', port: 80 } }),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  // The restart a credential change applies itself with, once it holds the app.
  const held = { restart: vi.fn().mockResolvedValue({ requestId: 'r-1' }), restartAndWait: vi.fn().mockResolvedValue(true) };
  const lifecycle = {
    restartApp: vi.fn().mockResolvedValue({ requestId: 'r-1' }),
    restartAppAndWait: vi.fn().mockResolvedValue(true),
    regenerateAppEnv: vi.fn().mockResolvedValue(true),
    held,
    withAppHeld: vi.fn(async (_appUrn: string, run: (app: typeof held) => Promise<unknown>) => run(held)),
    withAppHeldUnlessBusy: vi.fn(
      async (_appUrn: string, run: (app: typeof held) => Promise<unknown>): Promise<{ result: unknown } | { busy: string }> => ({
        result: await run(held),
      }),
    ),
  };
  // applyAndRestart only restarts an app that is actually up — a stopped app must
  // not be started by a rotation sweep or a status poll. Default to running so the
  // existing expectations exercise the restart path.
  const appsRepository = { getAppByUrn: vi.fn().mockResolvedValue({ status: 'running' }) };
  const moduleRef = { get: vi.fn().mockReturnValue(lifecycle) };
  // Default to a healthy tunnel so the existing expectations exercise the public
  // launcher path; the local-fallback cases override this per test.
  const tunnelHealth = { getHealth: vi.fn().mockReturnValue('up'), getHealthNow: vi.fn().mockResolvedValue('up'), invalidate: vi.fn() };

  const service = new MemoryConnectService(
    resolver as never,
    exchange as never,
    connections as never,
    pending as never,
    deviceRegistration as never,
    config as never,
    logger as never,
    appsRepository as never,
    tunnelHealth as never,
    moduleRef as never,
  );

  return { service, resolver, exchange, connections, pending, lifecycle, appsRepository, logger, tunnelHealth, deviceRegistration, config };
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

  it('does not allowlist the loopback Hub origin for a non-loopback caller', async () => {
    const { service, resolver, pending, config } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    // A listen-all INTERNAL_IP collapses the local Hub origin to loopback.
    config.getConfig.mockReturnValue({ domain: 'example.org', userSettings: { internalIp: '0.0.0.0', port: 80 } });

    // A LAN visitor supplies a `next` pointing at the Hub's own loopback origin.
    await service.startConnect('ci-openclaw:local', 'http://127.0.0.1/phish', 'user-1', { host: '192.168.1.9' });

    // 127.0.0.1 is not routable from 192.168.x, so it must NOT be allowlisted —
    // otherwise `next` becomes a loopback open-redirect. The next is discarded and
    // the app's own URL is stored instead.
    expect(pending.create).toHaveBeenCalledWith('ci-openclaw:local', 'https://app.example.org', 'user-1');
  });

  it('allowlists the loopback Hub origin only when the caller is itself on loopback', async () => {
    const { service, resolver, pending, config } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    config.getConfig.mockReturnValue({ domain: 'example.org', userSettings: { internalIp: '0.0.0.0', port: 80 } });

    // Same loopback `next`, but this caller reached the Hub on loopback too, so the
    // origin is genuinely routable for them and the return path is honored.
    await service.startConnect('ci-openclaw:local', 'http://127.0.0.1/finish', 'user-1', { host: '127.0.0.1' });

    expect(pending.create).toHaveBeenCalledWith('ci-openclaw:local', 'http://127.0.0.1/finish', 'user-1');
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

  const FINISHING_PATH = '/memory-connect/finishing?app=ci-openclaw%3Alocal&next=https%3A%2F%2Fapp.example.org%2F';
  const CONSUMED = {
    outcome: 'consumed',
    appUrn: 'ci-openclaw:local',
    next: 'https://app.example.org/',
    userId: 'user-1',
    redirect: 'https://app.example.org/',
  };

  it('exchanges the code, stores the key, schedules the restart, and returns the finishing interstitial', async () => {
    const { service, resolver, exchange, connections, pending, lifecycle } = makeService();
    pending.consume.mockReturnValue(CONSUMED);
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'raw-key', expiresAt: '2026-10-07T00:00:00.000Z' });

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    // The store resolves the state for THIS user and the presented code (hashed),
    // so a fresh consent grant is distinguishable from a browser replay.
    expect(pending.consume).toHaveBeenCalledWith('state-nonce', 'user-1', expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(exchange.exchange).toHaveBeenCalledWith('http://gateway:8642', 'the-code');
    expect(connections.storeConnected).toHaveBeenCalledWith(
      'ci-openclaw:local',
      'http://gateway:8642',
      'raw-key',
      '2026-10-07T00:00:00.000Z',
      'user-1',
    );
    // The restart is scheduled (fire-and-track, skipPull — env-only change), NOT
    // awaited to completion: the browser must not hang out the compose cycle.
    expect(lifecycle.held.restart).toHaveBeenCalledWith({ skipPull: true, reason: 'memory-connect' });
    expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
    // The real outcome is recorded so a later replay repeats this exact redirect.
    expect(pending.recordOutcome).toHaveBeenCalledWith('state-nonce', FINISHING_PATH);
    expect(result).toEqual({ next: FINISHING_PATH });
  });

  it('rewrites the env in place and returns the app URL directly when the app is down (nothing to watch)', async () => {
    const { service, resolver, exchange, pending, lifecycle, appsRepository } = makeService();
    pending.consume.mockReturnValue(CONSUMED);
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'raw-key', expiresAt: '2026-10-07T00:00:00.000Z' });
    appsRepository.getAppByUrn.mockResolvedValue({ status: 'stopped' });

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    expect(lifecycle.regenerateAppEnv).toHaveBeenCalledWith('ci-openclaw:local');
    expect(lifecycle.held.restart).not.toHaveBeenCalled();
    expect(result).toEqual({ next: 'https://app.example.org/' });
    // Every consumed outcome records its actual redirect — deferred lands on
    // the app URL, so a replay repeats that, never the finishing interstitial.
    expect(pending.recordOutcome).toHaveBeenCalledWith('state-nonce', 'https://app.example.org/');
  });

  it('still lands on the app (no error marker) when scheduling the restart fails — parity with the awaited flow', async () => {
    const { service, resolver, exchange, pending, lifecycle, logger } = makeService();
    pending.consume.mockReturnValue(CONSUMED);
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'raw-key', expiresAt: '2026-10-07T00:00:00.000Z' });
    lifecycle.held.restart.mockRejectedValue(new Error('queue unavailable'));

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    expect(result).toEqual({ next: 'https://app.example.org/' });
    expect(pending.recordOutcome).toHaveBeenCalledWith('state-nonce', 'https://app.example.org/');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('failed to apply the connection change'), expect.any(Error));
  });

  // A grant can be taken away while the person is on CI Memory's consent page.
  it('refuses at the callback, before any exchange, when the restart grant is gone', async () => {
    const { service, resolver, exchange, connections, pending, lifecycle } = makeService();
    pending.consume.mockReturnValue(CONSUMED);
    resolver.findProvider.mockResolvedValue(PROVIDER);
    const mayConnect = vi.fn().mockResolvedValue(false);

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1', mayConnect);

    expect(mayConnect).toHaveBeenCalledWith('ci-openclaw:local');
    expect(exchange.exchange).not.toHaveBeenCalled();
    expect(exchange.revoke).not.toHaveBeenCalled();
    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(lifecycle.held.restart).not.toHaveBeenCalled();
    expect(pending.recordOutcome).toHaveBeenCalledWith('state-nonce', '/?memoryConnect=denied');
    expect(result).toEqual({ next: '/?memoryConnect=denied', error: true });
  });

  it('finishes the connect when the person still holds the restart grant', async () => {
    const { service, resolver, exchange, pending } = makeService();
    pending.consume.mockReturnValue(CONSUMED);
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'raw-key', expiresAt: '2026-10-07T00:00:00.000Z' });

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1', vi.fn().mockResolvedValue(true));

    expect(exchange.exchange).toHaveBeenCalledWith('http://gateway:8642', 'the-code');
    expect(result).toEqual({ next: FINISHING_PATH });
  });

  it('rejects an invalid/expired state without exchanging', async () => {
    const { service, pending, exchange } = makeService();
    pending.consume.mockReturnValue({ outcome: 'unknown' });

    await expect(service.handleCallback('the-code', 'bad-state', 'user-1')).rejects.toThrow(/Invalid or expired/);
    expect(exchange.exchange).not.toHaveBeenCalled();
  });

  it('sends a foreign user to the dashboard without exchanging or learning the app URL', async () => {
    // The store reports 'foreign' for a state bound to another Hub user — and
    // crucially does NOT consume it, so the initiator's flow survives the hit.
    const { service, exchange, connections, pending, lifecycle } = makeService();
    pending.consume.mockReturnValue({ outcome: 'foreign' });

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-2');

    expect(exchange.exchange).not.toHaveBeenCalled();
    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(lifecycle.held.restart).not.toHaveBeenCalled();
    // Same landing as an unknown/expired state, so a probing non-initiator can't
    // tell 'foreign' from 'unknown', and the real user whose session drifted
    // still gets a failure toast.
    expect(result).toEqual({ next: '/?memoryConnect=error', error: true });
  });

  it('routes a replayed state to its RECORDED redirect without re-exchanging or restarting', async () => {
    // The browser refreshing the callback URL after an aborted navigation: the
    // first request already exchanged the (single-use) code and scheduled the
    // restart, recording the finishing path — the replay repeats it.
    const { service, exchange, connections, pending, lifecycle } = makeService();
    pending.consume.mockReturnValue({
      outcome: 'replayed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.org/',
      userId: 'user-1',
      redirect: FINISHING_PATH,
    });

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    expect(exchange.exchange).not.toHaveBeenCalled();
    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(lifecycle.held.restart).not.toHaveBeenCalled();
    expect(result).toEqual({ next: FINISHING_PATH });
  });

  it('replays a FAILED attempt to the app URL, never fabricating a finishing/success redirect', async () => {
    // The first attempt failed downstream (exchange threw / provider gone), so
    // its recorded redirect stayed the app URL — the replay must land there,
    // where the connect interstitial re-appears.
    const { service, exchange, pending, lifecycle } = makeService();
    pending.consume.mockReturnValue({
      outcome: 'replayed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.org/',
      userId: 'user-1',
      redirect: 'https://app.example.org/',
    });

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    expect(exchange.exchange).not.toHaveBeenCalled();
    expect(lifecycle.held.restart).not.toHaveBeenCalled();
    expect(result).toEqual({ next: 'https://app.example.org/' });
  });

  it('runs the full flow when the store re-opens a consumed state for a fresh code (deny → back → allow)', async () => {
    // The store returns 'consumed' for a different code hash on a tombstoned
    // state; the service must treat it exactly like a first consume — the
    // user's second Allow carries a fresh, valid, single-use code.
    const { service, resolver, exchange, connections, pending, lifecycle } = makeService();
    pending.consume.mockReturnValue(CONSUMED);
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'fresh-key', expiresAt: '2026-10-07T00:00:00.000Z' });

    const result = await service.handleCallback('fresh-code', 'state-nonce', 'user-1');

    expect(exchange.exchange).toHaveBeenCalledWith('http://gateway:8642', 'fresh-code');
    expect(connections.storeConnected).toHaveBeenCalled();
    expect(lifecycle.held.restart).toHaveBeenCalledWith({ skipPull: true, reason: 'memory-connect' });
    expect(result).toEqual({ next: FINISHING_PATH });
    // Restarted under the hold the callback took before the exchange, never by waiting for the app.
    expect(lifecycle.withAppHeldUnlessBusy).toHaveBeenCalledWith('ci-openclaw:local', expect.any(Function));
    expect(RESTARTS_THAT_WAIT_FOR_THE_APP.has('memory-connect')).toBe(false);
  });

  it('returns the app URL with error on app mismatch (does not store), so the user lands back on the app', async () => {
    const { service, resolver, exchange, connections, pending } = makeService();
    pending.consume.mockReturnValue(CONSUMED);
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockResolvedValue({ appUrn: 'ci-hermes:local', key: 'raw-key' });

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(pending.recordOutcome).toHaveBeenCalledWith('state-nonce', 'https://app.example.org/');
    expect(result).toEqual({ next: 'https://app.example.org/', error: true });
  });

  it('returns the app URL with error when the exchange throws (no dead-end on the dashboard)', async () => {
    const { service, resolver, exchange, connections, pending } = makeService();
    pending.consume.mockReturnValue(CONSUMED);
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.exchange.mockRejectedValue(new Error('ci-memory unreachable'));

    const result = await service.handleCallback('the-code', 'state-nonce', 'user-1');

    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(pending.recordOutcome).toHaveBeenCalledWith('state-nonce', 'https://app.example.org/');
    expect(result).toEqual({ next: 'https://app.example.org/', error: true });
  });
});

describe('MemoryConnectService.abandonConnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('consumes the pending state (bound to the user, no code) and returns the originating app URL', () => {
    const { service, pending } = makeService();
    pending.consume.mockReturnValue({
      outcome: 'consumed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.org/',
      userId: 'user-1',
      redirect: 'https://app.example.org/',
    });

    expect(service.abandonConnect('state-nonce', 'user-1')).toBe('https://app.example.org/');
    expect(pending.consume).toHaveBeenCalledWith('state-nonce', 'user-1');
  });

  it('resolves a replayed deny (refresh of the error redirect) to its recorded redirect', () => {
    const { service, pending } = makeService();
    pending.consume.mockReturnValue({
      outcome: 'replayed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.org/',
      userId: 'user-1',
      redirect: 'https://app.example.org/',
    });

    expect(service.abandonConnect('state-nonce', 'user-1')).toBe('https://app.example.org/');
  });

  it('sends a foreign user to the Hub root — a co-user replaying a deny URL learns nothing', () => {
    const { service, pending } = makeService();
    pending.consume.mockReturnValue({ outcome: 'foreign' });

    expect(service.abandonConnect('state-nonce', 'user-2')).toBe('/');
  });

  it('falls back to the Hub root when the state is missing or unknown', () => {
    const { service, pending } = makeService();
    pending.consume.mockReturnValue({ outcome: 'unknown' });

    expect(service.abandonConnect(undefined, 'user-1')).toBe('/');
    expect(service.abandonConnect('gone', 'user-1')).toBe('/');
  });

  it("carries the provider's error code onto the dashboard for an unknown state, so the toast can tell a failure from a decline", () => {
    // The fail-silent behavior CI-Engineering#75 set out to remove: a
    // csrf_failed / login_required consent failure must not land on a bare '/'
    // indistinguishable from a user-initiated decline.
    const { service, pending } = makeService();
    pending.consume.mockReturnValue({ outcome: 'unknown' });

    expect(service.abandonConnect(undefined, 'user-1', 'csrf_failed')).toBe('/?memoryConnect=csrf_failed');
  });

  it('logs (does not swallow) a provider error even when the state resolves to an app redirect', () => {
    const { service, pending, logger } = makeService();
    pending.consume.mockReturnValue({
      outcome: 'consumed',
      appUrn: 'ci-openclaw:local',
      next: 'https://app.example.org/',
      userId: 'user-1',
      redirect: 'https://app.example.org/',
    });

    expect(service.abandonConnect('state-nonce', 'user-1', 'login_required')).toBe('https://app.example.org/');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('login_required'));
  });
});

describe('MemoryConnectService side effects', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skip marks the app skipped', async () => {
    const { service, connections } = makeService();
    await service.skip('ci-openclaw:local');
    expect(connections.markSkipped).toHaveBeenCalledWith('ci-openclaw:local', undefined);
  });

  it('getStatus for another Hub person leaves the connection someone else made alone (#2080)', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.getRow.mockResolvedValue({ id: 1, state: 'connected', hubUserId: 1, encryptedKey: 'enc', serverUrl: 'http://gateway:8642' });
    connections.getActiveConnection.mockResolvedValue({
      id: 1,
      state: 'connected',
      hubUserId: 1,
      encryptedKey: 'enc',
      serverUrl: 'http://gateway:8642',
    });
    connections.getState.mockResolvedValue('unconfigured');

    const status = await service.getStatus('ci-openclaw:local', undefined, '2');

    // The caller's own state, so the wrapper offers them a connect of their own.
    expect(status.state).toBe('unconfigured');
    expect(connections.getState).toHaveBeenCalledWith('ci-openclaw:local', '2');
    expect(exchange.revoke).not.toHaveBeenCalled();
    expect(connections.clear).not.toHaveBeenCalled();
    expect(lifecycle.held.restart).not.toHaveBeenCalled();
    expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
  });

  it("getStatus leaves another person's token alone while another operation holds the app, for a later poll", async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.getRow.mockResolvedValue({ state: 'connected', hubUserId: 1, encryptedKey: 'enc', serverUrl: 'http://gateway:8642' });
    connections.getState.mockResolvedValue('connected');
    lifecycle.withAppHeldUnlessBusy.mockResolvedValue({ busy: 'start' });

    await service.getStatus('ci-openclaw:local', undefined, '2');

    expect(exchange.revoke).not.toHaveBeenCalled();
    expect(connections.clear).not.toHaveBeenCalled();
    expect(lifecycle.held.restart).not.toHaveBeenCalled();
  });

  it('disconnect revokes on ci-memory, clears state, and restarts', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);

    await service.disconnect('ci-openclaw:local');

    expect(exchange.revoke).toHaveBeenCalledWith('http://gateway:8642', 'ci-openclaw:local');
    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local', undefined);
    expect(lifecycle.withAppHeld).toHaveBeenCalledWith('ci-openclaw:local', expect.any(Function));
    expect(lifecycle.held.restartAndWait).toHaveBeenCalledWith({ skipPull: true });
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
  });

  // Revoking and then waiting for the app left it on a revoked key for as long as the operation
  // holding it lasted, and kept the request open as long.
  it('disconnect is refused with the 409 of the operation holding the app, and revokes nothing', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    lifecycle.withAppHeld.mockRejectedValue(new TranslatableError('APP_ERROR_START_IN_PROGRESS', { id: 'ci-openclaw' }, HttpStatus.CONFLICT));

    await expect(service.disconnect('ci-openclaw:local')).rejects.toMatchObject({ status: HttpStatus.CONFLICT });

    expect(exchange.revoke).not.toHaveBeenCalled();
    expect(connections.clear).not.toHaveBeenCalled();
  });

  it('disconnect does not START an app the user had stopped, but DOES scrub its env', async () => {
    // A restart is compose down + up, so restarting a stopped app would silently bring
    // it back. Its env must still be rewritten though — deferring that too would leave
    // the revoked token sitting in app.env until the app happened to be started again.
    const { service, resolver, connections, lifecycle, appsRepository } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    appsRepository.getAppByUrn.mockResolvedValue({ status: 'stopped' });

    await service.disconnect('ci-openclaw:local');

    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local', undefined);
    expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
    expect(lifecycle.regenerateAppEnv).toHaveBeenCalledWith('ci-openclaw:local');
  });

  it.each(['backing_up', 'restoring', 'updating', 'resetting'] as const)(
    'does not restart an app mid-%s (those stop it first, and restore its run-state after)',
    async (status) => {
      // Restarting here would race the maintenance op AND leave an app the user had
      // stopped running once it finished.
      const { service, resolver, connections, lifecycle, appsRepository } = makeService();
      resolver.findProvider.mockResolvedValue(PROVIDER);
      appsRepository.getAppByUrn.mockResolvedValue({ status });

      await service.disconnect('ci-openclaw:local');

      expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local', undefined);
      expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
      expect(lifecycle.regenerateAppEnv).toHaveBeenCalledWith('ci-openclaw:local');
    },
  );

  it('disconnect throws and keeps the connection (no clear/restart) when the revoke fails', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    exchange.revoke.mockResolvedValue(false); // CI-Server never confirmed revocation

    await expect(service.disconnect('ci-openclaw:local')).rejects.toMatchObject({ message: 'MEMORY_CONNECT_DISCONNECT_NOT_CONFIRMED', status: 503 });

    // Must NOT falsely report disconnected while the key is still live server-side.
    expect(connections.clear).not.toHaveBeenCalled();
    expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
  });

  it('disconnect clears locally when the provider is unresolvable (nothing to revoke)', async () => {
    const { service, resolver, exchange, connections } = makeService();
    resolver.findProvider.mockResolvedValue(null);

    await service.disconnect('ci-openclaw:local');

    expect(exchange.revoke).not.toHaveBeenCalled();
    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local', undefined);
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
    const stale = { id: 4, hubUserId: 3, state: 'connected', keyExpiresAt: '2026-10-07T00:00:00.000Z' };
    connections.getRow.mockResolvedValue(stale);
    connections.getActiveConnection.mockResolvedValue(stale);
    exchange.isKeyValid.mockResolvedValue(false); // ci-memory reset → key dead

    const status = await service.getUiStatus('ci-openclaw:local', undefined, '3');

    // The row that was checked, by its owner: the app's newest row can belong to someone else.
    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:local', 3);
    // Must restart so the container drops the dead credential and re-prompts.
    expect(lifecycle.held.restartAndWait).toHaveBeenCalledWith({ skipPull: true });
    expect(status.state).toBe('unconfigured');
    // The stale key's expiry is cleared alongside the connection.
    expect(status.keyExpiresAt).toBeNull();
  });

  it('getUiStatus leaves a rejected key to a later poll while another operation holds the app', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.getRow.mockResolvedValue({ state: 'connected', keyExpiresAt: '2026-10-07T00:00:00.000Z' });
    exchange.isKeyValid.mockResolvedValue(false);
    lifecycle.withAppHeldUnlessBusy.mockResolvedValue({ busy: 'update' });

    const status = await service.getUiStatus('ci-openclaw:local');

    expect(connections.clear).not.toHaveBeenCalled();
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
    expect(status.state).toBe('connected');
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
      connectUrlLocal: null,
      connectable: false,
      // A non-consumer app is not "blocked" from connecting — it simply has no
      // memory integration, so there is nothing to explain.
      reason: null,
      keyExpiresAt: null,
      connectedByOther: false,
    });
    expect(resolver.findProvider).not.toHaveBeenCalled();
  });

  it('getUiStatus reports the provider as installed-but-not-ready and withholds the connect URL while ci-memory is installing', async () => {
    const { service, resolver, connections } = makeService();
    resolver.getProviderRuntimeInfo.mockResolvedValue({ status: 'starting', localOnly: false });
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

  /** Due rows that are also the connection each app runs with, which the sweep requires before it rotates. */
  function listDue(connections: ReturnType<typeof makeService>['connections'], rows: Array<{ appUrn: string } & Record<string, unknown>>) {
    connections.listConnected.mockResolvedValue(rows);
    connections.getActiveConnection.mockImplementation(async (urn: string) => rows.find((row) => row.appUrn === urn));
  }

  it('rotateDueKeys rotates a key older than the threshold and restarts the app', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    listDue(connections, [{ appUrn: 'ci-openclaw:local', hubUserId: 3, updatedAt: daysAgoIso(61) }]);
    exchange.rotate.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'fresh-key', expiresAt: '2026-10-07T00:00:00.000Z' });

    await service.rotateDueKeys();

    expect(exchange.rotate).toHaveBeenCalledWith('http://gateway:8642', 'ci-openclaw:local');
    expect(connections.storeConnected).toHaveBeenCalledWith('ci-openclaw:local', 'http://gateway:8642', 'fresh-key', '2026-10-07T00:00:00.000Z', 3);
    expect(lifecycle.withAppHeldUnlessBusy).toHaveBeenCalledWith('ci-openclaw:local', expect.any(Function));
    expect(lifecycle.held.restartAndWait).toHaveBeenCalledWith({ skipPull: true });
  });

  // Rotating retires the old key: rotating and then waiting left the app on the retired key for as
  // long as the operation holding it lasted.
  it('rotateDueKeys leaves an app another operation holds to the next sweep, its key untouched', async () => {
    const { service, resolver, exchange, connections, lifecycle, logger } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-openclaw:local', hubUserId: 3, updatedAt: daysAgoIso(61) }]);
    lifecycle.withAppHeldUnlessBusy.mockResolvedValue({ busy: 'backup' });

    await service.rotateDueKeys();

    expect(exchange.rotate).not.toHaveBeenCalled();
    expect(connections.storeConnected).not.toHaveBeenCalled();
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('left to the next sweep'));
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
    expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalled();
  });

  it('rotateDueKeys retries once and reports failure when the restart does not take', async () => {
    // `restartApp` resolves as soon as the command is PUBLISHED, so the sweep awaits the
    // real outcome instead — otherwise a failed compose would be logged as a success and
    // the app would sit on the key CI-Server just retired.
    const { service, resolver, exchange, connections, lifecycle, logger } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    listDue(connections, [{ appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) }]);
    exchange.rotate.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'fresh-key', expiresAt: '2026-10-07T00:00:00.000Z' });
    lifecycle.held.restartAndWait.mockResolvedValue(false);
    lifecycle.restartAppAndWait.mockResolvedValue(false);

    await service.rotateDueKeys();

    // The retry claims the app afresh: the first restart's hold ended when it settled.
    expect(lifecycle.held.restartAndWait).toHaveBeenCalledTimes(1);
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not restart it'));
  });

  it('rotateDueKeys does not let a restart-induced stop masquerade as a benign deferral', async () => {
    // A failed restart marks the app `stopped`. The retry then sees a down app and would
    // report 'deferred' — logging the reassuring "applies on next start" line for an app
    // that was RUNNING and that the sweep itself just knocked over onto a retired key.
    const { service, resolver, exchange, connections, lifecycle, appsRepository, logger } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    listDue(connections, [{ appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) }]);
    exchange.rotate.mockResolvedValue({ appUrn: 'ci-openclaw:local', key: 'fresh-key', expiresAt: '2026-10-07T00:00:00.000Z' });
    // Running at rotation time; the failed restart then leaves it stopped.
    appsRepository.getAppByUrn
      .mockResolvedValueOnce({ status: 'running' }) // pre-rotation liveness check
      .mockResolvedValueOnce({ status: 'running' }) // first apply
      .mockResolvedValue({ status: 'stopped' }); // retry sees the wreckage
    lifecycle.held.restartAndWait.mockResolvedValue(false);
    lifecycle.restartAppAndWait.mockResolvedValue(false);

    await service.rotateDueKeys();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not restart it'));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('applies on next start'));
  });

  it('rotateDueKeys keeps going when one app fails to rotate', async () => {
    const { service, resolver, exchange, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(PROVIDER);
    listDue(connections, [
      { appUrn: 'ci-openclaw:local', updatedAt: daysAgoIso(61) },
      { appUrn: 'ci-hermes:local', updatedAt: daysAgoIso(70) },
    ]);
    exchange.rotate
      .mockRejectedValueOnce(new Error('ci-memory down'))
      .mockResolvedValueOnce({ appUrn: 'ci-hermes:local', key: 'fresh-key', expiresAt: '2026-10-07T00:00:00.000Z' });

    await service.rotateDueKeys();

    // The second app still rotates despite the first throwing.
    expect(exchange.rotate).toHaveBeenCalledTimes(2);
    expect(lifecycle.withAppHeldUnlessBusy).toHaveBeenCalledWith('ci-hermes:local', expect.any(Function));
    expect(lifecycle.held.restartAndWait).toHaveBeenCalledTimes(1);
  });

  it('getStatus returns the state and a launcher URL built from the Hub origin', async () => {
    const { service, connections, resolver } = makeService();
    connections.getState.mockResolvedValue('unconfigured');
    resolver.getProviderRuntimeInfo.mockResolvedValue({ status: 'ready', localOnly: false });

    const status = await service.getStatus('ci-openclaw:local');

    expect(status.state).toBe('unconfigured');
    expect(status.connectUrl).toBe('https://core2-x.example.org/api/memory-connect/start?app=ci-openclaw%3Alocal');
  });

  it('getStatus withholds the connectUrl when Companion Memory is not installed (no dead-end gate)', async () => {
    const { service, connections, resolver } = makeService();
    connections.getState.mockResolvedValue('unconfigured');
    resolver.getProviderRuntimeInfo.mockResolvedValue({ status: 'absent', localOnly: false });

    const status = await service.getStatus('ci-openclaw:local');

    // A null connectUrl makes the wrapper suppress the connect gate rather than
    // link to a startConnect that would 400 with "Companion Memory is not installed".
    expect(status.connectUrl).toBeNull();
  });

  it('getStatus withholds the connectUrl while Companion Memory is only installing (not reachable yet)', async () => {
    const { service, connections, resolver } = makeService();
    connections.getState.mockResolvedValue('unconfigured');
    resolver.getProviderRuntimeInfo.mockResolvedValue({ status: 'starting', localOnly: false });

    const status = await service.getStatus('ci-openclaw:local');

    // The wrapper gate stays suppressed until ci-memory is actually running,
    // rather than linking to a startConnect that 400s with "not reachable yet".
    expect(status.connectUrl).toBeNull();
  });

  it('getStatus still returns state (connectUrl null) when the provider lookup fails', async () => {
    const { service, connections, resolver } = makeService();
    connections.getState.mockResolvedValue('unconfigured');
    resolver.getProviderRuntimeInfo.mockRejectedValue(new Error('db blip'));

    const status = await service.getStatus('ci-openclaw:local');

    // Resilience: a transient provider-lookup failure must not 500 the poll.
    expect(status.state).toBe('unconfigured');
    expect(status.connectUrl).toBeNull();
  });

  it('handleUninstall of Companion Memory clears + restarts every connected consumer', async () => {
    const { service, resolver, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(null); // provider already gone from the install list
    connections.listConnected.mockResolvedValue([
      { appUrn: 'ci-memory:ci-marketplace', hubUserId: 1, updatedAt: '2026-07-09T00:00:00.000Z' },
      { appUrn: 'ci-openclaw:ci-marketplace', hubUserId: 1, updatedAt: '2026-07-09T00:00:00.000Z' },
      { appUrn: 'ci-hermes:ci-marketplace', hubUserId: 2, updatedAt: '2026-07-09T00:00:00.000Z' },
    ]);

    await service.handleUninstall('ci-memory:ci-marketplace');

    // Each consumer's connected row is cleared + restarted; the provider row itself is skipped.
    expect(connections.clear).toHaveBeenCalledWith('ci-openclaw:ci-marketplace', 1);
    expect(connections.clear).toHaveBeenCalledWith('ci-hermes:ci-marketplace', 2);
    expect(connections.clear.mock.calls.map(([urn]) => urn)).not.toContain('ci-memory:ci-marketplace');
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-openclaw:ci-marketplace', skipPull: true, waitForApp: true });
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-hermes:ci-marketplace', skipPull: true, waitForApp: true });
  });

  it('re-arms the remaining consumers even when one fails, and never rejects the sweep (#906)', async () => {
    const { service, resolver, connections, lifecycle } = makeService();
    resolver.findProvider.mockResolvedValue(null);
    connections.listConnected.mockResolvedValue([
      { appUrn: 'ci-openclaw:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
      { appUrn: 'ci-hermes:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' },
    ]);
    // One consumer wedges while being cleared; it must not strand the other.
    connections.clear.mockImplementation(async (urn: string) => {
      if (urn === 'ci-openclaw:ci-marketplace') throw new Error('clear failed');
    });

    await expect(service.handleUninstall('ci-memory:ci-marketplace')).resolves.toBeUndefined();

    // The healthy consumer is still cleared + restarted; the failed one never reached restart.
    expect(lifecycle.restartAppAndWait).toHaveBeenCalledWith({ appUrn: 'ci-hermes:ci-marketplace', skipPull: true, waitForApp: true });
    expect(lifecycle.restartAppAndWait).not.toHaveBeenCalledWith({ appUrn: 'ci-openclaw:ci-marketplace', skipPull: true, waitForApp: true });
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

  it('propagates a DB error on a real row instead of dropping the consumer (fails closed)', async () => {
    const { service, connections, appsRepository } = makeService();
    connections.listConnected.mockResolvedValue([{ appUrn: 'ci-hermes:ci-marketplace', updatedAt: '2026-07-09T00:00:00.000Z' }]);
    // A transient infra error on a genuinely-connected row must NOT be swallowed —
    // otherwise the uninstall/reset guard would see 0 consumers and destroy the store.
    appsRepository.getAppByUrn.mockRejectedValue(new Error('db pool exhausted'));

    await expect(service.listConnectedConsumers()).rejects.toThrow('db pool exhausted');
  });
});

/**
 * One container, one key: OpenClaw runs with the connection of whoever connected it last. Looking at
 * the app must not change that; only a finished connect does (Companion-Hub#2080).
 */
describe('MemoryConnectService with two Hub people', () => {
  beforeEach(() => vi.clearAllMocks());

  const APP = 'ci-openclaw:local';
  // Person 2 connected; person 1 is the Hub owner looking at the app.
  const PERSON_2_ROW = {
    id: 21,
    appUrn: APP,
    hubUserId: 2,
    state: 'connected',
    encryptedKey: 'enc-2',
    serverUrl: 'http://gateway:8642',
    keyExpiresAt: null,
  };
  const CONSUMED_BY_1 = { outcome: 'consumed', appUrn: APP, next: 'https://app.example.org/', userId: '1', redirect: 'https://app.example.org/' };

  function withPerson2Connected() {
    const ctx = makeService();
    ctx.resolver.findProvider.mockResolvedValue(PROVIDER);
    ctx.connections.getActiveConnection.mockResolvedValue(PERSON_2_ROW);
    ctx.connections.listConnected.mockResolvedValue([PERSON_2_ROW]);
    ctx.connections.getRow.mockImplementation(async (_urn: string, hubUserId?: string | null) =>
      String(hubUserId) === '1' ? undefined : PERSON_2_ROW,
    );
    ctx.connections.getState.mockImplementation(async (_urn: string, hubUserId?: string | null) =>
      String(hubUserId) === '1' ? 'unconfigured' : 'connected',
    );

    return ctx;
  }

  it("person 1 opening the app page leaves person 2's connection running and says whose it is", async () => {
    const { service, exchange, connections, lifecycle } = withPerson2Connected();

    const status = await service.getUiStatus(APP, undefined, '1');

    expect(status.state).toBe('unconfigured');
    expect(status.connectedByOther).toBe(true);
    expect(exchange.revoke).not.toHaveBeenCalled();
    // Person 2's key is not even probed: it is not the caller's to judge.
    expect(exchange.isKeyValid).not.toHaveBeenCalled();
    expect(connections.clear).not.toHaveBeenCalled();
    expect(lifecycle.held.restart).not.toHaveBeenCalled();
    expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
  });

  it("person 2 sees their own connection as connected, not as someone else's", async () => {
    const { service } = withPerson2Connected();

    const status = await service.getUiStatus(APP, undefined, '2');

    expect(status.state).toBe('connected');
    expect(status.connectedByOther).toBe(false);
  });

  it("person 1 who chose Not now still learns the app runs on person 2's memory", async () => {
    const { service, connections } = withPerson2Connected();
    connections.getRow.mockImplementation(async (_urn: string, hubUserId?: string | null) =>
      String(hubUserId) === '1' ? { id: 11, appUrn: APP, hubUserId: 1, state: 'skipped', encryptedKey: null, keyExpiresAt: null } : PERSON_2_ROW,
    );

    const status = await service.getUiStatus(APP, undefined, '1');

    expect(status.state).toBe('skipped');
    expect(status.connectedByOther).toBe(true);
  });

  it("person 1 finishing Connect revokes person 2's key BEFORE minting their own, then takes over", async () => {
    const { service, exchange, connections, pending, lifecycle } = withPerson2Connected();
    pending.consume.mockReturnValue(CONSUMED_BY_1);
    exchange.exchange.mockResolvedValue({ appUrn: APP, key: 'key-1', expiresAt: '2026-12-01T00:00:00.000Z' });

    await service.handleCallback('code-1', 'state-1', '1');

    // CI Memory revokes by app: after the exchange this would also take person 1's new key.
    expect(exchange.revoke).toHaveBeenCalledWith('http://gateway:8642', APP);
    expect(exchange.revoke.mock.invocationCallOrder[0]).toBeLessThan(exchange.exchange.mock.invocationCallOrder[0]);
    expect(connections.clear).toHaveBeenCalledWith(APP, 2);
    expect(connections.storeConnected).toHaveBeenCalledWith(APP, 'http://gateway:8642', 'key-1', '2026-12-01T00:00:00.000Z', '1');
    expect(lifecycle.held.restart).toHaveBeenCalledTimes(1);
  });

  it("keeps person 2's connection and mints nothing when their key cannot be revoked", async () => {
    const { service, exchange, connections, pending } = withPerson2Connected();
    pending.consume.mockReturnValue(CONSUMED_BY_1);
    exchange.revoke.mockResolvedValue(false);

    const result = await service.handleCallback('code-1', 'state-1', '1');

    expect(result).toEqual({ next: 'https://app.example.org/', error: true });
    expect(exchange.exchange).not.toHaveBeenCalled();
    expect(connections.clear).not.toHaveBeenCalled();
    expect(connections.storeConnected).not.toHaveBeenCalled();
  });

  it('restarts the app when the exchange fails after the old key was revoked, so it stops presenting a dead key', async () => {
    const { service, exchange, pending, lifecycle } = withPerson2Connected();
    pending.consume.mockReturnValue(CONSUMED_BY_1);
    exchange.exchange.mockRejectedValue(new Error('ci-memory unreachable'));

    const result = await service.handleCallback('code-1', 'state-1', '1');

    // Person 2's connection is gone and cannot come back, so person 1 is told, not sent to the app.
    expect(result).toEqual({ next: '/?memoryConnect=previous_removed', error: true });
    expect(pending.recordOutcome).toHaveBeenCalledWith('state-1', '/?memoryConnect=previous_removed');
    expect(lifecycle.held.restart).toHaveBeenCalledWith({ skipPull: true, reason: 'memory-connect' });
  });

  it('finishes the connect when the revoked row fails to clear', async () => {
    const { service, exchange, connections, pending, logger } = withPerson2Connected();
    pending.consume.mockReturnValue(CONSUMED_BY_1);
    exchange.exchange.mockResolvedValue({ appUrn: APP, key: 'key-1', expiresAt: '2026-12-01T00:00:00.000Z' });
    connections.clear.mockRejectedValueOnce(new Error('db blip'));

    const result = await service.handleCallback('code-1', 'state-1', '1');

    expect(result.error).toBeUndefined();
    expect(connections.storeConnected).toHaveBeenCalledWith(APP, 'http://gateway:8642', 'key-1', '2026-12-01T00:00:00.000Z', '1');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not clear'), expect.any(Error));
  });

  it('two people finishing Connect at once take turns, so the second revokes the first key before minting', async () => {
    const ctx = makeService();
    ctx.resolver.findProvider.mockResolvedValue(PROVIDER);
    // A tiny memory_connection table, so each connect sees what the other stored.
    const stored: Array<{ appUrn: string; hubUserId: number }> = [];
    ctx.connections.listConnected.mockImplementation(async () => stored.map((row) => ({ ...row, state: 'connected' })));
    ctx.connections.storeConnected.mockImplementation(async (appUrn: string, _url: string, _key: string, _expires: string, hubUserId: string) => {
      stored.push({ appUrn, hubUserId: Number(hubUserId) });
    });
    ctx.connections.clear.mockImplementation(async (_appUrn: string, hubUserId: number) => {
      const index = stored.findIndex((row) => row.hubUserId === Number(hubUserId));
      if (index >= 0) {
        stored.splice(index, 1);
      }
    });
    ctx.pending.consume.mockReturnValueOnce(CONSUMED_BY_1).mockReturnValueOnce({ ...CONSUMED_BY_1, userId: '3' });
    ctx.exchange.exchange.mockImplementation(async (_url: string, code: string) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { appUrn: APP, key: `key-${code}`, expiresAt: '2026-12-01T00:00:00.000Z' };
    });

    await Promise.all([ctx.service.handleCallback('code-1', 'state-1', '1'), ctx.service.handleCallback('code-3', 'state-3', '3')]);

    // Without turns both find nobody connected, neither revokes and CI Memory ends up with two owners.
    expect(ctx.exchange.revoke).toHaveBeenCalledTimes(1);
    expect(stored).toEqual([{ appUrn: APP, hubUserId: 3 }]);
  });

  it('person 2 reconnecting replaces only their own key (no revoke)', async () => {
    const { service, exchange, connections, pending } = withPerson2Connected();
    pending.consume.mockReturnValue({ ...CONSUMED_BY_1, userId: '2' });
    exchange.exchange.mockResolvedValue({ appUrn: APP, key: 'key-2b', expiresAt: '2026-12-01T00:00:00.000Z' });

    await service.handleCallback('code-2', 'state-2', '2');

    expect(exchange.revoke).not.toHaveBeenCalled();
    expect(connections.clear).not.toHaveBeenCalled();
    expect(connections.storeConnected).toHaveBeenCalledWith(APP, 'http://gateway:8642', 'key-2b', '2026-12-01T00:00:00.000Z', '2');
  });

  it("refuses person 1's Disconnect of person 2's connection without touching it", async () => {
    const { service, exchange, connections, lifecycle } = withPerson2Connected();

    await expect(service.disconnect(APP, '1')).rejects.toMatchObject({ message: 'MEMORY_CONNECT_DISCONNECT_REFUSED', status: 403 });

    expect(exchange.revoke).not.toHaveBeenCalled();
    expect(connections.clear).not.toHaveBeenCalled();
    expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
  });

  it('lets person 2 disconnect their own connection', async () => {
    const { service, exchange, connections, lifecycle } = withPerson2Connected();

    await service.disconnect(APP, '2');

    expect(exchange.revoke).toHaveBeenCalledWith('http://gateway:8642', APP);
    expect(connections.clear).toHaveBeenCalledWith(APP, '2');
    expect(lifecycle.held.restartAndWait).toHaveBeenCalledWith({ skipPull: true });
  });

  it("clears person 1's own dead key without restarting the app that runs on person 2's", async () => {
    const { service, exchange, connections, lifecycle } = withPerson2Connected();
    connections.getRow.mockImplementation(async (_urn: string, hubUserId?: string | null) =>
      String(hubUserId) === '1' ? { id: 11, appUrn: APP, hubUserId: 1, state: 'connected', encryptedKey: 'enc-1', keyExpiresAt: null } : PERSON_2_ROW,
    );
    exchange.isKeyValid.mockResolvedValue(false);

    await service.getUiStatus(APP, undefined, '1');

    expect(connections.clear).toHaveBeenCalledWith(APP, 1);
    expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
  });

  it("does not rotate person 2's listed key once person 1's Connect replaced it, since CI Memory rotates by app", async () => {
    const { service, exchange, connections } = withPerson2Connected();
    const due = { ...PERSON_2_ROW, updatedAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString() };
    connections.listConnected.mockResolvedValue([due]);
    // Person 1 finished Connect after the sweep read its list: theirs is the connection the app runs with now.
    connections.getActiveConnection.mockResolvedValue({ ...PERSON_2_ROW, id: 11, hubUserId: 1, encryptedKey: 'enc-1' });

    await service.rotateDueKeys();

    expect(exchange.rotate).not.toHaveBeenCalled();
    expect(connections.storeConnected).not.toHaveBeenCalled();
  });

  it('clears a leftover connected row of person 1 when person 2 disconnects, so the app is not given its revoked key', async () => {
    const { service, connections } = withPerson2Connected();
    // Left behind when person 2's Connect replaced person 1 and clearing person 1's row failed.
    const leftover = { ...PERSON_2_ROW, id: 11, hubUserId: 1, encryptedKey: 'enc-1' };
    connections.listConnected.mockResolvedValue([PERSON_2_ROW, leftover]);

    await service.disconnect(APP, '2');

    expect(connections.clear).toHaveBeenCalledWith(APP, '2');
    expect(connections.clear).toHaveBeenCalledWith(APP, 1);
  });

  it("tells OpenClaw's own gate that another person's connection runs the app", async () => {
    const { service } = withPerson2Connected();

    expect(await service.getStatus(APP, undefined, '1')).toMatchObject({ state: 'unconfigured', connectedByOther: true });
    expect(await service.getStatus(APP, undefined, '2')).toMatchObject({ state: 'connected', connectedByOther: false });
  });

  it('lands on the app, not on a removed-connection message, when nothing was replaced', async () => {
    const { service, exchange, connections, pending } = withPerson2Connected();
    connections.listConnected.mockResolvedValue([]);
    connections.getActiveConnection.mockResolvedValue(undefined);
    pending.consume.mockReturnValue(CONSUMED_BY_1);
    exchange.exchange.mockRejectedValue(new Error('ci-memory unreachable'));

    expect(await service.handleCallback('code-1', 'state-1', '1')).toEqual({ next: 'https://app.example.org/', error: true });
  });

  it('revokes the new key when it cannot be stored, so no valid key is left that nobody holds', async () => {
    const { service, exchange, connections, pending, lifecycle } = withPerson2Connected();
    pending.consume.mockReturnValue(CONSUMED_BY_1);
    exchange.exchange.mockResolvedValue({ appUrn: APP, key: 'key-1', expiresAt: '2026-12-01T00:00:00.000Z' });
    connections.storeConnected.mockRejectedValue(new Error('db pool exhausted'));

    const result = await service.handleCallback('code-1', 'state-1', '1');

    // Once to replace person 2's connection, once more after the exchange for the key that was never stored.
    expect(exchange.revoke).toHaveBeenCalledTimes(2);
    expect(exchange.revoke.mock.invocationCallOrder[1]).toBeGreaterThan(exchange.exchange.mock.invocationCallOrder[0]);
    expect(result).toEqual({ next: '/?memoryConnect=previous_removed', error: true });
    expect(lifecycle.held.restart).toHaveBeenCalled();
  });

  it('revokes an unstored key on a plain connect too, and lands back on the app', async () => {
    const { service, exchange, connections, pending, lifecycle } = withPerson2Connected();
    connections.listConnected.mockResolvedValue([]);
    connections.getActiveConnection.mockResolvedValue(undefined);
    pending.consume.mockReturnValue(CONSUMED_BY_1);
    exchange.exchange.mockResolvedValue({ appUrn: APP, key: 'key-1', expiresAt: '2026-12-01T00:00:00.000Z' });
    connections.storeConnected.mockRejectedValue(new Error('db pool exhausted'));

    const result = await service.handleCallback('code-1', 'state-1', '1');

    expect(exchange.revoke).toHaveBeenCalledTimes(1);
    expect(exchange.revoke.mock.invocationCallOrder[0]).toBeGreaterThan(exchange.exchange.mock.invocationCallOrder[0]);
    expect(result).toEqual({ next: 'https://app.example.org/', error: true });
    // The exchange replaced any earlier key of this person's, so the app must stop presenting it.
    expect(lifecycle.held.restart).toHaveBeenCalled();
  });

  it("clears this person's own earlier connection when the new key cannot be stored, so the restart does not hand its revoked key back", async () => {
    const { service, exchange, connections, pending } = withPerson2Connected();
    const ownEarlier = { ...PERSON_2_ROW, id: 11, hubUserId: 1, encryptedKey: 'enc-1-old' };
    connections.listConnected.mockResolvedValue([ownEarlier]);
    connections.getActiveConnection.mockResolvedValue(ownEarlier);
    pending.consume.mockReturnValue(CONSUMED_BY_1);
    exchange.exchange.mockResolvedValue({ appUrn: APP, key: 'key-1', expiresAt: '2026-12-01T00:00:00.000Z' });
    connections.storeConnected.mockRejectedValue(new Error('db pool exhausted'));

    await service.handleCallback('code-1', 'state-1', '1');

    expect(connections.clear).toHaveBeenCalledWith(APP, 1);
  });

  it('leaves a key alone that a Connect replaced while it was being checked', async () => {
    const { service, exchange, connections, lifecycle } = withPerson2Connected();
    const stale = { ...PERSON_2_ROW, encryptedKey: 'enc-2-old' };
    // The status read loads the old key; by the time the cleanup holds the lock, a Connect stored a new one.
    connections.getRow.mockResolvedValueOnce(stale).mockResolvedValue(PERSON_2_ROW);
    connections.getActiveConnection.mockResolvedValue(stale);
    exchange.isKeyValid.mockResolvedValue(false);

    const status = await service.getUiStatus(APP, undefined, '2');

    expect(connections.clear).not.toHaveBeenCalled();
    expect(lifecycle.held.restartAndWait).not.toHaveBeenCalled();
    expect(status.state).toBe('connected');
  });

  it('clears a rejected key only while holding the app lock', async () => {
    const { service, exchange, connections } = withPerson2Connected();
    exchange.isKeyValid.mockResolvedValue(false);
    // A Disconnect holds the lock until CI Memory answers its revoke.
    let answerRevoke: (revoked: boolean) => void = () => {};
    exchange.revoke.mockReturnValueOnce(new Promise<boolean>((resolve) => (answerRevoke = resolve)));
    const disconnecting = service.disconnect(APP, '2');
    await vi.waitFor(() => expect(exchange.revoke).toHaveBeenCalled());

    const reading = service.getUiStatus(APP, undefined, '2');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connections.clear).not.toHaveBeenCalled();

    answerRevoke(true);
    await Promise.all([disconnecting, reading]);
    expect(connections.clear).toHaveBeenCalled();
  });
});

/**
 * A connection with no Hub person on it (`hub_user_id` 0, from before connections were per person)
 * is nobody's: it reads as connected for everyone and anyone who can open the app page may disconnect it.
 */
describe('MemoryConnectService with an install-global connection', () => {
  beforeEach(() => vi.clearAllMocks());

  const APP = 'ci-openclaw:local';
  const GLOBAL_ROW = {
    id: 5,
    appUrn: APP,
    hubUserId: 0,
    state: 'connected',
    encryptedKey: 'enc-0',
    serverUrl: 'http://gateway:8642',
    keyExpiresAt: null,
  };

  function withGlobalConnection() {
    const ctx = makeService();
    ctx.resolver.findProvider.mockResolvedValue(PROVIDER);
    ctx.connections.getActiveConnection.mockResolvedValue(GLOBAL_ROW);
    ctx.connections.listConnected.mockResolvedValue([GLOBAL_ROW]);
    ctx.connections.getRow.mockImplementation(async (_urn: string, hubUserId?: string | number | null) =>
      hubUserId == null || Number(hubUserId) === 0 ? GLOBAL_ROW : undefined,
    );
    ctx.connections.getState.mockResolvedValue('unconfigured');

    return ctx;
  }

  it("reads as connected, not as someone else's, on the app page and on the gate", async () => {
    const { service } = withGlobalConnection();

    expect(await service.getUiStatus(APP, undefined, '1')).toMatchObject({ state: 'connected', connectedByOther: false });
    expect(await service.getStatus(APP, undefined, '1')).toMatchObject({ state: 'connected', connectedByOther: false });
  });

  it('lets anyone disconnect it', async () => {
    const { service, exchange, connections, lifecycle } = withGlobalConnection();

    await service.disconnect(APP, '1');

    expect(exchange.revoke).toHaveBeenCalledWith('http://gateway:8642', APP);
    expect(connections.clear).toHaveBeenCalledWith(APP, 0);
    expect(lifecycle.held.restartAndWait).toHaveBeenCalledWith({ skipPull: true });
  });

  it('keeps it when a gate with no Hub person on it chooses Not now', async () => {
    const { service, connections } = withGlobalConnection();

    await service.skip(APP, null);

    expect(connections.markSkipped).not.toHaveBeenCalled();
  });

  it("refuses a Disconnect with no Hub person on it once a person's connection runs the app", async () => {
    const { service, exchange, connections } = withGlobalConnection();
    connections.getActiveConnection.mockResolvedValue({ ...GLOBAL_ROW, id: 6, hubUserId: 2 });

    await expect(service.disconnect(APP, '')).rejects.toMatchObject({ message: 'MEMORY_CONNECT_DISCONNECT_REFUSED', status: 403 });
    expect(exchange.revoke).not.toHaveBeenCalled();
  });

  it('clears its key when CI Memory rejects it, whoever is looking', async () => {
    const { service, exchange, connections, lifecycle } = withGlobalConnection();
    exchange.isKeyValid.mockResolvedValue(false);

    const status = await service.getUiStatus(APP, undefined, '1');

    expect(connections.clear).toHaveBeenCalledWith(APP, 0);
    expect(lifecycle.held.restartAndWait).toHaveBeenCalled();
    expect(status).toMatchObject({ state: 'unconfigured', connectedByOther: false });
  });
});
