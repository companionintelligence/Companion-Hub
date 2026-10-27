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

    /*
     * Right after a re-pair the Portal still holds the names this Hub had before its reinstall, and the
     * Hub has not synced yet. Its own old name read "DNS record already exists" for up to two hours (#2133).
     */
    describe("a taken name the Portal says is this device's own", () => {
      const taken = { available: false, reason: 'hostname_taken' as const, message: 'DNS record already exists for game-core-2-acme.ci0.pw' };

      beforeEach(() => {
        hostnameService.resolvesToExistingAppHostname.mockResolvedValue(false);
      });

      it("is available when it is this Hub's own from before the pairing", async () => {
        cfService.checkDnsAvailability.mockResolvedValue({ ...taken, heldByCaller: true });
        hostnameService.isOwnNameFromBeforePairing.mockResolvedValue(true);

        await expect(controller.checkDnsAvailability('game', 'ci0.pw')).resolves.toEqual({ available: true });
        expect(hostnameService.isOwnNameFromBeforePairing).toHaveBeenCalledWith('game', undefined);
      });

      // The app being set up does not count against its own old name.
      it('asks about the name for the app being set up', async () => {
        cfService.checkDnsAvailability.mockResolvedValue({ ...taken, heldByCaller: true });
        hostnameService.isOwnNameFromBeforePairing.mockResolvedValue(true);

        await expect(controller.checkDnsAvailability('game', 'ci0.pw', 'game:ci-marketplace')).resolves.toEqual({ available: true });
        expect(hostnameService.isOwnNameFromBeforePairing).toHaveBeenCalledWith('game', 'game:ci-marketplace');
      });

      it('stays taken otherwise, and the forms never see the flag', async () => {
        cfService.checkDnsAvailability.mockResolvedValue({ ...taken, heldByCaller: true });
        hostnameService.isOwnNameFromBeforePairing.mockResolvedValue(false);

        await expect(controller.checkDnsAvailability('game', 'ci0.pw')).resolves.toEqual(taken);
      });

      it("is not asked about a name that is not this device's own", async () => {
        cfService.checkDnsAvailability.mockResolvedValue(taken);

        await expect(controller.checkDnsAvailability('game', 'ci0.pw')).resolves.toEqual(taken);
        expect(hostnameService.isOwnNameFromBeforePairing).not.toHaveBeenCalled();
      });
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
