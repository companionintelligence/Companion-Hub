import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { McpToolRegistry } from '../../mcp-tool-registry.service';
import { RegistrationTools } from '../../tools/registration.tools';
import { RegistrationService } from '@/modules/registration/registration.service';
import { CloudflareClientService } from '@/modules/cloudflare/cloudflare-client.service';

describe('RegistrationTools', () => {
  let tools: RegistrationTools;
  let registrationService: MockProxy<RegistrationService>;
  let cloudflareClientService: MockProxy<CloudflareClientService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationTools,
        { provide: RegistrationService, useValue: mock<RegistrationService>() },
        { provide: CloudflareClientService, useValue: mock<CloudflareClientService>() },
        { provide: McpToolRegistry, useValue: mock<McpToolRegistry>() },
      ],
    }).compile();
    tools = module.get<RegistrationTools>(RegistrationTools);
    registrationService = module.get(RegistrationService);
    cloudflareClientService = module.get(CloudflareClientService);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  describe('hub_registration_status', () => {
    it('should return registration status with phase and registered boolean', async () => {
      registrationService.getLiveRegistrationStatus.mockResolvedValue({ phase: 'locally_ready', degradedReasons: [], registered: true } as any);
      const result = await tools.getRegistrationStatus();
      expect(result.phase).toBe('locally_ready');
      expect(result.registered).toBe(true);
    });
  });

  describe('hub_cloudflare_status', () => {
    it('should return tunnel status', async () => {
      cloudflareClientService.getTunnelToken.mockReturnValue('tok-123');
      cloudflareClientService.getTunnelId.mockReturnValue('tun-456');
      const result = await tools.getCloudflareStatus();
      expect(result.tunnelEnabled).toBe(true);
      expect(result.tunnelId).toBe('tun-456');
      expect(result.dnsEnabled).toBe(true);
    });
    it('should return tunnelEnabled: false when no token', async () => {
      cloudflareClientService.getTunnelToken.mockReturnValue(null);
      cloudflareClientService.getTunnelId.mockReturnValue(null);
      const result = await tools.getCloudflareStatus();
      expect(result.tunnelEnabled).toBe(false);
    });
  });
});
