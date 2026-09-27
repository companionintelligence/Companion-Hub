import { LoggerService } from '@/core/logger/logger.service';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ProxyTrustService } from '../proxy-trust.service';
import { configureTrustProxy, resolveTrustProxySetting } from '../trust-proxy';

const TRAEFIK = '172.19.0.7';

/**
 * `req.ip` as Express computes it for a request whose socket is `socketAddress` and whose
 * X-Forwarded-For is `forwardedFor` — the value every guard and audit log reads. Uses Express's own
 * request prototype, so the walk is the real `proxy-addr` one, not a model of it.
 */
function clientIp(app: express.Express, socketAddress: string, forwardedFor?: string): string | undefined {
  const req = Object.create(app.request) as express.Request;
  Object.assign(req, {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress: socketAddress },
  });
  return req.ip;
}

/*
 * The security claim of the edge network lands here, in main.ts's `trust proxy`: `req.ip` feeds
 * AppContainerOriginGuard, InternalNetworkGuard, internalOriginRefusal and the auth audit. Too much
 * trust and any LAN host or app container names itself as another app's container.
 */
describe('configureTrustProxy', () => {
  let proxyTrust: ProxyTrustService;
  let app: express.Express;

  beforeEach(async () => {
    vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '');
    vi.stubEnv('HUB_EDGE_TAILSCALE_IP', '');
    const docker = {
      getNetwork: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ IPAM: { Config: [{ Subnet: '10.128.0.0/29', IPRange: '10.128.0.0/31', Gateway: '10.128.0.1' }] } }),
      })),
      getContainer: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ NetworkSettings: { Networks: { 'ci-hub_network': { IPAddress: TRAEFIK } } } }),
      })),
    };
    proxyTrust = new ProxyTrustService(docker as never, mock<LoggerService>());
    app = express();
    configureTrustProxy(app, {}, proxyTrust);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names the socket until the hops have been read', () => {
    expect(clientIp(app, TRAEFIK, 'spoof, 203.0.113.9, 10.128.0.3')).toBe(TRAEFIK);
  });

  describe('once the hops are read', () => {
    beforeEach(async () => {
      await proxyTrust.refresh();
    });

    it('walks back past Traefik and cloudflared to the visitor, ignoring what the visitor claimed before them', () => {
      expect(clientIp(app, TRAEFIK, 'spoof, 203.0.113.9, 10.128.0.3')).toBe('203.0.113.9');
      // Express sees IPv4 sockets IPv6-mapped on a dual-stack listener.
      expect(clientIp(app, `::ffff:${TRAEFIK}`, 'spoof, 203.0.113.9, 10.128.0.4')).toBe('203.0.113.9');
    });

    it('stops at the edge gateway, which is the host and vouches for nobody', () => {
      expect(clientIp(app, TRAEFIK, 'spoof, 10.128.0.1')).toBe('10.128.0.1');
    });

    it('believes nothing an app container or LAN host sends straight to the Hub', () => {
      expect(clientIp(app, '172.19.0.8', '172.19.0.9')).toBe('172.19.0.8');
      expect(clientIp(app, '192.168.1.20', '10.128.0.3')).toBe('192.168.1.20');
    });

    it('names the proxy when nothing was forwarded', () => {
      expect(clientIp(app, TRAEFIK)).toBe(TRAEFIK);
    });
  });

  it('honours HUB_TRUST_PROXY as a hop count or a list, passed through unchanged', () => {
    expect(resolveTrustProxySetting({ HUB_TRUST_PROXY: ' 1 ' }, proxyTrust)).toBe(1);
    expect(resolveTrustProxySetting({ HUB_TRUST_PROXY: '172.16.0.0/12, 10.0.0.1' }, proxyTrust)).toBe('172.16.0.0/12, 10.0.0.1');
    expect(typeof resolveTrustProxySetting({ HUB_TRUST_PROXY: '  ' }, proxyTrust)).toBe('function');

    const counted = express();
    configureTrustProxy(counted, { HUB_TRUST_PROXY: '1' }, proxyTrust);
    expect(clientIp(counted, '192.168.1.20', 'spoof, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('fails closed at startup on a value Express cannot read', () => {
    expect(() => configureTrustProxy(express(), { HUB_TRUST_PROXY: 'true' }, proxyTrust)).toThrow();
  });
});
