import { Injectable } from '@nestjs/common';
import { ActorService } from './actor.service';
import { SignatureService } from './signature.service';
import type { ActivityPubActivity, ActivityPubRecipient } from './activitypub.types';

@Injectable()
export class DeliveryService {
  constructor(
    private readonly actorService: ActorService,
    private readonly signatureService: SignatureService,
  ) {}

  async fetchRemoteActor(actorUri: string): Promise<Record<string, unknown>> {
    return this.signatureService.fetchRemoteActor(actorUri);
  }

  async deliverActivity(activity: ActivityPubActivity, recipients: ActivityPubRecipient[]): Promise<void> {
    const targets = [
      ...new Set(recipients.filter((recipient) => recipient.accepted).map((recipient) => recipient.sharedInboxUri || recipient.inboxUri)),
    ];
    await Promise.all(targets.map(async (target) => this.deliverToInbox(target, activity)));
  }

  async deliverToInbox(inboxUrl: string, activity: ActivityPubActivity): Promise<void> {
    const actor = await this.actorService.getActor();
    const keyPair = await this.actorService.getOrCreateKeyPair();
    const body = JSON.stringify(activity);
    const headers = this.signatureService.createSignedHeaders({
      url: inboxUrl,
      body,
      keyId: actor.publicKey.id,
      privateKeyPem: keyPair.privateKeyPem,
    });

    const response = await fetch(inboxUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Delivery failed with status ${response.status}`);
    }
  }
}
