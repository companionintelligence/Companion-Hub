import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DockerService } from '../docker.service';

/*
 * cloudflared is on the edge network ONLY. A Hub rolled with `up -d ci-hub` against the new compose
 * file keeps a Traefik created before that network existed, and when the Hub then recreates
 * cloudflared, compose creates the network for cloudflared alone: `traefik:80` stops resolving and
 * every tunnelled app returns 502 until a full `up`.
 */
describe('DockerService.ensureTraefikOnEdgeNetwork', () => {
  const setup = (traefik: unknown, edge: 'exists' | 'missing' = 'exists') => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const docker = {
      getNetwork: vi.fn(() => ({
        inspect: edge === 'exists' ? vi.fn().mockResolvedValue({ Name: 'ci-hub_edge' }) : vi.fn().mockRejectedValue(new Error('network not found')),
        connect,
      })),
      getContainer: vi.fn(() => ({
        inspect: traefik instanceof Error ? vi.fn().mockRejectedValue(traefik) : vi.fn().mockResolvedValue(traefik),
      })),
    };
    const service = new DockerService(mock(), mock(), mock(), mock(), mock(), docker as never, mock());
    return { service, connect };
  };
  const running = (networks: Record<string, unknown>) => ({ State: { Running: true }, NetworkSettings: { Networks: networks } });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('attaches a pre-edge Traefik at its fixed address, without taking over its default route', async () => {
    const { service, connect } = setup(running({ 'ci-hub_network': {}, 'ci-os-hub_network': {} }));

    await expect(service.ensureTraefikOnEdgeNetwork()).resolves.toBe('attached');

    expect(connect).toHaveBeenCalledWith({
      Container: 'traefik',
      EndpointConfig: { IPAMConfig: { IPv4Address: '10.128.0.2' }, Aliases: ['traefik'], GwPriority: -1 },
    });
  });

  it('follows an operator-moved edge address', async () => {
    vi.stubEnv('HUB_EDGE_TRAEFIK_IP', '10.200.0.2');
    const { service, connect } = setup(running({ 'ci-hub_network': {} }));

    await service.ensureTraefikOnEdgeNetwork();

    expect(connect.mock.calls[0]?.[0]).toMatchObject({ EndpointConfig: { IPAMConfig: { IPv4Address: '10.200.0.2' } } });
  });

  it('leaves a Traefik already on the edge network alone', async () => {
    const { service, connect } = setup(running({ 'ci-hub_network': {}, 'ci-hub_edge': {} }));

    await expect(service.ensureTraefikOnEdgeNetwork()).resolves.toBe('present');
    expect(connect).not.toHaveBeenCalled();
  });

  it('does nothing on a stack without the edge network, or without a running Traefik', async () => {
    const preEdge = setup(running({ 'ci-hub_network': {} }), 'missing');
    await expect(preEdge.service.ensureTraefikOnEdgeNetwork()).resolves.toBe('skipped');
    expect(preEdge.connect).not.toHaveBeenCalled();

    const stopped = setup({ State: { Running: false }, NetworkSettings: { Networks: {} } });
    await expect(stopped.service.ensureTraefikOnEdgeNetwork()).resolves.toBe('skipped');

    const absent = setup(new Error('no such container'));
    await expect(absent.service.ensureTraefikOnEdgeNetwork()).resolves.toBe('skipped');
    expect(absent.connect).not.toHaveBeenCalled();
  });

  it('reports a failed attach instead of throwing into the tunnel start', async () => {
    const { service, connect } = setup(running({ 'ci-hub_network': {} }));
    connect.mockRejectedValue(new Error('Address already in use'));

    await expect(service.ensureTraefikOnEdgeNetwork()).resolves.toBe('failed');
  });
});
