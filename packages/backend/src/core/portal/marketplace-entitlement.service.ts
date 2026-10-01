import { TranslatableError } from '@/common/error/translatable-error';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { describeNetworkError } from '@/common/helpers/network-error';
import { DatabaseService } from '@/core/database/database.service';
import { entitlementCache } from '@/core/database/drizzle/schema';
import { LoggerService } from '@/core/logger/logger.service';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { AppUrn } from '@ci-hub/common/types';
import { eq } from 'drizzle-orm';

import { PortalClientService } from './portal-client.service';

export const ENTITLEMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const ENTITLEMENT_START_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

type EntitlementMode = 'install' | 'start' | 'update';

type CachedEntitlement = {
  entitled: boolean;
  reason: string | null;
  paymentUrl: string | null;
  cachedAt: string;
};

/**
 * Hub UX cache of Portal marketplace entitlements.
 *
 * Not a commerce control. A modified Hub can skip this. Portal GET install
 * and registry mint remain the till.
 */
@Injectable()
export class MarketplaceEntitlementService {
  constructor(
    private readonly portal: PortalClientService,
    private readonly database: DatabaseService,
    private readonly logger: LoggerService,
  ) {}

  async assertForInstall(appUrn: AppUrn): Promise<void> {
    await this.assert(appUrn, 'install');
  }

  async assertForUpdate(appUrn: AppUrn): Promise<void> {
    await this.assert(appUrn, 'update');
  }

  /**
   * Start and restart share this policy. Restart is `down` then `up --force-recreate`, which is a
   * start in every sense the gate cares about; leaving it ungated meant an app refused at Start
   * came back through Restart.
   */
  async assertForStart(appUrn: AppUrn): Promise<void> {
    await this.assert(appUrn, 'start');
  }

  private async assert(appUrn: AppUrn, mode: EntitlementMode): Promise<void> {
    const { appName } = extractAppUrn(appUrn);
    const cache = await this.readCache(appUrn);
    const now = Date.now();

    let result: Awaited<ReturnType<PortalClientService['checkAppEntitlement']>>;

    try {
      result = await this.portal.checkAppEntitlement(appName);
    } catch (error) {
      this.logger.warn(`Portal entitlement check failed for ${appUrn}: ${describeNetworkError(error)}`);
      this.applyUnreachable(cache, now, mode);
      return;
    }

    if (result === null) {
      return;
    }

    if (result.status === 404 || result.reason === 'unknown_app' || result.reason === 'free') {
      await this.writeCache(appUrn, true, result.reason ?? 'unknown_app', null);
      return;
    }

    if (result.status === 401) {
      /*
       * A 401 is Portal refusing this Hub's device key, not an entitlement decision: Portal never
       * looked at the app. Install and update still refuse, because the bundle download and
       * registry mint that follow would get the same 401. Starting an app that is already on disk
       * needs neither, so it gets the unreachable policy. Refusing it is measured: on core-4, whose
       * key Portal had rejected, the boot-time start of ci-memory, ci-hermes, ci-openclaw and
       * ci-import-tools all failed with this error at 2026-09-15T20:17:48Z, while a restart of
       * the same apps, which was not gated, would have brought them straight back.
       */
      if (mode === 'start') {
        this.logger.warn(`Portal rejected this Hub's device key while checking ${appUrn}; starting on the unreachable policy`);
        this.applyUnreachable(cache, now, mode);
        return;
      }

      throw new TranslatableError('APP_INSTALL_PORTAL_DOWNLOAD_UNAUTHORIZED', undefined, HttpStatus.UNAUTHORIZED);
    }

    if (result.status === 402 || result.entitled === false) {
      await this.writeCache(appUrn, false, result.reason ?? 'not_entitled', result.paymentUrl ?? null);
      const key = result.code === 'ASK_ADMIN' ? 'APP_INSTALL_PORTAL_DOWNLOAD_ASK_ADMIN' : 'APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED';
      throw new TranslatableError(key, { paymentUrl: result.paymentUrl }, HttpStatus.PAYMENT_REQUIRED);
    }

    if (result.status >= 200 && result.status < 300 && result.entitled) {
      await this.writeCache(appUrn, true, result.reason ?? 'org_entitled', null);
      return;
    }

    this.logger.warn(`Portal entitlement check returned HTTP ${result.status} for ${appUrn}`);
    this.applyUnreachable(cache, now, mode);
  }

  private applyUnreachable(cache: CachedEntitlement | null, now: number, mode: EntitlementMode): void {
    const age = cache ? now - Date.parse(cache.cachedAt) : Number.POSITIVE_INFINITY;

    if (mode === 'start') {
      if (cache && !cache.entitled && Number.isFinite(age) && age < ENTITLEMENT_CACHE_TTL_MS) {
        throw new TranslatableError(
          'APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED',
          { paymentUrl: cache.paymentUrl ?? undefined },
          HttpStatus.PAYMENT_REQUIRED,
        );
      }
      return;
    }

    if (cache?.entitled && Number.isFinite(age) && age < ENTITLEMENT_CACHE_TTL_MS) {
      return;
    }

    throw new TranslatableError('PORTAL_REQUEST_FAILED', { status: 'unreachable', path: '/entitlements/check' }, HttpStatus.BAD_GATEWAY);
  }

  private async readCache(appUrn: AppUrn): Promise<CachedEntitlement | null> {
    const rows = await this.database.db.select().from(entitlementCache).where(eq(entitlementCache.appUrn, appUrn)).limit(1);

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      entitled: row.entitled,
      reason: row.reason ?? null,
      paymentUrl: row.paymentUrl ?? null,
      cachedAt: row.cachedAt,
    };
  }

  private async writeCache(appUrn: AppUrn, entitled: boolean, reason: string, paymentUrl: string | null): Promise<void> {
    const cachedAt = new Date().toISOString();

    await this.database.db.insert(entitlementCache).values({ appUrn, entitled, reason, paymentUrl, cachedAt }).onConflictDoUpdate({
      target: entitlementCache.appUrn,
      set: { entitled, reason, paymentUrl, cachedAt },
    });
  }
}
