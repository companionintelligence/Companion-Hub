import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { ActorService } from './actor.service';
import { ActivityPubStoreService } from './activitypub-store.service';
import { DeliveryService } from './delivery.service';
import { FederationConfigService } from './federation-config.service';
import type { ActivityPubActivity, ActivityPubObject, ActivityPubRecipient } from './activitypub.types';

@Injectable()
export class OutboxService {
  constructor(
    private readonly store: ActivityPubStoreService,
    private readonly actorService: ActorService,
    private readonly deliveryService: DeliveryService,
    private readonly federationConfig: FederationConfigService,
  ) {}

  private async createBaseIds() {
    const baseUrl = await this.federationConfig.getBaseUrl();
    const id = randomUUID();
    return {
      localId: id,
      activityId: `${baseUrl}/api/activitypub/activities/${id}`,
      objectId: `${baseUrl}/api/activitypub/objects/${id}`,
    };
  }

  private async persistActivity(params: {
    type: string;
    object?: ActivityPubObject;
    objectRef?: string | Record<string, unknown>;
    deliver?: boolean;
    recipients?: ActivityPubRecipient[];
    to?: string[];
  }) {
    const actor = await this.actorService.getActor();
    const ids = await this.createBaseIds();
    const published = new Date().toISOString();
    const object =
      params.object &&
      ({
        ...params.object,
        id: params.object.id || ids.objectId,
        published: params.object.published || published,
      } as ActivityPubObject);
    const activity: ActivityPubActivity = {
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: ids.activityId,
      type: params.type,
      actor: actor.id,
      object: object || params.objectRef || ids.objectId,
      to: params.to || ['https://www.w3.org/ns/activitystreams#Public'],
      published,
    };

    await this.store.updateState((state) => {
      if (object) {
        state.objects.unshift({
          id: ids.localId,
          objectId: object.id,
          payload: object,
          createdAt: published,
        });
      }

      state.activities.unshift({
        id: ids.localId,
        activityId: ids.activityId,
        type: params.type,
        objectId: object?.id,
        payload: activity,
        published: params.deliver !== false,
        createdAt: published,
      });

      return state;
    });

    if (params.deliver !== false && params.recipients?.length) {
      await this.deliveryService.deliverActivity(activity, params.recipients);
    }

    return activity;
  }

  async publishNote(content: string) {
    this.federationConfig.ensureEnabled();
    const state = await this.store.readState();
    const actor = await this.actorService.getActor();

    return this.persistActivity({
      type: 'Create',
      object: {
        id: '',
        type: 'Note',
        attributedTo: actor.id,
        content,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      },
      recipients: state.followers,
    });
  }

  async publishAppEvent(kind: 'install' | 'update' | 'start' | 'stop', appUrn: AppUrn) {
    const settings = this.federationConfig.getSettings();
    if (!settings.federationEnabled) {
      return null;
    }

    if (kind === 'install' && !settings.federationPublishAppInstalls) {
      return null;
    }

    if (kind === 'update' && !settings.federationPublishAppUpdates) {
      return null;
    }

    const messages: Record<typeof kind, string> = {
      install: `Installed ${appUrn} 📦`,
      update: `Updated ${appUrn}`,
      start: `${appUrn} is now running`,
      stop: `${appUrn} has stopped`,
    };

    return this.publishNote(messages[kind]);
  }

  async followActor(actorUri: string) {
    this.federationConfig.ensureEnabled();
    const remoteActor = await this.deliveryService.fetchRemoteActor(actorUri);
    const inboxUri = String(remoteActor.inbox || '');
    if (!inboxUri) {
      throw new Error('Remote actor is missing an inbox');
    }

    const recipient = {
      actorUri,
      inboxUri,
      sharedInboxUri: ((remoteActor.endpoints as { sharedInbox?: string } | undefined)?.sharedInbox ?? null) as string | null,
      accepted: false,
      createdAt: new Date().toISOString(),
    };

    await this.store.updateState((state) => {
      state.following = [recipient, ...state.following.filter((entry) => entry.actorUri !== actorUri)];
      return state;
    });

    return this.persistActivity({
      type: 'Follow',
      objectRef: actorUri,
      recipients: [{ ...recipient, accepted: true }],
      to: [actorUri],
    });
  }

  async unfollowActor(actorUri: string) {
    this.federationConfig.ensureEnabled();
    const state = await this.store.readState();
    const existing = state.following.find((entry) => entry.actorUri === actorUri);
    if (!existing) {
      return { success: true };
    }

    await this.store.updateState((current) => {
      current.following = current.following.filter((entry) => entry.actorUri !== actorUri);
      return current;
    });

    await this.persistActivity({
      type: 'Undo',
      objectRef: {
        type: 'Follow',
        actor: (await this.actorService.getActor()).id,
        object: actorUri,
      },
      recipients: [{ ...existing, accepted: true }],
      to: [actorUri],
    });

    return { success: true };
  }

  async acceptFollower(actorUri: string, followActivity?: Record<string, unknown>) {
    this.federationConfig.ensureEnabled();
    const state = await this.store.updateState((current) => {
      current.followers = current.followers.map((entry) => (entry.actorUri === actorUri ? { ...entry, accepted: true } : entry));
      return current;
    });
    const follower = state.followers.find((entry) => entry.actorUri === actorUri);
    if (!follower) {
      throw new Error('Follower not found');
    }

    return this.persistActivity({
      type: 'Accept',
      objectRef:
        followActivity ||
        ({
          type: 'Follow',
          actor: actorUri,
          object: (await this.actorService.getActor()).id,
        } as Record<string, unknown>),
      recipients: [{ ...follower, accepted: true }],
      to: [actorUri],
    });
  }

  async getOutbox() {
    const actor = await this.actorService.getActor();
    const state = await this.store.readState();
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${actor.outbox}`,
      type: 'OrderedCollection',
      totalItems: state.activities.length,
      orderedItems: state.activities.map((entry) => entry.payload),
    };
  }

  async getFollowersCollection() {
    const actor = await this.actorService.getActor();
    const state = await this.store.readState();
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: actor.followers,
      type: 'OrderedCollection',
      totalItems: state.followers.filter((entry) => entry.accepted).length,
      orderedItems: state.followers.filter((entry) => entry.accepted).map((entry) => entry.actorUri),
    };
  }

  async getFollowingCollection() {
    const actor = await this.actorService.getActor();
    const state = await this.store.readState();
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: actor.following,
      type: 'OrderedCollection',
      totalItems: state.following.filter((entry) => entry.accepted).length,
      orderedItems: state.following.filter((entry) => entry.accepted).map((entry) => entry.actorUri),
    };
  }

  async getActivityById(id: string) {
    const state = await this.store.readState();
    return state.activities.find((entry) => entry.id === id)?.payload ?? null;
  }

  async getObjectById(id: string) {
    const state = await this.store.readState();
    return state.objects.find((entry) => entry.id === id)?.payload ?? null;
  }

  async listFollowers() {
    return (await this.store.readState()).followers;
  }

  async listFollowing() {
    return (await this.store.readState()).following;
  }

  async getStatus() {
    const settings = this.federationConfig.getSettings();
    const state = await this.store.readState();
    return {
      enabled: settings.federationEnabled,
      followerCount: state.followers.filter((entry) => entry.accepted).length,
      followingCount: state.following.filter((entry) => entry.accepted).length,
      pendingFollowers: state.followers.filter((entry) => !entry.accepted).length,
    };
  }
}
