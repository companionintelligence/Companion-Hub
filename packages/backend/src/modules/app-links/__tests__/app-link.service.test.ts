import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { LoggerService } from '@/core/logger/logger.service';
import { AppLinkService } from '../app-link.service';
import { appLinkNetworkName } from '../app-link-plan';

const OPENCLAW = 'ci-openclaw:ci-marketplace';
const MEMORY = 'ci-memory:ci-marketplace';
const LINK = appLinkNetworkName({ consumerUrn: OPENCLAW as never, providerUrn: MEMORY as never, service: 'gateway', alias: 'ci-memory' });

type Container = { Id: string; State: string; Labels: Record<string, string>; HostConfig?: { NetworkMode?: string } };

const container = (id: string, urn: string, service: string, extra: Partial<Container> = {}): Container => ({
  Id: id,
  State: 'running',
  Labels: { 'ci-hub.appurn': urn, 'com.docker.compose.service': service },
  ...extra,
});

/** A Docker that holds `containers`, link networks by name, and nothing else. */
function setup({
  containers,
  linkNetworks = {},
  apple = false,
}: {
  containers: Container[];
  linkNetworks?: Record<string, string[]>;
  apple?: boolean;
}) {
  const networks = new Map(Object.entries(linkNetworks).map(([name, members]) => [name, new Set(members)]));
  const created: Array<Record<string, unknown>> = [];
  const connected: Array<{ network: string; Container: string; Aliases: string[] }> = [];
  const disconnected: Array<{ network: string; Container: string }> = [];
  const removed: string[] = [];

  const docker = {
    listContainers: vi.fn(async ({ filters }: { filters: { label: string[] } }) =>
      containers.filter((entry) =>
        filters.label.every((label) => {
          const [key, value] = label.split('=');
          return entry.Labels[key as string] === value;
        }),
      ),
    ),
    listNetworks: vi.fn(async (options?: { filters?: { label?: string[] } }) =>
      options?.filters?.label
        ? [...networks.keys()].map((name) => ({ Id: name, Name: name, Labels: { 'ci-hub.app-link': 'true' } }))
        : [{ IPAM: { Config: [{ Subnet: '10.128.0.0/29' }] } }, { IPAM: { Config: [{ Subnet: '10.128.1.0/27' }] } }],
    ),
    createNetwork: vi.fn(async (options: { Name: string }) => {
      created.push(options);
      networks.set(options.Name, new Set());
    }),
    getNetwork: vi.fn((name: string) => ({
      inspect: async () => ({ Containers: Object.fromEntries([...(networks.get(name) ?? [])].map((id) => [id, {}])) }),
      connect: async ({ Container, EndpointConfig }: { Container: string; EndpointConfig: { Aliases: string[] } }) => {
        connected.push({ network: name, Container, Aliases: EndpointConfig.Aliases });
        networks.get(name)?.add(Container);
      },
      disconnect: async ({ Container }: { Container: string }) => {
        disconnected.push({ network: name, Container });
        networks.get(name)?.delete(Container);
      },
      remove: async () => {
        removed.push(name);
        networks.delete(name);
      },
    })),
  };
  const dockerService = { onAppNetworksSettled: vi.fn(() => () => undefined), isAppleContainerEngine: vi.fn().mockResolvedValue(apple) };
  const consumer = { memory: { url_env: 'CI_SERVER_URL', token_env: 'CI_SERVER_TOKEN' } };
  const appsReadService = {
    getInstalledApps: vi
      .fn()
      .mockResolvedValue([
        { info: { urn: OPENCLAW, hub_integration: consumer } },
        { info: { id: 'ci-memory', urn: MEMORY, hub_integration: { memory: { provider: { service: 'gateway', port: 8642 } } } } },
      ]),
  };
  const approvals = { list: vi.fn().mockResolvedValue([]), approve: vi.fn(), revoke: vi.fn(), forgetApp: vi.fn() };
  const logger = mock<LoggerService>();
  const service = new AppLinkService(logger, docker as never, dockerService as never, appsReadService as never, approvals as never);
  return { service, docker, created, connected, disconnected, removed, networks, logger, appsReadService };
}

describe('AppLinkService', () => {
  it("creates the link network on a free subnet, connects the consumer's containers by no name and the gateway as ci-memory", async () => {
    const { service, created, connected } = setup({
      containers: [
        container('oc-main', OPENCLAW, 'openclaw'),
        container('oc-worker', OPENCLAW, 'worker'),
        container('oc-shared', OPENCLAW, 'sidecar', { HostConfig: { NetworkMode: 'container:oc-main' } }),
        container('mem-gw', MEMORY, 'gateway'),
        container('mem-db', MEMORY, 'postgres'),
      ],
    });

    await service.reconcile();

    expect(created).toEqual([
      {
        Name: LINK,
        Driver: 'bridge',
        Internal: true,
        IPAM: { Config: [{ Subnet: '10.128.1.32/27' }] },
        Labels: { 'ci-hub.app-link': 'true', 'ci-hub.app-link.consumer': OPENCLAW, 'ci-hub.app-link.provider': MEMORY },
      },
    ]);
    // Never ci-memory's database, never a container that shares another's network stack.
    expect(connected).toEqual([
      { network: LINK, Container: 'oc-main', Aliases: [] },
      { network: LINK, Container: 'oc-worker', Aliases: [] },
      { network: LINK, Container: 'mem-gw', Aliases: ['ci-memory'] },
    ]);
  });

  it('takes anything that does not belong off a link network', async () => {
    const { service, connected, disconnected } = setup({
      containers: [container('oc-main', OPENCLAW, 'openclaw'), container('mem-gw', MEMORY, 'gateway')],
      linkNetworks: { [LINK]: ['oc-main', 'mem-gw', 'intruder'] },
    });

    await service.reconcile();

    expect(connected).toEqual([]);
    expect(disconnected).toEqual([{ network: LINK, Container: 'intruder' }]);
  });

  it('removes the network of a link no longer in force', async () => {
    const { service, removed, disconnected, appsReadService } = setup({
      containers: [container('oc-main', OPENCLAW, 'openclaw')],
      linkNetworks: { [LINK]: ['oc-main'], 'ci-hub-link_stale0123456789ab': ['x'] },
    });
    appsReadService.getInstalledApps.mockResolvedValue([{ info: { urn: OPENCLAW, hub_integration: {} } }]);

    await service.reconcile();

    expect(removed.sort()).toEqual([LINK, 'ci-hub-link_stale0123456789ab'].sort());
    expect(disconnected).toEqual(expect.arrayContaining([{ network: LINK, Container: 'oc-main' }]));
  });

  it('creates nothing until both apps run', async () => {
    const { service, created, connected } = setup({ containers: [container('oc-main', OPENCLAW, 'openclaw')] });

    await service.reconcile();

    expect(created).toEqual([]);
    expect(connected).toEqual([]);
  });

  it('links nothing on Apple container, and says so once', async () => {
    const { service, created, logger } = setup({
      containers: [container('oc-main', OPENCLAW, 'openclaw'), container('mem-gw', MEMORY, 'gateway')],
      apple: true,
    });

    await service.reconcile();
    await service.reconcile();

    expect(created).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
