import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { mock } from 'vitest-mock-extended';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { NetworkDiagnosticsService } from '../network-diagnostics.service';

describe('NetworkDiagnosticsService', () => {
  let service: NetworkDiagnosticsService;
  let appsRepository: ReturnType<typeof mock<AppsRepository>>;
  let dockerMock: {
    listNetworks: ReturnType<typeof vi.fn>;
    listContainers: ReturnType<typeof vi.fn>;
    getNetwork: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    appsRepository = mock<AppsRepository>();
    dockerMock = {
      listNetworks: vi.fn(),
      listContainers: vi.fn(),
      getNetwork: vi.fn(),
    };

    service = new NetworkDiagnosticsService(appsRepository, mock<LoggerService>(), dockerMock as never);
  });

  it('reports duplicate DB subnets and occupied range conflicts', async () => {
    appsRepository.getApps.mockResolvedValue([
      fromPartial({ appName: 'ghost', appStoreSlug: 'ci-marketplace', subnet: '10.128.10.0/24' }),
      fromPartial({ appName: 'chatwoot', appStoreSlug: 'ci-marketplace', subnet: '10.128.11.0/24' }),
    ]);
    dockerMock.listNetworks.mockResolvedValue([
      fromPartial({
        Id: 'net-ghost',
        Name: 'ghost_ci-marketplace_network',
        Labels: { 'com.docker.compose.project': 'ghost_ci-marketplace' },
        IPAM: { Config: [{ Subnet: '10.128.10.0/24' }] },
      }),
      fromPartial({
        Id: 'net-chatwoot',
        Name: 'chatwoot_ci-marketplace_network',
        Labels: { 'com.docker.compose.project': 'chatwoot_ci-marketplace' },
        IPAM: { Config: [{ Subnet: '10.128.10.128/25' }] },
      }),
    ]);
    dockerMock.listContainers.mockResolvedValue([]);

    const report = await service.getDiagnostics();

    expect(report.duplicateDbSubnets).toEqual([]);
    expect(report.hubPoolOverlaps.length).toBeGreaterThan(0);
    expect(report.orphanNetworks).toEqual([
      expect.objectContaining({ dockerNetworkName: 'ghost_ci-marketplace_network' }),
      expect.objectContaining({ dockerNetworkName: 'chatwoot_ci-marketplace_network' }),
    ]);
  });

  it('removes orphan compose networks during repair', async () => {
    appsRepository.getApps.mockResolvedValue([]);
    dockerMock.listNetworks.mockResolvedValue([
      fromPartial({
        Id: 'net-ghost',
        Name: 'ghost_ci-marketplace_network',
        Labels: { 'com.docker.compose.project': 'ghost_ci-marketplace' },
        IPAM: { Config: [{ Subnet: '10.128.10.0/24' }] },
      }),
    ]);
    dockerMock.listContainers.mockResolvedValue([]);
    dockerMock.getNetwork.mockReturnValue({ remove: vi.fn().mockResolvedValue(undefined) });

    const repair = await service.repairOrphanNetworks();

    expect(repair.removed).toEqual(['ghost_ci-marketplace_network']);
    expect(dockerMock.getNetwork).toHaveBeenCalledWith('net-ghost');
  });

  /*
   * The Hub joins every app's own network so the app's non-main services can reach it
   * (HubAppNetworkService). Its endpoint must not keep an app network alive once the app's
   * containers are gone, and Docker will not remove the network until the Hub has left it.
   */
  describe('with the Hub on app networks', () => {
    const hub = (networks: string[]) =>
      fromPartial({
        Id: 'hub-id',
        Names: ['/ci-hub'],
        Labels: { 'com.docker.compose.project': 'ci-hub' },
        NetworkSettings: { Networks: Object.fromEntries(networks.map((name) => [name, { IPAddress: '10.128.10.2' }])) },
      });
    const network = (name: string, project: string) =>
      fromPartial({ Id: `net-${name}`, Name: name, Labels: { 'com.docker.compose.project': project } });

    beforeEach(() => {
      appsRepository.getApps.mockResolvedValue([]);
    });

    it('reports an app network only the Hub is on as an orphan, without the Hub in the public report', async () => {
      dockerMock.listNetworks.mockResolvedValue([network('ghost_ci-marketplace_network', 'ghost_ci-marketplace')]);
      dockerMock.listContainers.mockResolvedValue([hub(['ci-hub_network', 'ghost_ci-marketplace_network'])]);

      const report = await service.getDiagnostics();

      expect(report.orphanNetworks).toEqual([
        {
          dockerNetworkId: 'net-ghost_ci-marketplace_network',
          dockerNetworkName: 'ghost_ci-marketplace_network',
          composeProject: 'ghost_ci-marketplace',
        },
      ]);
    });

    it('does not report an app network an app container is still on, Hub or not', async () => {
      dockerMock.listNetworks.mockResolvedValue([network('ghost_ci-marketplace_network', 'ghost_ci-marketplace')]);
      dockerMock.listContainers.mockResolvedValue([
        hub(['ghost_ci-marketplace_network']),
        fromPartial({
          Id: 'ghost-1',
          Names: ['/ghost_ci-marketplace-ghost-1'],
          NetworkSettings: { Networks: { 'ghost_ci-marketplace_network': {} } },
        }),
      ]);

      expect((await service.getDiagnostics()).orphanNetworks).toEqual([]);
    });

    it("never reports a network of the Hub's own compose project, whatever it is called", async () => {
      dockerMock.listNetworks.mockResolvedValue([network('ci-os-hub_internal', 'ci-os-hub')]);
      dockerMock.listContainers.mockResolvedValue([
        fromPartial({
          Id: 'hub-id',
          Names: ['/ci-os-hub'],
          Labels: { 'com.docker.compose.project': 'ci-os-hub' },
          NetworkSettings: { Networks: { 'ci-os-hub_internal': {} } },
        }),
      ]);

      expect((await service.getDiagnostics()).orphanNetworks).toEqual([]);
    });

    it('takes the Hub off an orphan before removing it', async () => {
      dockerMock.listNetworks.mockResolvedValue([network('ghost_ci-marketplace_network', 'ghost_ci-marketplace')]);
      dockerMock.listContainers.mockResolvedValue([hub(['ghost_ci-marketplace_network'])]);
      const calls: string[] = [];
      const disconnect = vi.fn(async (options: { Container: string }) => {
        calls.push(`disconnect ${options.Container}`);
      });
      const remove = vi.fn(async () => {
        calls.push('remove');
      });
      dockerMock.getNetwork.mockReturnValue({ disconnect, remove });

      const repair = await service.repairOrphanNetworks();

      expect(repair.removed).toEqual(['ghost_ci-marketplace_network']);
      expect(calls).toEqual(['disconnect hub-id', 'remove']);
      expect(disconnect).toHaveBeenCalledWith({ Container: 'hub-id', Force: true });
    });
  });
});
