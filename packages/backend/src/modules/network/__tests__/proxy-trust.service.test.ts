import { LoggerService } from '@/core/logger/logger.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ProxyTrustService } from '../proxy-trust.service';

describe('ProxyTrustService', () => {
  let service: ProxyTrustService;
  let networkInspect: ReturnType<typeof vi.fn>;
  let containerInspect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    networkInspect = vi.fn();
    containerInspect = vi.fn();
    const docker = {
      getNetwork: vi.fn(() => ({ inspect: networkInspect })),
      getContainer: vi.fn(() => ({ inspect: containerInspect })),
    };
    service = new ProxyTrustService(docker as never, mock<LoggerService>());
    vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '');
    vi.stubEnv('HUB_EDGE_TAILSCALE_IP', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const edgeNetwork = { IPAM: { Config: [{ Subnet: '10.128.0.0/29', Gateway: '10.128.0.1' }] } };
  const traefikOnHubNetwork = (ip: string) => ({
    NetworkSettings: { Networks: { 'ci-hub_network': { IPAddress: ip }, 'ci-hub_edge': { IPAddress: '10.128.0.2' } } },
  });

  it('trusts nothing until it has read Docker', () => {
    expect(service.trustedProxyCidrs()).toEqual([]);
    expect(service.isTrustedProxy('172.19.0.7')).toBe(false);
  });

  it('trusts exactly the two edge hops and Traefik, each as a /32', async () => {
    networkInspect.mockResolvedValue(edgeNetwork);
    containerInspect.mockResolvedValue(traefikOnHubNetwork('172.19.0.7'));

    await service.refresh();

    expect(service.trustedProxyCidrs()).toEqual(['10.128.0.3/32', '10.128.0.4/32', '172.19.0.7/32']);
    // cloudflared and the Tailscale sidecar, at their fixed edge addresses.
    expect(service.isTrustedProxy('10.128.0.3')).toBe(true);
    expect(service.isTrustedProxy('10.128.0.4')).toBe(true);
    // The edge bridge's gateway is where anything that reaches Traefik through
    // the host arrives from (docker-proxy, or an app dialling
    // host.docker.internal:80), so it must never vouch for anyone.
    expect(service.isTrustedProxy('10.128.0.1')).toBe(false);
    // Nor the rest of the subnet: nothing else on it is a hop.
    expect(service.isTrustedProxy('10.128.0.5')).toBe(false);
    expect(service.isTrustedProxy('172.19.0.7')).toBe(true);
    // Express hands over the socket address IPv6-mapped; still Traefik.
    expect(service.isTrustedProxy('::ffff:172.19.0.7')).toBe(true);
    // A neighbouring app container on the Hub network is NOT a proxy.
    expect(service.isTrustedProxy('172.19.0.8')).toBe(false);
    // Nor is the real client, wherever it is.
    expect(service.isTrustedProxy('203.0.113.9')).toBe(false);
    expect(service.isTrustedProxy('192.168.1.20')).toBe(false);
  });

  it('trusts only Traefik when the edge network does not exist (older stack)', async () => {
    networkInspect.mockRejectedValue(new Error('no such network'));
    containerInspect.mockResolvedValue(traefikOnHubNetwork('172.19.0.7'));

    await service.refresh();

    expect(service.trustedProxyCidrs()).toEqual(['172.19.0.7/32']);
    expect(service.isTrustedProxy('10.128.0.3')).toBe(false);
  });

  it('trusts nothing when Traefik is not running and there is no edge network', async () => {
    networkInspect.mockRejectedValue(new Error('no such network'));
    containerInspect.mockRejectedValue(new Error('no such container'));

    await service.refresh();

    expect(service.trustedProxyCidrs()).toEqual([]);
  });

  it('follows a recreated Traefik to its new address', async () => {
    networkInspect.mockResolvedValue(edgeNetwork);
    containerInspect.mockResolvedValueOnce(traefikOnHubNetwork('172.19.0.7'));
    await service.refresh();
    expect(service.isTrustedProxy('172.19.0.7')).toBe(true);

    containerInspect.mockResolvedValueOnce(traefikOnHubNetwork('172.19.0.12'));
    await service.refresh();

    expect(service.isTrustedProxy('172.19.0.7')).toBe(false);
    expect(service.isTrustedProxy('172.19.0.12')).toBe(true);
  });

  it('refuses a configured hop that is the edge gateway or off the edge subnet', async () => {
    vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '10.128.0.1');
    vi.stubEnv('HUB_EDGE_TAILSCALE_IP', '10.200.0.4');
    networkInspect.mockResolvedValue(edgeNetwork);
    containerInspect.mockResolvedValue(traefikOnHubNetwork('172.19.0.7'));

    await service.refresh();

    expect(service.trustedProxyCidrs()).toEqual(['172.19.0.7/32']);
  });

  it('takes the first host as the gateway when the network does not name one', async () => {
    vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '10.128.0.1');
    networkInspect.mockResolvedValue({ IPAM: { Config: [{ Subnet: '10.128.0.0/29' }] } });
    containerInspect.mockRejectedValue(new Error('no such container'));

    await service.refresh();

    expect(service.trustedProxyCidrs()).toEqual(['10.128.0.4/32']);
  });

  it('follows an operator-moved edge network and its hop addresses', async () => {
    vi.stubEnv('HUB_EDGE_CLOUDFLARED_IP', '10.200.0.3');
    vi.stubEnv('HUB_EDGE_TAILSCALE_IP', '10.200.0.4');
    networkInspect.mockResolvedValue({ IPAM: { Config: [{ Subnet: '10.200.0.0/29', Gateway: '10.200.0.1' }] } });
    containerInspect.mockResolvedValue(traefikOnHubNetwork('172.19.0.7'));

    await service.refresh();

    expect(service.trustedProxyCidrs()).toEqual(['10.200.0.3/32', '10.200.0.4/32', '172.19.0.7/32']);
    expect(service.isTrustedProxy('10.128.0.3')).toBe(false);
  });

  it('ignores anything that is not an IPv4 literal', async () => {
    networkInspect.mockResolvedValue(edgeNetwork);
    containerInspect.mockResolvedValue(traefikOnHubNetwork('172.19.0.7'));
    await service.refresh();

    expect(service.isTrustedProxy(undefined)).toBe(false);
    expect(service.isTrustedProxy('')).toBe(false);
    expect(service.isTrustedProxy('traefik')).toBe(false);
    expect(service.isTrustedProxy('fd00::1')).toBe(false);
  });
});
