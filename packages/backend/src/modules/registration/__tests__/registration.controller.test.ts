import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { RegistrationController } from '../registration.controller';
import { RegistrationService } from '../registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';

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
        { provide: LoggerService, useValue: mock<LoggerService>() },
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

  describe('markRestoreIntent', () => {
    it('should record restore intent', async () => {
      registrationService.markRestoreIntent.mockResolvedValue({ success: true, message: 'Restore intent recorded' });

      const result = await controller.markRestoreIntent();
      expect(result.success).toBe(true);
      expect(registrationService.markRestoreIntent).toHaveBeenCalled();
    });
  });

  describe('getStateDrift', () => {
    it('should return drift detection result', async () => {
      registrationService.getStateDrift.mockResolvedValue({
        detected: true,
        hardwareDeviceId: 'device-123',
        localRegistered: false,
        portalDeviceActive: true,
        staleAppEnvDeviceIds: ['old-id'],
        signals: [{ reason: 'local_unregistered_portal_active' }],
        hasStaleTunnelToken: false,
      });

      const result = await controller.getStateDrift();

      expect(result.detected).toBe(true);
      expect(registrationService.getStateDrift).toHaveBeenCalled();
    });
  });

  describe('prepareFreshSetup', () => {
    it('should clear local registration artifacts', async () => {
      registrationService.prepareFreshSetup.mockResolvedValue({
        success: true,
        message: 'cleared',
        clearedAppEnvFiles: 2,
      });

      const result = await controller.prepareFreshSetup();

      expect(result.success).toBe(true);
      expect(registrationService.prepareFreshSetup).toHaveBeenCalled();
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

    it('carries the minted nonce into the callback URL Portal is sent to', async () => {
      // The callback guard can only pass if the nonce reaches `callback_url`.
      registrationService.getDeviceId.mockResolvedValue('device-123');
      registrationService.mintCallbackNonce.mockReturnValue('nonce-1');
      configService.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.ci.com' } as any);

      const req = { protocol: 'https', get: () => 'localhost:3000' } as any;
      const result = await controller.getDeviceId(req);

      expect(result.callback_url).toBe('https://localhost:3000/device-registration?state=nonce-1');
      expect(result.registration_url).toContain(encodeURIComponent(result.callback_url));
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

  describe('handleCallbackPost', () => {
    /** A callback body that is complete apart from its proof of origin. */
    const validBody = {
      device_id: 'device-1',
      organization_id: 'org-1',
      organization_name: 'My Org',
      slug: 'my-org',
      subdomain: 'my-sub',
      tunnel_id: 'tun-1',
      tunnel_token: 'tok-1',
      api_key: 'key-1',
      domain: 'example.com',
    };

    it('refuses a callback with no nonce', async () => {
      /*
       * ⚠ THE ROUTE HANDS THE HUB ITS IDENTITY. The body carries `api_key`,
       * `tunnel_id` and `tunnel_token`, and there was no guard of any kind — so
       * anyone who could reach this port could re-register a running Hub onto
       * credentials and a tunnel of their choosing.
       */
      registrationService.consumeCallbackNonce.mockReturnValue(false);

      await expect(controller.handleCallbackPost(validBody)).rejects.toThrow(ForbiddenException);
      expect(registrationService.completeRegistrationFromCallback).not.toHaveBeenCalled();
    });

    it('refuses a callback when the Hub is already registered', async () => {
      // A nonce is minted by an UNAUTHENTICATED route, so it alone does not stop
      // someone who can reach this port from starting a registration and
      // finishing it. Re-registering a running Hub is `resetRegistration`'s job.
      registrationService.consumeCallbackNonce.mockReturnValue(true);
      registrationService.isRegisteredAndServing.mockResolvedValue(true);

      await expect(controller.handleCallbackPost(validBody)).rejects.toThrow(ForbiddenException);
      expect(registrationService.completeRegistrationFromCallback).not.toHaveBeenCalled();
    });

    it('spends the nonce, so a replay of the same callback is refused', async () => {
      registrationService.consumeCallbackNonce.mockReturnValueOnce(true).mockReturnValue(false);
      registrationService.isRegisteredAndServing.mockResolvedValue(false);
      registrationService.completeRegistrationFromCallback.mockResolvedValue({ success: true } as any);

      await expect(controller.handleCallbackPost(validBody, 'nonce-1')).resolves.toEqual({ success: true });
      await expect(controller.handleCallbackPost(validBody, 'nonce-1')).rejects.toThrow(ForbiddenException);
    });

    it('returns an error when required params are missing', async () => {
      registrationService.consumeCallbackNonce.mockReturnValue(true);
      registrationService.isRegisteredAndServing.mockResolvedValue(false);

      const result = await controller.handleCallbackPost({
        ...validBody,
        device_id: '',
        api_key: '',
      });

      expect(result.success).toBe(false);
    });

    it('does not spend the nonce on a body that is missing required params', async () => {
      // Burning the one-time secret on a malformed body would cost the person
      // another round trip through Portal.
      registrationService.consumeCallbackNonce.mockReturnValue(true);
      registrationService.isRegisteredAndServing.mockResolvedValue(false);

      await controller.handleCallbackPost({ ...validBody, device_id: '' }, 'nonce-1');

      expect(registrationService.consumeCallbackNonce).not.toHaveBeenCalled();
    });

    it('completes registration from a JSON body with a valid nonce', async () => {
      registrationService.consumeCallbackNonce.mockReturnValue(true);
      registrationService.isRegisteredAndServing.mockResolvedValue(false);
      registrationService.completeRegistrationFromCallback.mockResolvedValue({ success: true } as any);

      const result = await controller.handleCallbackPost(validBody, 'nonce-1');

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

    it('accepts the nonce from the body as well as the query', async () => {
      // Portal returns to `callback_url` verbatim, so the query is where it
      // normally arrives; a client that parsed the redirect re-posts it in the
      // body.
      registrationService.consumeCallbackNonce.mockReturnValue(true);
      registrationService.isRegisteredAndServing.mockResolvedValue(false);
      registrationService.completeRegistrationFromCallback.mockResolvedValue({ success: true } as any);

      await controller.handleCallbackPost({ ...validBody, state: 'nonce-in-body' });

      expect(registrationService.consumeCallbackNonce).toHaveBeenCalledWith('nonce-in-body');
    });
  });

  describe('handleCallback (deprecated GET)', () => {
    /*
     * CI-OS's headless setup service (`/opt/setup-backend/setup_service.py`)
     * forwards the cloud's registration response to this route as a GET once the
     * Hub is running. Removing it strands every appliance that pairs from the
     * setup portal, so it stays until that caller moves to the POST.
     */
    const req = { ip: '127.0.0.1' } as any;

    it('completes registration without a nonce, so headless setup keeps working', async () => {
      registrationService.completeRegistrationFromCallback.mockResolvedValue({ success: true } as any);

      const result = await controller.handleCallback(
        req,
        'device-1',
        'org-1',
        'My Org',
        'my-org',
        'my-sub',
        'tun-1',
        'tok-1',
        'key-1',
        'example.com',
      );

      expect(result).toEqual({ success: true });
      expect(registrationService.consumeCallbackNonce).not.toHaveBeenCalled();
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

    it('returns an error when required params are missing', async () => {
      const result = (await controller.handleCallback(req, '', '', '', '', '', '', '', '', '')) as { success: boolean };

      expect(result.success).toBe(false);
      expect(registrationService.completeRegistrationFromCallback).not.toHaveBeenCalled();
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

    it('returns the Portal refusal code to the registration page', async () => {
      registrationService.pairDevice.mockResolvedValue({ success: false, message: 'Already paired', code: 'DEVICE_PROOF_REQUIRED' });

      const result = await controller.pairDevice({ pairing_code: 'ABCDEF' });
      expect(result).toEqual({ success: false, message: 'Already paired', code: 'DEVICE_PROOF_REQUIRED' });
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
