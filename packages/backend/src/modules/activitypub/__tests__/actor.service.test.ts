import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { DeviceRegistrationRepository } from '@/modules/registration/device-registration.repository';
import { ActorService } from '../actor.service';
import { ActivityPubStoreService } from '../activitypub-store.service';
import { FederationConfigService } from '../federation-config.service';

describe('ActorService', () => {
  let service: ActorService;
  let store: MockProxy<ActivityPubStoreService>;
  let appsRepository: MockProxy<AppsRepository>;
  let registrationRepository: MockProxy<DeviceRegistrationRepository>;
  let federationConfig: MockProxy<FederationConfigService>;
  let configuration: MockProxy<ConfigurationService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ActorService,
        { provide: ActivityPubStoreService, useValue: mock<ActivityPubStoreService>() },
        { provide: AppsRepository, useValue: mock<AppsRepository>() },
        { provide: DeviceRegistrationRepository, useValue: mock<DeviceRegistrationRepository>() },
        { provide: FederationConfigService, useValue: mock<FederationConfigService>() },
        { provide: ConfigurationService, useValue: mock<ConfigurationService>() },
      ],
    }).compile();

    service = moduleRef.get(ActorService);
    store = moduleRef.get(ActivityPubStoreService);
    appsRepository = moduleRef.get(AppsRepository);
    registrationRepository = moduleRef.get(DeviceRegistrationRepository);
    federationConfig = moduleRef.get(FederationConfigService);
    configuration = moduleRef.get(ConfigurationService);

    federationConfig.getBaseUrl.mockResolvedValue('https://hub.example.com');
    federationConfig.getSettings.mockReturnValue({
      federationEnabled: true,
      federationDisplayName: 'Companion Hub',
      federationSummary: '',
      federationPreferredUsername: 'hub',
      federationManualApproval: false,
      federationPublishAppInstalls: false,
      federationPublishAppUpdates: false,
      federationPublishHubStatus: true,
      federationPublishAgentActivity: false,
      federationPublishSystemMetrics: false,
      federationRelayGhost: true,
      federationRelayForgejo: true,
      federationRelayNextcloud: false,
    });
    appsRepository.getApps.mockResolvedValue([{} as any, {} as any]);
    registrationRepository.getFirstDeviceRegistration.mockResolvedValue({ name: 'Josh' } as any);
    configuration.getConfig.mockReturnValue({ version: '1.2.3' } as any);
  });

  it('generates and persists a keypair once', async () => {
    store.readKeyPair.mockResolvedValueOnce(null).mockResolvedValueOnce({
      publicKeyPem: 'public',
      privateKeyPem: 'private',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const first = await service.getOrCreateKeyPair();
    const second = await service.getOrCreateKeyPair();

    expect(first.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(store.writeKeyPair).toHaveBeenCalledTimes(1);
    expect(second.publicKeyPem).toBe('public');
  });

  it('returns a Service actor profile with public key data', async () => {
    store.readKeyPair.mockResolvedValue({
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
      privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const actor = await service.getActor();

    expect(actor.type).toBe('Service');
    expect(actor.id).toBe('https://hub.example.com/api/activitypub/actor');
    expect(actor.publicKey.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(actor.summary).toContain('2 apps');
  });
});
