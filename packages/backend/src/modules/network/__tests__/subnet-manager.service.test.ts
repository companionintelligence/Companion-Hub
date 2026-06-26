import { TranslatableError } from '@/common/error/translatable-error';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { Test } from '@nestjs/testing';
import type { AppUrn } from '@ci-hub/common/types';
import { fromAny, fromPartial } from '@total-typescript/shoehorn';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { SubnetManagerService } from '../subnet-manager.service';
import type Dockerode from 'dockerode';

// Create a mock for Dockerode
const dockerMock = {
  listNetworks: vi.fn().mockResolvedValue([]),
  pruneNetworks: vi.fn(),
};

describe('SubnetManagerService', () => {
  let service: SubnetManagerService;
  let appsRepository = mock<AppsRepository>();

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [SubnetManagerService, { provide: DOCKERODE, useValue: dockerMock }],
    })
      .useMocker(mock)
      .compile();

    service = moduleRef.get<SubnetManagerService>(SubnetManagerService);
    appsRepository = moduleRef.get(AppsRepository);

    vi.clearAllMocks();
    dockerMock.listNetworks.mockReset().mockResolvedValue([]);
    dockerMock.pruneNetworks.mockReset().mockResolvedValue(undefined);
    appsRepository.getApps.mockResolvedValue([]);
  });

  describe('allocateSubnet', () => {
    it('should throw an error if app is not found', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      appsRepository.getAppByUrn.mockResolvedValue(fromAny(null));

      // act & assert
      await expect(service.allocateSubnet(appUrn)).rejects.toThrow(TranslatableError);
    });

    it('should reuse an existing subnet when it does not conflict with Docker', async () => {
      const appUrn = 'app:test/app' as AppUrn;
      const existingSubnet = '10.128.15.0/24';

      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          appName: 'app',
          appStoreSlug: 'test/app',
          subnet: existingSubnet,
        }),
      );
      dockerMock.listNetworks.mockResolvedValue([]);

      const result = await service.allocateSubnet(appUrn);

      expect(result).toBe(existingSubnet);
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
      expect(dockerMock.listNetworks).toHaveBeenCalled();
    });

    it('should reassign a stored subnet that overlaps a live Docker network', async () => {
      const appUrn = 'ghost:ci-marketplace' as AppUrn;

      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          appName: 'ghost',
          appStoreSlug: 'ci-marketplace',
          subnet: '10.128.10.0/24',
        }),
      );
      dockerMock.listNetworks.mockResolvedValue([
        fromPartial({
          Labels: { 'com.docker.compose.project': 'chatwoot_ci-marketplace' },
          IPAM: { Config: [{ Subnet: '10.128.10.0/24' }] },
        }),
      ]);
      appsRepository.getApps.mockResolvedValue([]);
      appsRepository.updateAppById.mockResolvedValue(fromPartial({ id: 1, subnet: '10.128.11.0/24' }));

      const result = await service.allocateSubnet(appUrn);

      expect(result).toBe('10.128.11.0/24');
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { subnet: null });
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { subnet: '10.128.11.0/24' });
    });

    it('should allocate a new subnet if app does not have one', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      const newSubnet = '10.128.10.0/24';
      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );

      dockerMock.listNetworks.mockResolvedValue([]);
      appsRepository.updateAppById.mockResolvedValue(fromPartial({ id: 1, subnet: newSubnet }));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe(newSubnet);
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { subnet: newSubnet });
    });

    it('should skip already allocated subnets when allocating a new one', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      const expectedSubnet = '10.128.12.0/24';

      appsRepository.getApps.mockResolvedValue([fromPartial({ subnet: '10.128.10.0/24' }), fromPartial({ subnet: '10.128.11.0/24' })]);

      appsRepository.getAppByUrn.mockResolvedValue(fromPartial({ id: 1, subnet: null }));
      appsRepository.updateAppById.mockResolvedValue(fromPartial({ id: 1, subnet: expectedSubnet }));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe(expectedSubnet);
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, { subnet: expectedSubnet });
    });

    it('should throw an error when no more subnets are available', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;

      // Create mock for Docker with all subnets allocated
      const networkMocks = [];
      for (let y = 128; y <= 254; y++) {
        for (let z = 0; z <= 254; z++) {
          networkMocks.push({
            subnet: `10.${y}.${z}.0/24`,
          });
        }
      }
      appsRepository.getApps.mockResolvedValue(networkMocks.map((network) => fromPartial(network)));

      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );

      // act & assert
      await expect(service.allocateSubnet(appUrn)).rejects.toThrow(TranslatableError);
      expect(appsRepository.updateAppById).not.toHaveBeenCalled();
    });
  });

  describe('findNextAvailableSubnet', () => {
    it('should return the first available subnet after reserved subnets', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );
      dockerMock.listNetworks.mockResolvedValue([]);
      appsRepository.updateAppById.mockImplementation((id, subnet) => Promise.resolve(fromAny({ id, subnet })));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe('10.128.10.0/24');
    });

    it('should find gaps in allocated subnets', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;

      appsRepository.getApps.mockResolvedValue([
        fromPartial({ subnet: '10.128.10.0/24' }),
        fromPartial({ subnet: '10.128.12.0/24' }),
        fromPartial({ subnet: '10.128.13.0/24' }),
      ]);

      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );
      appsRepository.updateAppById.mockImplementation((id, subnet) => Promise.resolve(fromAny({ id, subnet })));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe('10.128.11.0/24');
    });

    it('should handle malformed subnet strings correctly', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;

      appsRepository.getApps.mockResolvedValue([
        fromPartial({ subnet: '10.128.10.0/24' }),
        fromPartial({ subnet: 'invalid-subnet' }),
        fromPartial({ subnet: '10.128.11.0/24' }),
      ]);

      appsRepository.getAppByUrn.mockResolvedValue(
        fromPartial({
          id: 1,
          subnet: null,
        }),
      );
      appsRepository.updateAppById.mockImplementation((id, subnet) => Promise.resolve(fromAny({ id, subnet })));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe('10.128.12.0/24');
    });

    it('should increase the second octet when all third octets are used', async () => {
      // arrange
      const appUrn = 'app:test/app' as AppUrn;
      const expectedSubnet = '10.129.0.0/24';
      const networkMocks: Partial<Dockerode.NetworkInspectInfo>[] = [];

      // Fill up the entire 10.128.x.0/24 range
      for (let i = 0; i <= 254; i++) {
        networkMocks.push(
          fromPartial({
            subnet: `10.128.${i}.0/24`,
          }),
        );
      }
      appsRepository.getApps.mockResolvedValue(networkMocks);

      appsRepository.getAppByUrn.mockResolvedValue(fromPartial({ id: 1, subnet: null }));
      appsRepository.updateAppById.mockResolvedValue(fromPartial({ id: 1, subnet: expectedSubnet }));

      // act
      const result = await service.allocateSubnet(appUrn);

      // assert
      expect(result).toBe(expectedSubnet);
      expect(appsRepository.updateAppById).toHaveBeenCalledWith(1, {
        subnet: expectedSubnet,
      });
    });
  });
});
