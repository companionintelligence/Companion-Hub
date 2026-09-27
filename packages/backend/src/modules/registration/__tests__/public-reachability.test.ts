import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_PROBE_PATH,
  type PublicReachabilityDeps,
  type ZoneAnswer,
  allowedAddressLookup,
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
const PUBLISHED: ZoneAnswer = { kind: 'addresses', addresses: EDGE };

function dnsError(code: string): Error {
  return Object.assign(new Error(`getaddrinfo ${code} ${HOST}`), { code });
}

function deps(zone: ZoneAnswer | Error = PUBLISHED) {
  return {
    get: vi.fn<PublicReachabilityDeps['get']>(),
    resolveAtZoneNameservers: vi.fn<PublicReachabilityDeps['resolveAtZoneNameservers']>(() =>
      zone instanceof Error ? Promise.reject(zone) : Promise.resolve(zone),
    ),
  };
}

const isPublic = (address: string) => !address.startsWith('10.') && address !== '127.0.0.1';

describe('probePublicHostname', () => {
  it("asks the zone's nameservers first, then goes through this host's resolver once they publish the name", async () => {
    const d = deps();
    d.get.mockResolvedValue(200);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toEqual({ reachable: true, via: 'system', status: 200 });
    expect(d.resolveAtZoneNameservers).toHaveBeenCalledWith(HOST, { timeoutMs: 5_000 });
    expect(d.get).toHaveBeenCalledTimes(1);
    expect(d.get).toHaveBeenCalledWith(PROBE_URL, { timeoutMs: 5_000 });
  });

  it("never asks this host's resolver about a name the zone does not publish yet, which is what plants the NXDOMAIN", async () => {
    // A fresh pairing while Portal's DNS backlog has not reached this name: one getaddrinfo now
    // would make systemd-resolved and the LAN resolver repeat NXDOMAIN for 30 minutes.
    const d = deps({ kind: 'nxdomain' });

    await expect(probePublicHostname(HOST, {}, d)).resolves.toEqual({
      reachable: false,
      via: 'zone_nameservers',
      detail: "the zone's nameservers do not publish it yet",
    });
    expect(d.get).not.toHaveBeenCalled();
  });

  it("connects where the zone's nameservers point when this host still holds a cached NXDOMAIN", async () => {
    // core-2 after the 2026-09-26 re-pair: its resolver chain said ENOTFOUND while the name answered from the internet.
    const d = deps();
    d.get.mockRejectedValueOnce(dnsError('ENOTFOUND')).mockResolvedValueOnce(200);

    const probe = await probePublicHostname(HOST, { timeoutMs: 2_000 }, d);

    expect(probe).toMatchObject({ reachable: true, via: 'zone_nameservers', status: 200 });
    expect(probe.detail).toMatch(/^this host's resolver has no address for it \(getaddrinfo ENOTFOUND/);
    expect(d.resolveAtZoneNameservers).toHaveBeenCalledWith(HOST, { timeoutMs: 2_000 });
    expect(d.get).toHaveBeenLastCalledWith(PROBE_URL, { addresses: EDGE, timeoutMs: 2_000 });
  });

  it.each(['ENODATA', 'EAI_AGAIN'])('treats %s from this host as "no address" too', async (code) => {
    const d = deps();
    d.get.mockRejectedValueOnce(dnsError(code)).mockResolvedValueOnce(204);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toMatchObject({ reachable: true, via: 'zone_nameservers' });
  });

  it('with requireSystemResolver, does not count a request that went around this host, and makes none', async () => {
    // The registration page sends the browser to this URL next, and the browser is behind the same cache.
    const d = deps();
    d.get.mockRejectedValue(dnsError('ENOTFOUND'));

    const probe = await probePublicHostname(HOST, { requireSystemResolver: true }, d);

    expect(probe).toMatchObject({ reachable: false, via: 'system' });
    expect(probe.detail).toMatch(/though the zone's nameservers publish it$/);
    expect(d.get).toHaveBeenCalledTimes(1);
  });

  it("goes through this host's resolver when the zone has the name without an address, as it has a CNAME to elsewhere", async () => {
    const d = deps({ kind: 'no_address' });
    d.get.mockResolvedValue(200);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toEqual({ reachable: true, via: 'system', status: 200 });
  });

  it('is not reachable, and says so, when neither resolver has an address', async () => {
    const d = deps({ kind: 'no_address' });
    d.get.mockRejectedValue(dnsError('ENOTFOUND'));

    const probe = await probePublicHostname(HOST, {}, d);

    expect(probe).toMatchObject({ reachable: false, via: 'system' });
    expect(probe.detail).toMatch(/and the zone's nameservers publish no address for it$/);
    expect(d.get).toHaveBeenCalledTimes(1);
  });

  it("goes through this host's resolver alone when the zone's nameservers cannot be asked, as on a network that blocks outbound DNS", async () => {
    const d = deps(Object.assign(new Error('queryA ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    d.get.mockResolvedValue(200);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toEqual({ reachable: true, via: 'system', status: 200 });
  });

  it("is not reachable, and says why twice over, when this host has no address and the zone's nameservers cannot be asked", async () => {
    const d = deps(Object.assign(new Error('queryA ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    d.get.mockRejectedValue(dnsError('ENOTFOUND'));

    const probe = await probePublicHostname(HOST, {}, d);

    expect(probe).toMatchObject({ reachable: false, via: 'system' });
    expect(probe.detail).toContain('ENOTFOUND');
    expect(probe.detail).toContain('ECONNREFUSED');
  });

  it("bounds the time spent asking the zone's nameservers, and then asks this host", async () => {
    vi.useFakeTimers();
    try {
      const d = {
        get: vi.fn<PublicReachabilityDeps['get']>().mockResolvedValue(200),
        resolveAtZoneNameservers: vi.fn(() => new Promise<ZoneAnswer>(() => {})),
      };

      const pending = probePublicHostname(HOST, { timeoutMs: 2_000 }, d);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toEqual({ reachable: true, via: 'system', status: 200 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never counts a response that is not a 2xx, such as Cloudflare's 530 for a tunnel with no connector", async () => {
    const d = deps();
    d.get.mockRejectedValueOnce(dnsError('ENOTFOUND')).mockResolvedValueOnce(530);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toMatchObject({ reachable: false, via: 'zone_nameservers', status: 530 });
  });

  it.each([301, 403, 502])('never counts HTTP %s through this host either', async (status) => {
    const d = deps();
    d.get.mockResolvedValue(status);

    await expect(probePublicHostname(HOST, {}, d)).resolves.toEqual({ reachable: false, via: 'system', status });
    expect(d.get).toHaveBeenCalledTimes(1);
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
    expect(d.get).toHaveBeenCalledTimes(1);
  });

  it('does not go around this host for a certificate that is not valid for the name', async () => {
    const d = deps();
    d.get.mockRejectedValue(Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }));

    const probe = await probePublicHostname(HOST, {}, d);

    expect(probe).toMatchObject({ reachable: false, via: 'system' });
    expect(probe.detail).toContain('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(d.get).toHaveBeenCalledTimes(1);
  });

  describe('with isAllowedAddress, for a hostname someone else chose', () => {
    it('refuses a name whose zone publishes an address it rejects, and connects nowhere', async () => {
      const d = deps({ kind: 'addresses', addresses: ['104.21.48.168', '10.0.0.5'] });

      const probe = await probePublicHostname(HOST, { isAllowedAddress: isPublic }, d);

      expect(probe).toEqual({
        reachable: false,
        via: 'zone_nameservers',
        detail: "the zone's nameservers publish 10.0.0.5, which this probe may not connect to",
      });
      expect(d.get).not.toHaveBeenCalled();
    });

    it("hands the filter to both resolvers' paths, so this host's answer is checked as well as the zone's", async () => {
      const d = deps();
      d.get.mockResolvedValue(200);

      await probePublicHostname(HOST, { isAllowedAddress: isPublic }, d);

      expect(d.resolveAtZoneNameservers).toHaveBeenCalledWith(HOST, { timeoutMs: 5_000, isAllowedAddress: isPublic });
      expect(d.get).toHaveBeenCalledWith(PROBE_URL, { timeoutMs: 5_000, isAllowedAddress: isPublic });
    });
  });
});

describe('describePublicReachability', () => {
  it('names the path that decided, so an operator can tell a cached NXDOMAIN from a dead tunnel', () => {
    expect(describePublicReachability({ reachable: true, via: 'system', status: 200 })).toBe("through this host's resolver; HTTP 200");
    expect(
      describePublicReachability({ reachable: true, via: 'zone_nameservers', status: 200, detail: "this host's resolver has no address for it" }),
    ).toBe("through the zone's nameservers; this host's resolver has no address for it; HTTP 200");
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

describe('allowedAddressLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function systemAnswers(addresses: string[]) {
    return vi.spyOn(dns, 'lookup').mockImplementation(((
      _hostname: string,
      _options: unknown,
      callback: (error: null, entries: dns.LookupAddress[]) => void,
    ) => {
      callback(
        null,
        addresses.map((address) => ({ address, family: net.isIP(address) })),
      );
    }) as never);
  }

  it('refuses a name this host resolves to an address the filter rejects, on the addresses the socket would use', () => {
    systemAnswers(['104.21.48.168', '10.0.0.5']);
    const callback = vi.fn();

    allowedAddressLookup(isPublic)(HOST, { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ message: `${HOST} resolves to 10.0.0.5, which this probe may not connect to` }),
      '',
    );
  });

  it('answers both callback shapes with what this host resolved otherwise', () => {
    systemAnswers(EDGE);
    const all = vi.fn();
    const single = vi.fn();

    allowedAddressLookup(isPublic)(HOST, { all: true }, all);
    allowedAddressLookup(isPublic)(HOST, {}, single);

    expect(all).toHaveBeenCalledWith(
      null,
      EDGE.map((address) => ({ address, family: 4 })),
    );
    expect(single).toHaveBeenCalledWith(null, EDGE[0], 4);
  });
});

/*
 * A real TLS server with a real certificate, so these tests fail if certificate checking is ever
 * weakened: `rejectUnauthorized: false` or a `checkServerIdentity` that accepts anything would let a
 * pinned request succeed against whatever answers at the pinned address.
 *
 * The certificate is built here instead of committed, because a private key in the tree trips
 * secret scanning. It is a minimal X.509 v3 self-signed EC certificate with one DNS name.
 */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

function derOid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function selfSignedCertificate(dnsName: string): { cert: string; key: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const utcTime = (date: Date) => der(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
  const name = der(0x30, der(0x31, der(0x30, derOid('2.5.4.3'), der(0x0c, Buffer.from(dnsName)))));
  const ecdsaWithSha256 = der(0x30, derOid('1.2.840.10045.4.3.2'));
  const now = Date.now();
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x01, ...crypto.randomBytes(8)])),
    ecdsaWithSha256,
    name,
    der(0x30, utcTime(new Date(now - 60 * 60 * 1000)), utcTime(new Date(now + 24 * 60 * 60 * 1000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(
      0xa3,
      der(
        0x30,
        // basicConstraints CA:TRUE, so the certificate can be its own trust anchor.
        der(0x30, derOid('2.5.29.19'), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30, der(0x01, Buffer.from([0xff]))))),
        // subjectAltName with the one dNSName the certificate is valid for.
        der(0x30, derOid('2.5.29.17'), der(0x04, der(0x30, der(0x82, Buffer.from(dnsName))))),
      ),
    ),
  );
  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const certificate = der(0x30, tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Node 22 before 22.19 cannot add a trust anchor at run time; the tests that need one are skipped there. */
const canTrustAtRunTime = typeof tls.setDefaultCACertificates === 'function';

describe('httpsGetStatus', () => {
  const servers: net.Server[] = [];
  const bundledTrust = canTrustAtRunTime ? tls.getCACertificates('default') : [];

  afterEach(async () => {
    if (canTrustAtRunTime) {
      tls.setDefaultCACertificates(bundledTrust);
    }
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function listen(server: net.Server): Promise<number> {
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  }

  function liveRoute(certificate: { cert: string; key: string }): Promise<number> {
    return listen(
      https.createServer(certificate, (_request, response) => response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}')),
    );
  }

  it('connects to the pinned address while the TLS handshake still names the host, so the certificate is checked against it', async () => {
    // A plain TCP listener stands in for the edge: it records the ClientHello and hangs up. The
    // request fails, and that is fine; what matters is where it went and which name it sent.
    let hello: (chunk: Buffer) => void = () => {};
    const received = new Promise<Buffer>((resolve) => (hello = resolve));
    const port = await listen(
      net.createServer((socket) => {
        socket.once('data', (chunk: Buffer) => {
          hello(chunk);
          socket.destroy();
        });
      }),
    );

    // `.invalid` never resolves anywhere, so reaching the listener at all proves the pin was used.
    const request = httpsGetStatus(`https://pinned-hub.invalid:${port}${PUBLIC_PROBE_PATH}`, { addresses: ['127.0.0.1'], timeoutMs: 5_000 });

    expect((await received).toString('latin1')).toContain('pinned-hub.invalid');
    await expect(request).rejects.toThrow();
  });

  it('refuses a pinned address whose certificate nothing trusts', async () => {
    const port = await liveRoute(selfSignedCertificate('pinned-hub.invalid'));

    await expect(
      httpsGetStatus(`https://pinned-hub.invalid:${port}${PUBLIC_PROBE_PATH}`, { addresses: ['127.0.0.1'], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  });

  it.skipIf(!canTrustAtRunTime)('answers with the status from a pinned address whose trusted certificate is valid for the name', async () => {
    const certificate = selfSignedCertificate('pinned-hub.invalid');
    tls.setDefaultCACertificates([...bundledTrust, certificate.cert]);
    const port = await liveRoute(certificate);

    await expect(
      httpsGetStatus(`https://pinned-hub.invalid:${port}${PUBLIC_PROBE_PATH}`, { addresses: ['127.0.0.1'], timeoutMs: 5_000 }),
    ).resolves.toBe(200);
  });

  it.skipIf(!canTrustAtRunTime)('refuses a trusted certificate issued for another name, which is what a pin to the wrong address meets', async () => {
    const elsewhere = selfSignedCertificate('someone-else.invalid');
    tls.setDefaultCACertificates([...bundledTrust, elsewhere.cert]);
    const port = await liveRoute(elsewhere);

    await expect(
      httpsGetStatus(`https://pinned-hub.invalid:${port}${PUBLIC_PROBE_PATH}`, { addresses: ['127.0.0.1'], timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });
});

describe('resolveAtZoneNameservers', () => {
  type Answer = string[] | string;
  function fakeResolvers(records: {
    ns?: Record<string, Answer>;
    a?: Record<string, Answer>;
    aaaa?: Record<string, Answer>;
    authoritativeA?: Answer;
    authoritativeAAAA?: Answer;
  }) {
    const answer = (value: Answer | undefined) =>
      Array.isArray(value) ? Promise.resolve(value) : Promise.reject(Object.assign(new Error(value ?? 'ENODATA'), { code: value ?? 'ENODATA' }));
    const local = {
      resolveNs: vi.fn((name: string) => answer(records.ns?.[name] ?? 'ENOTFOUND')),
      resolve4: vi.fn((name: string) => answer(records.a?.[name])),
      resolve6: vi.fn((name: string) => answer(records.aaaa?.[name])),
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

  const CI_COMPUTER_NS = { ns: { 'ci.computer': ['amit.ns.cloudflare.com'] }, a: { 'amit.ns.cloudflare.com': ['108.162.193.63'] } };

  it("walks up to the zone, and asks that zone's own nameservers for the name", async () => {
    const r = fakeResolvers({
      ns: { 'hubs.example.com': 'ENODATA', 'example.com': ['amit.ns.cloudflare.com', 'walk.ns.cloudflare.com'] },
      a: { 'amit.ns.cloudflare.com': ['108.162.193.63'], 'walk.ns.cloudflare.com': ['108.162.194.128', '108.162.193.63'] },
      authoritativeA: EDGE,
    });

    await expect(resolveAtZoneNameservers('hub-core-2.hubs.example.com', { timeoutMs: 2_000, createResolver: r.create })).resolves.toEqual({
      kind: 'addresses',
      addresses: EDGE,
    });
    expect(r.local.resolveNs.mock.calls.map(([name]) => name)).toEqual(['hubs.example.com', 'example.com']);
    expect(r.authoritative.setServers).toHaveBeenCalledWith(['108.162.193.63', '108.162.194.128']);
    expect(r.authoritative.resolve4).toHaveBeenCalledWith('hub-core-2.hubs.example.com');
  });

  it('asks the nameservers over IPv6 too, after IPv4, so a host without an IPv4 route can still reach them', async () => {
    const r = fakeResolvers({
      ...CI_COMPUTER_NS,
      aaaa: { 'amit.ns.cloudflare.com': ['2803:f800:50::6ca2:c13f'] },
      authoritativeA: EDGE,
    });

    await resolveAtZoneNameservers(HOST, { timeoutMs: 2_000, createResolver: r.create });

    expect(r.authoritative.setServers).toHaveBeenCalledWith(['108.162.193.63', '2803:f800:50::6ca2:c13f']);
  });

  it('answers with both address families of the name, IPv4 first', async () => {
    const r = fakeResolvers({ ...CI_COMPUTER_NS, authoritativeA: EDGE, authoritativeAAAA: ['2606:4700:3031::ac43:9a62'] });

    await expect(resolveAtZoneNameservers(HOST, { timeoutMs: 2_000, createResolver: r.create })).resolves.toEqual({
      kind: 'addresses',
      addresses: [...EDGE, '2606:4700:3031::ac43:9a62'],
    });
  });

  it('answers with IPv6 alone when the zone publishes no A record', async () => {
    const r = fakeResolvers({ ...CI_COMPUTER_NS, authoritativeA: 'ENODATA', authoritativeAAAA: ['2606:4700:3031::ac43:9a62'] });

    await expect(resolveAtZoneNameservers(HOST, { timeoutMs: 2_000, createResolver: r.create })).resolves.toEqual({
      kind: 'addresses',
      addresses: ['2606:4700:3031::ac43:9a62'],
    });
  });

  it('says nxdomain when the zone says the name does not exist', async () => {
    const r = fakeResolvers({ ...CI_COMPUTER_NS, authoritativeA: 'ENOTFOUND', authoritativeAAAA: 'ENOTFOUND' });

    await expect(resolveAtZoneNameservers(HOST, { timeoutMs: 2_000, createResolver: r.create })).resolves.toEqual({ kind: 'nxdomain' });
  });

  it('says no_address, not nxdomain, for a name that exists there without an A or AAAA record', async () => {
    // What a CNAME to a name outside the zone, or a DNSSEC black lie, looks like from an authoritative server.
    const r = fakeResolvers({ ...CI_COMPUTER_NS, authoritativeA: 'ENODATA', authoritativeAAAA: 'ENODATA' });

    await expect(resolveAtZoneNameservers(HOST, { timeoutMs: 2_000, createResolver: r.create })).resolves.toEqual({ kind: 'no_address' });
  });

  it('fails, rather than answering "not published", when the nameservers themselves do not answer', async () => {
    const r = fakeResolvers({ ...CI_COMPUTER_NS, authoritativeA: 'ETIMEOUT', authoritativeAAAA: 'ETIMEOUT' });

    await expect(resolveAtZoneNameservers(HOST, { timeoutMs: 2_000, createResolver: r.create })).rejects.toMatchObject({ code: 'ETIMEOUT' });
  });

  it('sends no query to a nameserver address the filter rejects, since a chosen hostname can name its own nameservers', async () => {
    const r = fakeResolvers({
      ns: { 'ci.computer': ['ns.attacker.example', 'amit.ns.cloudflare.com'] },
      a: { 'ns.attacker.example': ['10.0.0.53'], 'amit.ns.cloudflare.com': ['108.162.193.63'] },
      authoritativeA: EDGE,
    });

    await resolveAtZoneNameservers(HOST, { timeoutMs: 2_000, isAllowedAddress: isPublic, createResolver: r.create });

    expect(r.authoritative.setServers).toHaveBeenCalledWith(['108.162.193.63']);
  });

  it('fails when no zone above the name has nameservers, and never asks for the TLD', async () => {
    const r = fakeResolvers({ ns: {} });

    await expect(resolveAtZoneNameservers(HOST, { timeoutMs: 2_000, createResolver: r.create })).rejects.toThrow(/no zone/);
    expect(r.local.resolveNs.mock.calls.map(([name]) => name)).toEqual(['ci.computer']);
  });
});

/*
 * Everything above hands in its own deps. This runs the probe as the Hub does, with only the
 * network faked: this host's getaddrinfo, the zone's nameservers, and a local TLS server standing in
 * for the edge. It fails if the fallback is ever disconnected from the production wiring.
 */
describe.skipIf(!canTrustAtRunTime)('probePublicHostname as wired for production', () => {
  const NAME = 'hub.pinned.invalid';
  const bundledTrust = canTrustAtRunTime ? tls.getCACertificates('default') : [];
  let server: https.Server | undefined;
  let origin: string;
  let systemLookup: ReturnType<typeof vi.spyOn>;
  let zoneA: string[] | 'ENOTFOUND';

  beforeEach(async () => {
    const certificate = selfSignedCertificate(NAME);
    tls.setDefaultCACertificates([...bundledTrust, certificate.cert]);
    server = https.createServer(certificate, (_request, response) => response.writeHead(200).end('{"status":"ok"}'));
    const port = await new Promise<number>((resolve) => server?.listen(0, '127.0.0.1', () => resolve((server?.address() as net.AddressInfo).port)));
    // The edge listens on 443; a port in the "hostname" is how a test reaches a local stand-in.
    origin = `${NAME}:${port}`;
    zoneA = ['127.0.0.1'];

    // This host's resolver still holds the NXDOMAIN from before the name was re-created.
    systemLookup = vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, options: unknown, callback?: (error: Error) => void) => {
      const done = (typeof options === 'function' ? options : callback) as (error: Error) => void;
      done(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    }) as never);

    const Resolver = dns.promises.Resolver.prototype;
    const noData = () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' }));
    vi.spyOn(Resolver, 'resolveNs').mockResolvedValue(['ns.pinned.invalid']);
    vi.spyOn(Resolver, 'setServers').mockImplementation(() => {});
    vi.spyOn(Resolver, 'resolve6').mockImplementation(noData);
    vi.spyOn(Resolver, 'resolve4').mockImplementation(((name: string) => {
      if (name === 'ns.pinned.invalid') return Promise.resolve(['192.0.2.53']);
      return zoneA === 'ENOTFOUND' ? Promise.reject(Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' })) : Promise.resolve(zoneA);
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    tls.setDefaultCACertificates(bundledTrust);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("reaches the Hub at the address the zone's nameservers publish while this host has no address for the name", async () => {
    const probe = await probePublicHostname(origin, { timeoutMs: 2_000 });

    expect(probe).toMatchObject({ reachable: true, via: 'zone_nameservers', status: 200 });
    expect(systemLookup).toHaveBeenCalledWith(NAME, expect.anything(), expect.any(Function));
  });

  it("asks this host's resolver nothing while the zone does not publish the name", async () => {
    zoneA = 'ENOTFOUND';

    await expect(probePublicHostname(origin, { timeoutMs: 2_000 })).resolves.toMatchObject({ reachable: false, via: 'zone_nameservers' });
    expect(systemLookup).not.toHaveBeenCalled();
  });
});
