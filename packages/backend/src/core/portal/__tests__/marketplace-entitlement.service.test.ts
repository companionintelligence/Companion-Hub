import { describe, it, expect, beforeEach } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { mock } from 'vitest-mock-extended';
import type { AppUrn } from '@ci-hub/common/types';
import { TranslatableError } from '@/common/error/translatable-error';
import { DatabaseService } from '@/core/database/database.service';
import { LoggerService } from '@/core/logger/logger.service';
import { EVERY_ADDRESS_FAILED, axiosEveryAddressFailed } from '@/tests/utils/network-failures';
import type { MarketplaceWhoIsService } from '../marketplace-whois.service';
import { PortalClientService } from '../portal-client.service';
import { ENTITLEMENT_CACHE_TTL_MS, MarketplaceEntitlementService } from '../marketplace-entitlement.service';

const APP_URN = 'immich:ci-marketplace' as AppUrn;
const ORGANIZATION_ID = 'org-of-this-hub';

describe('MarketplaceEntitlementService', () => {
  let portal: ReturnType<typeof mock<PortalClientService>>;
  let database: ReturnType<typeof mock<DatabaseService>>;
  let logger: ReturnType<typeof mock<LoggerService>>;
  let whois: ReturnType<typeof mock<MarketplaceWhoIsService>>;
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
    whois = mock<MarketplaceWhoIsService>();
    whois.deviceOrganizationId.mockResolvedValue(ORGANIZATION_ID);
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

    service = new MarketplaceEntitlementService(portal, database, logger, whois);
  });

  it('allows a free or unknown Portal app', async () => {
    portal.checkAppEntitlement.mockResolvedValue({ status: 404, reason: 'unknown_app' });

    await expect(service.assertForInstall(APP_URN)).resolves.toBeUndefined();
  });

  it('allows an entitled app', async () => {
    portal.checkAppEntitlement.mockResolvedValue({ status: 200, entitled: true, reason: 'org_entitled' });

    await expect(service.assertForInstall(APP_URN)).resolves.toBeUndefined();
  });

  describe("naming this Hub's organization", () => {
    it('asks about the organization this Hub is in', async () => {
      portal.checkAppEntitlement.mockResolvedValue({ status: 200, entitled: true, reason: 'org_entitled' });

      await service.assertForInstall(APP_URN);

      expect(portal.checkAppEntitlement).toHaveBeenCalledWith('immich', ORGANIZATION_ID);
    });

    it('names nothing when this Hub could not learn its organization while a device in one organization still gets its answer', async () => {
      whois.deviceOrganizationId.mockResolvedValue(null);
      portal.checkAppEntitlement.mockResolvedValue({ status: 200, entitled: true, reason: 'org_entitled' });

      await expect(service.assertForInstall(APP_URN)).resolves.toBeUndefined();

      expect(portal.checkAppEntitlement).toHaveBeenCalledWith('immich', null);
    });

    it('reads a 402 for the named organization as payment needed and keeps it', async () => {
      portal.checkAppEntitlement.mockResolvedValue({
        status: 402,
        entitled: false,
        reason: 'not_entitled',
        paymentUrl: 'https://portal.example/store/immich',
      });

      await expect(service.assertForInstall(APP_URN)).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
        message: 'APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED',
      });
      expect(cacheRows).toEqual([expect.objectContaining({ entitled: false })]);
    });
  });

  describe.each([
    { status: 409, code: 'ORGANIZATION_REQUIRED', key: 'APP_INSTALL_PORTAL_ORGANIZATION_REQUIRED' },
    { status: 403, code: 'DEVICE_NOT_IN_ORGANIZATION', key: 'APP_INSTALL_PORTAL_DEVICE_NOT_IN_ORGANIZATION' },
  ])('Portal answering $status $code, which is about the organization and not about payment', ({ status, code, key }) => {
    const row = (entitled: boolean, ageMs = 0) => ({
      appUrn: APP_URN,
      entitled,
      reason: entitled ? 'org_entitled' : 'not_entitled',
      paymentUrl: entitled ? null : 'https://portal.example/store/immich',
      cachedAt: new Date(Date.now() - ageMs).toISOString(),
    });

    beforeEach(() => {
      portal.checkAppEntitlement.mockResolvedValue({ status, code });
    });

    it('stops an install and an update with a message saying so, instead of an unreachable Portal', async () => {
      await expect(service.assertForInstall(APP_URN)).rejects.toMatchObject({ status, message: key });
      await expect(service.assertForUpdate(APP_URN)).rejects.toMatchObject({ status, message: key });
    });

    it('stops them on a fresh "entitled" row too, since the bundle download would get the same answer', async () => {
      cacheRows = [row(true)];

      await expect(service.assertForInstall(APP_URN)).rejects.toMatchObject({ status, message: key });
      await expect(service.assertForUpdate(APP_URN)).rejects.toMatchObject({ status, message: key });
    });

    it('does not cache it as "not entitled"', async () => {
      await expect(service.assertForInstall(APP_URN)).rejects.toBeInstanceOf(TranslatableError);
      await expect(service.assertForStart(APP_URN)).resolves.toBeUndefined();

      expect(cacheRows).toEqual([]);
    });

    it('starts an installed app with nothing cached, because a start needs no download', async () => {
      await expect(service.assertForStart(APP_URN)).resolves.toBeUndefined();
    });

    it('starts an installed app on an expired "not entitled" row and leaves the row alone', async () => {
      const expired = row(false, ENTITLEMENT_CACHE_TTL_MS + 1000);
      cacheRows = [expired];

      await expect(service.assertForStart(APP_URN)).resolves.toBeUndefined();

      expect(cacheRows).toEqual([expired]);
    });

    it('still refuses a start on a fresh "not entitled" row: that was a real answer, as for an unreachable Portal', async () => {
      cacheRows = [row(false)];

      await expect(service.assertForStart(APP_URN)).rejects.toMatchObject({
        status: HttpStatus.PAYMENT_REQUIRED,
        message: 'APP_INSTALL_PORTAL_DOWNLOAD_PAYMENT_REQUIRED',
      });
    });
  });

  it('takes the same status without the code as not an answer: a proxy in front of Portal says nothing about organizations', async () => {
    portal.checkAppEntitlement.mockResolvedValue({ status: 409 });

    await expect(service.assertForInstall(APP_URN)).rejects.toMatchObject({ message: 'PORTAL_REQUEST_FAILED' });
    await expect(service.assertForStart(APP_URN)).resolves.toBeUndefined();
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

  it('says why the check got no answer when no address of the Portal accepted the connection', async () => {
    portal.checkAppEntitlement.mockRejectedValue(axiosEveryAddressFailed());

    await expect(service.assertForStart(APP_URN)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(`Portal entitlement check failed for ${APP_URN}: ${EVERY_ADDRESS_FAILED}`);
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
