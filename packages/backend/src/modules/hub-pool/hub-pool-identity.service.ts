import { type KeyObject, randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { EncryptionService } from '@/core/encryption/encryption.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HubPoolIdentityRepository } from './hub-pool-identity.repository';
import { generatePoolKeyPair, privateKeyFromBase64, publicKeyFingerprint } from './hub-pool-peer-auth';
import type { PoolIdentitySummary } from './hub-pool.types';

/**
 * How long to wait before retrying a failed identity load. Long enough that a persistently broken
 * `JWT_SECRET` costs one query a minute rather than one per request, short enough that an operator
 * who fixes the `.env` and restarts nothing sees the Hub recover on its own.
 */
const IDENTITY_RETRY_MS = 60_000;

/**
 * This node's pool identity, loaded lazily and never fatally.
 *
 * `privateKey` is `null` when the stored key exists but could not be decrypted. That case is
 * deliberately NOT collapsed into "no identity": `node_uuid` and `public_key` are stored in the
 * clear, so a Hub whose `JWT_SECRET` changed can still *verify* its peers' signed requests (which
 * needs only their public keys and this node's own UUID) even though it can no longer *sign*. It
 * falls back to the bearer token outbound and keeps routing.
 */
export interface LoadedPoolIdentity {
  nodeUuid: string;
  /** SPKI DER, base64. */
  publicKey: string;
  /** `null` when `private_key_encrypted` could not be decrypted — verify still works, signing does not. */
  privateKey: KeyObject | null;
}

/**
 * Owns `hub_pool_identity`: this node's stable UUID and its Ed25519 keypair, plus the "identity
 * beats address" bookkeeping that goes with them.
 *
 * THE INIT CONTRACT, which is the single most consequential rule in this service: **this must never
 * throw out of `onModuleInit`.** `EncryptionService` derives its key from the `JWT_SECRET`
 * environment variable, and a regenerated `.env` over a retained Postgres volume is an ordinary
 * reinstall — not an exotic failure. A throw here would crash-loop every appliance running this
 * build, including single-node Hubs that have never had a peer and never will. So the load is
 * lazy, memoized, retried on a timer, and every failure degrades to `identityError` on
 * `/pool/status` exactly the way a down inference backend already degrades to `capabilitiesError`.
 *
 * The second rule: an undecryptable row is **never** silently re-minted. Re-minting would hand this
 * node a new public key while every peer still has the old one pinned, turning a recoverable
 * "fix your .env" into an unrecoverable fleet-wide unpair.
 */
@Injectable()
export class HubPoolIdentityService implements OnModuleInit {
  private cached: LoadedPoolIdentity | null = null;
  private loading: Promise<LoadedPoolIdentity | null> | null = null;
  private retryAfter = 0;
  private lastError: string | null = null;

  /**
   * FQDNs observed on *verified* signed requests that disagree with the peer row's `node_fqdn`.
   *
   * Lives here rather than in the guard because "which name is this identity at now" is an identity
   * question, and because the rewrite itself must not happen on the request path: `node_fqdn` is
   * UNIQUE, so a collision there would turn an authenticated hot-path request into a 500. The health
   * tick drains this and does the write, wrapped.
   */
  private readonly observedFqdns = new Map<string, string>();

  constructor(
    private readonly logger: LoggerService,
    private readonly repo: HubPoolIdentityRepository,
    private readonly encryption: EncryptionService,
  ) {}

  onModuleInit(): void {
    // Fire and forget, and swallow: warming the cache at boot means the first pairing does not pay
    // for the keygen, but nothing about this node's ability to start may depend on it succeeding.
    void this.get().catch(() => undefined);
  }

  /** The loaded identity, or `null` when it could not be established. Never rejects. */
  async get(): Promise<LoadedPoolIdentity | null> {
    if (this.cached) {
      return this.cached;
    }
    if (this.loading) {
      return this.loading;
    }
    if (Date.now() < this.retryAfter) {
      return null;
    }

    this.loading = this.load()
      .then((identity) => {
        this.cached = identity;
        return identity;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.lastError = message;
        this.retryAfter = Date.now() + IDENTITY_RETRY_MS;
        this.logger.warn(`[HubPool] pool identity unavailable; peers will keep using the bearer token: ${message}`);
        return null;
      })
      .finally(() => {
        this.loading = null;
      });

    return this.loading;
  }

  /** True when this node can actually produce a signature right now. */
  async canSign(): Promise<boolean> {
    return (await this.get())?.privateKey != null;
  }

  /**
   * What the operator surfaces show. Cheap enough for `/pool/status` to poll: after the first load
   * this is a cache read, and a Hub whose identity is broken pays one query a minute at most
   * ({@link IDENTITY_RETRY_MS}).
   *
   * Note that recovering from an undecryptable key needs a restart either way — `jwtSecret` is read
   * from the configuration loaded at boot — so the retry timer is there to survive a transient
   * database failure, not to pick up a corrected `.env` in place.
   */
  async summary(): Promise<PoolIdentitySummary> {
    const identity = await this.get();
    return {
      nodeUuid: identity?.nodeUuid ?? null,
      publicKeyFingerprint: publicKeyFingerprint(identity?.publicKey),
      identityError: identity?.privateKey ? null : this.lastError,
    };
  }

  /**
   * Replace the keypair, keeping the UUID.
   *
   * Destructive by design, and the caller (`HubPoolPeerService.rotateIdentity`) is responsible for
   * telling every peer *before* this runs — once the key is gone there is no way to sign the
   * message that would have told them.
   */
  async rotate(): Promise<LoadedPoolIdentity> {
    const existing = await this.repo.get();
    if (!existing) {
      throw new Error('This node has no pool identity to rotate');
    }
    const material = generatePoolKeyPair();
    await this.repo.replaceKeys(material.publicKey, this.encryption.encrypt(material.privateKey, existing.nodeUuid));
    this.cached = { nodeUuid: existing.nodeUuid, publicKey: material.publicKey, privateKey: privateKeyFromBase64(material.privateKey) };
    this.lastError = null;
    this.retryAfter = 0;
    this.logger.info(`[HubPool] pool identity key rotated; node UUID ${existing.nodeUuid} is unchanged`);
    return this.cached;
  }

  /** Record a verified sender FQDN that disagrees with the stored row. Drained by the health tick. */
  noteObservedPeerFqdn(peerId: string, nodeFqdn: string): void {
    this.observedFqdns.set(peerId, nodeFqdn);
  }

  /** Take and forget the pending FQDN sighting for a peer, if any. */
  takeObservedPeerFqdn(peerId: string): string | undefined {
    const observed = this.observedFqdns.get(peerId);
    this.observedFqdns.delete(peerId);
    return observed;
  }

  private async load(): Promise<LoadedPoolIdentity> {
    const existing = await this.repo.get();
    if (existing) {
      return this.materialize(existing.nodeUuid, existing.publicKey, existing.privateKeyEncrypted);
    }

    const nodeUuid = randomUUID();
    const material = generatePoolKeyPair();
    // Salted with the UUID rather than the FQDN (the salt `presentTokenEncrypted` uses), because the
    // whole point of the UUID is that it survives a rename — a salt that did not would make every
    // MagicDNS change an undecryptable private key.
    await this.repo.insertIfAbsent({
      nodeUuid,
      publicKey: material.publicKey,
      privateKeyEncrypted: this.encryption.encrypt(material.privateKey, nodeUuid),
      algorithm: 'ed25519',
    });

    // Re-read rather than trusting the insert: under the ON CONFLICT race the row that survived may
    // be the other boot's, and this node must use whichever key actually landed.
    const stored = await this.repo.get();
    if (!stored) {
      throw new Error('pool identity row disappeared immediately after insert');
    }
    if (stored.nodeUuid === nodeUuid) {
      this.logger.info(`[HubPool] minted this node's pool identity (${nodeUuid})`);
    }
    return this.materialize(stored.nodeUuid, stored.publicKey, stored.privateKeyEncrypted);
  }

  private materialize(nodeUuid: string, publicKey: string, privateKeyEncrypted: string): LoadedPoolIdentity {
    try {
      const decrypted = this.encryption.decrypt(privateKeyEncrypted, nodeUuid);
      this.lastError = null;
      return { nodeUuid, publicKey, privateKey: privateKeyFromBase64(decrypted) };
    } catch (error) {
      // Deliberately NOT a re-mint. The public half is what every peer pinned; replacing it here
      // would unpair the whole fleet to work around a recoverable environment problem. Verification
      // still works — it needs only this UUID and the peers' own public keys.
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `stored pool private key could not be decrypted (JWT_SECRET changed?): ${message}`;
      this.logger.warn(`[HubPool] ${this.lastError}; this node can verify peers but cannot sign, and falls back to the bearer token`);
      return { nodeUuid, publicKey, privateKey: null };
    }
  }
}
