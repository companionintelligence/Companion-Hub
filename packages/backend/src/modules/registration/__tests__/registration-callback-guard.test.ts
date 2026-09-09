/**
 * The callback guard, driven through the real controller and the real service.
 *
 * A Hub that lost its tunnel token is registered but must still be able to pair
 * again — that is how the token comes back, and CI-OS's headless setup service
 * completes that pairing through this callback. Guarding on `isRegistered`
 * alone would refuse it and strand the appliance.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { Test } from '@nestjs/testing';
import * as si from 'systeminformation';
import { RegistrationController } from '../registration.controller';
import { RegistrationService } from '../registration.service';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { CloudflareClientService } from '../../cloudflare/cloudflare-client.service';
import { TraefikConfigService } from '../../docker/traefik-config.service';
import { DeviceRegistrationRepository } from '../device-registration.repository';
import { RepoEventsQueue } from '../../queue/entities/repo-events';
import { PortalClientService } from '@/core/portal/portal-client.service';
import { TailscaleService } from '../../tailscale/tailscale.service';

vi.mock('systeminformation');
vi.mock('axios');

const BODY = {
  device_id: 'd',
  organization_id: 'o',
  organization_name: 'O',
  slug: 's',
  subdomain: 'sub',
  tunnel_id: 't',
  tunnel_token: 'tok',
  api_key: 'k',
};

let controller: RegistrationController;
let service: RegistrationService;

beforeEach(async () => {
  const config = mock<ConfigurationService>();
  config.getConfig.mockReturnValue({ ciCloudUrl: 'https://portal.example.com' } as any);
  (si.uuid as any) = vi.fn().mockResolvedValue({ os: 'uuid-123' });

  const moduleRef = await Test.createTestingModule({
    controllers: [RegistrationController],
    providers: [
      RegistrationService,
      { provide: ConfigurationService, useValue: config },
      { provide: LoggerService, useValue: mock<LoggerService>() },
      { provide: CloudflareClientService, useValue: mock<CloudflareClientService>() },
      { provide: TraefikConfigService, useValue: mock<TraefikConfigService>() },
      { provide: DeviceRegistrationRepository, useValue: mock<DeviceRegistrationRepository>() },
      { provide: RepoEventsQueue, useValue: mock<RepoEventsQueue>() },
      { provide: PortalClientService, useValue: mock<PortalClientService>() },
      { provide: TailscaleService, useValue: mock<TailscaleService>() },
    ],
  }).compile();

  controller = moduleRef.get(RegistrationController);
  service = moduleRef.get(RegistrationService);
  vi.spyOn(service as any, 'refreshPhaseFromSources').mockResolvedValue(undefined);
  vi.spyOn(service, 'completeRegistrationFromCallback').mockResolvedValue({ success: true } as any);
});

const withPhase = (phase: string, reasons: string[] = []) => {
  (service as any)._currentPhase = phase;
  (service as any)._degradedReasons = reasons;
};

describe('registration callback guard', () => {
  it('a Hub re-pairing to restore its tunnel now completes the callback', async () => {
    withPhase('degraded', ['tunnel_token_missing']);
    const nonce = service.mintCallbackNonce();

    await expect(controller.handleCallbackPost(BODY, nonce)).resolves.toEqual({ success: true });
  });

  it('a Hub that is up and serving is still refused', async () => {
    for (const phase of ['publicly_ready', 'locally_ready']) {
      withPhase(phase);
      const nonce = service.mintCallbackNonce();
      await expect(controller.handleCallbackPost(BODY, nonce)).rejects.toThrow(/already registered/);
    }
  });

  it('a Hub degraded for an unrelated reason is still refused', async () => {
    withPhase('degraded', ['cloud_validation_failed']);
    const nonce = service.mintCallbackNonce();

    await expect(controller.handleCallbackPost(BODY, nonce)).rejects.toThrow(/already registered/);
  });
});
