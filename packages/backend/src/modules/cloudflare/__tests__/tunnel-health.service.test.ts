import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TunnelHealthService } from '../tunnel-health.service';

const { axiosGet } = vi.hoisted(() => ({ axiosGet: vi.fn() }));

vi.mock('axios', () => ({ default: { get: axiosGet } }));

/**
 * The tunnel-health signal decides whether the connect surfaces offer the public
 * launcher at all, so the properties that matter are: it never blocks the caller,
 * a cold read is `unknown` (never a failure), and a single blip cannot flip a
 * healthy Hub to `down`.
 */
function makeService(overrides: { tunnelToken?: string | null; domain?: string; hubSubdomain?: string; containerRunning?: boolean } = {}) {
  // `in`, not `??`: an explicit `tunnelToken: null` is the "no tunnel configured"
  // case and must not fall through to the default.
  const cloudflareClient = {
    getTunnelToken: vi.fn().mockReturnValue('tunnelToken' in overrides ? overrides.tunnelToken : 'tunnel-token'),
  };
  const deviceRegistration = {
    getFirstDeviceRegistration: vi.fn().mockResolvedValue({ hubSubdomain: overrides.hubSubdomain ?? 'hub-core2-acme' }),
  };
  const configService = { getConfig: vi.fn().mockReturnValue({ domain: overrides.domain ?? 'companionintelligence.com' }) };
  const dockerReadFacade = { isContainerRunning: vi.fn().mockResolvedValue(overrides.containerRunning ?? true) };
  const moduleRef = { get: vi.fn().mockReturnValue(dockerReadFacade) };

  const service = new TunnelHealthService(cloudflareClient as never, deviceRegistration as never, configService as never, moduleRef as never);

  return { service, cloudflareClient, deviceRegistration, configService, dockerReadFacade };
}

beforeEach(() => {
  vi.clearAllMocks();
  axiosGet.mockResolvedValue({ status: 200, data: '<html>hub</html>' });
});

