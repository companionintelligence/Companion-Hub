export interface ActivityPubPublicKey {
  id: string;
  owner: string;
  publicKeyPem: string;
}

export interface ActivityPubActor {
  '@context': string[];
  id: string;
  type: 'Service';
  preferredUsername: string;
  name: string;
  summary: string;
  url: string;
  inbox: string;
  outbox: string;
  followers: string;
  following: string;
  icon?: {
    type: 'Image';
    url: string;
  };
  publicKey: ActivityPubPublicKey;
  endpoints: {
    sharedInbox: string;
  };
}

export interface ActivityPubObject {
  id: string;
  type: string;
  attributedTo?: string;
  content?: string;
  published?: string;
  to?: string[];
  [key: string]: unknown;
}

export interface ActivityPubActivity {
  '@context'?: string | string[];
  id: string;
  type: string;
  actor: string;
  object: string | ActivityPubObject | Record<string, unknown>;
  to?: string[];
  published?: string;
  [key: string]: unknown;
}

export interface ActivityPubRecipient {
  actorUri: string;
  inboxUri: string;
  sharedInboxUri?: string | null;
  accepted: boolean;
  createdAt: string;
}

export interface StoredActivity {
  id: string;
  activityId: string;
  type: string;
  objectId?: string;
  payload: ActivityPubActivity;
  published: boolean;
  createdAt: string;
}

export interface StoredObject {
  id: string;
  objectId: string;
  payload: ActivityPubObject;
  createdAt: string;
}

export interface ActivityPubState {
  followers: ActivityPubRecipient[];
  following: ActivityPubRecipient[];
  activities: StoredActivity[];
  objects: StoredObject[];
}

export interface StoredKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: string;
}
