import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DATA_DIR } from '@/common/constants';
import { LoggerService } from '@/core/logger/logger.service';
import { resolveDeviceId } from '@/modules/registration/device-id.resolver';
import type { PoolIdentitySummary } from './hub-pool.types';

/**
 * Namespace separating this UUID from every other hash of the same device id. Versioned, so that
 * changing the derivation later is a new namespace rather than a silent identity change on upgrade.
 */
const POOL_NODE_ID_NAMESPACE = 'ci-hub.pool.node.v1';

/**
 * This node's stable pool UUID: a name for the machine that survives being renamed.
 *
 * `hub_pool_peer.node_fqdn` is the trust anchor and the unique key, and it is a MagicDNS name — so
 * renaming a device in the Tailscale admin console silently breaks a pairing, and neither side can
 * tell "my peer was renamed" from "my peer is gone". The UUID is what makes that *detectable*.
 *
 * Three properties, and the reason for each:
 *
 * - **Derived, not persisted.** No table and no migration, and the identity survives a database
 *   wipe or a reinstall — which is exactly the moment a peer still holding a row for us needs to
 *   recognise us.
 * - **Hashed, never the raw device id.** `resolveDeviceId` can return a chassis serial number or an
 *   IOPlatformUUID. That value legitimately goes to the Portal at registration; it must not become
 *   something this Hub hands to any node that asks.
 * - **`DATA_DIR` in the mix**, so two Hub stacks on one host (a dev stack beside a prod one) do not
 *   collide on a single identity.
 *
 * Group C's `hub_pool_identity` table (migration 0059) supersedes this with a persisted UUID and an
 * Ed25519 keypair. Until it lands, this is the only node UUID in play, and the two must be
 * reconciled in one direction only — a persisted row wins over a derived value, never the reverse,
 * because peers will already have pinned whatever they were told first.
 */
@Injectable()
export class HubPoolNodeIdentityService implements OnModuleInit {
  private nodeUuidPromise: Promise<string> | null = null;
  private resolvedNodeUuid: string | null = null;
  private identityError: string | null = null;

  constructor(private readonly logger: LoggerService) {}

  /**
   * Fire-and-forget, and it MUST stay that way.
   *
   * `resolveDeviceId` walks a chain of `execSync` probes (`ioreg`, `dmidecode`) with 5s timeouts.
   * Awaiting it here would block boot behind a hardware probe; letting it reject here would throw
   * out of `onModuleInit` and crash-loop the whole appliance — peerless single-node Hubs included —
   * over a subsystem they do not use. Resolving eagerly is still worth it: it means the value is in
   * memory before the first peer probe arrives, so no request path ever waits on the probe chain.
   */
  onModuleInit(): void {
    void this.nodeUuid();
  }

  /**
   * This node's pool UUID, or `null` when the device id could not be resolved.
   *
   * Cached in a promise field with rejection-clearing, exactly as `RegistrationService.getDeviceId`
   * does it: a transient failure must not be cached for the life of the process.
   */
  async nodeUuid(): Promise<string | null> {
    if (this.resolvedNodeUuid) {
      return this.resolvedNodeUuid;
    }
    if (!this.nodeUuidPromise) {
      this.nodeUuidPromise = resolveDeviceId({ dataDir: DATA_DIR, logger: this.logger }).then((deviceId) => deriveNodeUuid(deviceId, DATA_DIR));
    }
    try {
      const uuid = await this.nodeUuidPromise;
      this.resolvedNodeUuid = uuid;
      this.identityError = null;
      return uuid;
    } catch (error) {
      this.nodeUuidPromise = null;
      const message = error instanceof Error ? error.message : String(error);
      this.identityError = message;
      // Warn, never throw: a Hub with no resolvable node identity still pairs, still routes, and
      // still serves. It only loses the rename-detection this UUID exists for.
      this.logger.warn(`[HubPool] could not derive this node's pool UUID; peers will not be told one: ${message}`);
      return null;
    }
  }

  /**
   * The already-resolved UUID, or `null` — never any I/O.
   *
   * This is the accessor for anything on a request or poll path. `getOwnCapabilities` answers every
   * peer's 30s probe and `getPoolStatus` is polled by the UI; neither may sit behind a `dmidecode`
   * that has not finished yet.
   */
  peekNodeUuid(): string | null {
    return this.resolvedNodeUuid;
  }

  /**
   * Identity as the operator surfaces show it.
   *
   * `publicKeyFingerprint` is `null` here by construction — signing keys are Group C's, and this
   * service deliberately holds no key material. Reporting `identityError` the way
   * `localNode.capabilitiesError` already reports a down backend is what keeps "identity is not
   * working" from being indistinguishable from "identity is fine and there is nothing to say".
   */
  identitySummary(): PoolIdentitySummary {
    return { nodeUuid: this.resolvedNodeUuid, publicKeyFingerprint: null, identityError: this.identityError };
  }
}

/**
 * `sha256(namespace \0 deviceId \0 dataDir)` folded into an RFC 9562 version-8 ("custom") UUID.
 *
 * Version 8 is the right nibble precisely because this is not a v4 random or a v5 name-based UUID —
 * anything reading the version gets told "custom, do not infer the input", which is the honest
 * answer for a value derived from hardware identity.
 *
 * Exported as a pure function so the derivation is testable without the probe chain behind it.
 */
export function deriveNodeUuid(deviceId: string, dataDir: string): string {
  const digest = createHash('sha256').update(`${POOL_NODE_ID_NAMESPACE}\0${deviceId}\0${dataDir}`).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // Version 8 in the high nibble of octet 6; RFC 9562 variant (10xx) in the high bits of octet 8.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