describe('TunnelHealthService.getHealth', () => {
  it('returns unknown on a cold read without blocking, then warms the cache in the background', async () => {
    const { service } = makeService();

    // The very first read must be synchronous and non-committal: `/state` is on
    // every consumer app's navigation path and must never wait on a probe.
    expect(service.getHealth()).toBe('unknown');

    // Poll rather than a single setImmediate: the background refresh now awaits a
    // cold `import('../docker/docker-read.facade')` whose module subtree is not
    // guaranteed to resolve within one macrotask, which would make a single flush
    // flaky.
    await vi.waitFor(() => expect(service.getHealth()).toBe('up'));
  });

  it('serves the cached verdict on subsequent reads without re-probing', async () => {
    const { service } = makeService();

    await service.getHealthNow();
    axiosGet.mockClear();

    expect(service.getHealth()).toBe('up');
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('serves the stale verdict without blocking once past the TTL, then re-probes in the background', async () => {
    // Fake only Date so the cache can be aged deterministically; real timers keep
    // the background refresh and vi.waitFor working.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { service } = makeService();

      await service.getHealthNow();
      axiosGet.mockClear();

      // Within the TTL: served from cache, no re-probe.
      expect(service.getHealth()).toBe('up');
      expect(axiosGet).not.toHaveBeenCalled();

      // Past the TTL: the hot read still returns the cached value synchronously
      // (it must never block /state), but now schedules a background refresh.
      vi.setSystemTime(Date.now() + 60_001);
      expect(service.getHealth()).toBe('up');
      await vi.waitFor(() => expect(axiosGet).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TunnelHealthService layering', () => {
  it('reports down (not disabled) when a provisioned Hub has lost its tunnel token', async () => {
    const { service } = makeService({ tunnelToken: null });

    // The hostname is provisioned, so nothing can be routing to it without a
    // tunnel — that is broken, not "no public route by design". Definite, so it
    // takes effect on the first observation rather than waiting for the threshold.
    expect(await service.getHealthNow()).toBe('down');
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('reports disabled on the local/E2E domain', async () => {
    const { service } = makeService({ domain: 'ci.localhost' });

    expect(await service.getHealthNow()).toBe('disabled');
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('reports disabled when the appliance has no public origin', async () => {
    const { service } = makeService({ hubSubdomain: '' });

    expect(await service.getHealthNow()).toBe('disabled');
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('reports down immediately when cloudflared is not running (a certain local negative)', async () => {
    const { service } = makeService({ containerRunning: false });

    // One observation is enough: unlike the network probe, a stopped container
    // cannot be a false negative, so it bypasses the anti-flap threshold.
    expect(await service.getHealthNow()).toBe('down');
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('probes the Hub public origin when the container is up', async () => {
    const { service } = makeService();

    await service.getHealthNow();

    expect(axiosGet).toHaveBeenCalledWith('https://hub-core2-acme.companionintelligence.com', expect.objectContaining({ maxRedirects: 0 }));
  });
});

describe('TunnelHealthService probe classification', () => {
  it('treats a redirect or 401 as up — the browser still reached the Hub', async () => {
    const { service } = makeService();
    axiosGet.mockResolvedValue({ status: 302, data: '' });

    expect(await service.getHealthNow()).toBe('up');
  });

  it.each([502, 503, 521, 522, 530])('treats a Cloudflare %d as a failed observation', async (status) => {
    const { service } = makeService();
    axiosGet.mockResolvedValue({ status, data: '' });

    await service.getHealthNow();

    expect(await service.getHealthNow()).toBe('down');
  });

  it('detects a Cloudflare error interstitial served with a 200', async () => {
    const { service } = makeService();
    axiosGet.mockResolvedValue({ status: 200, data: '<html>Error 1033 Cloudflare Ray ID: abc</html>' });

    await service.getHealthNow();

    expect(await service.getHealthNow()).toBe('down');
  });
});

describe('TunnelHealthService anti-flap', () => {
  it('does not report down on a single failure — a blip must not withdraw the public launcher', async () => {
    const { service } = makeService();

    await service.getHealthNow();
    expect(service.getHealth()).toBe('up');

    axiosGet.mockRejectedValue(new Error('ECONNRESET'));
    await service.getHealthNow();

    // One failure only; the previous verdict stands.
    expect(service.getHealth()).toBe('up');
  });

  it('reports down once the failures are consecutive', async () => {
    const { service } = makeService();
    axiosGet.mockRejectedValue(new Error('ENOTFOUND'));

    await service.getHealthNow();
    await service.getHealthNow();

    expect(service.getHealth()).toBe('down');
  });

  it('resets the failure run on any success, so alternating results never accumulate to down', async () => {
    const { service } = makeService();

    axiosGet.mockRejectedValueOnce(new Error('blip'));
    await service.getHealthNow();
    axiosGet.mockResolvedValueOnce({ status: 200, data: 'ok' });
    await service.getHealthNow();
    axiosGet.mockRejectedValueOnce(new Error('blip'));
    await service.getHealthNow();

    expect(service.getHealth()).toBe('up');
  });

  it('recovers to up after a confirmed outage', async () => {
    const { service } = makeService();
    axiosGet.mockRejectedValue(new Error('down'));
    await service.getHealthNow();
    await service.getHealthNow();
    expect(service.getHealth()).toBe('down');

    axiosGet.mockResolvedValue({ status: 200, data: 'ok' });
    await service.getHealthNow();

    expect(service.getHealth()).toBe('up');
  });
});

describe('TunnelHealthService.invalidate', () => {
  it('drops the cached verdict so a repaired tunnel is not masked by stale pessimism', async () => {
    const { service } = makeService();
    await service.getHealthNow();
    expect(service.getHealth()).toBe('up');

    service.invalidate();

    expect(service.getHealth()).toBe('unknown');
  });

  it('discards an in-flight probe superseded by invalidate rather than writing its now-stale result', async () => {
    // Seed a DEFINITE 'down' (cloudflared not running), then "repair" the tunnel
    // and let a probe that resolves 'up' be in flight when invalidate() fires.
    //
    // The distinguishing move: the superseded probe resolves to a DIFFERENT verdict
    // ('up') than the cache would otherwise settle on. If the generation guard is
    // removed, that 'up' is written back and getHealth() returns 'up'; with the
    // guard it is discarded and the cache stays cold ('unknown'). A single 530 —
    // as an earlier version of this test used — could not distinguish the two,
    // because one sub-threshold failure resolves to 'unknown' either way.
    const { service, dockerReadFacade } = makeService({ containerRunning: false });
    expect(await service.getHealthNow()).toBe('down');

    dockerReadFacade.isContainerRunning.mockResolvedValue(true);
    let landProbe: (value: unknown) => void = () => {};
    axiosGet.mockReturnValueOnce(
      new Promise((resolve) => {
        landProbe = resolve;
      }),
    );

    const inFlight = service.getHealthNow();

    service.invalidate();
    landProbe({ status: 200, data: 'ok' });
    await inFlight;

    // The superseded 'up' must NOT have landed.
    expect(service.getHealth()).toBe('unknown');
  });

  it('starts a FRESH probe on the next read after invalidate, not the detached one', async () => {
    // invalidate() nulls inFlight so the next getHealth() does not collapse onto
    // the doomed probe (which scheduleRefresh would otherwise return) and serve
    // `unknown` until it times out. Driven through getHealth()/scheduleRefresh,
    // which is the only path that actually populates inFlight.
    const { service } = makeService();
    let landFirst: (value: unknown) => void = () => {};
    axiosGet.mockReturnValueOnce(
      new Promise((resolve) => {
        landFirst = resolve;
      }),
    );

    service.getHealth(); // schedules background probe A (sets inFlight)
    await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(1)); // A is in flight

    service.invalidate(); // must null inFlight so the next read re-probes

    // Without the detach, this second read collapses onto A and never re-probes.
    service.getHealth();
    await vi.waitFor(() => expect(axiosGet).toHaveBeenCalledTimes(2)); // fresh probe B fired

    landFirst({ status: 530, data: '' }); // A lands late; harmless
  });
});
