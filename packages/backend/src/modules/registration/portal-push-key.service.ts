import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable } from '@nestjs/common';
import { PORTAL_SCOPE } from '../api-keys/api-key.scopes';
import { ApiKeyService, PREFIX_LEN } from '../api-keys/api-key.service';

/** The row's name in Settings → Security, where an operator can see and revoke it. */
export const PORTAL_PUSH_KEY_NAME = 'Companion Portal (push)';

/** What the next check-in carries about the push key. */
export interface PortalPushKeyCheckInFields {
  /** Fingerprint of the key this Hub expects Portal to hold. */
  hub_push_key_prefix: string;
  /** The key itself — sent only until Portal has confirmed holding it. */
  hub_push_key?: string;
}

/**
 * The key Companion Portal presents when it pushes to this Hub.
 *
 * Portal used to authenticate its pushes (an app install brokered through the
 * store) with the Hub's own Portal DEVICE key. That key is also what first-party
 * Memory holds to call Portal as the device, so accepting it as an operator
 * bearer made a compromised Memory container a Hub operator (2026-09-24 audit).
 *
 * Now the Hub mints a key of its own for Portal — an ordinary hashed, scoped
 * (`portal`), revocable row in the key store — and hands it to Portal over the
 * check-in, which the device key already authenticates:
 *
 *  - every check-in carries the row's fingerprint (`hub_push_key_prefix`);
 *  - until Portal answers with that same fingerprint, the check-in also carries
 *    the raw key (`hub_push_key`), which is kept in settings.json only that long;
 *  - once Portal has confirmed, `portalPushKeyDeliveredAt` is set and the
 *    middleware stops accepting the device key as a bearer. Until then it still
 *    does, so a Hub talking to a Portal that predates this exchange keeps
 *    working exactly as before — the change lands on each Hub the first time
 *    its Portal confirms.
 *
 * If the row disappears (an operator revoked it) or Portal reports a different
 * fingerprint with no raw key left to resend, a new key is minted and delivered
 * on the next check-in. Nothing here can fail a check-in: every method catches
 * and logs.
 */
@Injectable()
export class PortalPushKeyService {
  private announcedDelivery = false;

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  /** The fields for the next check-in, minting a key first if this Hub has none. `null` on failure. */
  async checkInFields(): Promise<PortalPushKeyCheckInFields | null> {
    try {
      const prefix = await this.ensure();
      if (!prefix) {
        return null;
      }
      const pending = this.config.get('portalPushKeyPending');
      return pending ? { hub_push_key_prefix: prefix, hub_push_key: pending } : { hub_push_key_prefix: prefix };
    } catch (error) {
      this.logger.warn(`[PortalPushKey] could not prepare the push key for check-in: ${describe(error)}`);
      return null;
    }
  }

  /**
   * Read Portal's answer to a check-in. `hub_push_key_prefix` in the body is the fingerprint of the
   * key Portal holds for this device: equal to ours means delivered; null or different means Portal
   * does not hold ours; absent means Portal predates the exchange and nothing is concluded.
   */
  async acknowledge(body: unknown): Promise<void> {
    try {
      const held = heldPrefix(body);
      if (held === undefined) {
        return;
      }
      const prefix = this.config.get('portalPushKeyPrefix');
      if (!prefix) {
        return;
      }
      if (held === prefix) {
        if (this.config.get('portalPushKeyPending') || !this.config.get('portalPushKeyDeliveredAt')) {
          await this.config.setFileOnlySettings({ portalPushKeyPending: '', portalPushKeyDeliveredAt: new Date().toISOString() });
        }
        if (!this.announcedDelivery) {
          this.announcedDelivery = true;
          this.logger.info("[PortalPushKey] Companion Portal holds this Hub's push key; the Portal device key no longer authenticates on this API");
        }
        return;
      }
      if (this.config.get('portalPushKeyPending')) {
        // We just sent it and Portal still names another: it did not store ours. Keep resending.
        this.logger.warn(`[PortalPushKey] Portal reports push key ${held ?? '(none)'}, not ours (${prefix}); resending on the next check-in`);
        return;
      }
      // Portal does not hold our key and the raw one is gone (delivered earlier, then lost on
      // Portal's side, or this Hub re-paired). Only a fresh key can be delivered.
      this.logger.warn(`[PortalPushKey] Portal reports push key ${held ?? '(none)'}, not ours (${prefix}); minting a new one`);
      await this.mint();
    } catch (error) {
      this.logger.warn(`[PortalPushKey] could not read Portal's push-key answer: ${describe(error)}`);
    }
  }

  /** Revoke the row and forget it: a registration reset. The next check-in mints and delivers anew. */
  async forget(): Promise<void> {
    try {
      await this.revokeAll();
      await this.config.setFileOnlySettings({ portalPushKeyPrefix: '', portalPushKeyPending: '', portalPushKeyDeliveredAt: '' });
      this.announcedDelivery = false;
    } catch (error) {
      this.logger.warn(`[PortalPushKey] could not forget the push key: ${describe(error)}`);
    }
  }

  /** The current fingerprint, minting when the row is missing. */
  private async ensure(): Promise<string | null> {
    const prefix = this.config.get('portalPushKeyPrefix');
    if (prefix) {
      const rows = await this.apiKeys.list();
      if (rows.some((row) => row.prefix === prefix && row.scopes.includes(PORTAL_SCOPE))) {
        return prefix;
      }
      this.logger.warn('[PortalPushKey] the push key row is gone (revoked?); minting a new one');
    }
    return this.mint();
  }

  private async mint(): Promise<string> {
    await this.revokeAll();
    const created = await this.apiKeys.create(PORTAL_PUSH_KEY_NAME, { scopes: [PORTAL_SCOPE] });
    await this.config.setFileOnlySettings({
      portalPushKeyPrefix: created.prefix,
      portalPushKeyPending: created.key,
      portalPushKeyDeliveredAt: '',
    });
    this.announcedDelivery = false;
    this.logger.info(`[PortalPushKey] minted push key ${created.prefix}; it is delivered to Portal on the next check-in`);
    return created.prefix;
  }

  private async revokeAll(): Promise<void> {
    const rows = await this.apiKeys.list();
    for (const row of rows) {
      if (row.scopes.includes(PORTAL_SCOPE)) {
        await this.apiKeys.revoke(row.id);
      }
    }
  }
}

/** Portal's `hub_push_key_prefix`: a string, `null` for "none", or `undefined` when the field is absent. */
function heldPrefix(body: unknown): string | null | undefined {
  if (!body || typeof body !== 'object' || !('hub_push_key_prefix' in body)) {
    return undefined;
  }
  const value = (body as { hub_push_key_prefix: unknown }).hub_push_key_prefix;
  if (value === null) {
    return null;
  }
  return typeof value === 'string' ? value.slice(0, PREFIX_LEN) : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
