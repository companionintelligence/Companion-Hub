import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { CloudflareController } from '../cloudflare.controller';
import { CloudflareClientService } from '../cloudflare-client.service';
import { CloudflareHostnameService } from '../cloudflare-hostname.service';
import { LoggerService } from '@/core/logger/logger.service';

describe('CloudflareController', () => {
  let controller: CloudflareController;
  let cfService: MockProxy<CloudflareClientService>;
  let hostnameService: MockProxy<CloudflareHostnameService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CloudflareController],
      providers: [
        { provide: CloudflareClientService, useValue: mock<CloudflareClientService>() },
        { provide: CloudflareHostnameService, useValue: mock<CloudflareHostnameService>() },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();

    controller = moduleRef.get(CloudflareController);
    cfService = moduleRef.get(CloudflareClientService);
    hostnameService = moduleRef.get(CloudflareHostnameService);
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
      hostnameService.resolvesToExistingAppHostname.mockResolvedValue(false);
      cfService.checkDnsAvailability.mockResolvedValue({
        available: true,
        message: 'Availability check delegated to CI-Cloud',
      });

      const result = await controller.checkDnsAvailability('test');

      expect(cfService.checkDnsAvailability).toHaveBeenCalledWith('test', undefined);
      expect(result.available).toBe(true);
      expect(result.message).toContain('CI-Cloud');
    });

    it('allows the current app to keep its existing hostname without delegating', async () => {
      hostnameService.resolvesToExistingAppHostname.mockResolvedValue(true);

      const result = await controller.checkDnsAvailability('dropgate', 'companionintelligence.com', 'dropgate:store');

      expect(result).toEqual({ available: true });
      expect(cfService.checkDnsAvailability).not.toHaveBeenCalled();
    });

    it('still delegates when the requested hostname changes during edit', async () => {
      hostnameService.resolvesToExistingAppHostname.mockResolvedValue(false);
      cfService.checkDnsAvailability.mockResolvedValue({
        available: false,
        message: 'DNS record already exists for changed-nvda-devben.companionintelligence.com',
      });

      const result = await controller.checkDnsAvailability('changed', 'companionintelligence.com', 'dropgate:store');

      expect(cfService.checkDnsAvailability).toHaveBeenCalledWith('changed', 'companionintelligence.com');
      expect(result.available).toBe(false);
    });

    it('hands the form the reason CI-Cloud gave, so a full zone lands on the domain picker', async () => {
      hostnameService.resolvesToExistingAppHostname.mockResolvedValue(false);
      const answer = {
        available: false,
        reason: 'zone_unreachable' as const,
        message: "We can't serve any more apps from this domain. Pick another domain name to host this app.",
      };
      cfService.checkDnsAvailability.mockResolvedValue(answer);

      const result = await controller.checkDnsAvailability('n8n', 'ci3.pw', 'n8n:store');

      expect(result).toEqual(answer);
    });

    it('treats an invalid appUrn query as absent instead of throwing', async () => {
      hostnameService.resolvesToExistingAppHostname.mockResolvedValue(false);
      cfService.checkDnsAvailability.mockResolvedValue({
        available: true,
      });

      const result = await controller.checkDnsAvailability('changed', 'companionintelligence.com', 'not-a-urn');

      expect(hostnameService.resolvesToExistingAppHostname).toHaveBeenCalledWith('changed', 'companionintelligence.com', undefined);
      expect(cfService.checkDnsAvailability).toHaveBeenCalledWith('changed', 'companionintelligence.com');
      expect(result.available).toBe(true);
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
