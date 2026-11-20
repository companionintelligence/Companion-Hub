import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { DockerService } from '../docker.service';

/*
 * Each app is on a network of its own and on no network another app is on. The Hub (as `ci-hub`, which
 * apps are handed for inference and the Hub API), Traefik (at a fixed address the app trusts) and the
 * Private VPN sidecar join that network to reach the app. An app container still on the shared Hub
 * network from before is taken off it.
 */

const APP_URN = 'ci-memory:ci-marketplace' as never;
const APP_NETWORK = 'ci-memory_ci-marketplace_network';
const APP_SUBNET = '10.128.12.0/24';

type Inspect = {
  Name?: string;
  State?: { Running?: boolean; Status?: string; Error?: string };
  NetworkSettings?: { Networks?: Record<string, unknown> };
};

const running = (name: string, networks: Record<string, unknown>): Inspect => ({
  Name: `/${name}`,
  State: { Running: true },
  NetworkSettings: { Networks: networks },
});

const stopped = (name: string, networks: Record<string, unknown>, error = ''): Inspect => ({
  Name: `/${name}`,
  State: { Running: false, Status: 'exited', Error: error },
  NetworkSettings: { Networks: networks },
});

describe('DockerService app-network membership', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** `containers` by name; a name that is absent is a container that does not exist. */
  const setup = (containers: Record<string, Inspect>) => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const networks = new Map<string, { Internal?: boolean; Subnet?: string }>();
    /** Networks that no longer exist: inspecting one is a 404. */
    const deletedNetworks = new Set<string>();
    const start = vi.fn().mockResolvedValue(undefined);
    const docker = {
      listNetworks: vi.fn().mockResolvedValue([]),
      listContainers: vi.fn().mockResolvedValue([]),
      getNetwork: vi.fn((id: string) => ({
        connect,
        disconnect,
        inspect: vi.fn().mockImplementation(async () => {
          if (deletedNetworks.has(id)) throw new Error(`(HTTP code 404) no such network - network ${id} not found`);
          return {
            Name: id,
            Internal: networks.get(id)?.Internal === true,
            IPAM: { Config: [{ Subnet: networks.get(id)?.Subnet ?? APP_SUBNET }] },
          };
        }),
        remove: vi.fn(),
      })),
      getContainer: vi.fn((name: string) => ({
        inspect: vi.fn().mockImplementation(async () => {
          const found = containers[name];
          if (!found) throw new Error(`(HTTP code 404) no such container - No such container: ${name}`);
          return found;
        }),
        start: () => start(name),
      })),
      version: vi.fn().mockResolvedValue({ Components: [{ Name: 'Engine' }] }),
    };
    const logger = mock<LoggerService>();
    const dockerReadFacade = { getComposeProjectName: (appUrn: string) => String(appUrn).replace(':', '_') };
    const service = new DockerService(logger, mock(), mock(), mock(), mock(), docker as never, dockerReadFacade as never);
    return { service, connect, disconnect, docker, networks, logger, start, deletedNetworks };
  };

  const projectNetwork = (id: string, name: string, labels: Record<string, string> = {}) => ({ Id: id, Name: name, Labels: labels });

  const hubOnly = () => ({ 'ci-hub': running('ci-hub', { 'ci-hub_network': {} }) });
  const allThree = () => ({
    ...hubOnly(),
    traefik: running('traefik', { 'ci-hub_network': {}, 'ci-hub_edge': {} }),
    'hub-tailscale': running('hub-tailscale', { 'ci-hub_network': {}, 'ci-hub_edge': {} }),
  });

  it('joins the Hub, Traefik at its fixed address and the VPN sidecar to the app network after up', async () => {
    const { service, connect, docker, networks } = setup(allThree());
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
    expect(connect.mock.calls.map(([options]) => options)).toEqual([
      { Container: 'ci-hub', EndpointConfig: { Aliases: ['ci-hub', 'ci-os-hub'], GwPriority: -1 } },
      { Container: 'traefik', EndpointConfig: { IPAMConfig: { IPv4Address: '10.128.12.254' }, Aliases: [], GwPriority: -1 } },
      { Container: 'hub-tailscale', EndpointConfig: { Aliases: [], GwPriority: -1 } },
    ]);
  });

  it('joins Traefik where Docker says when its fixed address is taken, and warns that the app will not trust it', async () => {
    const { service, connect, docker, networks, logger } = setup({ ...hubOnly(), traefik: running('traefik', { 'ci-hub_network': {} }) });
    networks.set('app-net', { Internal: false });
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);
    connect.mockImplementation(async ({ EndpointConfig }: { EndpointConfig: { IPAMConfig?: unknown } }) => {
      if (EndpointConfig.IPAMConfig) throw new Error('Address already in use');
    });

    await service.attachHubToAppNetworks(APP_URN);

    expect(connect).toHaveBeenLastCalledWith({ Container: 'traefik', EndpointConfig: { Aliases: [], GwPriority: -1 } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('will not trust the client address Traefik forwards'));
  });

  it('leaves a member that is already on the app network alone', async () => {
    const { service, connect, docker, networks } = setup({
      'ci-hub': running('ci-hub', { 'ci-hub_network': {}, [APP_NETWORK]: {} }),
      traefik: running('traefik', { [APP_NETWORK]: {} }),
    });
    networks.set('app-net', { Internal: false });
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

    await service.attachHubToAppNetworks(APP_URN);

    expect(connect).not.toHaveBeenCalled();
  });

  it('does not join an internal app network', async () => {
    const { service, connect, docker, networks, logger } = setup(allThree());
    networks.set('app-net', { Internal: true });
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

    await service.attachHubToAppNetworks(APP_URN);

    expect(connect).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('internal network'));
  });

  it('never joins a network that links two apps', async () => {
    const { service, connect, docker } = setup(allThree());
    docker.listNetworks.mockResolvedValue([projectNetwork('link', 'ci-hub-link_0123456789abcdef')]);

    await service.attachHubToAppNetworks(APP_URN);

    expect(connect).not.toHaveBeenCalled();
  });

  it('reports a failed attach instead of throwing into compose up', async () => {
    const { service, connect, docker, networks } = setup(hubOnly());
    networks.set('app-net', { Internal: false });
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);
    connect.mockRejectedValue(new Error('network is at capacity'));

    await expect(service.attachHubToAppNetworks(APP_URN)).resolves.toBeUndefined();
  });

  it('does nothing when the Hub container is not running', async () => {
    const { service, connect, docker } = setup({});
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

    await service.attachHubToAppNetworks(APP_URN);
    await service.detachHubFromAppNetworks(APP_URN);

    expect(connect).not.toHaveBeenCalled();
  });

  it('detaches every member before a network can be deleted, and ignores one it is not on', async () => {
    const { service, disconnect, docker, networks } = setup({
      'ci-hub': running('ci-hub', { 'ci-hub_network': {}, [APP_NETWORK]: {} }),
      traefik: running('traefik', { [APP_NETWORK]: {} }),
      'hub-tailscale': running('hub-tailscale', { 'ci-hub_edge': {} }),
    });
    networks.set('app-net', {});
    docker.listNetworks.mockResolvedValue([
      projectNetwork('app-net', APP_NETWORK),
      projectNetwork('hub-net', 'ci-hub_network'),
      projectNetwork('other', 'other_app_network'),
    ]);

    await service.detachHubFromAppNetworks(APP_URN);

    expect(disconnect.mock.calls.map(([options]) => options)).toEqual([
      { Container: 'ci-hub', Force: true },
      { Container: 'traefik', Force: true },
    ]);
  });

  it('treats an already-disconnected network as detached', async () => {
    const { service, disconnect, docker, networks } = setup({ 'ci-hub': running('ci-hub', { [APP_NETWORK]: {} }) });
    networks.set('app-net', {});
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);
    disconnect.mockRejectedValue(new Error('ci-hub is not connected to the network'));

    await expect(service.detachHubFromAppNetworks(APP_URN)).resolves.toBeUndefined();
  });

  it('rejoins managed app networks on boot, still skips internal ones, and tells the listeners', async () => {
    const { service, connect, docker, networks } = setup(hubOnly());
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
    const listener = vi.fn();
    service.onAppNetworksSettled(listener);

    await service.ensureHubOnAppNetworks();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(null));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({
      Container: 'ci-hub',
      EndpointConfig: { Aliases: ['ci-hub', 'ci-os-hub'], GwPriority: -1 },
    });
  });

  it('takes app containers off the shared Hub networks, and nothing else', async () => {
    const { service, disconnect, docker, logger } = setup(hubOnly());
    docker.listContainers.mockImplementation(async ({ filters }: { filters: { network: string[] } }) =>
      filters.network[0] === 'ci-hub_network'
        ? [
            { Id: 'app-1', Names: ['/ci-memory_ci-marketplace-gateway-1'], Labels: { 'ci-hub.appurn': 'ci-memory:ci-marketplace' } },
            { Id: 'legacy-1', Names: ['/old-app-1'], Labels: { 'ci-os-hub.appurn': 'old:store' } },
            { Id: 'traefik-1', Names: ['/traefik'], Labels: { 'ci-hub.managed': 'true' } },
            { Id: 'hub-1', Names: ['/ci-hub'], Labels: {} },
          ]
        : [],
    );

    // Each must be recreated: its containers still name the network they left in their Traefik label.
    await expect(service.moveAppsOffSharedNetworks()).resolves.toEqual(['ci-memory:ci-marketplace', 'old:store']);

    expect(disconnect.mock.calls.map(([options]) => options)).toEqual([
      { Container: 'app-1', Force: true },
      { Container: 'legacy-1', Force: true },
    ]);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('apps no longer share a network'));
  });

  it('finds a Hub that is still named ci-os-hub and registers ci-hub as an alias', async () => {
    vi.stubEnv('RABBITMQ_HOST', 'ci-os-hub-queue');
    const { service, connect, docker, networks } = setup({ 'ci-os-hub': running('ci-os-hub', { 'ci-os-hub_network': {} }) });
    networks.set('app-net', { Internal: false });
    docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

    await service.attachHubToAppNetworks(APP_URN);

    expect(connect).toHaveBeenCalledWith({
      Container: 'ci-os-hub',
      EndpointConfig: { Aliases: ['ci-hub', 'ci-os-hub'], GwPriority: -1 },
    });
  });

  /*
   * A Traefik that is down still has to follow the app networks. Docker lets a stopped container join
   * and leave networks and applies them at its next start. Left out, a Traefik that failed its bind
   * mount at boot missed the networks apps created meanwhile and kept the ones `compose down` deleted,
   * and Docker then refused to start it ("network <id> not found").
   */
  describe('a Traefik that is not running', () => {
    it('is joined to an app network at its fixed address all the same', async () => {
      const { service, connect, docker, networks } = setup({ ...hubOnly(), traefik: stopped('traefik', { 'ci-hub_network': {} }) });
      networks.set('app-net', { Internal: false });
      docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

      await service.attachHubToAppNetworks(APP_URN);

      expect(connect).toHaveBeenCalledWith({
        Container: 'traefik',
        EndpointConfig: { IPAMConfig: { IPv4Address: '10.128.12.254' }, Aliases: [], GwPriority: -1 },
      });
    });

    it('is taken off an app network before compose down deletes it', async () => {
      const { service, disconnect, docker, networks } = setup({ ...hubOnly(), traefik: stopped('traefik', { [APP_NETWORK]: {} }) });
      networks.set('app-net', {});
      docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

      await service.detachHubFromAppNetworks(APP_URN);

      expect(disconnect).toHaveBeenCalledWith({ Container: 'traefik', Force: true });
    });

    it('does not warn about a VPN sidecar that does not exist', async () => {
      const { service, docker, networks, logger } = setup({ ...hubOnly(), traefik: stopped('traefik', {}) });
      networks.set('app-net', { Internal: false });
      docker.listNetworks.mockResolvedValue([projectNetwork('app-net', APP_NETWORK)]);

      await service.attachHubToAppNetworks(APP_URN);

      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('hub-tailscale'));
    });
  });

  /*
   * Docker does not retry a container that failed to start when the daemon did. Traefik fails then
   * whenever the Hub's data folder is mounted after Docker (an encrypted home or drive), and every app
   * hostname stays dead while the Hub is healthy.
   */
  describe('ensureTraefikRunning', () => {
    const BIND_MOUNT_ERROR =
      'error mounting "/data/traefik/config/traefik.yml" to rootfs at "/etc/traefik/traefik.yml": not a directory: Are you trying to mount a directory onto a file (or vice-versa)?';

    it('leaves a running Traefik alone', async () => {
      const { service, start } = setup(allThree());
      await expect(service.ensureTraefikRunning([0])).resolves.toBe('running');
      expect(start).not.toHaveBeenCalled();
    });

    it('does nothing when there is no Traefik container', async () => {
      const { service, start, logger } = setup(hubOnly());
      await expect(service.ensureTraefikRunning([0])).resolves.toBe('absent');
      expect(start).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('starts one that failed its bind mount at boot, and says why it was down', async () => {
      const { service, start, logger } = setup({ ...hubOnly(), traefik: stopped('traefik', {}, BIND_MOUNT_ERROR) });

      await expect(service.ensureTraefikRunning([0])).resolves.toBe('started');

      expect(start).toHaveBeenCalledWith('traefik');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mount a directory onto a file'));
    });

    it('tries again while the data folder is still missing, and starts it once it is there', async () => {
      const { service, start } = setup({ ...hubOnly(), traefik: stopped('traefik', {}) });
      start.mockRejectedValueOnce(new Error(BIND_MOUNT_ERROR)).mockRejectedValueOnce(new Error(BIND_MOUNT_ERROR));

      await expect(service.ensureTraefikRunning([0, 0, 0, 0])).resolves.toBe('started');

      expect(start).toHaveBeenCalledTimes(3);
    });

    it('takes it off a network that no longer exists, then starts it', async () => {
      const { service, start, disconnect, deletedNetworks } = setup({
        ...hubOnly(),
        traefik: stopped('traefik', { 'ci-hub_network': {}, gone_app_network: { NetworkID: '8dc999fc0fc3aaaa' } }),
      });
      deletedNetworks.add('gone_app_network');
      start.mockRejectedValueOnce(
        new Error('(HTTP code 500) server error - failed to set up container networking: network 8dc999fc0fc3aaaa not found'),
      );

      await expect(service.ensureTraefikRunning([0, 0])).resolves.toBe('started');

      // Only the deleted one: a network that exists (by name) is left as it is.
      expect(disconnect.mock.calls.map(([options]) => options)).toEqual([{ Container: 'traefik', Force: true }]);
      expect(start).toHaveBeenCalledTimes(2);
    });

    it('treats one started meanwhile as running', async () => {
      const { service, start } = setup({ ...hubOnly(), traefik: stopped('traefik', {}) });
      start.mockRejectedValueOnce(Object.assign(new Error('(HTTP code 304) container already started'), { statusCode: 304 }));

      await expect(service.ensureTraefikRunning([0])).resolves.toBe('running');
    });

    it('gives up after its last try, with the command that recreates it, and never throws', async () => {
      const { service, start, logger } = setup({ ...hubOnly(), traefik: stopped('traefik', {}) });
      start.mockRejectedValue(new Error(BIND_MOUNT_ERROR));

      await expect(service.ensureTraefikRunning([0, 0])).resolves.toBe('failed');

      expect(start).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('docker compose up -d --force-recreate traefik'));
    });
  });
});
