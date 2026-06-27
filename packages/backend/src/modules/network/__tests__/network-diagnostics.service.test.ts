import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { mock } from 'vitest-mock-extended';
import type { AppUrn } from '@ci-hub/common/types';
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
});
