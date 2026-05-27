import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { ActivityPubStoreService } from '../activitypub-store.service';
import { DeliveryService } from '../delivery.service';
import { FederationConfigService } from '../federation-config.service';
import { InboxService } from '../inbox.service';
import { OutboxService } from '../outbox.service';
import { SignatureService } from '../signature.service';

describe('InboxService', () => {
  let service: InboxService;
  let store: MockProxy<ActivityPubStoreService>;
  let signatureService: MockProxy<SignatureService>;
  let deliveryService: MockProxy<DeliveryService>;
  let outboxService: MockProxy<OutboxService>;
  let federationConfig: MockProxy<FederationConfigService>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InboxService,
        { provide: ActivityPubStoreService, useValue: mock<ActivityPubStoreService>() },
        { provide: SignatureService, useValue: mock<SignatureService>() },
        { provide: DeliveryService, useValue: mock<DeliveryService>() },
        { provide: OutboxService, useValue: mock<OutboxService>() },
        { provide: FederationConfigService, useValue: mock<FederationConfigService>() },
      ],
    }).compile();

    service = moduleRef.get(InboxService);
    store = moduleRef.get(ActivityPubStoreService);
    signatureService = moduleRef.get(SignatureService);
    deliveryService = moduleRef.get(DeliveryService);
    outboxService = moduleRef.get(OutboxService);
    federationConfig = moduleRef.get(FederationConfigService);
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
  });

  it('stores accepted followers and sends an Accept activity', async () => {
    signatureService.verifyIncomingRequest.mockResolvedValue(true);
    deliveryService.fetchRemoteActor.mockResolvedValue({
      inbox: 'https://remote.example/inbox',
      endpoints: { sharedInbox: 'https://remote.example/shared' },
    });
    store.updateState.mockImplementation(async (mutator) => {
      const state = { followers: [], following: [], activities: [], objects: [] };
      return mutator(state as any) as any;
    });

    const result = await service.processIncomingActivity(
      {
        type: 'Follow',
        actor: 'https://remote.example/users/alice',
      },
      {} as any,
    );

    expect(result).toEqual({ accepted: true });
    expect(outboxService.acceptFollower).toHaveBeenCalledWith('https://remote.example/users/alice', {
      type: 'Follow',
      actor: 'https://remote.example/users/alice',
    });
  });

  it('rejects requests with invalid signatures', async () => {
    signatureService.verifyIncomingRequest.mockResolvedValue(false);

    await expect(service.processIncomingActivity({ type: 'Follow', actor: 'https://remote.example/users/alice' }, {} as any)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
