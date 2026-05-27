import { generateKeyPairSync } from 'node:crypto';
import { ConfigurationService } from '@/core/config/configuration.service';
import { Injectable } from '@nestjs/common';
import { AppsRepository } from '../apps/apps.repository';
import { DeviceRegistrationRepository } from '../registration/device-registration.repository';
import { ActivityPubStoreService } from './activitypub-store.service';
import { FederationConfigService } from './federation-config.service';
import type { ActivityPubActor, StoredKeyPair } from './activitypub.types';

@Injectable()
export class ActorService {
  constructor(
    private readonly store: ActivityPubStoreService,
    private readonly appsRepository: AppsRepository,
    private readonly registrationRepository: DeviceRegistrationRepository,
    private readonly federationConfig: FederationConfigService,
    private readonly configuration: ConfigurationService,
  ) {}

  async getOrCreateKeyPair(): Promise<StoredKeyPair> {
    const existing = await this.store.readKeyPair();
    if (existing) {
      return existing;
    }

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const created = {
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      createdAt: new Date().toISOString(),
    };
    await this.store.writeKeyPair(created);
    return created;
  }

  async getActor(host?: string): Promise<ActivityPubActor> {
    const baseUrl = await this.federationConfig.getBaseUrl(host);
    const actorId = `${baseUrl}/api/activitypub/actor`;
    const keyPair = await this.getOrCreateKeyPair();
    const apps = await this.appsRepository.getApps();
    const registration = await this.registrationRepository.getFirstDeviceRegistration();
    const settings = this.federationConfig.getSettings();
    const configuredSummary = settings.federationSummary.trim();
    const displayName =
      settings.federationDisplayName || (registration?.name?.trim() ? `${registration.name.trim()} Companion Hub` : 'Companion Hub');
    const summary = configuredSummary || `Self-hosted personal server running ${apps.length} app${apps.length === 1 ? '' : 's'}`;

    return {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
      id: actorId,
      type: 'Service',
      preferredUsername: settings.federationPreferredUsername,
      name: displayName,
      summary,
      url: baseUrl,
      inbox: `${baseUrl}/api/activitypub/inbox`,
      outbox: `${baseUrl}/api/activitypub/outbox`,
      followers: `${baseUrl}/api/activitypub/followers`,
      following: `${baseUrl}/api/activitypub/following`,
      icon: {
        type: 'Image',
        url: `${baseUrl}/favicon.ico`,
      },
      publicKey: {
        id: `${actorId}#main-key`,
        owner: actorId,
        publicKeyPem: keyPair.publicKeyPem,
      },
      endpoints: {
        sharedInbox: `${baseUrl}/api/activitypub/inbox`,
      },
    };
  }

  async getNodeInfo(host?: string) {
    const baseUrl = await this.federationConfig.getBaseUrl(host);
    const apps = await this.appsRepository.getApps();
    const state = await this.store.readState();

    return {
      version: '2.0',
      software: {
        name: 'ci-hub',
        version: this.configuration.getConfig().version,
      },
      protocols: ['activitypub'],
      services: {
        inbound: [],
        outbound: [],
      },
      openRegistrations: false,
      usage: {
        users: {
          total: 1,
        },
        localPosts: state.activities.length,
        localComments: 0,
      },
      metadata: {
        actor: `${baseUrl}/api/activitypub/actor`,
        installedApps: apps.length,
      },
    };
  }
}
