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
  const dockerService = { isContainerRunning: vi.fn().mockResolvedValue(overrides.containerRunning ?? true) };
  const moduleRef = { get: vi.fn().mockReturnValue(dockerService) };

  const service = new TunnelHealthService(cloudflareClient as never, deviceRegistration as never, configService as never, moduleRef as never);

  return { service, cloudflareClient, deviceRegistration, configService, dockerService };
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
    // cold `import('../docker/docker.service')` whose module subtree is not
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

  it('discards a probe that was already in flight when the cache was invalidated', async () => {
    // The realistic ordering: a probe starts, the tunnel is repaired and
    // invalidate() fires, then the pre-repair probe lands. Writing that reading
    // back would re-poison the cache with `down` for a full TTL — precisely the
    // staleness invalidate() was called to prevent.
    const { service } = makeService();
    let landProbe: (value: unknown) => void = () => {};
    axiosGet.mockReturnValueOnce(
      new Promise((resolve) => {
        landProbe = resolve;
      }),
    );

    const inFlight = service.getHealthNow();

    service.invalidate();
    landProbe({ status: 530, data: '' });
    await inFlight;

    expect(service.getHealth()).toBe('unknown');
  });
});
