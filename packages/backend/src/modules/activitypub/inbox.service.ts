import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ActivityPubStoreService } from './activitypub-store.service';
import { DeliveryService } from './delivery.service';
import { FederationConfigService } from './federation-config.service';
import { OutboxService } from './outbox.service';
import { SignatureService } from './signature.service';

@Injectable()
export class InboxService {
  constructor(
    private readonly store: ActivityPubStoreService,
    private readonly signatureService: SignatureService,
    private readonly deliveryService: DeliveryService,
    private readonly outboxService: OutboxService,
    private readonly federationConfig: FederationConfigService,
  ) {}

  async processIncomingActivity(body: Record<string, unknown>, request: Request) {
    this.federationConfig.ensureEnabled();
    const actorUri = typeof body.actor === 'string' ? body.actor : undefined;
    const verified = await this.signatureService.verifyIncomingRequest({
      request,
      body: JSON.stringify(body),
      actorUri,
    });
    if (!verified) {
      throw new UnauthorizedException('Invalid ActivityPub signature');
    }

    switch (body.type) {
      case 'Follow':
        return this.processFollow(body, actorUri);
      case 'Undo':
        return this.processUndo(body);
      case 'Accept':
        return this.processAccept(body);
      default:
        return { accepted: true };
    }
  }

  private async processFollow(body: Record<string, unknown>, actorUri?: string) {
    if (!actorUri) {
      throw new UnauthorizedException('Follow activity is missing actor');
    }

    const remoteActor = await this.deliveryService.fetchRemoteActor(actorUri);
    const inboxUri = String(remoteActor.inbox || '');
    if (!inboxUri) {
      throw new UnauthorizedException('Remote actor is missing inbox');
    }

    const manualApproval = this.federationConfig.getSettings().federationManualApproval;
    await this.store.updateState((state) => {
      state.followers = [
        {
          actorUri,
          inboxUri,
          sharedInboxUri: ((remoteActor.endpoints as { sharedInbox?: string } | undefined)?.sharedInbox ?? null) as string | null,
          accepted: !manualApproval,
          createdAt: new Date().toISOString(),
        },
        ...state.followers.filter((entry) => entry.actorUri !== actorUri),
      ];
      return state;
    });

    if (!manualApproval) {
      await this.outboxService.acceptFollower(actorUri, body);
    }

    return { accepted: true };
  }

  private async processUndo(body: Record<string, unknown>) {
    const object = body.object as { type?: string; actor?: string } | undefined;
    if (object?.type === 'Follow' && typeof object.actor === 'string') {
      await this.store.updateState((state) => {
        state.followers = state.followers.filter((entry) => entry.actorUri !== object.actor);
        return state;
      });
    }

    return { accepted: true };
  }

  private async processAccept(body: Record<string, unknown>) {
    const object = body.object as { type?: string; object?: string } | undefined;
    if (object?.type === 'Follow' && typeof object.object === 'string') {
      await this.store.updateState((state) => {
        state.following = state.following.map((entry) => (entry.actorUri === object.object ? { ...entry, accepted: true } : entry));
        return state;
      });
    }

    return { accepted: true };
  }
}
