import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { CloudflareController } from '../cloudflare.controller';
import { CloudflareClientService } from '../cloudflare-client.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('CloudflareController', () => {
  let controller: CloudflareController;
  let cfService: MockProxy<CloudflareClientService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CloudflareController],
      providers: [
        { provide: CloudflareClientService, useValue: mock<CloudflareClientService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(CloudflareController);
    cfService = moduleRef.get(CloudflareClientService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('checkDnsAvailability', () => {
    it('should return available true for empty subdomain', async () => {
      const result = await controller.checkDnsAvailability('');
      expect(result.available).toBe(true);
    });

    it('should delegate to CI-Cloud for non-empty subdomain', async () => {
      const result = await controller.checkDnsAvailability('test');
      expect(result.available).toBe(true);
      expect(result.message).toContain('CI-Cloud');
    });
  });

  describe('getStatus', () => {
    it('should return tunnel status', async () => {
      cfService.getTunnelToken.mockReturnValue('some-token');
      cfService.getTunnelId.mockReturnValue('tun-123');

      const result = await controller.getStatus();
      expect(result.tunnelEnabled).toBe(true);
      expect(result.tunnelId).toBe('tun-123');
    });

    it('should show disabled when no token', async () => {
      cfService.getTunnelToken.mockReturnValue('');
      cfService.getTunnelId.mockReturnValue(null as any);

      const result = await controller.getStatus();
      expect(result.tunnelEnabled).toBe(false);
      expect(result.tunnelId).toBeNull();
    });
  });

  describe('syncDnsRecords', () => {
    it('should return stub response', async () => {
      const result = await controller.syncMissingDnsRecords();
      expect(result.success).toBe(true);
      expect(result.message).toContain('CI-Cloud');
    });
  });
});
