import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_PROBE_PATH,
  type PublicReachabilityDeps,
  describePublicReachability,
  httpsGetStatus,
  pinnedLookup,
  probePublicHostname,
  resolveAtZoneNameservers,
} from '../public-reachability';

const HOST = 'hub-core-2-demopool1.ci.computer';
const PROBE_URL = `https://${HOST}${PUBLIC_PROBE_PATH}`;
/** Cloudflare's anycast answers for a proxied record, as the zone's nameservers gave them for core-2. */
const EDGE = ['172.67.154.98', '104.21.48.168'];

function dnsError(code: string): Error {
  return Object.assign(new Error(`getaddrinfo ${code} ${HOST}`), { code });
}

function deps(overrides: Partial<PublicReachabilityDeps> = {}) {
  return {
    get: vi.fn<PublicReachabilityDeps['get']>(),
    resolveAtZoneNameservers: vi.fn<PublicReachabilityDeps['resolveAtZoneNameservers']>().mockResolvedValue(EDGE),
    ...overrides,
  };
}

describe('probePublicHostname', () => {
  it("is reachable through this host's own resolver when that resolver has the name", async () => {
    const d = deps();
    d.get.mockResolvedValue(200);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toEqual({ reachable: true, via: 'system', status: 200 });
    expect(d.get).toHaveBeenCalledWith(PROBE_URL, { timeoutMs: 5_000 });
    expect(d.resolveAtZoneNameservers).not.toHaveBeenCalled();
  });

  it("asks the zone's nameservers when this host still holds a cached NXDOMAIN, and connects where they point", async () => {
    // core-2 after the 2026-09-26 re-pair: its resolver chain said ENOTFOUND while the name answered from the internet.
    const d = deps();
    d.get.mockRejectedValueOnce(dnsError('ENOTFOUND')).mockResolvedValueOnce(200);

    const probe = await probePublicHostname(HOST, { timeoutMs: 2_000 }, d);

    expect(probe).toEqual({ reachable: true, via: 'zone_nameservers', status: 200 });
    expect(d.resolveAtZoneNameservers).toHaveBeenCalledWith(HOST, 2_000);
    expect(d.get).toHaveBeenLastCalledWith(PROBE_URL, { addresses: EDGE, timeoutMs: 2_000 });
  });

  it.each(['ENODATA', 'EAI_AGAIN'])('treats %s from this host as "no address" too', async (code) => {
    const d = deps();
    d.get.mockRejectedValueOnce(dnsError(code)).mockResolvedValueOnce(204);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toMatchObject({ reachable: true, via: 'zone_nameservers' });
  });

  it("is not reachable when the zone's nameservers do not publish the name either, and requests nothing", async () => {
    const d = deps({ resolveAtZoneNameservers: vi.fn().mockResolvedValue([]) });
    d.get.mockRejectedValue(dnsError('ENOTFOUND'));

    await expect(probePublicHostname(HOST, {}, d)).resolves.toEqual({
      reachable: false,
      via: 'zone_nameservers',
      detail: "the zone's nameservers do not publish it yet",
    });
    expect(d.get).toHaveBeenCalledTimes(1);
  });

  it("never counts a response that is not a 2xx, such as Cloudflare's 530 for a tunnel with no connector", async () => {
    const d = deps();
    d.get.mockRejectedValueOnce(dnsError('ENOTFOUND')).mockResolvedValueOnce(530);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toEqual({ reachable: false, via: 'zone_nameservers', status: 530 });
  });

  it.each([301, 403, 502])('never counts HTTP %s through this host either', async (status) => {
    const d = deps();
    d.get.mockResolvedValue(status);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toEqual({ reachable: false, via: 'system', status });
    expect(d.resolveAtZoneNameservers).not.toHaveBeenCalled();
  });

  it('does not go around this host for a failure that is not about DNS, because the edge would answer the same', async () => {
    // core-5 on 2026-09-27: the name resolved and the request hung, because its tunnel's origin did not answer.
    const d = deps();
    d.get.mockRejectedValue(Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));

    await expect(probePublicHostname(HOST, { timeoutMs: 2_000 }, d)).resolves.toEqual({
      reachable: false,
      via: 'system',
      detail: 'no response within 2000 ms',
    });
    expect(d.resolveAtZoneNameservers).not.toHaveBeenCalled();
  });

  it('does not go around this host for a certificate that is not valid for the name', async () => {
    const d = deps();
    d.get.mockRejectedValue(Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }));

    const probe = await probePublicHostname(HOST, {}, d);

    expect(probe).toMatchObject({ reachable: false, via: 'system' });
    expect(probe.detail).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(d.resolveAtZoneNameservers).not.toHaveBeenCalled();
  });

  it("is not reachable, and says why twice over, when the zone's nameservers cannot be asked", async () => {
    const d = deps({
      resolveAtZoneNameservers: vi.fn().mockRejectedValue(Object.assign(new Error('queryA ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    });
    d.get.mockRejectedValue(dnsError('ENOTFOUND'));

    const probe = await probePublicHostname(HOST, {}, d);

    expect(probe).toMatchObject({ reachable: false, via: 'zone_nameservers' });
    expect(probe.detail).toContain('ENOTFOUND');
    expect(probe.detail).toContain('ECONNREFUSED');
  });

  it("bounds the time spent asking the zone's nameservers", async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ resolveAtZoneNameservers: vi.fn().mockReturnValue(new Promise<string[]>(() => {})) });
      d.get.mockRejectedValue(dnsError('ENOTFOUND'));

      const pending = probePublicHostname(HOST, { timeoutMs: 2_000 }, d);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toMatchObject({ reachable: false, via: 'zone_nameservers' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('describePublicReachability', () => {
  it('names the path that decided, so an operator can tell a cached NXDOMAIN from a dead tunnel', () => {
    expect(describePublicReachability({ reachable: true, via: 'system', status: 200 })).toBe("resolved by this host's resolver; HTTP 200");
    expect(describePublicReachability({ reachable: true, via: 'zone_nameservers', status: 200 })).toMatch(
      /^this host's resolver has no address for it.*asked the zone's nameservers; HTTP 200$/,
    );
  });
});

describe('pinnedLookup', () => {
  it('answers the all-addresses form net.connect uses when it races address families', () => {
    const callback = vi.fn();

    pinnedLookup(['104.21.48.168', '2606:4700:3031::ac43:9a62'])(HOST, { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [
      { address: '104.21.48.168', family: 4 },
      { address: '2606:4700:3031::ac43:9a62', family: 6 },
    ]);
  });

  it('answers the single-address form otherwise', () => {
    const callback = vi.fn();

    pinnedLookup(['104.21.48.168'])(HOST, {}, callback);

    expect(callback).toHaveBeenCalledWith(null, '104.21.48.168', 4);
  });

  it('fails like an unresolvable name when it has nothing to pin, instead of connecting nowhere', () => {
    const callback = vi.fn();

    pinnedLookup([])(HOST, { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOTFOUND' }), '');
  });
});

describe('httpsGetStatus', () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('connects to the pinned address while the TLS handshake still names the host, so the certificate is checked against it', async () => {
    // A plain TCP listener stands in for the edge: it records the ClientHello and hangs up. The
    // request fails, and that is fine; what matters is where it went and which name it sent.
    const hello = new Promise<Buffer>((resolve) => {
      server = net.createServer((socket) => {
        socket.once('data', (chunk: Buffer) => {
          resolve(chunk);
          socket.destroy();
        });
      });
    });
    const port = await new Promise<number>((resolve) => server?.listen(0, '127.0.0.1', () => resolve((server?.address() as net.AddressInfo).port)));

    // `.invalid` never resolves anywhere, so reaching the listener at all proves the pin was used.
    const request = httpsGetStatus(`https://pinned-hub.invalid:${port}${PUBLIC_PROBE_PATH}`, { addresses: ['127.0.0.1'], timeoutMs: 5_000 });

    expect((await hello).toString('latin1')).toContain('pinned-hub.invalid');
    await expect(request).rejects.toThrow();
  });
});

describe('resolveAtZoneNameservers', () => {
  function fakeResolvers(records: {
    ns?: Record<string, string[] | string>;
    a?: Record<string, string[] | string>;
    authoritativeA?: string[] | string;
    authoritativeAAAA?: string[] | string;
  }) {
    const answer = (value: string[] | string | undefined) =>
      Array.isArray(value) ? Promise.resolve(value) : Promise.reject(Object.assign(new Error(value ?? 'ENOTFOUND'), { code: value ?? 'ENOTFOUND' }));
    const local = {
      resolveNs: vi.fn((name: string) => answer(records.ns?.[name])),
      resolve4: vi.fn((name: string) => answer(records.a?.[name])),
      resolve6: vi.fn(),
      setServers: vi.fn(),
    };
    const authoritative = {
      resolveNs: vi.fn(),
      resolve4: vi.fn(() => answer(records.authoritativeA)),
      resolve6: vi.fn(() => answer(records.authoritativeAAAA)),
      setServers: vi.fn(),
    };
    const created = [local, authoritative];
    return { local, authoritative, create: () => created.shift() as never };
  }

  it("walks up to the zone, and asks that zone's own nameservers for the name", async () => {
    const r = fakeResolvers({
      ns: { 'hubs.example.com': 'ENODATA', 'example.com': ['amit.ns.cloudflare.com', 'walk.ns.cloudflare.com'] },
      a: { 'amit.ns.cloudflare.com': ['108.162.193.63'], 'walk.ns.cloudflare.com': ['108.162.194.128', '108.162.193.63'] },
      authoritativeA: EDGE,
    });

    await expect(resolveAtZoneNameservers('hub-core-2.hubs.example.com', 2_000, r.create)).resolves.toEqual(EDGE);
    expect(r.local.resolveNs.mock.calls.map(([name]) => name)).toEqual(['hubs.example.com', 'example.com']);
    expect(r.authoritative.setServers).toHaveBeenCalledWith(['108.162.193.63', '108.162.194.128']);
    expect(r.authoritative.resolve4).toHaveBeenCalledWith('hub-core-2.hubs.example.com');
  });

  it('falls back to AAAA only when the zone publishes no A record', async () => {
    const r = fakeResolvers({
      ns: { 'ci.computer': ['amit.ns.cloudflare.com'] },
      a: { 'amit.ns.cloudflare.com': ['108.162.193.63'] },
      authoritativeA: 'ENODATA',
      authoritativeAAAA: ['2606:4700:3031::ac43:9a62'],
    });

    await expect(resolveAtZoneNameservers(HOST, 2_000, r.create)).resolves.toEqual(['2606:4700:3031::ac43:9a62']);
  });

  it('answers with nothing when the zone says the name does not exist', async () => {
    const r = fakeResolvers({
      ns: { 'ci.computer': ['amit.ns.cloudflare.com'] },
      a: { 'amit.ns.cloudflare.com': ['108.162.193.63'] },
      authoritativeA: 'ENOTFOUND',
      authoritativeAAAA: 'ENOTFOUND',
    });

    await expect(resolveAtZoneNameservers(HOST, 2_000, r.create)).resolves.toEqual([]);
  });

  it('fails, rather than answering "not published", when the nameservers themselves do not answer', async () => {
    const r = fakeResolvers({
      ns: { 'ci.computer': ['amit.ns.cloudflare.com'] },
      a: { 'amit.ns.cloudflare.com': ['108.162.193.63'] },
      authoritativeA: 'ETIMEOUT',
    });

    await expect(resolveAtZoneNameservers(HOST, 2_000, r.create)).rejects.toMatchObject({ code: 'ETIMEOUT' });
  });

  it('fails when no zone above the name has nameservers, and never asks for the TLD', async () => {
    const r = fakeResolvers({ ns: {} });

    await expect(resolveAtZoneNameservers(HOST, 2_000, r.create)).rejects.toThrow(/no zone/);
    expect(r.local.resolveNs.mock.calls.map(([name]) => name)).toEqual(['ci.computer']);
  });
});
