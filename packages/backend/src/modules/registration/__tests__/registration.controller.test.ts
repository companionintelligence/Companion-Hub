import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { RegistrationController } from '../registration.controller';
import { RegistrationService } from '../registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';

describe('RegistrationController', () => {
  let controller: RegistrationController;
  let registrationService: MockProxy<RegistrationService>;
  let configService: MockProxy<ConfigurationService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RegistrationController],
      providers: [
        { provide: RegistrationService, useValue: mock<RegistrationService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: vi.fn().mockReturnValue(true) })
      .compile();

    controller = moduleRef.get(RegistrationController);
    registrationService = moduleRef.get(RegistrationService);
    configService = moduleRef.get(ConfigurationService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getStatus', () => {
    it('should return full registration status with phase', async () => {
      registrationService.getLiveRegistrationStatus.mockResolvedValue({
        phase: 'locally_ready',
        degradedReasons: [],
        registered: true,
      });

      const result = await controller.getStatus();
      expect(result).toEqual({
        phase: 'locally_ready',
        degradedReasons: [],
        registered: true,
      });
    });

    it('should return unregistered status', async () => {
      registrationService.getLiveRegistrationStatus.mockResolvedValue({
        phase: 'unregistered',
        degradedReasons: [],
        registered: false,
      });

      const result = await controller.getStatus();
      expect(result).toEqual({
        phase: 'unregistered',
        degradedReasons: [],
        registered: false,
      });
    });

    it('should return degraded status with reasons', async () => {
      registrationService.getLiveRegistrationStatus.mockResolvedValue({
        phase: 'degraded',
        degradedReasons: ['tunnel_token_missing'],
        registered: true,
      });

      const result = await controller.getStatus();
      expect(result.phase).toBe('degraded');
      expect(result.degradedReasons).toEqual(['tunnel_token_missing']);
      expect(result.registered).toBe(true);
    });
  });

  describe('resetRegistration', () => {
    it('should reset registration', async () => {
      registrationService.resetRegistration.mockResolvedValue(undefined);

      const result = await controller.resetRegistration();
      expect(result.success).toBe(true);
      expect(registrationService.resetRegistration).toHaveBeenCalled();
    });
  });

  describe('getDeviceId', () => {
    it('should return device ID and registration URL', async () => {
      registrationService.getDeviceId.mockResolvedValue('device-123');
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.ci.com' } as any);

      const req = { protocol: 'https', get: () => 'localhost:3000' } as any;
      const result = await controller.getDeviceId(req);

      expect(result.device_id).toBe('device-123');
      expect(result.registration_url).toContain('portal.ci.com');
      expect(result.registration_url).toContain('device-123');
    });

    it('should return null registration URL when ciCloudUrl is empty', async () => {
      registrationService.getDeviceId.mockResolvedValue('device-123');
      configService.getConfig.mockReturnValue({ ciCloudUrl: '' } as any);

      const req = { protocol: 'https', get: () => 'localhost:3000' } as any;
      const result = await controller.getDeviceId(req);

      expect(result.device_id).toBe('device-123');
      expect(result.registration_url).toBeNull();
    });
  });

  describe('handleCallback', () => {
    it('should return error when required params are missing', async () => {
      const result = await controller.handleCallback('', '', '', '', '', '', '', '', '');
      expect(result.success).toBe(false);
    });

    it('should complete registration with valid params', async () => {
      registrationService.completeRegistrationFromCallback.mockResolvedValue({ success: true } as any);

      const result = await controller.handleCallback('device-1', 'org-1', 'My Org', 'my-org', 'my-sub', 'tun-1', 'tok-1', 'key-1', 'example.com');
      expect(result).toEqual({ success: true });
      expect(registrationService.completeRegistrationFromCallback).toHaveBeenCalledWith({
        deviceId: 'device-1',
        organizationId: 'org-1',
        organizationName: 'My Org',
        subdomain: 'my-sub',
        tunnelId: 'tun-1',
        tunnelToken: 'tok-1',
        apiKey: 'key-1',
        slug: 'my-org',
        domain: 'example.com',
      });
    });
  });

  describe('handleCallbackPost', () => {
    it('should complete registration from JSON body', async () => {
      registrationService.completeRegistrationFromCallback.mockResolvedValue({ success: true } as any);

      const result = await controller.handleCallbackPost({
        device_id: 'device-1',
        organization_id: 'org-1',
        organization_name: 'My Org',
        slug: 'my-org',
        subdomain: 'my-sub',
        tunnel_id: 'tun-1',
        tunnel_token: 'tok-1',
        api_key: 'key-1',
        domain: 'example.com',
      });

      expect(result).toEqual({ success: true });
    });
  });

  describe('validateOrganizationName', () => {
    it('should reject empty names', async () => {
      const result = await controller.validateOrganizationName('');
      expect(result.available).toBe(false);
    });

    it('should accept valid names', async () => {
      const result = await controller.validateOrganizationName('my-org');
      expect(result.available).toBe(true);
    });

    it('should reject names that sanitize to empty', async () => {
      const result = await controller.validateOrganizationName('!!!');
      expect(result.available).toBe(false);
    });
  });

  describe('verifyPairingCode', () => {
    it('should reject invalid pairing codes', async () => {
      const result = await controller.verifyPairingCode({ pairing_code: 'AB' });
      expect(result.success).toBe(false);
    });

    it('should reject when device ID not found', async () => {
      registrationService.getDeviceId.mockResolvedValue('');
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.ci.com' } as any);

      const result = await controller.verifyPairingCode({ pairing_code: 'ABCDEF' });
      expect(result.success).toBe(false);
    });
  });

  describe('pairDevice', () => {
    it('should reject invalid pairing codes', async () => {
      const result = await controller.pairDevice({ pairing_code: '' });
      expect(result.success).toBe(false);
    });

    it('should pair with valid code', async () => {
      registrationService.pairDevice.mockResolvedValue({ success: true } as any);

      const result = await controller.pairDevice({ pairing_code: 'ABCDEF' });
      expect(result).toEqual({ success: true });
      expect(registrationService.pairDevice).toHaveBeenCalledWith('ABCDEF');
    });
  });

  describe('registerDevice', () => {
    it('should reject missing organization_id', async () => {
      const result = await controller.registerDevice({ organization_id: '', organization_name: 'Test' });
      expect(result.success).toBe(false);
    });

    it('should reject missing organization_name', async () => {
      const result = await controller.registerDevice({ organization_id: 'org-1', organization_name: '' });
      expect(result.success).toBe(false);
    });

    it('should initiate registration with valid data', async () => {
      registrationService.initiateRegistration.mockResolvedValue({ success: true } as any);

      const result = await controller.registerDevice({ organization_id: 'org-1', organization_name: 'Test Org' });
      expect(result).toEqual({ success: true });
    });
  });
});
