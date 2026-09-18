import { describe, it, expect, beforeEach } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { mock } from 'vitest-mock-extended';
import type { AppUrn } from '@ci-hub/common/types';
import { TranslatableError } from '@/common/error/translatable-error';
import { DatabaseService } from '@/core/database/database.service';
import { LoggerService } from '@/core/logger/logger.service';
import { PortalClientService } from '../portal-client.service';
import { MarketplaceEntitlementService } from '../marketplace-entitlement.service';

const APP_URN = 'immich:ci-marketplace' as AppUrn;

describe('MarketplaceEntitlementService', () => {
  let portal: ReturnType<typeof mock<PortalClientService>>;
  let database: ReturnType<typeof mock<DatabaseService>>;
  let logger: ReturnType<typeof mock<LoggerService>>;
  let service: MarketplaceEntitlementService;
  let cacheRows: Array<{
    appUrn: string;
    entitled: boolean;
    reason: string | null;
    paymentUrl: string | null;
    cachedAt: string;
  }>;

  beforeEach(() => {
    portal = mock<PortalClientService>();
    database = mock<DatabaseService>();
    logger = mock<LoggerService>();
    cacheRows = [];

    database.db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => cacheRows,
          }),
        }),
      }),
      insert: () => ({
        values: (row: (typeof cacheRows)[number]) => ({
          onConflictDoUpdate: async () => {
            cacheRows = [row];
          },
        }),
      }),
    } as unknown as DatabaseService['db'];

    service = new MarketplaceEntitlementService(portal, database, logger);
  });

  it('allows a free or unknown Portal app', async () => {
    portal.checkAppEntitlement.mockResolvedValue({ status: 404, reason: 'unknown_app' });

    await expect(service.assertForInstall(APP_URN)).resolves.toBeUndefined();
  });

  it('allows an entitled app', async () => {
    portal.checkAppEntitlement.mockResolvedValue({ status: 200, entitled: true, reason: 'org_entitled' });

    await expect(service.assertForInstall(APP_URN)).resolves.toBeUndefined();
  });

  it('refuses a paid app without entitlement', async () => {
    portal.checkAppEntitlement.mockResolvedValue({
      status: 402,
      entitled: false,
      reason: 'not_entitled',
      paymentUrl: 'https://portal.example/store/immich',
    });

    await expect(service.assertForInstall(APP_URN)).rejects.toMatchObject({
      status: HttpStatus.PAYMENT_REQUIRED,
    });
  });

  it('refuses an install or update when the device key is missing or unknown, since the bundle download would 401 too', async () => {
    portal.checkAppEntitlement.mockResolvedValue({ status: 401 });

    await expect(service.assertForInstall(APP_URN)).rejects.toBeInstanceOf(TranslatableError);
    await expect(service.assertForUpdate(APP_URN)).rejects.toBeInstanceOf(TranslatableError);
  });

  it('still starts an installed app when Portal rejects the device key, which is not an entitlement decision', async () => {
    // core-4, key rejected by Portal: ci-memory, ci-hermes, ci-openclaw and ci-import-tools all
    // failed to start at boot with APP_INSTALL_PORTAL_DOWNLOAD_UNAUTHORIZED on 2026-09-15.
    portal.checkAppEntitlement.mockResolvedValue({ status: 401 });

    await expect(service.assertForStart(APP_URN)).resolves.toBeUndefined();
  });

  it('does not start on a rejected key when the last real answer was a fresh 402', async () => {
    cacheRows = [
      {
        appUrn: APP_URN,
        entitled: false,
        reason: 'not_entitled',
        paymentUrl: 'https://portal.example/store/immich',
        cachedAt: new Date().toISOString(),
      },
    ];
    portal.checkAppEntitlement.mockResolvedValue({ status: 401 });

    await expect(service.assertForStart(APP_URN)).rejects.toMatchObject({
      status: HttpStatus.PAYMENT_REQUIRED,
    });
  });

  it('fails closed on install when Portal is unreachable and there is no fresh entitled cache', async () => {
    portal.checkAppEntitlement.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.assertForInstall(APP_URN)).rejects.toBeInstanceOf(TranslatableError);
  });

  it('lets an already-installed app start when Portal is unreachable', async () => {
    portal.checkAppEntitlement.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.assertForStart(APP_URN)).resolves.toBeUndefined();
  });

  it('does not start an app whose last check was a fresh 402 when Portal is unreachable', async () => {
    cacheRows = [
      {
        appUrn: APP_URN,
        entitled: false,
        reason: 'not_entitled',
        paymentUrl: 'https://portal.example/store/immich',
        cachedAt: new Date().toISOString(),
      },
    ];
    portal.checkAppEntitlement.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.assertForStart(APP_URN)).rejects.toMatchObject({
      status: HttpStatus.PAYMENT_REQUIRED,
    });
  });
});
