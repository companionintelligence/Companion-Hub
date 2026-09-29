import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '../docker.service';

/*
 * Inference is handed to every app as `http://ci-hub:<port>/...`, and that name exists only on a
 * network the Hub container is attached to. Compose puts a service on the shared Hub network only
 * when it is `isMain` or `addToMainNetwork`, so a sibling that calls inference cannot resolve
 * `ci-hub`. The Hub joins the app's own network instead of pulling those services onto the shared
 * one, where their compose names would collide with other apps.
 */

const APP_URN = 'ci-memory:ci-marketplace' as never;
const APP_NETWORK = 'ci-memory_ci-marketplace_network';

const runningHub = (networks: Record<string, unknown>) => ({
  Name: '/ci-hub',
  State: { Running: true },
  NetworkSettings: { Networks: networks },
});

describe('DockerService app-network membership', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const setup = (hub: unknown) => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const networks = new Map<string, { Internal?: boolean; remove?: ReturnType<typeof vi.fn> }>();
    const docker = {
      listNetworks: vi.fn().mockResolvedValue([]),
      getNetwork: vi.fn((id: string) => ({
        connect,
        disconnect,
        inspect: vi.fn().mockResolvedValue({ Name: id, Internal: networks.get(id)?.Internal === true }),
        remove: networks.get(id)?.remove ?? vi.fn(),
      })),
      getContainer: vi.fn(() => ({
        inspect: hub instanceof Error ? vi.fn().mockRejectedValue(hub) : vi.fn().mockResolvedValue(hub),
      })),
    };
    const logger = mock<LoggerService>();
    const dockerReadFacade = { getComposeProjectName: (appUrn: string) => String(appUrn).replace(':', '_') };
    const service = new DockerService(logger, mock(), mock(), mock(), mock(), docker as never, dockerReadFacade as never);
    return { service, connect, disconnect, docker, networks, logger };
  };

  const projectNetwork = (id: string, name: string, labels: Record<string, string> = {}) => ({ Id: id, Name: name, Labels: labels });

  it('joins the app network after up, without taking the Hub default route or a fixed address', async () => {
    const { service, connect, docker, networks } = setup(runningHub({ 'ci-hub_network': {} }));
    networks.set('app-net', { Internal: false });
    docker.listNetworks.mockResolvedValue([
      projectNetwork('app-net', APP_NETWORK, { 'ci-hub.managed': 'true' }),
      projectNetwork('hub-net', 'ci-hub_network'),
      projectNetwork('ext', 'user_external', { 'com.docker.compose.network.external': 'true' }),
    ]);

    await service.attachHubToAppNetworks(APP_URN);

    expect(docker.listNetworks).toHaveBeenCalledWith({
      filters: { label: ['com.docker.compose.project=ci-memory_ci-marketplace'] },
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      Container: 'ci-hub',
      EndpointConfig: { Aliases: ['ci-hub', 'ci-os-hub'], GwPriority: -1 },
    });
  });

  it('leaves a Hub that is already on the app network alone', async () => {
    const { service, connect, docker, networks } = setup(runningHub({ 'ci-hub_network': {}, [APP_NETWORK]: {} }));
    networks.set('app-net', { Internal: false });
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

    await service.attachHubToAppNetworks(APP_URN);

    expect(connect).not.toHaveBeenCalled();
  });

  it('does not join an internal app network', async () => {
    const { service, connect, docker, networks, logger } = setup(runningHub({ 'ci-hub_network': {} }));
    networks.set('app-net', { Internal: true });
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

    await service.attachHubToAppNetworks(APP_URN);

    expect(connect).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('internal network'));
  });

  it('reports a failed attach instead of throwing into compose up', async () => {
    const { service, connect, docker, networks } = setup(runningHub({ 'ci-hub_network': {} }));
    networks.set('app-net', { Internal: false });
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);
    connect.mockRejectedValue(new Error('network is at capacity'));

    await expect(service.attachHubToAppNetworks(APP_URN)).resolves.toBeUndefined();
  });

  it('does nothing when the Hub container is not running', async () => {
    const { service, connect, docker } = setup(new Error('no such container'));
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

    await service.attachHubToAppNetworks(APP_URN);
    await service.detachHubFromAppNetworks(APP_URN);

    expect(connect).not.toHaveBeenCalled();
    expect(docker.listNetworks).not.toHaveBeenCalled();
  });

  it('detaches before a network can be deleted, and ignores one it is not on', async () => {
    const { service, disconnect, docker, networks } = setup(runningHub({ 'ci-hub_network': {}, [APP_NETWORK]: {} }));
    networks.set('app-net', {});
    docker.listNetworks.mockResolvedValue([
      projectNetwork('app-net', APP_NETWORK),
      projectNetwork('hub-net', 'ci-hub_network'),
      projectNetwork('other', 'other_app_network'),
    ]);

    await service.detachHubFromAppNetworks(APP_URN);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith({ Container: 'ci-hub', Force: true });
  });

  it('treats an already-disconnected network as detached', async () => {
    const { service, disconnect, docker, networks } = setup(runningHub({ [APP_NETWORK]: {} }));
    networks.set('app-net', {});
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);
    disconnect.mockRejectedValue(new Error('ci-hub is not connected to the network'));

    await expect(service.detachHubFromAppNetworks(APP_URN)).resolves.toBeUndefined();
  });

  it('rejoins managed app networks on boot, and still skips internal ones', async () => {
    const { service, connect, docker, networks } = setup(runningHub({ 'ci-hub_network': {} }));
    networks.set('app-net', { Internal: false });
    networks.set('isolated', { Internal: true });
    docker.listNetworks.mockImplementation(async (options?: { filters?: { label?: string[] } }) => {
      const label = options?.filters?.label?.[0] ?? '';
      if (label.startsWith('ci-hub.managed')) {
        return [projectNetwork('app-net', APP_NETWORK, { 'ci-hub.managed': 'true' })];
      }
      if (label.startsWith('ci-os-hub.managed')) {
        return [projectNetwork('isolated', 'secret_store_network', { 'ci-os-hub.managed': 'true' })];
      }
      return [];
    });

    await service.ensureHubOnAppNetworks();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      Container: 'ci-hub',
      EndpointConfig: { Aliases: ['ci-hub', 'ci-os-hub'], GwPriority: -1 },
    });
  });

  it('finds a Hub that is still named ci-os-hub and registers ci-hub as an alias', async () => {
    vi.stubEnv('RABBITMQ_HOST', 'ci-os-hub-queue');
    const legacy = {
      Name: '/ci-os-hub',
      State: { Running: true },
      NetworkSettings: { Networks: { 'ci-os-hub_network': {} } },
    };
    const { service, connect, docker, networks } = setup(legacy);
    networks.set('app-net', { Internal: false });
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);
    docker.getContainer.mockImplementation((name: string) => ({
      inspect: vi.fn().mockImplementation(async () => {
        if (name === 'ci-os-hub') return legacy;
        throw new Error('no such container');
      }),
    }));

    await service.attachHubToAppNetworks(APP_URN);

    expect(connect).toHaveBeenCalledWith({
      Container: 'ci-os-hub',
      EndpointConfig: { Aliases: ['ci-hub', 'ci-os-hub'], GwPriority: -1 },
    });
  });
});
