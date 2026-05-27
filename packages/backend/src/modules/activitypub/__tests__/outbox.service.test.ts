import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ActorService } from '../actor.service';
import { ActivityPubStoreService } from '../activitypub-store.service';
import { DeliveryService } from '../delivery.service';
import { FederationConfigService } from '../federation-config.service';
import { OutboxService } from '../outbox.service';

describe('OutboxService', () => {
  let service: OutboxService;
  let store: MockProxy<ActivityPubStoreService>;
  let actorService: MockProxy<ActorService>;
  let deliveryService: MockProxy<DeliveryService>;
  let federationConfig: MockProxy<FederationConfigService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: ActivityPubStoreService, useValue: mock<ActivityPubStoreService>() },
        { provide: ActorService, useValue: mock<ActorService>() },
        { provide: DeliveryService, useValue: mock<DeliveryService>() },
        { provide: FederationConfigService, useValue: mock<FederationConfigService>() },
      ],
    }).compile();

    service = moduleRef.get(OutboxService);
    store = moduleRef.get(ActivityPubStoreService);
    actorService = moduleRef.get(ActorService);
    deliveryService = moduleRef.get(DeliveryService);
    federationConfig = moduleRef.get(FederationConfigService);

    federationConfig.ensureEnabled.mockReturnValue(undefined);
    federationConfig.getBaseUrl.mockResolvedValue('https://hub.example.com');
    federationConfig.getSettings.mockReturnValue({
      federationEnabled: true,
      federationDisplayName: 'Companion Hub',
      federationSummary: '',
      federationPreferredUsername: 'hub',
      federationManualApproval: false,
      federationPublishAppInstalls: true,
      federationPublishAppUpdates: true,
      federationPublishHubStatus: true,
      federationPublishAgentActivity: false,
      federationPublishSystemMetrics: false,
      federationRelayGhost: true,
      federationRelayForgejo: true,
      federationRelayNextcloud: false,
    });
    actorService.getActor.mockResolvedValue({
      id: 'https://hub.example.com/api/activitypub/actor',
      outbox: 'https://hub.example.com/api/activitypub/outbox',
      followers: 'https://hub.example.com/api/activitypub/followers',
      following: 'https://hub.example.com/api/activitypub/following',
    } as any);
    store.readState.mockResolvedValue({
      followers: [
        {
          actorUri: 'https://remote.example/users/alice',
          inboxUri: 'https://remote.example/inbox',
          accepted: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      following: [],
      activities: [],
      objects: [],
    });
    store.updateState.mockImplementation(async (mutator) => {
      const state = await store.readState();
      return mutator(structuredClone(state)) as any;
    });
  });

  it('publishes notes to followers and stores them', async () => {
    const activity = await service.publishNote('Hello fediverse');

    expect(activity.type).toBe('Create');
    expect(store.updateState).toHaveBeenCalled();
    expect(deliveryService.deliverActivity).toHaveBeenCalled();
  });

  it('reports federation status counts', async () => {
    const status = await service.getStatus();

    expect(status).toEqual({
      enabled: true,
      followerCount: 1,
      followingCount: 0,
      pendingFollowers: 0,
    });
  });
});
